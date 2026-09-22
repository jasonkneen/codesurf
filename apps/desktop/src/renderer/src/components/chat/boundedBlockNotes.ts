const BLOCK_NOTES_CONTEXT_MAX_CHARS = 4000
const BLOCK_NOTES_HEADER = 'User annotations on earlier turns (treat as durable guidance, not fresh requests):\n'
const BLOCK_NOTE_PREVIEW_INPUT_MAX_CHARS = 512
const BLOCK_NOTE_PREVIEW_MAX_CHARS = 80

interface BlockNoteLike {
  text?: string
}

interface BlockNoteMessageLike {
  role?: string
  content?: string
  note?: BlockNoteLike
  toolBlocks?: Array<{
    name?: string
    note?: BlockNoteLike
  }>
  thinkingBlocks?: Array<{
    content?: string
    note?: BlockNoteLike
  }>
}

function boundedPreview(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .slice(0, BLOCK_NOTE_PREVIEW_INPUT_MAX_CHARS)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, BLOCK_NOTE_PREVIEW_MAX_CHARS)
}

/** Build notes incrementally so neither an entry nor the aggregate is joined before capping. */
export function buildBlockNotesContext(messages: readonly BlockNoteMessageLike[]): string | null {
  let output = ''
  let foundNote = false

  const appendNote = (label: string, noteValue: unknown): boolean => {
    if (typeof noteValue !== 'string') return true
    const note = noteValue
    if (!note) return true
    foundNote = true

    if (!output) output = BLOCK_NOTES_HEADER
    const prefix = `- [${label}] `
    const remaining = BLOCK_NOTES_CONTEXT_MAX_CHARS - output.length
    if (remaining <= 1) return false

    const separator = output.endsWith('\n') ? '' : '\n'
    const available = remaining - separator.length
    if (available <= 1) return false
    const entryPrefix = prefix.slice(0, available)
    const noteBudget = available - entryPrefix.length

    output += separator + entryPrefix
    if (noteBudget <= 0) return false
    if (note.length <= noteBudget) {
      output += note
      return output.length < BLOCK_NOTES_CONTEXT_MAX_CHARS
    }

    output += `${note.slice(0, Math.max(0, noteBudget - 1)).trimEnd()}…`
    return false
  }

  for (let turnIndex = 0; turnIndex < messages.length; turnIndex += 1) {
    const message = messages[turnIndex]
    if (message?.note?.text) {
      const preview = boundedPreview(message.content)
      const previewLabel = preview
        ? `: \"${preview}${preview.length >= BLOCK_NOTE_PREVIEW_MAX_CHARS ? '…' : ''}\"`
        : ''
      if (!appendNote(`${message.role ?? 'unknown'} turn ${turnIndex + 1}${previewLabel}`, message.note.text)) break
    }

    let exhausted = false
    for (const toolBlock of message?.toolBlocks ?? []) {
      if (!toolBlock?.note?.text) continue
      const toolName = boundedPreview(toolBlock.name) || 'unknown'
      if (!appendNote(`tool \`${toolName}\``, toolBlock.note.text)) {
        exhausted = true
        break
      }
    }
    if (exhausted) break

    for (const thinkingBlock of message?.thinkingBlocks ?? []) {
      if (!thinkingBlock?.note?.text) continue
      const preview = boundedPreview(thinkingBlock.content)
      const previewLabel = preview
        ? `: \"${preview}${preview.length >= BLOCK_NOTE_PREVIEW_MAX_CHARS ? '…' : ''}\"`
        : ''
      if (!appendNote(`thinking${previewLabel}`, thinkingBlock.note.text)) {
        exhausted = true
        break
      }
    }
    if (exhausted) break
  }

  return foundNote ? output : null
}

export const BLOCK_NOTES_CONTEXT_BUDGET = BLOCK_NOTES_CONTEXT_MAX_CHARS
