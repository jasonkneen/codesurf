/**
 * Translate Pi AgentSessionEvent payloads into CodeSurf agent:stream events.
 *
 * Isolated from the runtime loader so the mapping can be tested without
 * resolving @mariozechner/pi-coding-agent.
 */

export type PiStreamEvent = Record<string, unknown>

export interface PiTranslateAssistantEvent {
  type: string
  delta?: string
  content?: string
  contentIndex?: number
  toolCall?: {
    id?: string
    name?: string
    arguments?: unknown
  }
  error?: {
    errorMessage?: string
  }
}

export interface PiTranslateContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: unknown
  input?: unknown
}

export interface PiTranslateMessage {
  role?: string
  content?: PiTranslateContentBlock[]
  stopReason?: string
  errorMessage?: string
}

export interface PiTranslateToolResult {
  toolCallId?: string
  toolName?: string
  result?: unknown
  output?: unknown
  isError?: boolean
}

export interface PiTranslateEvent {
  type: string
  assistantMessageEvent?: PiTranslateAssistantEvent
  message?: PiTranslateMessage
  toolResults?: PiTranslateToolResult[]
  toolCallId?: string
  toolName?: string
  args?: unknown
  result?: unknown
  isError?: boolean
}

export interface PiTranslateState {
  streamedTextByIndex: Map<number, string>
  streamedThinkingByIndex: Map<number, string>
  seenToolIds: Set<string>
  errorEmitted: boolean
}

export function createPiTranslateState(): PiTranslateState {
  return {
    streamedTextByIndex: new Map(),
    streamedThinkingByIndex: new Map(),
    seenToolIds: new Set(),
    errorEmitted: false,
  }
}

/** Text the snapshot still owes after stream deltas (same contract as Claude/Hermes). */
export function remainingPiSnapshotText(incoming: string, accumulated: string): string {
  if (!incoming) return ''
  if (!accumulated) return incoming
  if (incoming === accumulated || accumulated.endsWith(incoming)) return ''
  if (incoming.startsWith(accumulated)) return incoming.slice(accumulated.length)
  if (accumulated.startsWith(incoming)) return ''
  return ''
}

function consumeSnapshot(map: Map<number, string>, index: number, incoming: string): string {
  const prev = map.get(index) ?? ''
  const tail = remainingPiSnapshotText(incoming, prev)
  if (incoming.startsWith(prev) && incoming.length >= prev.length) {
    map.set(index, incoming)
  } else if (tail) {
    map.set(index, prev + tail)
  }
  return tail
}

function appendDelta(map: Map<number, string>, index: number, delta: string): string {
  if (!delta) return ''
  map.set(index, (map.get(index) ?? '') + delta)
  return delta
}

function indexOf(event: PiTranslateAssistantEvent): number {
  return typeof event.contentIndex === 'number' ? event.contentIndex : 0
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return String(value ?? '')
  }
}

function summarizeToolResult(isError: boolean | undefined, value: unknown): string {
  if (isError) {
    return `Error: ${typeof value === 'string' ? value : safeJson(value)}`
  }
  if (typeof value === 'string') return value.slice(0, 500)
  return safeJson(value).slice(0, 500)
}

function formatPiError(message: string): string {
  const trimmed = message.trim()
  if (!trimmed) return 'Pi assistant turn failed.'
  if (/no api key for provider/i.test(trimmed)) {
    return `${trimmed}. Pick a Pi model you are logged into, or run \`pi login\`.`
  }
  return trimmed
}

function resetAssistantStream(state: PiTranslateState): void {
  state.streamedTextByIndex.clear()
  state.streamedThinkingByIndex.clear()
  state.seenToolIds.clear()
  state.errorEmitted = false
}

function emitError(state: PiTranslateState, message: string | undefined, events: PiStreamEvent[]): void {
  if (state.errorEmitted) return
  state.errorEmitted = true
  events.push({ type: 'error', error: formatPiError(message ?? '') })
}

function emitToolUse(block: PiTranslateContentBlock, state: PiTranslateState, events: PiStreamEvent[]): void {
  const id = typeof block.id === 'string' ? block.id : undefined
  if (id && state.seenToolIds.has(id)) return
  if (id) state.seenToolIds.add(id)
  events.push({
    type: 'tool_use',
    toolName: block.name,
    toolId: id,
    toolInput: safeJson(block.arguments ?? block.input),
  })
}

