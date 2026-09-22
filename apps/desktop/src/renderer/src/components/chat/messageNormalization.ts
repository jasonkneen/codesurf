import type { ToolBlock, ChatMessage } from '../../../../shared/chat-types'

// ── Memory-guard constants ──────────────────────────────────────────────
const CHAT_MEMORY_MESSAGE_LIMIT = 120
const CHAT_MEMORY_CHAR_LIMIT = 180_000
const CHAT_MEMORY_SINGLE_MESSAGE_LIMIT = 80_000
const CHAT_MEMORY_PRESERVE_RICH_MESSAGE_COUNT = 12
const CHAT_MEMORY_TOOL_INPUT_LIMIT = 2_000
const CHAT_MEMORY_TOOL_INPUT_LIMIT_AGGRESSIVE = 500
const CHAT_MEMORY_TOOL_SUMMARY_LIMIT = 2_000
const CHAT_MEMORY_TOOL_SUMMARY_LIMIT_AGGRESSIVE = 600
const CHAT_MEMORY_THINKING_LIMIT = 8_000
const CHAT_MEMORY_THINKING_LIMIT_AGGRESSIVE = 1_200
const CHAT_MEMORY_CONTENT_BLOCK_LIMIT = 8_000
const CHAT_MEMORY_CONTENT_BLOCK_LIMIT_AGGRESSIVE = 1_500
export const CHAT_TRIM_NOTICE_PREFIX = '[CodeSurf memory guard]'

const TOOL_OUTPUT_METADATA_PATTERNS = [
  /^Chunk ID:/i,
  /^Wall time:/i,
  /^Process exited with code /i,
  /^Process running with session ID /i,
  /^Original token count:/i,
  /^Output:$/i,
  /^\[CodeSurf memory guard\] Older tool (output|summary) /i,
]

// ── Helpers ─────────────────────────────────────────────────────────────

function sanitizeToolOutputText(text: string | undefined): string | undefined {
  if (!text) return text

  const cleaned = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => !TOOL_OUTPUT_METADATA_PATTERNS.some(pattern => pattern.test(line.trim())))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return cleaned || undefined
}

function truncateTextForMemory(text: string | undefined, limit: number, label: string): string {
  if (!text) return ''
  if (text.length <= limit) return text
  const keptTail = text.slice(-limit)
  return `${CHAT_TRIM_NOTICE_PREFIX} Older ${label} was truncated to keep the renderer alive.\n\n${keptTail}`
}

function trimToolBlockForMemory(block: ToolBlock, aggressive: boolean): ToolBlock {
  const input = truncateTextForMemory(
    block.input,
    aggressive ? CHAT_MEMORY_TOOL_INPUT_LIMIT_AGGRESSIVE : CHAT_MEMORY_TOOL_INPUT_LIMIT,
    `tool input for ${block.name}`,
  )
  const sanitizedSummary = sanitizeToolOutputText(block.summary)
  const summary = sanitizedSummary
    ? truncateTextForMemory(
      sanitizedSummary,
      aggressive ? CHAT_MEMORY_TOOL_SUMMARY_LIMIT_AGGRESSIVE : CHAT_MEMORY_TOOL_SUMMARY_LIMIT,
      `tool summary for ${block.name}`,
    )
    : sanitizedSummary
  const fileChanges = block.fileChanges?.map(change => {
    const diff = truncateTextForMemory(
      change.diff,
      aggressive ? CHAT_MEMORY_TOOL_SUMMARY_LIMIT_AGGRESSIVE : CHAT_MEMORY_TOOL_SUMMARY_LIMIT,
      `tool diff for ${change.path}`,
    )
    if (diff === change.diff) return change
    return { ...change, diff }
  })
  const commandEntries = block.commandEntries?.map(entry => {
    const sanitizedOutput = sanitizeToolOutputText(entry.output)
    if (!sanitizedOutput) {
      if (!entry.output) return entry
      return { ...entry, output: undefined }
    }
    const output = truncateTextForMemory(
      sanitizedOutput,
      aggressive ? CHAT_MEMORY_TOOL_SUMMARY_LIMIT_AGGRESSIVE : CHAT_MEMORY_TOOL_SUMMARY_LIMIT,
      `tool output for ${entry.label}`,
    )
    if (output === entry.output) return entry
    return { ...entry, output }
  })

  const fileChangesChanged = fileChanges?.some((change, index) => change !== block.fileChanges?.[index]) ?? false
  const commandEntriesChanged = commandEntries?.some((entry, index) => entry !== block.commandEntries?.[index]) ?? false

  if (input === block.input && summary === block.summary && !fileChangesChanged && !commandEntriesChanged) return block
  return { ...block, input, summary, fileChanges, commandEntries }
}

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
    commandEntries: incoming.commandEntries ?? existing.commandEntries,
  }
}

