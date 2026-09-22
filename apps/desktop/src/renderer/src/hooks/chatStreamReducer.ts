/**
 * Pure stream reducer for the chat tile.
 *
 * `applyChatStreamEvent` is the side-effect-free core of `useChatStreamHandler`:
 * given the current streaming `ChatMessage` and one normalised stream event, it
 * returns the next message with its thinking / tool / content blocks updated.
 *
 * Side-effecting events (session id, permission maps, `isStreaming` toggles, the
 * activity bus, and text buffering) stay in the hook — this module only owns the
 * deterministic block-model transforms, so they can be snapshot-tested headless.
 *
 * Note: the synthetic-id fallbacks (`think-${Date.now()}` / `tool-${Date.now()}`)
 * are preserved verbatim from the original hook. They only fire for malformed
 * events missing an id; well-formed provider events always carry one. Tests pass
 * explicit ids to stay deterministic.
 */
import type {
  ChatMessage,
  ToolBlock,
  ThinkingBlock,
  FileChange,
  CommandEntry,
  FileChangesOrigin,
} from '../../../shared/chat-types'
import { normalizeToolName } from '../../../shared/tool-normalization.ts'

/** Fields the reducer reads off a normalised stream event. */
export interface ChatStreamEvent {
  type: string
  text?: string
  thinkingId?: string
  toolId?: string
  toolName?: string
  toolInput?: string
  elapsed?: number
  fileChanges?: FileChange[]
  fileChangesTrusted?: boolean
  fileChangesOrigin?: FileChangesOrigin
  commandEntries?: CommandEntry[]
  cost?: number
  turns?: number
  error?: string
  // Other fields (sessionId, sequence, jobId, provider, title, description,
  // blockedPath, workspaceDir, decision) are handled by the hook, not here.
  [key: string]: unknown
}

function toolBlockFields(toolName: string | null | undefined, provider?: unknown): Pick<
  ToolBlock,
  'name' | 'rawName' | 'canonicalName' | 'displayName' | 'groupKey' | 'category' | 'provider' | 'namespace'
> {
  const normalized = normalizeToolName(toolName, typeof provider === 'string' ? provider : undefined)
  return {
    name: normalized.rawName,
    rawName: normalized.rawName,
    canonicalName: normalized.canonicalName,
    displayName: normalized.displayName,
    groupKey: normalized.groupKey,
    category: normalized.category,
    provider: normalized.provider,
    namespace: normalized.namespace,
  }
}

function mergeToolName(block: ToolBlock, toolName: string | null | undefined, provider?: unknown): ToolBlock {
  if (!toolName) return block
  return { ...block, ...toolBlockFields(toolName, provider) }
}

/** Event types whose message-block mutation lives in this pure reducer. */
const REDUCER_EVENT_TYPES = new Set([
  'thinking_start',
  'thinking',
  'tool_start',
  'tool_input',
  'tool_use',
  'tool_summary',
  'tool_progress',
  'block_stop',
  'done',
  'error',
])

/** True when `applyChatStreamEvent` owns this event's message mutation. */
export function isReducerEvent(type: string): boolean {
  return REDUCER_EVENT_TYPES.has(type)
}

/** Merge a duplicate tool block entry, preferring non-empty / more-advanced state. */
export function mergeToolBlockDuplicate(existing: ToolBlock, incoming: ToolBlock): ToolBlock {
  return {
    ...existing,
    ...incoming,
    name: incoming.name || existing.name,
    input: incoming.input || existing.input,
    summary: incoming.summary ?? existing.summary,
    status: incoming.status === 'running' && existing.status !== 'running'
      ? existing.status
      : incoming.status,
    elapsed: incoming.elapsed ?? existing.elapsed,
    fileChanges: incoming.fileChanges ?? existing.fileChanges,
    fileChangesTrusted: incoming.fileChangesTrusted ?? existing.fileChangesTrusted,
    fileChangesOrigin: incoming.fileChangesOrigin ?? existing.fileChangesOrigin,
    commandEntries: incoming.commandEntries ?? existing.commandEntries,
    rawName: incoming.rawName ?? existing.rawName,
    canonicalName: incoming.canonicalName ?? existing.canonicalName,
    displayName: incoming.displayName ?? existing.displayName,
    groupKey: incoming.groupKey ?? existing.groupKey,
    category: incoming.category ?? existing.category,
    provider: incoming.provider ?? existing.provider,
    namespace: incoming.namespace ?? existing.namespace,
  }
}

