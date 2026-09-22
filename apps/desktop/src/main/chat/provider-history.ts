import type { StreamEvent } from '../agent-stream.ts'
import { MAX_PROVIDER_DIAGNOSTIC_BYTES } from './bounded-output.ts'
import type { ChatMessage } from './types.ts'
import { utf8Bytes, utf8Prefix } from './peer-context-serialization.ts'

export const LOCAL_PROXY_HISTORY_LIMITS = Object.freeze({
  maxItems: 48,
  maxItemBytes: 8 * 1024,
  maxAggregateBytes: 64 * 1024,
} as const)

const ITEM_TRUNCATED = '\n[Provider history item truncated at host byte limit.]'
const HISTORY_TRUNCATED = '[Provider history truncated by host count or byte limits.]'
export const LOCAL_PROXY_STREAM_TRUNCATED = '[Provider output truncated at host byte limit.]'
export const LOCAL_PROXY_DIAGNOSTIC_TRUNCATED = '\n[Proxy error body truncated at host byte limit.]'

export function boundLocalProxyDiagnostic(value: unknown): string {
  const text = String(value ?? '').trim()
  if (utf8Bytes(text) <= MAX_PROVIDER_DIAGNOSTIC_BYTES) return text
  const markerBytes = utf8Bytes(LOCAL_PROXY_DIAGNOSTIC_TRUNCATED)
  return `${utf8Prefix(text, MAX_PROVIDER_DIAGNOSTIC_BYTES - markerBytes)}${LOCAL_PROXY_DIAGNOSTIC_TRUNCATED}`
}

export interface BoundedLocalProxyMessages {
  messages: ChatMessage[]
  truncated: boolean
  omittedItems: number
  aggregateBytes: number
}

function boundMessageContent(content: string, maxBytes: number): string {
  if (utf8Bytes(content) <= maxBytes) return content
  const markerBytes = utf8Bytes(ITEM_TRUNCATED)
  if (markerBytes >= maxBytes) return utf8Prefix(ITEM_TRUNCATED, maxBytes)
  return `${utf8Prefix(content, maxBytes - markerBytes)}${ITEM_TRUNCATED}`
}

function normalizedMessage(value: ChatMessage): ChatMessage {
  // Conversation history is renderer supplied. Only actual assistant turns
  // retain a provider role; renderer-authored `system` notices are untrusted
  // user data and must not become a second privileged system channel.
  const role = value?.role === 'assistant' ? 'assistant' : 'user'
  return {
    role,
    content: boundMessageContent(String(value?.content ?? ''), LOCAL_PROXY_HISTORY_LIMITS.maxItemBytes),
  }
}

function serializedBytes(messages: ChatMessage[]): number {
  return utf8Bytes(JSON.stringify(messages))
}

/**
 * Retain the newest conversation turns while always preserving the latest user
 * turn. Every item and the complete serialized provider payload are bounded.
 */
export function boundLocalProxyMessages(input: readonly ChatMessage[]): BoundedLocalProxyMessages {
  const source = Array.isArray(input) ? input : []
  let latestUserIndex = -1
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (source[index]?.role === 'user') {
      latestUserIndex = index
      break
    }
  }

  const selected = new Set<number>()
  if (latestUserIndex >= 0) selected.add(latestUserIndex)
  for (let index = source.length - 1; index >= 0 && selected.size < LOCAL_PROXY_HISTORY_LIMITS.maxItems; index -= 1) {
    selected.add(index)
  }

  const indexed = [...selected]
    .sort((left, right) => left - right)
    .map(index => ({ index, message: normalizedMessage(source[index]) }))

  while (serializedBytes(indexed.map(entry => entry.message)) > LOCAL_PROXY_HISTORY_LIMITS.maxAggregateBytes) {
    const removableIndex = indexed.findIndex(entry => entry.index !== latestUserIndex)
    if (removableIndex < 0) break
    indexed.splice(removableIndex, 1)
  }

  let omittedItems = Math.max(0, source.length - indexed.length)
  let truncated = omittedItems > 0 || indexed.some(entry => (
    utf8Bytes(String(source[entry.index]?.content ?? '')) > LOCAL_PROXY_HISTORY_LIMITS.maxItemBytes
  ))

  if (omittedItems > 0 && indexed.length > 0) {
    const first = indexed[0]
    first.message = {
      ...first.message,
      content: boundMessageContent(
        `${HISTORY_TRUNCATED}\n${first.message.content}`,
        LOCAL_PROXY_HISTORY_LIMITS.maxItemBytes,
      ),
    }
    while (serializedBytes(indexed.map(entry => entry.message)) > LOCAL_PROXY_HISTORY_LIMITS.maxAggregateBytes) {
      const removableIndex = indexed.findIndex(entry => entry.index !== latestUserIndex && entry !== first)
      if (removableIndex < 0) {
        first.message = {
          ...first.message,
          content: boundMessageContent(HISTORY_TRUNCATED, LOCAL_PROXY_HISTORY_LIMITS.maxItemBytes),
        }
        break
      }
      indexed.splice(removableIndex, 1)
      omittedItems += 1
    }
  }

  const messages = indexed.map(entry => entry.message)
  const aggregateBytes = serializedBytes(messages)
  if (aggregateBytes > LOCAL_PROXY_HISTORY_LIMITS.maxAggregateBytes) {
    // Constants guarantee one maximally bounded item fits; keep the explicit
    // guard fail closed if those constants are changed independently later.
    throw new Error('Bounded local proxy history exceeds aggregate byte limit')
  }

  truncated ||= omittedItems > 0
  return { messages, truncated, omittedItems, aggregateBytes }
}

function eventText(event: StreamEvent): { field: 'text' | 'error' | 'toolName', value: string } | null {
  if (event.type === 'error') return { field: 'error', value: String(event.error ?? '') }
  if (event.type === 'tool_use') return { field: 'toolName', value: String(event.toolName ?? '') }
  if (event.type === 'text' || event.type === 'thinking') return { field: 'text', value: String(event.text ?? '') }
  return null
}

/** Bounds all model-controlled text emitted by a local proxy stream. */
export class LocalProxyStreamBudget {
  private usedBytes = 0
  private didExhaust = false
  private markerSent = false
  private readonly maxBytes: number

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
  }

  accept(event: StreamEvent): StreamEvent[] {
    if (this.didExhaust) return event.type === 'done' ? [event] : []
    const text = eventText(event)
    if (!text) return [event]
    const valueBytes = utf8Bytes(text.value)
    const markerBudget = Math.min(this.maxBytes, utf8Bytes(LOCAL_PROXY_STREAM_TRUNCATED))
    const contentLimit = Math.max(0, this.maxBytes - markerBudget)
    const contentRemaining = Math.max(0, contentLimit - this.usedBytes)
    if (valueBytes <= contentRemaining) {
      this.usedBytes += valueBytes
      return [event]
    }

    this.didExhaust = true
    const marker = this.markerSent ? '' : LOCAL_PROXY_STREAM_TRUNCATED
    this.markerSent = true
    const boundedBody = utf8Prefix(text.value, contentRemaining)
    const remaining = Math.max(0, this.maxBytes - this.usedBytes - utf8Bytes(boundedBody))
    const boundedMarker = utf8Prefix(marker, remaining)
    this.usedBytes += utf8Bytes(boundedBody) + utf8Bytes(boundedMarker)
    const value = `${boundedBody}${boundedMarker}`
    if (!value) return []
    return [{ ...event, [text.field]: value }]
  }

  get exhausted(): boolean {
    return this.didExhaust
  }
}
