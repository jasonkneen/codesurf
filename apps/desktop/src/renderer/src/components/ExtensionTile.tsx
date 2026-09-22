/**
 * ExtensionTile — renders extension tile content inside a sandboxed iframe.
 *
 * Extension HTML is served through the custom codesurf-ext:// protocol so dev
 * renderer pages can load it safely, and a postMessage RPC bridge lets the
 * iframe talk back to the host renderer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from '../ThemeContext'
import { useFontTokens, useAppFonts } from '../FontContext'
import { CODESURF_OPEN_CHAT_SURFACE_EVENT } from '../utils/appLaunchRequests'
import { PluginSurface } from './PluginSurface'
import {
  getExtensionIframeAllow,
  isSensitiveMediaCapability,
  type SensitiveMediaCapability,
} from '../../../shared/extension-sensitive-media'
import {
  isTileContextChangeForScope,
  tileContextChannel,
  type TileContextChangedPayload,
} from '../../../shared/tileContextScope'

const el = (window as any).electron

export interface ExtensionAction {
  name: string
  description: string
}

interface ExtensionPeerInfo {
  peerId: string
  peerType: string
  tools?: string[]
  actions?: ExtensionAction[]
  filePath?: string
  label?: string
}

interface ExtensionTileProps {
  tileId: string
  extType: string  // e.g. 'ext:timer'
  width: number
  height: number
  workspaceId?: string
  workspacePath?: string
  isInteracting?: boolean
  connectedPeers?: ExtensionPeerInfo[]
  onCreateTile?: (type: string, opts?: { filePath?: string; x?: number; y?: number; hideTitlebar?: boolean; hideNavbar?: boolean }) => string | null
  onActionsChanged?: (tileId: string, actions: ExtensionAction[]) => void
}

export function ExtensionTile({ tileId, extType, width, height, workspaceId, workspacePath, isInteracting, connectedPeers = [], onCreateTile, onActionsChanged }: ExtensionTileProps) {
  const theme = useTheme()
  const fontTokens = useFontTokens()
  const fonts = useAppFonts()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const busUnsubsRef = useRef<Map<string, () => void>>(new Map())
  const relayUnsubRef = useRef<(() => void) | null>(null)
  const bridgeReadyRef = useRef(false)
  const registeredActionsRef = useRef<Map<string, string>>(new Map()) // name → description
  const pendingActionResultsRef = useRef<Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>>(new Map())
  const extensionChatCardsRef = useRef<Set<string>>(new Set())
  const handleRpcRef = useRef<((method: string, params: any) => Promise<any>) | null>(null)
  // P1 capability gate — host-side enforcement for gated RPC namespaces. Fetched
  // once extId resolves; null means "not yet known" (treated as ungated).
  const capabilityGateRef = useRef<{ enforced: boolean; granted: string[] } | null>(null)

  const [entryUrl, setEntryUrl] = useState<string | null>(null)
  const [renderMode, setRenderMode] = useState<string>('iframe')
  const [mcpHtml, setMcpHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [extId, setExtId] = useState<string | null>(null)
  const [sensitiveMedia, setSensitiveMedia] = useState<SensitiveMediaCapability[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const [renderedSize, setRenderedSize] = useState({ w: width, h: Math.max(0, height - 36) })
  const themeCssVarsRef = useRef<Record<string, string>>({})
  const connectedPeerIds = useMemo(() => connectedPeers.map(peer => peer.peerId).filter(Boolean), [connectedPeers])

  // Use ResizeObserver to track actual rendered size — works correctly in both
  // canvas mode (TileChrome constrains the container) and panel/tab mode (container fills the pane).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) setRenderedSize({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const contentHeight = renderedSize.h
  const contentWidth = renderedSize.w
  const extensionSurfaceBackground = theme.surface.panel

  const themeColors = useMemo(() => ({
    background: extensionSurfaceBackground,
    panel: theme.extension.panel,
    border: theme.extension.border,
    text: theme.extension.text,
    muted: theme.extension.muted,
    accent: theme.extension.accent,
    mode: theme.mode,
    success: theme.status.success,
    warning: theme.status.warning,
    danger: theme.status.danger,
  }), [extensionSurfaceBackground, theme])

  // CSS variables pushed into every extension iframe — auto light/dark compatible
  const themeCssVars = useMemo(() => ({
    '--ct-bg':        extensionSurfaceBackground,
    '--ct-panel':     theme.extension.panel,
    '--ct-panel-2':   theme.surface.panelElevated,
    '--ct-border':    theme.extension.border,
    '--ct-border-2':  theme.border.strong,
    '--ct-text':      theme.extension.text,
    '--ct-muted':     theme.text.secondary,
    '--ct-dim':       theme.extension.muted,
    '--ct-hover':     theme.surface.hover,
    '--ct-accent':    theme.extension.accent,
    '--ct-accent-s':  theme.accent.soft,
    '--ct-select-b':  theme.surface.selection,
    '--ct-success':   theme.status.success,
    '--ct-warning':   theme.status.warning,
    '--ct-danger':    theme.status.danger,
    '--ct-radius':    '8px',
    // Primary font (main UI text, headings, labels)
    '--ct-font-primary': fontTokens.primary?.family ?? fonts.primary,
    '--ct-font-primary-size': `${fontTokens.primary?.size ?? fonts.size}px`,
    '--ct-font-primary-line': String(fontTokens.primary?.lineHeight ?? fonts.lineHeight),
    '--ct-font-primary-weight': String(fontTokens.primary?.weight ?? fonts.weight),
    // Secondary font (metadata, subtitles, smaller text)
    '--ct-font-secondary': fontTokens.secondary?.family ?? fonts.secondary,
    '--ct-font-secondary-size': `${fontTokens.secondary?.size ?? fonts.secondarySize}px`,
    '--ct-font-secondary-line': String(fontTokens.secondary?.lineHeight ?? fonts.secondaryLineHeight),
    '--ct-font-secondary-weight': String(fontTokens.secondary?.weight ?? fonts.secondaryWeight),
    // Monospace font (code, terminal, data)
    '--ct-font-mono': fontTokens.mono?.family ?? fonts.mono,
    '--ct-font-mono-size': `${fontTokens.mono?.size ?? fonts.monoSize}px`,
    '--ct-font-mono-line': String(fontTokens.mono?.lineHeight ?? fonts.monoLineHeight),
    '--ct-font-mono-weight': String(fontTokens.mono?.weight ?? fonts.monoWeight),
    // Legacy aliases (backward compat for existing extensions)
    '--ct-font-sans': fontTokens.primary?.family ?? fonts.primary,
    '--ct-font-size': `${fontTokens.primary?.size ?? fonts.size}px`,
    '--ct-font-line': String(fontTokens.primary?.lineHeight ?? fonts.lineHeight),
    '--ct-font-weight': String(fontTokens.primary?.weight ?? fonts.weight),
    '--ct-font-title': fontTokens.primary?.family ?? fonts.primary,
    '--ct-font-title-size': `${fontTokens.primary?.size ?? fonts.size}px`,
    '--ct-font-title-weight': String(fontTokens.primary?.weight ?? Math.max(fonts.weight, 600)),
    '--ct-font-subtle': fontTokens.secondary?.family ?? fonts.secondary,
    '--ct-font-subtle-size': `${fontTokens.secondary?.size ?? fonts.secondarySize}px`,
    '--ct-mode':      `"${theme.mode}"`,
  }), [extensionSurfaceBackground, theme, fontTokens, fonts])

  // Keep ref in sync; push vars to iframe whenever theme changes (must be after both memos)
  themeCssVarsRef.current = themeCssVars
  useEffect(() => {
    if (!bridgeReadyRef.current) return
    iframeRef.current?.contentWindow?.postMessage({ type: 'codesurf-theme-vars', vars: themeCssVars }, '*')
    iframeRef.current?.contentWindow?.postMessage({ type: 'codesurf-event', event: 'theme.change', data: themeColors }, '*')
  }, [themeCssVars, themeColors])

  // The only origin trusted to talk RPC to this tile: the origin of the URL
  // the iframe was pointed at (codesurf-ext://<extId>). A sandboxed frame can
  // self-navigate to a remote origin while keeping its contentWindow, so
  // event.source alone never proves the sender is still the extension.
  const expectedIframeOrigin = (iframe: HTMLIFrameElement | null): string | null => {
    try {
      return iframe?.src ? new URL(iframe.src).origin : null
    } catch {
      return null
    }
  }

  const postToIframe = useCallback((message: Record<string, unknown>) => {
    const iframe = iframeRef.current
    const targetOrigin = expectedIframeOrigin(iframe)
    // Fail closed: without a known extension origin, don't broadcast events
    // (bus/relay traffic can carry workspace data).
    if (!iframe?.contentWindow || !targetOrigin) return
    iframe.contentWindow.postMessage(message, targetOrigin)
  }, [])

  const cleanupBusSubscriptions = useCallback(() => {
    for (const unsubscribe of busUnsubsRef.current.values()) unsubscribe()
    busUnsubsRef.current.clear()
  }, [])

  const forwardContextEvent = useCallback((peerId: string, data: any) => {
    postToIframe({
      type: 'codesurf-event',
      event: 'context.peerChanged',
      data: { peerId, ...data },
    })
  }, [postToIframe])

  const cleanupRelaySubscription = useCallback(() => {
    relayUnsubRef.current?.()
    relayUnsubRef.current = null
  }, [])

  const ensureBusSubscription = useCallback((channel: string) => {
    if (!channel || busUnsubsRef.current.has(channel)) return

    const subscriberId = `exttile:${tileId}:${channel}`
    const unsubscribe = el.bus?.subscribe?.(channel, subscriberId, (event: any) => {
      postToIframe({
        type: 'codesurf-event',
        event: `bus.event.${channel}`,
        data: event,
      })
    })

    if (typeof unsubscribe === 'function') {
      busUnsubsRef.current.set(channel, unsubscribe)
    }
  }, [postToIframe, tileId])

  const buildChatPeers = useCallback(async () => {
    if (!workspaceId || connectedPeers.length === 0) return []

    const peers = await Promise.all(connectedPeers.map(async (peer) => {
      const context = await el.tileContext?.getAll?.(workspaceId, peer.peerId).catch?.(() => ({}))
      return {
        peerId: peer.peerId,
        peerType: peer.peerType,
        tools: Array.isArray(peer.tools) ? peer.tools : [],
        actions: Array.isArray(peer.actions) ? peer.actions : undefined,
        context: context && typeof context === 'object' ? context : undefined,
      }
    }))

    return peers.filter(peer => peer.peerId)
  }, [connectedPeers, workspaceId])

  // Fetch the plugin's capability gate once its id is known, so handleRpc can
  // reject gated namespaces the plugin wasn't granted (P1 host-side enforcement).
  useEffect(() => {
    if (!extId) return
    let cancelled = false
    void el.extensions?.capabilityGate?.(extId)
      .then((gate: { enforced: boolean; granted: string[] }) => { if (!cancelled) capabilityGateRef.current = gate })
      .catch(() => { /* default ungated on failure */ })
    return () => { cancelled = true }
  }, [extId])

  const handleRpc = useCallback(async (method: string, params: any) => {
    // P1 capability gate: chat/relay/canvas RPCs require the same-named
    // capability. The sandboxed iframe can only reach these via this dispatcher,
    // so rejecting here is authoritative. Ungated plugins (no declared caps) pass.
    const ns = method.split('.')[0]
    if ((ns === 'chat' || ns === 'relay' || ns === 'canvas')) {
      const gate = capabilityGateRef.current
      if (gate?.enforced && !gate.granted.includes(ns)) {
        throw new Error(`Plugin "${extId}" is not granted the "${ns}" capability`)
      }
    }
    switch (method) {
      case 'tile.getState':
        if (!workspaceId) return null
        {
          const state = await el.canvas?.loadTileState?.(workspaceId, tileId) ?? null
          const key = typeof params?.key === 'string' ? params.key : null
          if (!key) return state
          return state && typeof state === 'object' ? (state as Record<string, unknown>)[key] ?? null : null
        }

      case 'tile.setState':
        if (!workspaceId) return false
        if (params && typeof params === 'object' && typeof params.key === 'string') {
          const prev = await el.canvas?.loadTileState?.(workspaceId, tileId)
          const next = prev && typeof prev === 'object' ? { ...prev } : {}
          ;(next as Record<string, unknown>)[params.key] = params.value
          await el.canvas?.saveTileState?.(workspaceId, tileId, next)
          return true
        }
        await el.canvas?.saveTileState?.(workspaceId, tileId, params?.data ?? params ?? {})
        return true

      case 'tile.getSize':
        return { width: contentWidth, height: contentHeight }

      case 'tile.getMeta':
        return {
          tileId,
          extId,
          extType,
          width: contentWidth,
          height: contentHeight,
          workspaceId: workspaceId ?? '',
          workspacePath: workspacePath ?? '',
          connectedPeers: connectedPeerIds,
        }

      case 'discovery.getPeers':
        return connectedPeerIds

      case 'bus.publish': {
        const channel = String(params?.channel ?? '')
        const type = String(params?.type ?? 'data')
        const payload = params?.payload ?? {}
        if (!channel) throw new Error('Missing bus channel')
        return el.bus?.publish?.(channel, type, `exttile:${tileId}`, payload)
      }

      case 'bus.subscribe': {
        const channel = String(params?.channel ?? '')
        if (!channel) throw new Error('Missing bus channel')
        ensureBusSubscription(channel)
        return true
      }

      case 'canvas.listTiles': {
        if (!workspaceId) return []
        const canvasState = await el.canvas?.load?.(workspaceId)
        return canvasState?.tiles ?? []
      }

      case 'canvas.createTile': {
        const type = String(params?.type ?? '')
        if (!type) throw new Error('Missing tile type')
        return onCreateTile?.(type, {
          filePath: typeof params?.filePath === 'string' ? params.filePath : undefined,
          x: typeof params?.x === 'number' ? params.x : undefined,
          y: typeof params?.y === 'number' ? params.y : undefined,
          hideTitlebar: !!params?.hideTitlebar,
          hideNavbar: !!params?.hideNavbar,
        }) ?? null
      }

      case 'settings.get': {
        if (!extId) return undefined
        const settings = await el.extensions?.getSettings?.(extId)
        const key = String(params?.key ?? '')
        return key ? settings?.[key] : settings
      }

      case 'settings.set': {
        if (!extId) return false
        await el.extensions?.setSettings?.(extId, params ?? {})
        return true
      }

      case 'store.get': {
        if (!extId) return {}
        return el.extensions?.storeGet?.(extId)
      }

      case 'store.set': {
        if (!extId) return {}
        return el.extensions?.storeSet?.(extId, params?.patch ?? {})
      }

      case 'store.replace': {
        if (!extId) return {}
        return el.extensions?.storeReplace?.(extId, params?.value ?? {})
      }

      case 'ext.invoke': {
        if (!extId) throw new Error('Extension not resolved yet')
        const method = String(params?.method ?? '')
        if (!method) throw new Error('Missing extension method')
        const args = Array.isArray(params?.args) ? params.args : []
        return el.extensions?.invoke?.(extId, method, ...args)
      }

      case 'workspace.getPath':
        return workspacePath ?? ''

      case 'chat.send': {
        const request = params?.request ?? params
        const cardId = String(request?.cardId ?? '').trim()
        if (!cardId) throw new Error('Missing chat cardId')
        if (!workspaceId) throw new Error('Missing workspace identity')
        extensionChatCardsRef.current.add(cardId)
        const peers = await buildChatPeers()
        return el.chat?.send?.({
          ...request,
          workspaceId,
          workspaceDir: request?.workspaceDir ?? workspacePath,
          peers: peers.length > 0 ? peers : undefined,
        })
      }

      case 'chat.stop': {
        const cardId = String(params?.cardId ?? '').trim()
        if (!cardId) throw new Error('Missing chat cardId')
        if (!workspaceId) throw new Error('Missing workspace identity')
        extensionChatCardsRef.current.delete(cardId)
        return el.chat?.stop?.(workspaceId, cardId)
      }

      case 'chat.openSurface': {
        const request = params?.request ?? params ?? {}
        const requestedExtId = String(request?.extId ?? extId ?? '').trim()
        const surfaceId = String(request?.surfaceId ?? request?.id ?? '').trim()
        const preferredTileId = String(request?.preferredTileId ?? '').trim()
        const initialContext = request?.initialContext && typeof request.initialContext === 'object' && !Array.isArray(request.initialContext)
          ? request.initialContext as Record<string, unknown>
          : undefined
        if (!requestedExtId || !surfaceId) throw new Error('Missing chat surface target')
        window.dispatchEvent(new CustomEvent(CODESURF_OPEN_CHAT_SURFACE_EVENT, {
          detail: {
            extId: requestedExtId,
            surfaceId,
            sourceTileId: tileId,
            ...(preferredTileId ? { preferredTileId } : {}),
            ...(initialContext ? { initialContext } : {}),
          },
        }))
        return true
      }

      case 'chat.clearSession': {
        const cardId = String(params?.cardId ?? '').trim()
        if (!cardId) throw new Error('Missing chat cardId')
        if (!workspaceId) throw new Error('Missing workspace identity')
        extensionChatCardsRef.current.delete(cardId)
        return el.chat?.clearSession?.(workspaceId, cardId)
      }

      case 'relay.init':
        return workspacePath ? el.relay?.init?.(workspacePath) : false

      case 'relay.listParticipants':
        return workspacePath ? el.relay?.listParticipants?.(workspacePath) : []

      case 'relay.listChannels':
        return workspacePath ? el.relay?.listChannels?.(workspacePath) : []

      case 'relay.listCentralFeed':
        return workspacePath ? el.relay?.listCentralFeed?.(workspacePath, typeof params?.limit === 'number' ? params.limit : undefined) : []

      case 'relay.listMessages':
        return workspacePath ? el.relay?.listMessages?.(workspacePath, String(params?.participantId ?? ''), String(params?.mailbox ?? 'inbox'), typeof params?.limit === 'number' ? params.limit : undefined) : []

      case 'relay.readMessage':
        return workspacePath ? el.relay?.readMessage?.(workspacePath, String(params?.participantId ?? ''), String(params?.mailbox ?? 'inbox'), String(params?.filename ?? '')) : null

      case 'relay.sendDirectMessage':
        return workspacePath ? el.relay?.sendDirectMessage?.(workspacePath, String(params?.from ?? 'system'), params?.draft ?? {}) : null

      case 'relay.sendChannelMessage':
        return workspacePath ? el.relay?.sendChannelMessage?.(workspacePath, String(params?.from ?? 'system'), params?.draft ?? {}) : null

      case 'relay.setWorkContext':
        return workspacePath ? el.relay?.setWorkContext?.(workspacePath, String(params?.participantId ?? ''), params?.work ?? {}) : null

      case 'relay.analyzeRelationships':
        return workspacePath ? el.relay?.analyzeRelationships?.(workspacePath) : []

      case 'relay.spawnAgent':
        return workspacePath ? el.relay?.spawnAgent?.(workspacePath, params?.request ?? {}) : null

      case 'relay.stopAgent':
        return workspacePath ? el.relay?.stopAgent?.(workspacePath, String(params?.participantId ?? '')) : false

      case 'relay.waitForReady':
        return workspacePath ? el.relay?.waitForReady?.(workspacePath, Array.isArray(params?.ids) ? params.ids : [], typeof params?.timeoutMs === 'number' ? params.timeoutMs : undefined) : false

      case 'relay.waitForAny':
        return workspacePath ? el.relay?.waitForAny?.(workspacePath, Array.isArray(params?.ids) ? params.ids : [], typeof params?.timeoutMs === 'number' ? params.timeoutMs : undefined) : null

      case 'theme.getColors':
        return themeColors

      case 'context.get': {
        if (!workspaceId) return null
        const key = String(params?.key ?? '')
        const entry = await el.tileContext?.get?.(workspaceId, tileId, key)
        if (!entry || typeof entry !== 'object') return null
        return (entry as { value?: unknown }).value ?? null
      }

      case 'context.set': {
        if (!workspaceId) return false
        const key = String(params?.key ?? '')
        const value = params?.value ?? null
        await el.tileContext?.set?.(workspaceId, tileId, key, value)
        return true
      }

      case 'context.getAll': {
        if (!workspaceId) return []
        const tagPrefix = typeof params?.tagPrefix === 'string' ? params.tagPrefix : undefined
        return el.tileContext?.getAll?.(workspaceId, tileId, tagPrefix) ?? []
      }

      case 'context.delete': {
        if (!workspaceId) return false
        const key = String(params?.key ?? '')
        await el.tileContext?.delete?.(workspaceId, tileId, key)
        return true
      }

      case 'context.getPeerContext': {
        if (!workspaceId) return null
        const peerId = String(params?.peerId ?? '')
        const tagPrefix = typeof params?.tagPrefix === 'string' ? params.tagPrefix : undefined
        if (!peerId) return null
        return el.tileContext?.getAll?.(workspaceId, peerId, tagPrefix) ?? []
      }

      case 'context.getAllPeerContext': {
        if (!workspaceId) return {}
        const tagPrefix = typeof params?.tagPrefix === 'string' ? params.tagPrefix : undefined
        const result: Record<string, any> = {}
        for (const peerId of connectedPeerIds) {
          const peerContext = await el.tileContext?.getAll?.(workspaceId, peerId, tagPrefix)
          if (peerContext) {
            result[peerId] = peerContext
          }
        }
        return result
      }

      case 'actions.register': {
        const name = String(params?.name ?? '')
        const description = String(params?.description ?? '')
        if (!name) throw new Error('Missing action name')
        registeredActionsRef.current.set(name, description)
        onActionsChanged?.(tileId, Array.from(registeredActionsRef.current.entries()).map(([n, d]) => ({ name: n, description: d })))
        return true
      }

      case 'actions.invoke': {
        const peerId = String(params?.peerId ?? '')
        const action = String(params?.action ?? '')
        if (!peerId || !action) throw new Error('Missing peerId or action')
        // Use bus publish which triggers peer's ext:action listener via main process
        await el.bus?.publish?.(`tile:${peerId}`, 'data', `exttile:${tileId}`, { command: action, ...params?.params, _fromTileId: tileId })
        return true
      }

      default:
        throw new Error(`Unsupported extension RPC method: ${method}`)
    }
  }, [buildChatPeers, connectedPeerIds, contentHeight, ensureBusSubscription, extId, extType, onCreateTile, onActionsChanged, themeColors, tileId, width, workspaceId, workspacePath, forwardContextEvent])

  // Keep ref in sync so the message listener doesn't need to be re-created
  handleRpcRef.current = handleRpc

  useEffect(() => {
    bridgeReadyRef.current = false

    async function resolve() {
      try {
        const tiles = await el.extensions?.listTiles?.() ?? []
        const match = tiles.find((t: any) => t.type === extType)
        if (!match) {
          setError(`Extension block type "${extType}" not found.`)
          setLoading(false)
          return
        }

        setExtId(match.extId)
        setRenderMode(match.render ?? 'iframe')
        setSensitiveMedia(
          Array.isArray(match.sensitiveMedia)
            ? match.sensitiveMedia.filter(isSensitiveMediaCapability)
            : [],
        )

        // render:'mcp-ui' tiles paint via PluginSurface (AppRenderer) instead of a
        // raw iframe — fetch the guest HTML and skip the codesurf-ext:// url path.
        if (match.render === 'mcp-ui') {
          const h = await el.extensions?.surfaceHtml?.(match.extId, 'tile', extType)
          setMcpHtml(typeof h === 'string' ? h : '')
          setError(null)
          setLoading(false)
          return
        }

        // Read manifest actions and register them immediately (no iframe RPC needed)
        if (match.actions && Array.isArray(match.actions)) {
          for (const action of match.actions) {
            if (action.name) registeredActionsRef.current.set(action.name, action.description ?? '')
          }
          if (registeredActionsRef.current.size > 0) {
            onActionsChanged?.(tileId, Array.from(registeredActionsRef.current.entries()).map(([n, d]) => ({ name: n, description: d })))
          }
        }

        const url = await el.extensions?.tileEntry?.(match.extId, extType, tileId)
        if (!url) {
          setError(`No entry URL for extension "${match.extId}".`)
          setLoading(false)
          return
        }

        setEntryUrl(url)
        setError(null)
      } catch (err) {
        setError(String(err))
      } finally {
        setLoading(false)
      }
    }

    resolve()
  }, [extType, tileId])

  // Stable message listener — uses refs to avoid teardown/re-creation gaps
  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      const message = event.data
      if (!message || typeof message !== 'object') return
      // Filter by tileId and source so sibling frames cannot spoof extension RPC.
      if (message.tileId && message.tileId !== tileId) return

      const iframeWindow = iframeRef.current?.contentWindow
      if (!iframeWindow || event.source !== iframeWindow) return

      // The sender must still be on the extension's own origin — see above.
      const expectedOrigin = expectedIframeOrigin(iframeRef.current)
      if (!expectedOrigin || event.origin !== expectedOrigin) return

      if (message.type === 'codesurf-bridge-ready' && message.tileId === tileId) {
        bridgeReadyRef.current = true
        iframeWindow.postMessage({ type: 'codesurf-theme-vars', vars: themeCssVarsRef.current }, event.origin)
        iframeWindow.postMessage({
          type: 'codesurf-event',
          event: 'tile.resize',
          data: { width: contentWidth, height: contentHeight },
        }, event.origin)
        return
      }

      // Action result from iframe
      if (message.type === 'codesurf-action-result' && message.tileId === tileId) {
        const pending = pendingActionResultsRef.current.get(message.requestId)
        if (pending) {
          pendingActionResultsRef.current.delete(message.requestId)
          if (message.error) pending.reject(new Error(message.error))
          else pending.resolve(message.result)
        }
        return
      }

      if (message.type !== 'codesurf-rpc' || message.tileId !== tileId) return

      const rpcHandler = handleRpcRef.current
      if (!rpcHandler) return

      try {
        const result = await rpcHandler(String(message.method ?? ''), message.params)
        iframeWindow.postMessage({ type: 'codesurf-rpc-response', id: message.id, result }, event.origin)
      } catch (err) {
        iframeWindow.postMessage({
          type: 'codesurf-rpc-response',
          id: message.id,
          error: err instanceof Error ? err.message : String(err),
        }, event.origin)
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [tileId, height, width]) // Minimal stable deps — handleRpc accessed via ref

  useEffect(() => {
    if (!bridgeReadyRef.current) return

    postToIframe({
      type: 'codesurf-event',
      event: 'tile.resize',
      data: { width: contentWidth, height: contentHeight },
    })
  }, [contentHeight, contentWidth, postToIframe])

  useEffect(() => {
    cleanupRelaySubscription()
    if (!workspacePath) return

    const unsubscribe = el.relay?.onEvent?.((data: { workspacePath: string; event: unknown }) => {
      if (data?.workspacePath !== workspacePath) return
      postToIframe({
        type: 'codesurf-event',
        event: 'relay.event',
        data: data.event,
      })
    })

    if (typeof unsubscribe === 'function') {
      relayUnsubRef.current = unsubscribe
    }

    return () => cleanupRelaySubscription()
  }, [cleanupRelaySubscription, postToIframe, workspacePath])

  useEffect(() => {
    const unsubscribe = el.stream?.onChunk?.((event: any) => {
      if (event?.workspaceId !== workspaceId) return
      const cardId = typeof event?.cardId === 'string' ? event.cardId : ''
      if (!cardId || !extensionChatCardsRef.current.has(cardId)) return

      postToIframe({
        type: 'codesurf-event',
        event: 'chat.stream',
        data: event,
      })

      if (event?.type === 'done' || event?.type === 'error') {
        extensionChatCardsRef.current.delete(cardId)
      }
    })

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
      extensionChatCardsRef.current.clear()
    }
  }, [postToIframe, workspaceId])

  useEffect(() => {
    if (!bridgeReadyRef.current) return
    postToIframe({
      type: 'codesurf-event',
      event: 'discovery.peersChanged',
      data: connectedPeers,
    })
  }, [connectedPeers, postToIframe])

  useEffect(() => {
    const peerContextUnsubs = new Map<string, () => void>()
    if (!workspaceId) return

    for (const peerId of connectedPeerIds) {
      const channel = tileContextChannel(workspaceId, peerId)
      const subscriberId = `exttile:${workspaceId}:${tileId}:peer-ctx:${peerId}`

      const unsubscribe = el.bus?.subscribe?.(channel, subscriberId, (event: any) => {
        const p = event?.payload ?? event
        if (isTileContextChangeForScope(p, workspaceId, peerId) && p.action === 'context_changed') {
          forwardContextEvent(peerId, {
            key: p.key,
            value: p.value,
          })
        }
      })

      if (typeof unsubscribe === 'function') {
        peerContextUnsubs.set(peerId, unsubscribe)
      }
    }

    return () => {
      for (const unsubscribe of peerContextUnsubs.values()) {
        unsubscribe()
      }
    }
  }, [connectedPeerIds, forwardContextEvent, tileId, workspaceId])

  // Listen for action invocations via tileContext:changed (proven IPC path)
  useEffect(() => {
    let actionReqId = 0
    if (!workspaceId) return
    const unsub = el.tileContext?.onChanged?.(workspaceId, tileId, (data: TileContextChangedPayload) => {
      if (!isTileContextChangeForScope(data, workspaceId, tileId)) return
      if (data.key !== '_action') return
      const cmd = data.value as { action: string; params: Record<string, unknown>; ts: number } | null
      if (!cmd?.action) return
      if (!registeredActionsRef.current.has(cmd.action)) return
      const requestId = `action-${++actionReqId}-${Date.now()}`
      postToIframe({
        type: 'codesurf-action-invoke',
        action: cmd.action,
        params: cmd.params || {},
        requestId,
      })
    })
    return () => { if (typeof unsub === 'function') unsub() }
  }, [tileId, postToIframe, workspaceId])

  useEffect(() => {
    return () => {
      bridgeReadyRef.current = false
      cleanupBusSubscriptions()
      cleanupRelaySubscription()
    }
  }, [cleanupBusSubscriptions, cleanupRelaySubscription])

  if (loading) {
    return (
      <div ref={containerRef} style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: theme.text.disabled, fontSize: fonts.secondarySize,
        background: extensionSurfaceBackground,
      }}>
        Loading extension…
      </div>
    )
  }

  if (error) {
    return (
      <div ref={containerRef} style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: theme.status.danger, fontSize: fonts.secondarySize, padding: 20, textAlign: 'center',
        background: extensionSurfaceBackground,
      }}>
        {error}
      </div>
    )
  }

  if (renderMode === 'mcp-ui') {
    return (
      <div ref={containerRef} style={{
        position: 'relative',
        width: '100%', height: '100%',
        overflow: 'hidden',
        background: extensionSurfaceBackground,
      }}>
        {/* MCP-UI proxy frames deliberately receive no sensitive media policy:
            their internal __runext_* principal is not an extension principal. */}
        <PluginSurface extId={extId ?? extType} render="mcp-ui" html={mcpHtml ?? ''} surfaceId={extType} />
      </div>
    )
  }

  if (!entryUrl) return null

  return (
    <div ref={containerRef} style={{
      position: 'relative',
      width: '100%', height: '100%',
      overflow: 'hidden',
      background: extensionSurfaceBackground,
    }}>
      <iframe
        ref={iframeRef}
        src={entryUrl}
        sandbox="allow-scripts allow-same-origin allow-modals"
        allow={getExtensionIframeAllow(sensitiveMedia)}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          border: 'none',
          background: 'transparent',
          pointerEvents: isInteracting ? 'none' : 'auto',
        }}
        title={extType}
      />
    </div>
  )
}