/**
 * Apply one stream event to the streaming message, returning the next message.
 * Events this reducer does not own (session, text, permission events) are
 * returned unchanged.
 */
export function applyChatStreamEvent(m: ChatMessage, event: ChatStreamEvent): ChatMessage {
  switch (event.type) {
    case 'thinking_start': {
      const thinkingId = typeof event.thinkingId === 'string'
        ? event.thinkingId
        : `think-${Date.now()}`
      const existing = m.thinkingBlocks ?? []
      if (existing.some(block => block.id === thinkingId)) return m
      return {
        ...m,
        thinking: { content: '', done: false, id: thinkingId },
        thinkingBlocks: [...existing, { id: thinkingId, content: '', done: false }],
        contentBlocks: [...(m.contentBlocks ?? []), { type: 'thinking' as const, thinkingId }],
      }
    }

    case 'thinking': {
      if (!event.text) return m
      const targetId = typeof event.thinkingId === 'string' ? event.thinkingId : m.thinking?.id
      const existing = m.thinkingBlocks ?? []
      const idx = targetId
        ? existing.findIndex(b => b.id === targetId)
        : existing.length - 1
      let nextBlocks: ThinkingBlock[]
      let nextContentBlocks = m.contentBlocks
      if (idx >= 0) {
        nextBlocks = [...existing]
        nextBlocks[idx] = { ...nextBlocks[idx], content: nextBlocks[idx].content + event.text, done: false }
      } else {
        const syntheticId = targetId ?? `think-${Date.now()}`
        nextBlocks = [...existing, { id: syntheticId, content: event.text, done: false }]
        nextContentBlocks = [...(m.contentBlocks ?? []), { type: 'thinking' as const, thinkingId: syntheticId }]
      }
      return {
        ...m,
        thinking: { content: (m.thinking?.content ?? '') + event.text, done: false, id: m.thinking?.id },
        thinkingBlocks: nextBlocks,
        contentBlocks: nextContentBlocks,
      }
    }

    case 'tool_start': {
      const toolId = (typeof event.toolId === 'string' && event.toolId) || `tool-${Date.now()}`
      const nextBlock: ToolBlock = {
        id: toolId,
        ...toolBlockFields(event.toolName ?? 'tool', event.provider),
        input: '',
        status: 'running',
      }
      const existingIndex = (m.toolBlocks ?? []).findIndex(block => block.id === toolId)
      const toolBlocks = existingIndex >= 0
        ? (m.toolBlocks ?? []).map((block, index) => index === existingIndex ? mergeToolBlockDuplicate(block, nextBlock) : block)
        : [...(m.toolBlocks ?? []), nextBlock]
      const hasContentRef = (m.contentBlocks ?? []).some(block => block.type === 'tool' && block.toolId === toolId)
      return {
        ...m,
        toolBlocks,
        contentBlocks: hasContentRef
          ? m.contentBlocks
          : [...(m.contentBlocks ?? []), { type: 'tool' as const, toolId }],
      }
    }

    case 'tool_input': {
      if (!event.text) return m
      const blocks = [...(m.toolBlocks ?? [])]
      const targetIndex = event.toolId
        ? blocks.findIndex(b => b.id === event.toolId)
        : blocks.length - 1
      const last = targetIndex >= 0 ? blocks[targetIndex] : null
      if (last && targetIndex >= 0) blocks[targetIndex] = { ...last, input: last.input + event.text }
      return { ...m, toolBlocks: blocks }
    }

    case 'tool_use': {
      const blocks = [...(m.toolBlocks ?? [])]
      const normalized = normalizeToolName(event.toolName)
      const idx = event.toolId
        ? blocks.findIndex(b => b.id === event.toolId)
        : blocks.findIndex(b => (b.name === event.toolName || b.groupKey === normalized.groupKey) && b.status === 'running')
      if (idx >= 0) {
        blocks[idx] = {
          ...mergeToolName(blocks[idx], event.toolName, event.provider),
          input: event.toolInput ?? blocks[idx].input,
          status: 'done',
        }
      } else {
        // No matching block (missing/out-of-order tool_start). Don't drop the
        // event — synthesize a completed block so the tool call shows up in the
        // transcript, mirroring tool_summary's fallback behaviour.
        const toolId = (typeof event.toolId === 'string' && event.toolId) || `tool-${Date.now()}`
        blocks.push({
          id: toolId,
          ...toolBlockFields(event.toolName ?? 'tool', event.provider),
          input: typeof event.toolInput === 'string' ? event.toolInput : '',
          status: 'done',
        })
        return {
          ...m,
          toolBlocks: blocks,
          contentBlocks: [...(m.contentBlocks ?? []), { type: 'tool' as const, toolId }],
        }
      }
      return { ...m, toolBlocks: blocks }
    }

    case 'tool_summary': {
      const blocks = [...(m.toolBlocks ?? [])]
      const target = event.toolId
        ? blocks.findIndex(b => b.id === event.toolId)
        : (() => {
            const idx = blocks.findLastIndex(b => b.status === 'done' && !b.summary)
            return idx >= 0 ? idx : blocks.findLastIndex(b => b.status === 'running')
          })()
      if (target >= 0) {
        blocks[target] = {
          ...mergeToolName(blocks[target], event.toolName, event.provider),
          summary: typeof event.text === 'string' ? event.text : blocks[target].summary,
          status: 'done',
          fileChanges: Array.isArray(event.fileChanges) ? event.fileChanges : blocks[target].fileChanges,
          fileChangesTrusted: Array.isArray(event.fileChanges)
            ? event.fileChangesTrusted === true
            : blocks[target].fileChangesTrusted,
          fileChangesOrigin: Array.isArray(event.fileChanges) && event.fileChangesTrusted === true
            ? event.fileChangesOrigin
            : blocks[target].fileChangesOrigin,
          commandEntries: Array.isArray(event.commandEntries) ? event.commandEntries : blocks[target].commandEntries,
        }
      } else if (typeof event.text === 'string' && event.text.trim()) {
        const toolId = (typeof event.toolId === 'string' && event.toolId) || `tool-${Date.now()}`
        blocks.push({
          id: toolId,
          ...toolBlockFields(event.toolName ?? 'Activity', event.provider),
          input: '',
          summary: event.text,
          status: 'done',
          fileChanges: Array.isArray(event.fileChanges) ? event.fileChanges : undefined,
          fileChangesTrusted: Array.isArray(event.fileChanges) && event.fileChangesTrusted === true,
          fileChangesOrigin: Array.isArray(event.fileChanges) && event.fileChangesTrusted === true
            ? event.fileChangesOrigin
            : undefined,
          commandEntries: Array.isArray(event.commandEntries) ? event.commandEntries : undefined,
        })
        return {
          ...m,
          toolBlocks: blocks,
          contentBlocks: [...(m.contentBlocks ?? []), { type: 'tool' as const, toolId }],
        }
      }
      return { ...m, toolBlocks: blocks }
    }

    case 'tool_progress': {
      const blocks = [...(m.toolBlocks ?? [])]
      const normalized = normalizeToolName(event.toolName)
      const idx = blocks.findIndex(b => (b.name === event.toolName || b.groupKey === normalized.groupKey) && b.status === 'running')
      if (idx >= 0) blocks[idx] = { ...blocks[idx], elapsed: event.elapsed }
      return { ...m, toolBlocks: blocks }
    }

    case 'block_stop': {
      const blocks = [...(m.toolBlocks ?? [])]
      const lastRunning = blocks.findLastIndex(b => b.status === 'running')
      if (lastRunning >= 0) {
        blocks[lastRunning] = { ...blocks[lastRunning], status: 'done' }
      }
      const thinkingBlocks = [...(m.thinkingBlocks ?? [])]
      const targetId = typeof event.thinkingId === 'string' ? event.thinkingId : null
      if (targetId) {
        const ti = thinkingBlocks.findIndex(b => b.id === targetId)
        if (ti >= 0) thinkingBlocks[ti] = { ...thinkingBlocks[ti], done: true }
      } else {
        const ti = thinkingBlocks.findLastIndex(b => !b.done)
        if (ti >= 0) thinkingBlocks[ti] = { ...thinkingBlocks[ti], done: true }
      }
      return {
        ...m,
        thinking: m.thinking ? { ...m.thinking, done: true } : m.thinking,
        thinkingBlocks,
        toolBlocks: blocks,
      }
    }

    case 'done':
      return {
        ...m,
        isStreaming: false,
        cost: event.cost ?? m.cost,
        turns: event.turns ?? m.turns,
        toolBlocks: m.toolBlocks?.map(b => b.status === 'running' ? { ...b, status: 'done' as const } : b),
      }

    case 'error':
      return {
        ...m, content: m.content || `Error: ${event.error}`, isStreaming: false,
      }

    default:
      return m
  }
}
