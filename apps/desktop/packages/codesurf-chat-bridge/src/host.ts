// Host side of the bridge. Used by whatever embeds the chat-app
// iframe — Electron renderer, Swift WKWebView wrapper, daemon HTTP
// page. The host registers method handlers + channel subscribers
// and feeds events back into the iframe.
//
// This file is host-agnostic. The Electron-specific adapter lives
// in src/renderer/src/components/ChatTileWebview.tsx and uses these
// primitives to wire window.electron.* IPC into the bridge.

import {
  type BridgeContext,
  type BridgeMessage,
  type ChannelName,
  PROTOCOL_VERSION,
  type RequestMethod,
  isNamespacedBridgeMessage,
  withNamespace,
} from './protocol'

export type MethodHandler = (params: unknown) => unknown | Promise<unknown>
export type ChannelStarter = (push: (payload: unknown) => void) => (() => void) | void
type Disposer = () => void

export interface BridgeHostOptions {
  iframe: HTMLIFrameElement
  methods: Partial<Record<RequestMethod, MethodHandler>>
  channels: Partial<Record<string, ChannelStarter>>
  /** Initial context to push on `ready`. Can also call pushContext later. */
  context: Omit<BridgeContext, 'kind' | 'protocolVersion'>
  /** Called after the iframe sends `ready`. */
  onReady?: () => void
}

export interface BridgeHostHandle {
  dispose: () => void
  pushContext: (next: Omit<BridgeContext, 'kind' | 'protocolVersion'>) => void
  pushEvent: (channel: ChannelName, payload: unknown) => void
}

/**
 * Channel-name pattern matcher. The host registers handlers for
 * pattern keys (e.g. `stream:*`, `bus:*:*`); the bridge resolves
 * which pattern a runtime channel like `stream:tile-abc` belongs to.
 */
function matchPattern(channel: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (pattern === channel) return pattern
    if (!pattern.includes('*')) continue
    const re = new RegExp('^' + pattern.split('*').map(escapeRegex).join('[^:]+') + '$')
    if (re.test(channel)) return pattern
  }
  return null
}
function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

export function attachBridgeHost(options: BridgeHostOptions): BridgeHostHandle {
  const { iframe, methods, channels, context, onReady } = options
  let currentContext: BridgeContext = {
    kind: 'context',
    protocolVersion: PROTOCOL_VERSION,
    ...context,
  }
  const channelDisposers = new Map<ChannelName, Disposer | void>()
  const patternKeys = Object.keys(channels)

  // The only origin trusted to use the bridge: the origin of the URL the
  // iframe was pointed at. The frame can self-navigate (or be navigated by a
  // hijacked local port) to another origin while keeping its contentWindow,
  // so event.source alone never proves the sender is still the chat app.
  function expectedIframeOrigin(): string | null {
    try {
      return iframe.src ? new URL(iframe.src).origin : null
    } catch {
      return null
    }
  }

  function postToIframe(message: BridgeMessage): void {
    const win = iframe.contentWindow
    const targetOrigin = expectedIframeOrigin()
    // Fail closed: without a known frame origin, don't broadcast.
    if (!win || !targetOrigin) return
    win.postMessage(withNamespace(message), targetOrigin)
  }

  async function handleRequest(id: string, method: RequestMethod, params: unknown): Promise<void> {
    const handler = methods[method]
    if (!handler) {
      postToIframe({ kind: 'response', id, ok: false, error: `Unsupported method: ${method}` })
      return
    }
    try {
      const value = await handler(params)
      postToIframe({ kind: 'response', id, ok: true, value })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      postToIframe({ kind: 'response', id, ok: false, error })
    }
  }

  function startChannel(channel: ChannelName): void {
    if (channelDisposers.has(channel)) return
    const matched = matchPattern(channel, patternKeys)
    if (!matched) return
    const starter = channels[matched]
    if (!starter) return
    const push = (payload: unknown) => postToIframe({ kind: 'event', channel, payload })
    const dispose = starter(push)
    channelDisposers.set(channel, dispose)
  }

  function stopChannel(channel: ChannelName): void {
    const dispose = channelDisposers.get(channel)
    if (typeof dispose === 'function') {
      try { dispose() } catch { /* swallow */ }
    }
    channelDisposers.delete(channel)
  }

  function listener(event: MessageEvent): void {
    if (event.source !== iframe.contentWindow) return
    const expectedOrigin = expectedIframeOrigin()
    if (!expectedOrigin || event.origin !== expectedOrigin) return
    const data = event.data
    if (!isNamespacedBridgeMessage(data)) return
    const message = data as BridgeMessage

    if (message.kind === 'ready') {
      postToIframe(currentContext)
      onReady?.()
      return
    }
    if (message.kind === 'request') {
      void handleRequest(message.id, message.method, message.params)
      return
    }
    if (message.kind === 'subscribe') {
      startChannel(message.channel)
      return
    }
    if (message.kind === 'unsubscribe') {
      stopChannel(message.channel)
      return
    }
  }

  window.addEventListener('message', listener)

  return {
    dispose() {
      window.removeEventListener('message', listener)
      for (const channel of [...channelDisposers.keys()]) stopChannel(channel)
    },
    pushContext(next) {
      currentContext = {
        kind: 'context',
        protocolVersion: PROTOCOL_VERSION,
        ...next,
      }
      postToIframe(currentContext)
    },
    pushEvent(channel, payload) {
      postToIframe({ kind: 'event', channel, payload })
    },
  }
}