function normalizeMessageStructure(message: ChatMessage): ChatMessage {
  const toolBlocks = message.toolBlocks
  const contentBlocks = message.contentBlocks
  if ((!toolBlocks || toolBlocks.length <= 1) && (!contentBlocks || contentBlocks.length <= 1)) return message

  let nextToolBlocks = toolBlocks
  if (toolBlocks?.length) {
    const seen = new Map<string, number>()
    const deduped: ToolBlock[] = []
    let changed = false
    for (const block of toolBlocks) {
      const existingIndex = seen.get(block.id)
      if (existingIndex == null) {
        seen.set(block.id, deduped.length)
        deduped.push(block)
        continue
      }
      deduped[existingIndex] = mergeToolBlockDuplicate(deduped[existingIndex], block)
      changed = true
    }
    if (changed) nextToolBlocks = deduped
  }

  let nextContentBlocks = contentBlocks
  if (contentBlocks?.length) {
    const seenToolRefs = new Set<string>()
    const deduped = contentBlocks.filter(block => {
      if (block.type !== 'tool') return true
      if (seenToolRefs.has(block.toolId)) return false
      seenToolRefs.add(block.toolId)
      return true
    })
    if (deduped.length !== contentBlocks.length) nextContentBlocks = deduped
  }

  if (nextToolBlocks === toolBlocks && nextContentBlocks === contentBlocks) return message
  return {
    ...message,
    toolBlocks: nextToolBlocks,
    contentBlocks: nextContentBlocks,
  }
}

function compactMessageForMemory(message: ChatMessage, options: { aggressive: boolean; preserveRichLayout: boolean }): ChatMessage {
  const normalizedMessage = normalizeMessageStructure(message)
  const aggressive = options.aggressive && !message.isStreaming
  const content = truncateTextForMemory(normalizedMessage.content, CHAT_MEMORY_SINGLE_MESSAGE_LIMIT, 'message content')
  let next: ChatMessage = content === normalizedMessage.content ? normalizedMessage : { ...normalizedMessage, content }

  if (normalizedMessage.thinking?.content) {
    const thinkingContent = truncateTextForMemory(
      normalizedMessage.thinking.content,
      aggressive ? CHAT_MEMORY_THINKING_LIMIT_AGGRESSIVE : CHAT_MEMORY_THINKING_LIMIT,
      'thinking text',
    )
    if (thinkingContent !== normalizedMessage.thinking.content) {
      next = next === normalizedMessage ? { ...normalizedMessage } : next
      next.thinking = { ...normalizedMessage.thinking, content: thinkingContent }
    }
  }

  if (normalizedMessage.toolBlocks?.length) {
    const sourceBlocks = aggressive && normalizedMessage.toolBlocks.length > 3
      ? normalizedMessage.toolBlocks.slice(-3)
      : normalizedMessage.toolBlocks
    const trimmedBlocks = sourceBlocks.map(block => trimToolBlockForMemory(block, aggressive))
    const blocksChanged = sourceBlocks.length !== normalizedMessage.toolBlocks.length
      || trimmedBlocks.some((block, index) => block !== sourceBlocks[index])
    if (blocksChanged) {
      next = next === normalizedMessage ? { ...normalizedMessage } : next
      next.toolBlocks = trimmedBlocks.length > 0 ? trimmedBlocks : undefined
    }
  }

  if (normalizedMessage.contentBlocks?.length) {
    if (normalizedMessage.isStreaming || options.preserveRichLayout) {
      const nextContentBlocks = normalizedMessage.contentBlocks.map(block => {
        if (block.type !== 'text') return block
        const text = truncateTextForMemory(
          block.text,
          aggressive ? CHAT_MEMORY_CONTENT_BLOCK_LIMIT_AGGRESSIVE : CHAT_MEMORY_CONTENT_BLOCK_LIMIT,
          'interleaved message content',
        )
        if (text === block.text) return block
        return {
          ...block,
          text,
        }
      })
      if (nextContentBlocks.some((block, index) => block !== normalizedMessage.contentBlocks?.[index])) {
        next = next === normalizedMessage ? { ...normalizedMessage } : next
        next.contentBlocks = nextContentBlocks
      }
    } else {
      next = next === normalizedMessage ? { ...normalizedMessage } : next
      next.contentBlocks = undefined
    }
  }

  return next
}