function emitRemainingAssistantContent(msg: PiTranslateMessage, state: PiTranslateState, events: PiStreamEvent[]): void {
  for (const [i, block] of (msg.content ?? []).entries()) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const tail = consumeSnapshot(state.streamedTextByIndex, i, block.text)
      if (tail) events.push({ type: 'text', text: tail })
    } else if (block.type === 'thinking') {
      const thinking = block.thinking ?? block.text
      if (typeof thinking === 'string') {
        const tail = consumeSnapshot(state.streamedThinkingByIndex, i, thinking)
        if (tail) events.push({ type: 'thinking', text: tail })
      }
    } else if (block.type === 'toolCall' || block.type === 'tool_call') {
      emitToolUse(block, state, events)
    }
  }
}

function translateMessageUpdate(event: PiTranslateAssistantEvent, state: PiTranslateState): PiStreamEvent[] {
  const events: PiStreamEvent[] = []
  const idx = indexOf(event)

  switch (event.type) {
    case 'text_delta':
      if (typeof event.delta === 'string') {
        const tail = appendDelta(state.streamedTextByIndex, idx, event.delta)
        if (tail) events.push({ type: 'text', text: tail })
      }
      break
    case 'text_end':
      if (typeof event.content === 'string') {
        const tail = consumeSnapshot(state.streamedTextByIndex, idx, event.content)
        if (tail) events.push({ type: 'text', text: tail })
      }
      break
    case 'thinking_start':
      events.push({ type: 'thinking_start' })
      break
    case 'thinking_delta':
      if (typeof event.delta === 'string') {
        const tail = appendDelta(state.streamedThinkingByIndex, idx, event.delta)
        if (tail) events.push({ type: 'thinking', text: tail })
      }
      break
    case 'thinking_end':
      if (typeof event.content === 'string') {
        const tail = consumeSnapshot(state.streamedThinkingByIndex, idx, event.content)
        if (tail) events.push({ type: 'thinking', text: tail })
      }
      break
    case 'toolcall_end':
      if (event.toolCall) {
        emitToolUse({
          type: 'toolCall',
          id: event.toolCall.id,
          name: event.toolCall.name,
          arguments: event.toolCall.arguments,
        }, state, events)
      }
      break
    case 'error':
      emitError(state, event.error?.errorMessage, events)
      break
    default:
      break
  }

  return events
}

/**
 * Map one Pi session event to zero or more normalised agent:stream events.
 * `agent_end` emits `{ type: 'done' }`; the runtime attaches cost/turns/sessionId.
 */
export function translatePiAgentEvent(event: PiTranslateEvent, state: PiTranslateState): PiStreamEvent[] {
  switch (event.type) {
    case 'message_start':
      if (event.message?.role === 'assistant') resetAssistantStream(state)
      return []
    case 'message_update': {
      const assistantEvent = event.assistantMessageEvent
      if (!assistantEvent) return []
      return translateMessageUpdate(assistantEvent, state)
    }
    case 'message_end': {
      if (event.message?.role !== 'assistant') return []
      const events: PiStreamEvent[] = []
      if (event.message.stopReason === 'error' || event.message.errorMessage) {
        emitError(state, event.message.errorMessage, events)
      } else {
        emitRemainingAssistantContent(event.message, state, events)
      }
      events.push({ type: 'block_stop' })
      return events
    }
    case 'tool_execution_start': {
      if (event.toolCallId) state.seenToolIds.add(event.toolCallId)
      return [
        { type: 'tool_start', toolId: event.toolCallId, toolName: event.toolName },
        { type: 'tool_input', toolId: event.toolCallId, text: safeJson(event.args) },
      ]
    }
    case 'tool_execution_update':
      return [{ type: 'tool_progress', toolName: event.toolName }]
    case 'tool_execution_end': {
      if (event.toolCallId) state.seenToolIds.add(event.toolCallId)
      return [
        {
          type: 'tool_use',
          toolName: event.toolName,
          toolId: event.toolCallId,
          toolInput: safeJson(event.args),
        },
        {
          type: 'tool_summary',
          toolId: event.toolCallId,
          toolName: event.toolName,
          text: summarizeToolResult(event.isError, event.result),
        },
      ]
    }
    case 'turn_end':
      return (event.toolResults ?? []).map(result => ({
        type: 'tool_summary',
        toolId: result.toolCallId,
        toolName: result.toolName,
        text: summarizeToolResult(result.isError, result.result ?? result.output),
      }))
    case 'compaction_start':
      return [{
        type: 'tool_summary',
        toolId: `csagent-compaction-${Date.now()}`,
        toolName: 'Compacting context',
        text: 'Compacting context...',
      }]
    case 'agent_end':
      return [{ type: 'done' }]
    default:
      return []
  }
}
