import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  attachBridgeHost,
  PROTOCOL_VERSION,
  type BridgeHostHandle,
  type ChannelStarter,
  type MethodHandler,
  type RequestMethod,
} from '@codesurf/chat-bridge'
import type { AppSettings } from '../../../shared/types'
import { scopeChatWebviewParams } from './chatWebviewScope'
import { useTheme } from '../ThemeContext'

interface DiscoveryPeer {
  peerId: string
  peerType: string
  capabilities: string[]
  distance: number
  lastSeen: number
  actions?: Array<{ name: string; description: string }>
  filePath?: string
  label?: string
}

interface Props {
  tileId: string
  workspaceId: string
  workspaceDir: string
  width: number
  height: number
  reloadToken?: number
  settings?: AppSettings
  onChatModePreferenceChange?: (providerId: string, modeId: string) => void
  isConnected?: boolean
  isAutoConnected?: boolean
  connectedPeers?: DiscoveryPeer[]
}

/**
 * Webview-based mount of the standalone apps/chat-app/ bundle.
 *
 * In dev mode the chat-app is served by its own Vite dev server at
 * http://localhost:5174 (hot reload independent of the host). In prod
 * we serve the static dist/ via a custom URL the build pipeline wires
 * up later. For initial smoke testing we read the dev URL from a
 * settings flag — falls back to localhost:5174.
 *
 * The wrapper is intentionally thin: it builds the host-side bridge
 * adapter that maps `window.electron.*` IPC into the bridge protocol
 * and pushes context whenever Props change. Same wrapper pattern can
 * be re-implemented in Swift WKWebView for muxy.
 */