export function estimateMessageChars(message: ChatMessage): number {
  const toolChars = (message.toolBlocks ?? []).reduce((sum, block) => {
    const fileChangeChars = (block.fileChanges ?? []).reduce((fileSum, change) => {
      return fileSum + change.path.length + (change.previousPath?.length ?? 0) + change.diff.length
    }, 0)
    const commandEntryChars = (block.commandEntries ?? []).reduce((entrySum, entry) => {
      return entrySum + entry.label.length + (entry.command?.length ?? 0) + (entry.output?.length ?? 0)
    }, 0)
    return sum + (block.name?.length ?? 0) + (block.input?.length ?? 0) + (block.summary?.length ?? 0) + fileChangeChars + commandEntryChars
  }, 0)
  const contentBlockChars = (message.contentBlocks ?? []).reduce((sum, block) => {
    return sum + (block.type === 'text' ? (block.text?.length ?? 0) : 24)
  }, 0)
  return (message.content?.length ?? 0) + (message.thinking?.content?.length ?? 0) + toolChars + contentBlockChars
}

export function normalizeMessagesForMemory(messages: ChatMessage[]): ChatMessage[] {
  const withoutNotice = messages.filter(message => !(message.role === 'system' && message.content.startsWith(CHAT_TRIM_NOTICE_PREFIX)))
  const sourceMessages = withoutNotice.length === messages.length ? messages : withoutNotice
  const normalized = sourceMessages.map((message, index, arr) => compactMessageForMemory(message, {
    aggressive: index < arr.length - CHAT_MEMORY_PRESERVE_RICH_MESSAGE_COUNT,
    preserveRichLayout: index >= arr.length - CHAT_MEMORY_PRESERVE_RICH_MESSAGE_COUNT,
  }))

  let start = 0
  let totalChars = normalized.reduce((sum, message) => sum + estimateMessageChars(message), 0)
  while (normalized.length - start > CHAT_MEMORY_MESSAGE_LIMIT || totalChars > CHAT_MEMORY_CHAR_LIMIT) {
    totalChars -= estimateMessageChars(normalized[start])
    start += 1
  }

  if (start === 0) {
    if (sourceMessages.length === messages.length && normalized.every((message, index) => message === messages[index])) {
      return messages
    }
    return normalized
  }

  const notice: ChatMessage = {
    id: `msg-memory-guard-${normalized[start]?.timestamp ?? Date.now()}`,
    role: 'system',
    content: `${CHAT_TRIM_NOTICE_PREFIX} Dropped ${start} older message${start === 1 ? '' : 's'} from live renderer state to avoid an out-of-memory crash. Remaining history may also be compacted.`,
    timestamp: normalized[start]?.timestamp ?? Date.now(),
  }
  return [notice, ...normalized.slice(start)]
}
