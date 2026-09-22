import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CODESURF_OPEN_CHAT_SURFACE_EVENT, normalizeOpenChatSurfaceDetail } from '../utils/appLaunchRequests'
import { handleBasicChatSurfaceRpc } from '../components/chatSurfaceHostRpc'
import { normalizeChatSurfaceMenuEntry } from '../components/chat/ChatTileViews'
import type { ChatSurfaceMenuEntry } from '../components/chat/ChatComposerMenus'
import type { ActiveChatSurface } from '../components/chat/chatTileUtils'

// The only origin trusted to talk RPC from a surface iframe: the origin of
// the URL the iframe was pointed at (codesurf-ext://<extId>). A frame can
// self-navigate to a remote origin while keeping its contentWindow, so
// matching event.source alone never proves the sender is still the surface.
function expectedIframeOrigin(iframe: HTMLIFrameElement | null | undefined): string | null {
  try {
    return iframe?.src ? new URL(iframe.src).origin : null
  } catch {
    return null
  }
}

export function useChatTileSurfaces(options: {
  tileId: string
  workspaceId: string
  workspaceDir: string
  openChatSurfaces: ActiveChatSurface[]
  setOpenChatSurfaces: React.Dispatch<React.SetStateAction<ActiveChatSurface[]>>
  activeChatSurfaceId: string | null
  setActiveChatSurfaceId: React.Dispatch<React.SetStateAction<string | null>>
  setShowInsertMenu: (value: boolean) => void
  chatSurfaceThemeColors: Record<string, string>
  chatSurfaceThemeVars: Record<string, string>
}) {
  const {
    tileId,
    workspaceId,
    workspaceDir,
    openChatSurfaces,
    setOpenChatSurfaces,
    activeChatSurfaceId,
    setActiveChatSurfaceId,
    setShowInsertMenu,
    chatSurfaceThemeColors,
    chatSurfaceThemeVars,
  } = options

  const [chatSurfaceMenu, setChatSurfaceMenu] = useState<ChatSurfaceMenuEntry[]>([])
  const openChatSurfacesRef = useRef<ActiveChatSurface[]>([])
  useEffect(() => { openChatSurfacesRef.current = openChatSurfaces }, [openChatSurfaces])

  const activeChatSurface = useMemo(
    () => openChatSurfaces.find(surface => surface.instanceId === activeChatSurfaceId) ?? openChatSurfaces[openChatSurfaces.length - 1] ?? null,
    [activeChatSurfaceId, openChatSurfaces],
  )
  const activeChatSurfaceRef = useRef<ActiveChatSurface | null>(null)
  useEffect(() => { activeChatSurfaceRef.current = activeChatSurface }, [activeChatSurface])

  const chatSurfaceIframeRefs = useRef<Record<string, HTMLIFrameElement | null>>({})
  const pendingChatSurfaceActionResultsRef = useRef(new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>())

  const setChatSurfaceIframeRef = useCallback((instanceId: string, node: HTMLIFrameElement | null) => {
    if (node) chatSurfaceIframeRefs.current[instanceId] = node
    else delete chatSurfaceIframeRefs.current[instanceId]
  }, [])

  const getChatSurfaceIframe = useCallback((instanceId: string): HTMLIFrameElement | null => (
    chatSurfaceIframeRefs.current[instanceId] ?? null
  ), [])

  const postToChatSurface = useCallback((instanceId: string, payload: Record<string, unknown>) => {
    const iframe = getChatSurfaceIframe(instanceId)
    const targetOrigin = expectedIframeOrigin(iframe)
    // Fail closed: without a known surface origin, don't broadcast.
    if (!iframe?.contentWindow || !targetOrigin) return
    iframe.contentWindow.postMessage(payload, targetOrigin)
  }, [getChatSurfaceIframe])

  const getChatSurfacePeerEntries = useCallback((surfaceId: string) => (
    openChatSurfacesRef.current
      .filter(surface => surface.instanceId !== surfaceId)
      .map(surface => ({
        peerId: surface.instanceId,
        label: surface.label,
        contextEntries: Object.entries(surface.context ?? {}).map(([key, value]) => ({ key, value })),
      }))
  ), [])

  useEffect(() => {
    if (openChatSurfaces.length === 0) {
      if (activeChatSurfaceId !== null) setActiveChatSurfaceId(null)
      return
    }
    if (!openChatSurfaces.some(surface => surface.instanceId === activeChatSurfaceId)) {
      setActiveChatSurfaceId(openChatSurfaces[openChatSurfaces.length - 1]?.instanceId ?? null)
    }
  }, [activeChatSurfaceId, openChatSurfaces, setActiveChatSurfaceId])

  useEffect(() => {
    let cancelled = false
    const extensionsApi = (window.electron as unknown as { extensions?: { listChatSurfaces?: () => Promise<ChatSurfaceMenuEntry[] & Array<any>> } })?.extensions
    const fetchMenu = () => {
      if (!extensionsApi?.listChatSurfaces) {
        setChatSurfaceMenu([])
        return
      }
      extensionsApi.listChatSurfaces().then((entries: any[]) => {
        if (cancelled) return
        setChatSurfaceMenu((entries ?? []).map(normalizeChatSurfaceMenuEntry))
      }).catch(() => { if (!cancelled) setChatSurfaceMenu([]) })
    }
    fetchMenu()
    const onChanged = () => fetchMenu()
    window.addEventListener('codesurf:extensions-changed', onChanged)
    return () => {
      cancelled = true
      window.removeEventListener('codesurf:extensions-changed', onChanged)
    }
  }, [])

  const openChatSurface = useCallback(async (entry: ChatSurfaceMenuEntry, opts: { initialContext?: Record<string, unknown> } = {}) => {
    setShowInsertMenu(false)
    const initialContext = opts.initialContext && typeof opts.initialContext === 'object' && !Array.isArray(opts.initialContext)
      ? opts.initialContext
      : undefined
    const existing = openChatSurfacesRef.current.find(surface => surface.extId === entry.extId && surface.surfaceId === entry.surfaceId)
    if (existing) {
      if (initialContext && Object.keys(initialContext).length > 0) {
        setOpenChatSurfaces(prev => prev.map(surface => surface.instanceId === existing.instanceId
          ? { ...surface, context: { ...surface.context, ...initialContext } }
          : surface))
        for (const [key, value] of Object.entries(initialContext)) {
          postToChatSurface(existing.instanceId, {
            type: 'codesurf-event',
            event: 'context.changed',
            data: { key, value },
          })
        }
      }
      setActiveChatSurfaceId(existing.instanceId)
      return
    }
    const instanceId = `surf-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
    const extensionsApi = (window.electron as unknown as { extensions?: { chatSurfaceEntry?: (ext: string, id: string, inst: string) => Promise<string | null> } })?.extensions
    const url = extensionsApi?.chatSurfaceEntry
      ? await extensionsApi.chatSurfaceEntry(entry.extId, entry.surfaceId, instanceId).catch(() => null)
      : null
    if (!url) return
    setOpenChatSurfaces(prev => [...prev, {
      extId: entry.extId,
      surfaceId: entry.surfaceId,
      label: entry.label,
      icon: entry.icon,
      instanceId,
      entryUrl: url,
      emits: entry.emits,
      height: Math.max(entry.minHeight, entry.defaultHeight),
      minHeight: entry.minHeight,
      payload: null,
      tileState: {},
      context: initialContext ?? {},
      registeredActions: [],
    }])
    setActiveChatSurfaceId(instanceId)
  }, [postToChatSurface, setActiveChatSurfaceId, setOpenChatSurfaces, setShowInsertMenu])

  const openBuilderFromSketch = useCallback(async () => {
    const builderEntry = chatSurfaceMenu.find(entry => entry.extId === 'builder' || entry.surfaceId === 'builder')
    if (!builderEntry) return
    await openChatSurface(builderEntry)
  }, [chatSurfaceMenu, openChatSurface])

  useEffect(() => {
    const handleOpenChatSurfaceRequest = async (event: Event) => {
      const detail = normalizeOpenChatSurfaceDetail((event as CustomEvent).detail)
      if (!detail || detail.targetTileId !== tileId) return

      let entry = chatSurfaceMenu.find(candidate => candidate.extId === detail.extId && candidate.surfaceId === detail.surfaceId)
      if (!entry) {
        const rawEntries = await window.electron?.extensions?.listChatSurfaces?.().catch(() => [])
        entry = (rawEntries ?? [])
          .map(normalizeChatSurfaceMenuEntry)
          .find(candidate => candidate.extId === detail.extId && candidate.surfaceId === detail.surfaceId)
      }
      if (!entry) return
      await openChatSurface(entry, { initialContext: detail.initialContext })
    }

    window.addEventListener(CODESURF_OPEN_CHAT_SURFACE_EVENT, handleOpenChatSurfaceRequest as EventListener)
    return () => window.removeEventListener(CODESURF_OPEN_CHAT_SURFACE_EVENT, handleOpenChatSurfaceRequest as EventListener)
  }, [chatSurfaceMenu, openChatSurface, tileId])

  const closeChatSurface = useCallback((instanceId?: string) => {
    const targetId = instanceId ?? activeChatSurfaceRef.current?.instanceId
    if (!targetId) return
    postToChatSurface(targetId, { type: 'codesurf-event', event: 'surface.clear', data: {} })
    pendingChatSurfaceActionResultsRef.current.forEach((pending, requestId) => {
      pending.reject(new Error('Chat surface closed'))
      pendingChatSurfaceActionResultsRef.current.delete(requestId)
    })
    setOpenChatSurfaces(prev => prev.filter(surface => surface.instanceId !== targetId))
    setActiveChatSurfaceId(prev => (prev === targetId ? null : prev))
  }, [postToChatSurface, setActiveChatSurfaceId, setOpenChatSurfaces])

  useEffect(() => {
    const handler = async (e: MessageEvent) => {
      const msg = e.data
      if (!msg || typeof msg !== 'object') return
      const sourceWin = e.source as Window | null
      const sourceFrame = Object.values(chatSurfaceIframeRefs.current)
        .find(frame => frame?.contentWindow === sourceWin)
      const sourceIsChatSurface = Boolean(sourceFrame)
      // A surface frame can self-navigate to a remote origin while keeping
      // its contentWindow — only accept messages from the surface's origin.
      if (sourceIsChatSurface) {
        const expectedOrigin = expectedIframeOrigin(sourceFrame)
        if (!expectedOrigin || e.origin !== expectedOrigin) return
      }
      const reply = (result: unknown, error?: string) => {
        sourceWin?.postMessage({ type: 'codesurf-rpc-response', id: msg.id, result: error ? undefined : result, error }, e.origin)
      }

      if (msg.type === 'codesurf-bridge-ready' && typeof msg.tileId === 'string') {
        const surface = openChatSurfacesRef.current.find(candidate => candidate.instanceId === msg.tileId)
        if (!surface) return
        if (getChatSurfaceIframe(surface.instanceId)?.contentWindow !== sourceWin) return
        sourceWin?.postMessage({ type: 'codesurf-theme-vars', vars: chatSurfaceThemeVars }, e.origin)
        for (const [key, value] of Object.entries(surface.context || {})) {
          sourceWin?.postMessage({
            type: 'codesurf-event',
            event: 'context.changed',
            data: { key, value },
          }, e.origin)
        }
        for (const peer of getChatSurfacePeerEntries(surface.instanceId)) {
          for (const entry of peer.contextEntries) {
            sourceWin?.postMessage({
              type: 'codesurf-event',
              event: 'context.peerChanged',
              data: { peerId: peer.peerId, key: entry.key, value: entry.value },
            }, e.origin)
          }
        }
        return
      }

      if (msg.type === 'codesurf-action-result' && typeof msg.requestId === 'string') {
        if (!sourceIsChatSurface) return
        const pending = pendingChatSurfaceActionResultsRef.current.get(msg.requestId)
        if (!pending) return
        pendingChatSurfaceActionResultsRef.current.delete(msg.requestId)
        if (msg.error) pending.reject(new Error(String(msg.error)))
        else pending.resolve(msg.result)
        return
      }

      if (msg.type !== 'codesurf-rpc' || typeof msg.tileId !== 'string') return
      const surface = openChatSurfacesRef.current.find(candidate => candidate.instanceId === msg.tileId)
      if (!surface) return
      if (getChatSurfaceIframe(surface.instanceId)?.contentWindow !== sourceWin) return

      try {
        const basicRpc = await handleBasicChatSurfaceRpc({
          method: String(msg.method ?? ''),
          params: msg.params,
          surface,
          connectedPeerIds: getChatSurfacePeerEntries(surface.instanceId).map(peer => peer.peerId),
          workspaceId,
          workspacePath: workspaceDir,
          themeColors: chatSurfaceThemeColors,
          extensionsApi: {
            invoke: window.electron?.extensions?.invoke,
            getSettings: window.electron?.extensions?.getSettings,
            setSettings: window.electron?.extensions?.setSettings,
          },
          openChatSurface: async (request) => {
            let entry = chatSurfaceMenu.find(candidate => candidate.extId === request.extId && candidate.surfaceId === request.surfaceId)
            if (!entry) {
              const rawEntries = await window.electron?.extensions?.listChatSurfaces?.().catch(() => [])
              entry = (rawEntries ?? [])
                .map(normalizeChatSurfaceMenuEntry)
                .find(candidate => candidate.extId === request.extId && candidate.surfaceId === request.surfaceId)
            }
            if (!entry) throw new Error(`Chat surface ${request.extId}:${request.surfaceId} not found`)
            await openChatSurface(entry, { initialContext: request.initialContext })
            return true
          },
        })
        if (basicRpc.handled) {
          if ('payload' in basicRpc) {
            setOpenChatSurfaces(prev => prev.map(candidate => candidate.instanceId === surface.instanceId
              ? { ...candidate, payload: basicRpc.payload ?? null }
              : candidate))
          }
          reply(basicRpc.result)
          return
        }

        if (msg.method === 'tile.getState') {
          const key = typeof msg.params?.key === 'string' ? msg.params.key : null
          const liveSurface = openChatSurfacesRef.current.find(candidate => candidate.instanceId === surface.instanceId) ?? surface
          const tileState = liveSurface.tileState && typeof liveSurface.tileState === 'object' ? liveSurface.tileState : {}
          reply(key ? tileState[key] ?? null : tileState)
          return
        }

        if (msg.method === 'tile.setState') {
          let nextSurfaceState: Record<string, unknown> = {}
          const nextSurfaces = openChatSurfacesRef.current.map(candidate => {
            if (candidate.instanceId !== surface.instanceId) return candidate
            const currentState = candidate.tileState && typeof candidate.tileState === 'object' ? candidate.tileState : {}
            if (typeof msg.params?.key === 'string') {
              nextSurfaceState = { ...currentState, [msg.params.key]: msg.params.value }
            } else {
              const data = msg.params?.data ?? msg.params ?? {}
              nextSurfaceState = data && typeof data === 'object' && !Array.isArray(data)
                ? { ...(data as Record<string, unknown>) }
                : {}
            }
            return { ...candidate, tileState: nextSurfaceState }
          })
          openChatSurfacesRef.current = nextSurfaces
          setOpenChatSurfaces(nextSurfaces)
          reply(true)
          return
        }

        if (msg.method === 'context.get') {
          const key = String(msg.params?.key ?? '')
          reply(Object.prototype.hasOwnProperty.call(surface.context, key) ? surface.context[key] ?? null : null)
          return
        }

        if (msg.method === 'context.set') {
          const key = String(msg.params?.key ?? '')
          const value = msg.params?.value ?? null
          setOpenChatSurfaces(prev => prev.map(candidate => candidate.instanceId === surface.instanceId
            ? { ...candidate, context: { ...candidate.context, [key]: value } }
            : candidate))
          for (const peer of getChatSurfacePeerEntries(surface.instanceId)) {
            postToChatSurface(peer.peerId, {
              type: 'codesurf-event',
              event: 'context.peerChanged',
              data: { peerId: surface.instanceId, key, value },
            })
          }
          reply(true)
          return
        }

        if (msg.method === 'context.getAll') {
          const tagPrefix = typeof msg.params?.tagPrefix === 'string' ? msg.params.tagPrefix : undefined
          reply(Object.entries(surface.context)
            .filter(([key]) => !tagPrefix || key.startsWith(tagPrefix))
            .map(([key, value]) => ({ key, value })))
          return
        }

        if (msg.method === 'context.delete') {
          const key = String(msg.params?.key ?? '')
          setOpenChatSurfaces(prev => prev.map(candidate => {
            if (candidate.instanceId !== surface.instanceId) return candidate
            const nextContext = { ...candidate.context }
            delete nextContext[key]
            return { ...candidate, context: nextContext }
          }))
          for (const peer of getChatSurfacePeerEntries(surface.instanceId)) {
            postToChatSurface(peer.peerId, {
              type: 'codesurf-event',
              event: 'context.peerChanged',
              data: { peerId: surface.instanceId, key, value: null },
            })
          }
          reply(true)
          return
        }

        if (msg.method === 'context.getPeerContext') {
          const peerId = String(msg.params?.peerId ?? '')
          const peer = openChatSurfacesRef.current.find(candidate => candidate.instanceId === peerId)
          const tagPrefix = typeof msg.params?.tagPrefix === 'string' ? msg.params.tagPrefix : undefined
          reply(peer
            ? Object.entries(peer.context)
              .filter(([key]) => !tagPrefix || key.startsWith(tagPrefix))
              .map(([key, value]) => ({ key, value }))
            : [])
          return
        }

        if (msg.method === 'context.getAllPeerContext') {
          const tagPrefix = typeof msg.params?.tagPrefix === 'string' ? msg.params.tagPrefix : undefined
          const result: Record<string, Array<{ key: string; value: unknown }>> = {}
          for (const peer of getChatSurfacePeerEntries(surface.instanceId)) {
            result[peer.peerId] = peer.contextEntries.filter(entry => !tagPrefix || entry.key.startsWith(tagPrefix))
          }
          reply(result)
          return
        }

        if (msg.method === 'actions.register') {
          const name = String(msg.params?.name ?? '')
          const description = String(msg.params?.description ?? '')
          if (!name) throw new Error('Missing action name')
          setOpenChatSurfaces(prev => prev.map(candidate => candidate.instanceId === surface.instanceId
            ? {
              ...candidate,
              registeredActions: [
                ...candidate.registeredActions.filter(action => action.name !== name),
                { name, description },
              ],
            }
            : candidate))
          reply(true)
          return
        }

        if (msg.method === 'actions.invoke') {
          const peerId = String(msg.params?.peerId ?? '')
          const action = String(msg.params?.action ?? '')
          const peer = openChatSurfacesRef.current.find(candidate => candidate.instanceId === peerId)
          if (!peerId || !action || !peer) throw new Error('Missing peerId or action')
          if (!peer.registeredActions.some(candidate => candidate.name === action)) {
            throw new Error(`Peer ${peer.label} has not registered action ${action}`)
          }
          const requestId = `${surface.instanceId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
          const result = await new Promise<unknown>((resolve, reject) => {
            pendingChatSurfaceActionResultsRef.current.set(requestId, { resolve, reject })
            postToChatSurface(peer.instanceId, {
              type: 'codesurf-action-invoke',
              action,
              params: msg.params?.params ?? {},
              requestId,
            })
            window.setTimeout(() => {
              const pending = pendingChatSurfaceActionResultsRef.current.get(requestId)
              if (!pending) return
              pendingChatSurfaceActionResultsRef.current.delete(requestId)
              reject(new Error(`Timed out waiting for ${peer.label}.${action}`))
            }, 10000)
          })
          reply(result)
          return
        }

        throw new Error(`Unsupported chat surface RPC method: ${String(msg.method ?? '')}`)
      } catch (error) {
        reply(null, error instanceof Error ? error.message : String(error))
      }
    }

    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [chatSurfaceMenu, chatSurfaceThemeColors, chatSurfaceThemeVars, getChatSurfaceIframe, getChatSurfacePeerEntries, openChatSurface, postToChatSurface, setOpenChatSurfaces, workspaceDir, workspaceId])

  return {
    chatSurfaceMenu,
    activeChatSurface,
    activeChatSurfaceRef,
    openChatSurfacesRef,
    setChatSurfaceIframeRef,
    getChatSurfaceIframe,
    postToChatSurface,
    openChatSurface,
    openBuilderFromSketch,
    closeChatSurface,
  }
}