export function ChatTileWebview(props: Props): React.ReactNode {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const handleRef = useRef<BridgeHostHandle | null>(null)
  const [bridgeReady, setBridgeReady] = useState(false)
  const theme = useTheme()

  const chatAppUrl = useMemo(() => {
    // Resolve in this order:
    //   1) explicit override on AppSettings (developer setting)
    //   2) Vite-style env if available (renderer dev mode)
    //   3) default to localhost:5174 (chat-app `npm run dev`)
    const override = (props.settings as { chatAppUrl?: string } | undefined)?.chatAppUrl
    if (override) return override
    return 'http://localhost:5174/'
  }, [props.settings])

  // Methods table — every host-implemented call. Each handler routes
  // a single method to the matching window.electron.* IPC. Keeping this
  // map explicit so it's obvious what's wired vs unwired during the
  // V1 → V2 port; everything missing returns "Unsupported method" until
  // ported.
  const methods = useMemo<Partial<Record<RequestMethod, MethodHandler>>>(() => {
    const e = window.electron as any
    const scopedChatParams = (params: unknown): Record<string, unknown> =>
      scopeChatWebviewParams(params, props.workspaceId, props.tileId)
    return {
      'chat.send': (params) => e?.chat?.send?.(scopedChatParams(params)),
      'chat.steer': (params) => e?.chat?.steer?.(scopedChatParams(params)),
      'chat.stop': (params) => {
        const scoped = scopedChatParams(params)
        return e?.chat?.stop?.(scoped.workspaceId, scoped.cardId)
      },
      'chat.clearSession': (params) => {
        const scoped = scopedChatParams(params)
        return e?.chat?.clearSession?.(scoped.workspaceId, scoped.cardId)
      },
      'chat.setPermissionMode': (params) =>
        e?.chat?.setPermissionMode?.(scopedChatParams(params)),
      'chat.resumeJob': (params) => e?.chat?.resumeJob?.(scopedChatParams(params)),
      'chat.loadSessionHistory': (params) =>
        e?.chat?.loadSessionHistory?.(scopedChatParams(params)),
      'chat.opencodeModels': () => e?.chat?.opencodeModels?.(),
      'chat.openclawAgents': () => e?.chat?.openclawAgents?.(),
      'chat.answerToolPermission': (params) =>
        e?.chat?.answerToolPermission?.(scopedChatParams(params)),
      'chat.answerUserQuestion': (params) =>
        e?.chat?.answerUserQuestion?.(scopedChatParams(params)),
      'chat.selectFiles': () => e?.chat?.selectFiles?.(),
      'canvas.saveTileState': (params: any) => e?.canvas?.saveTileState?.(params?.workspaceId, params?.tileId, params?.state),
      'canvas.loadTileState': (params: any) => e?.canvas?.loadTileState?.(params?.workspaceId, params?.tileId),
      'canvas.getSessionState': (params: any) => e?.canvas?.getSessionState?.(params?.workspaceId, params?.sessionEntryId, params?.options),
      'canvas.restoreCheckpoint': (params: any) => e?.canvas?.restoreCheckpoint?.(params?.workspaceId, params?.checkpointId, params?.sessionEntryId),
      'fs.readDir': (params) => e?.fs?.readDir?.(params),
      'fs.readFile': (params) => e?.fs?.readFile?.(params),
      'git.status': (params) => e?.git?.status?.(params),
      'git.branches': (params) => e?.git?.branches?.(params),
      'git.checkoutBranch': (params: any) => e?.git?.checkoutBranch?.(params?.workspaceDir, params?.branch),
      'git.createBranch': (params: any) => e?.git?.createBranch?.(params?.workspaceDir, params?.branch),
      'execution.listHosts': () => e?.execution?.listHosts?.(),
      'execution.resolveTarget': (params) => e?.execution?.resolveTarget?.(params),
      'workspace.openFolder': () => e?.workspace?.openFolder?.(),
      'workspace.addProjectFolder': (params: any) => e?.workspace?.addProjectFolder?.(params?.workspaceId, params?.path),
      'extensions.invoke': (params) => e?.extensions?.invoke?.(params),
      'extensions.getSettings': (params) => e?.extensions?.getSettings?.(params),
      'extensions.setSettings': (params) => e?.extensions?.setSettings?.(params),
      'system.daemonSummary': () => e?.system?.daemonSummary?.(),
      'tileContext.getAll': (params: any) => e?.tileContext?.getAll?.(params?.workspaceId, params?.peerId, params?.prefix),
      'transcribe.run': (params) => e?.transcribe?.run?.(params),
      'window.openMiniChat': (params) => e?.window?.openMiniChat?.(params),
      'bus.publish': (params: any) => e?.bus?.publish?.(params?.channel, params?.eventType, params?.source, params?.payload),
    }
  }, [props.tileId, props.workspaceId])

  // Channel patterns. The bridge invokes the matching starter when the
  // chat-app subscribes to a runtime channel like `stream:tile-abc`.
  // Starter returns an unsubscribe disposer that runs when chat-app
  // unsubscribes (or when the bridge tears down on unmount).
  const channels = useMemo<Record<string, ChannelStarter>>(() => {
    const e = window.electron as any
    return {
      'stream:*': (push) => {
        if (!e?.stream?.onChunk) return
        return e.stream.onChunk((chunk: unknown) => push(chunk))
      },
      'bus:*:*': (push) => {
        // Channel name format: bus:${channel}:${subscriberId}
        // We can't recover those from the pattern starter signature
        // alone, so the bridge would need to pass channel name through.
        // Deferred until first bus consumer ports.
        return () => { void push }
      },
    }
  }, [])

  // Build the BridgeContext payload from props + theme tokens. Pushed
  // both on initial bridge attach and whenever any field changes.
  const contextPayload = useMemo(() => {
    const themeVars: Record<string, string> = {}
    // Map a small set of theme tokens to CSS variables the chat-app
    // already reads. Expand as more get used.
    const t = theme as unknown as {
      chat?: { background?: string; text?: string; muted?: string }
      surface?: { panel?: string }
      accent?: { base?: string }
      border?: { default?: string }
    }
    if (t?.chat?.background) themeVars['--color-background'] = t.chat.background
    if (t?.chat?.text) themeVars['--color-foreground'] = t.chat.text
    if (t?.chat?.muted) themeVars['--color-muted-foreground'] = t.chat.muted
    if (t?.surface?.panel) themeVars['--color-card'] = t.surface.panel
    if (t?.accent?.base) themeVars['--color-primary'] = t.accent.base
    if (t?.border?.default) themeVars['--color-border'] = t.border.default
    return {
      tileId: props.tileId,
      workspaceId: props.workspaceId,
      workspaceDir: props.workspaceDir,
      width: props.width,
      height: props.height,
      reloadToken: props.reloadToken ?? 0,
      isConnected: props.isConnected,
      isAutoConnected: props.isAutoConnected,
      connectedPeers: props.connectedPeers,
      settings: props.settings as unknown,
      theme: themeVars,
      fonts: {} as Record<string, string | number>,
    }
  }, [props, theme])

  // Attach bridge once iframe is mounted.
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    const handle = attachBridgeHost({
      iframe,
      methods,
      channels,
      context: contextPayload,
      onReady: () => setBridgeReady(true),
    })
    handleRef.current = handle
    return () => {
      handle.dispose()
      handleRef.current = null
      setBridgeReady(false)
    }
    // Methods/channels are stable refs (built from window.electron once);
    // only re-attach if iframe changes, which it doesn't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [methods, channels])

  // Push updated context whenever props or theme change.
  useEffect(() => {
    handleRef.current?.pushContext(contextPayload)
  }, [contextPayload])

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        background: theme.chat?.background ?? '#1e1e1e',
        overflow: 'hidden',
      }}
    >
      <iframe
        ref={iframeRef}
        title={`chat-${props.tileId}`}
        src={chatAppUrl}
        // Sandbox flags: scripts + same-origin enable React + postMessage
        // round-trips. forms/popups left off until needed. The chat-app
        // is OUR code, so origin trust is delegated to network/load source.
        sandbox="allow-scripts allow-same-origin allow-forms"
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          background: 'transparent',
        }}
      />
      {!bridgeReady && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: theme.chat?.muted ?? '#888',
            fontSize: 12,
            fontFamily: 'var(--cs-font-primary, inherit)',
            background: theme.chat?.background ?? '#1e1e1e',
          }}
        >
          Connecting chat… <span style={{ marginLeft: 6, fontFamily: 'monospace' }}>v{PROTOCOL_VERSION}</span>
        </div>
      )}
    </div>
  )
}
