import type { ChatMessage, ThinkingBlock, ToolBlock } from './chat-types'

function hashString(input: string): string {
  let h1 = 0xdeadbeef ^ input.length
  let h2 = 0x41c6ce57 ^ input.length
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`
}

function normalizeThinkingSignature(message: {
  thinking?: Pick<ThinkingBlock, 'content'>
  thinkingBlocks?: Array<Pick<ThinkingBlock, 'content'>>
}): string {
  const blocks = Array.isArray(message.thinkingBlocks) && message.thinkingBlocks.length > 0
    ? message.thinkingBlocks
    : (message.thinking ? [message.thinking] : [])

  return blocks
    .map(block => String(block?.content ?? '').trim())
    .filter(Boolean)
    .join('\u0002')
}

function normalizeToolSignature(message: {
  toolBlocks?: Array<Pick<ToolBlock, 'name' | 'input' | 'summary'> & {
    fileChanges?: Array<{ path: string; previousPath?: string; changeType: string }>
    commandEntries?: Array<{ label: string; command?: string; kind?: string }>
  }>
}): string {
  return (message.toolBlocks ?? [])
    .map(block => [
      String(block?.name ?? ''),
      String(block?.input ?? ''),
      String(block?.summary ?? ''),
      (block?.fileChanges ?? []).map(change => `${change.changeType}:${change.path}:${change.previousPath ?? ''}`).join('\u0003'),
      (block?.commandEntries ?? []).map(entry => `${entry.kind ?? ''}:${entry.label}:${entry.command ?? ''}`).join('\u0003'),
    ].join('\u0001'))
    .join('\u0002')
}

export function buildChatMessageHistoryFingerprint(message: Pick<ChatMessage, 'role' | 'content' | 'timestamp'> & {
  thinking?: Pick<ThinkingBlock, 'content'>
  thinkingBlocks?: Array<Pick<ThinkingBlock, 'content'>>
  toolBlocks?: Array<Pick<ToolBlock, 'name' | 'input' | 'summary'> & {
    fileChanges?: Array<{ path: string; previousPath?: string; changeType: string }>
    commandEntries?: Array<{ label: string; command?: string; kind?: string }>
  }>
}): string {
  const canonical = [
    String(message.role ?? ''),
    String(Number.isFinite(message.timestamp) ? message.timestamp : ''),
    String(message.content ?? ''),
    normalizeThinkingSignature(message),
    normalizeToolSignature(message),
  ].join('\u0000')

  return hashString(canonical)
}
