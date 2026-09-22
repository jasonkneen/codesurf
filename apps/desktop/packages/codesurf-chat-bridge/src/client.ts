// Chat-app side of the bridge. Used INSIDE the iframe.
//
// Talks to the host via window.parent.postMessage. Provides an
// async request/response API plus channel subscriptions for streams.
// The host is whatever embedded the iframe — Electron renderer,
// Swift WKWebView, daemon HTTP page, etc. The chat-app must NOT
// import any host-specific globals (no window.electron, no IPC, no
// Node APIs). This file is the only window onto the host.

import {
  BRIDGE_NAMESPACE,
  type BridgeContext,
  type BridgeMessage,
  type ChannelName,
  PROTOCOL_VERSION,
  type RequestMethod,
  isNamespacedBridgeMessage,
  withNamespace,
} from './protocol'

type AnyHandler = (payload: unknown) => void
type ContextHandler = (ctx: BridgeContext) => void

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

let nextRequestId = 0
const pending = new Map<string, PendingRequest>()
const channelHandlers = new Map<ChannelName, Set<AnyHandler>>()
const contextHandlers = new Set<ContextHandler>()
let latestContext: BridgeContext | null = null
let installed = false

function postToHost(message: BridgeMessage): void {
  if (typeof window === 'undefined' || !window.parent || window.parent === window) {
    // No host — common in standalone dev (chat-app served outside any
    // wrapping page). Calls silently no-op so dev preview still loads.
    return
  }
  // `*` target is intentional: the iframe doesn't know which origin the
  // host was loaded from (file://, http://, contex://, swift custom).
  // Authentication is by namespace + protocol version, not origin.
  window.parent.postMessage(withNamespace(message), '*')
}

function ensureInstalled(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('message', (event) => {
    const data = event.data
    if (!isNamespacedBridgeMessage(data)) return
    const message = data as BridgeMessage

    if (message.kind === 'response') {
      const handler = pending.get(message.id)
      if (!handler) return
      pending.delete(message.id)
      if (message.ok) handler.resolve(message.value)
      else handler.reject(new Error(message.error))
      return
    }

    if (message.kind === 'event') {
      const handlers = channelHandlers.get(message.channel)
      if (!handlers) return
      for (const handler of handlers) {
        try { handler(message.payload) } catch { /* swallow */ }
      }
      return
    }

    if (message.kind === 'context') {
      latestContext = message
      for (const handler of contextHandlers) {
        try { handler(message) } catch { /* swallow */ }
      }
      return
    }
  })
  // Tell the host we're alive and ready for the first context push.
  postToHost({ kind: 'ready', protocolVersion: PROTOCOL_VERSION })
}

export function callHost<T = unknown>(method: RequestMethod, params?: unknown, timeoutMs = 30_000): Promise<T> {
  ensureInstalled()
  const id = `req-${++nextRequestId}-${Date.now()}`
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      reject(new Error(`Bridge call ${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value as T) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    postToHost({ kind: 'request', id, method, params })
  })
}

export function subscribe(channel: ChannelName, handler: AnyHandler): () => void {
  ensureInstalled()
  let handlers = channelHandlers.get(channel)
  if (!handlers) {
    handlers = new Set()
    channelHandlers.set(channel, handlers)
    postToHost({ kind: 'subscribe', channel })
  }
  handlers.add(handler)
  return () => {
    const set = channelHandlers.get(channel)
    if (!set) return
    set.delete(handler)
    if (set.size === 0) {
      channelHandlers.delete(channel)
      postToHost({ kind: 'unsubscribe', channel })
    }
  }
}

export function onContext(handler: ContextHandler): () => void {
  ensureInstalled()
  contextHandlers.add(handler)
  if (latestContext) {
    try { handler(latestContext) } catch { /* swallow */ }
  }
  return () => { contextHandlers.delete(handler) }
}

export function getLatestContext(): BridgeContext | null {
  return latestContext
}

export function publishToBus(channel: string, eventType: string, source: string, payload: unknown): Promise<void> {
  return callHost<void>('bus.publish', { channel, eventType, source, payload })
}

export { BRIDGE_NAMESPACE, PROTOCOL_VERSION }
