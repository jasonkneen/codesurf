export interface SessionOpenCapabilities {
  canOpenInChat?: boolean
  canOpenInApp?: boolean
  filePath?: string
  messageCount?: number
  lastMessage?: string | null
}

export type SessionOpenIntent =
  | { kind: 'chat'; persist: boolean }
  | { kind: 'app' }
  | { kind: 'file'; persist: boolean }
  | { kind: 'none' }

export function getSessionOpenIntent(
  session: SessionOpenCapabilities,
  options?: { persist?: boolean },
): SessionOpenIntent {
  const persist = options?.persist === true
  const hasKnownTranscriptSignal = typeof session.messageCount === 'number'
    || typeof session.lastMessage === 'string'
    || session.lastMessage === null
  const hasTranscript = (Number.isFinite(session.messageCount) && Number(session.messageCount) > 0)
    || (typeof session.lastMessage === 'string' && session.lastMessage.trim().length > 0)
  if (session.canOpenInChat !== false && (!hasKnownTranscriptSignal || hasTranscript)) return { kind: 'chat', persist }
  if (session.canOpenInApp === true) return { kind: 'app' }
  if (typeof session.filePath === 'string' && session.filePath.trim()) return { kind: 'file', persist }
  return { kind: 'none' }
}
