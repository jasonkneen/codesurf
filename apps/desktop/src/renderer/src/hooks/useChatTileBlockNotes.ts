import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { BlockNote, ChatMessage } from '../../../shared/chat-types'

export type BlockNoteTarget =
  | { kind: 'message'; messageId: string }
  | { kind: 'tool'; messageId: string; toolBlockId: string }
  | { kind: 'thinking'; messageId: string; thinkingId: string }

export type CollectedBlockNote = {
  kind: 'message' | 'tool' | 'thinking'
  messageId: string
  blockId?: string
  role?: string
  context: string
  note: BlockNote
}

export interface UseChatTileBlockNotesOptions {
  allMessages: ChatMessage[]
  setMessagesSafe: Dispatch<SetStateAction<ChatMessage[]>>
  setHistoricalMessages: Dispatch<SetStateAction<ChatMessage[]>>
}

export interface UseChatTileBlockNotesResult {
  updateBlockNote: (target: BlockNoteTarget, text: string | null) => void
  collectAllNotes: () => CollectedBlockNote[]
  exportNotesToClipboard: () => Promise<void>
}

function applyBlockNoteToMessages(
  collection: ChatMessage[],
  target: BlockNoteTarget,
  nextNote: BlockNote | null,
): ChatMessage[] {
  return collection.map(msg => {
    if (msg.id !== target.messageId) return msg
    if (target.kind === 'message') {
      if (nextNote) {
        const merged: BlockNote = msg.note
          ? { ...msg.note, text: nextNote.text, updatedAt: Date.now() }
          : nextNote
        return { ...msg, note: merged }
      }
      const { note: _discard, ...rest } = msg
      return rest
    }
    if (target.kind === 'tool') {
      const blocks = msg.toolBlocks?.map(b => {
        if (b.id !== target.toolBlockId) return b
        if (nextNote) {
          const merged: BlockNote = b.note
            ? { ...b.note, text: nextNote.text, updatedAt: Date.now() }
            : nextNote
          return { ...b, note: merged }
        }
        const { note: _discard, ...rest } = b
        return rest
      })
      return { ...msg, toolBlocks: blocks }
    }
    const thinkingBlocks = msg.thinkingBlocks?.map(tb => {
      if (tb.id !== target.thinkingId) return tb
      if (nextNote) {
        const merged: BlockNote = tb.note
          ? { ...tb.note, text: nextNote.text, updatedAt: Date.now() }
          : nextNote
        return { ...tb, note: merged }
      }
      const { note: _discard, ...rest } = tb
      return rest
    })
    return { ...msg, thinkingBlocks }
  })
}

export function useChatTileBlockNotes(options: UseChatTileBlockNotesOptions): UseChatTileBlockNotesResult {
  const { allMessages, setMessagesSafe, setHistoricalMessages } = options

  const updateBlockNote = useCallback((
    target: BlockNoteTarget,
    text: string | null,
  ) => {
    const nextNote: BlockNote | null = text && text.trim().length > 0
      ? { text: text.trim(), createdAt: Date.now() }
      : null
    setMessagesSafe(prev => applyBlockNoteToMessages(prev, target, nextNote))
    setHistoricalMessages(prev => applyBlockNoteToMessages(prev, target, nextNote))
  }, [setMessagesSafe, setHistoricalMessages])

  const collectAllNotes = useCallback((): CollectedBlockNote[] => {
    const out: CollectedBlockNote[] = []
    for (const m of allMessages) {
      if (m.note) {
        const snippet = m.content.trim().slice(0, 200)
        out.push({ kind: 'message', messageId: m.id, role: m.role, context: snippet, note: m.note })
      }
      for (const tb of m.toolBlocks ?? []) {
        if (tb.note) {
          const snippet = `${tb.name}: ${(tb.summary ?? tb.input ?? '').slice(0, 160)}`
          out.push({ kind: 'tool', messageId: m.id, blockId: tb.id, context: snippet, note: tb.note })
        }
      }
      for (const tk of m.thinkingBlocks ?? []) {
        if (tk.note) {
          const snippet = tk.content.slice(0, 200)
          out.push({ kind: 'thinking', messageId: m.id, blockId: tk.id, context: snippet, note: tk.note })
        }
      }
    }
    return out
  }, [allMessages])

  const exportNotesToClipboard = useCallback(async () => {
    const notes = collectAllNotes()
    if (notes.length === 0) {
      try { await navigator.clipboard.writeText('# Chat notes\n\n_No notes yet._') } catch { /* ignore */ }
      return
    }
    const lines = ['# Chat notes', '']
    for (const entry of notes) {
      const header = entry.kind === 'message'
        ? `## ${entry.role ?? 'message'}`
        : entry.kind === 'tool'
          ? '## tool call'
          : '## thinking'
      lines.push(header)
      lines.push(`> ${entry.context.replace(/\n/g, ' ')}`)
      lines.push('')
      lines.push(entry.note.text)
      lines.push('')
    }
    const payload = lines.join('\n')
    try { await navigator.clipboard.writeText(payload) } catch { /* ignore */ }
  }, [collectAllNotes])

  return {
    updateBlockNote,
    collectAllNotes,
    exportNotesToClipboard,
  }
}