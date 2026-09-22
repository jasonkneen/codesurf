import type { RelayImpact } from './types'
const INVALID_ID_PATTERN = /\.\.|\/|\\|^\.|\0/

export const MAX_RELAY_STORAGE_ID_LENGTH = 128

function validateStorageId(
  id: string,
  kind: 'Participant' | 'Channel' | 'Tile',
): void {
  if (!id || typeof id !== 'string') {
    throw new Error(`${kind} ID is required`)
  }
  if (INVALID_ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${kind.toLowerCase()} ID: ${id}`)
  }
  if (id.length > MAX_RELAY_STORAGE_ID_LENGTH) {
    throw new Error(
      `${kind} ID too long (max ${MAX_RELAY_STORAGE_ID_LENGTH} chars)`,
    )
  }
}

export function validateParticipantId(id: string): void {
  validateStorageId(id, 'Participant')
}

export function validateChannelId(id: string): void {
  validateStorageId(id, 'Channel')
}

export function validateTileId(id: string): void {
  validateStorageId(id, 'Tile')
}

// Mailbox filenames are joined into mailbox dirs and are renderer-supplied
// through relay:* IPC. They must stay plain basenames, otherwise
// moveMessage/readMessage become arbitrary file primitives.
export function validateMessageFilename(filename: string): void {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Message filename is required')
  }
  if (INVALID_ID_PATTERN.test(filename)) {
    throw new Error(`Invalid message filename: ${filename}`)
  }
}

export function safeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'message'
}

export function sanitizeForPrompt(
  text: string,
  maxLength = 4000,
): string {
  return text
    .replace(/```/g, '\\`\\`\\`')
    .replace(/<\|/g, '\\<\\|')
    .replace(/\|>/g, '\\|\\>')
    .slice(0, maxLength)
}

/** Upper bound on impacts retained per participant. */
export const MAX_RELAY_IMPACTS = 64
const IMPACT_TARGET_TYPES = new Set(['agent', 'human', 'system'])
const IMPACT_SEVERITIES = new Set(['low', 'medium', 'high'])

/**
 * Coerce a model-supplied `work.impacts` into a well-formed RelayImpact[].
 *
 * `parseTurnOutput` is a bare JSON.parse + cast, so a turn returning
 * `{"work":{"impacts":"none"}}` previously stored a string here. It was written
 * to participant.json *before* the relationships snapshot, and every later read
 * called `.filter()` on it and threw — so spawnAgent, syncWorkspace,
 * setWorkContext and even the error-recovery setParticipantStatus all failed,
 * permanently, across restarts, until the file was hand-edited.
 *
 * Anything that is not a well-formed impact is dropped rather than rejected:
 * a malformed model turn should lose its impacts, not brick the relay.
 */
export function normalizeRelayImpacts(value: unknown): RelayImpact[] {
  if (!Array.isArray(value)) return []
  const out: RelayImpact[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const candidate = entry as Record<string, unknown>
    const { targetType, targetId, description, severity } = candidate
    if (typeof targetType !== 'string' || !IMPACT_TARGET_TYPES.has(targetType)) continue
    if (typeof description !== 'string' || !description.trim()) continue
    if (typeof severity !== 'string' || !IMPACT_SEVERITIES.has(severity)) continue
    if (targetId !== undefined && typeof targetId !== 'string') continue
    out.push({
      targetType: targetType as RelayImpact['targetType'],
      ...(targetId === undefined ? {} : { targetId }),
      description,
      severity: severity as RelayImpact['severity'],
    })
    if (out.length >= MAX_RELAY_IMPACTS) break
  }
  return out
}

/** Mailbox names that name a real on-disk directory. */
const VALID_MAILBOXES = new Set(['inbox', 'sent', 'memory', 'bin'])

/**
 * Validate a mailbox path segment.
 *
 * The union type is erased across IPC — src/main/ipc/relay.ts forwards the raw
 * argument — so `mailbox` reaches participantMailboxDir/tileMailboxDir as an
 * arbitrary string while every sibling segment is guarded. moveMessage joins it
 * into BOTH operands of a renameSync and ensureDir's the destination, making it
 * an arbitrary rename-and-mkdir primitive:
 *   moveMessage(ws, 'system', '../../../../.ssh', '../../../../tmp', 'id_rsa')
 */
export function validateMailbox(mailbox: string): void {
  if (!VALID_MAILBOXES.has(mailbox)) {
    throw new Error(`Invalid relay mailbox: ${JSON.stringify(mailbox)}`)
  }
}

/** Status values a model turn may set. Anything else is rejected. */
const VALID_PARTICIPANT_STATUSES = new Set([
  'spawning', 'ready', 'running', 'blocked', 'stopped', 'error', 'done',
])

export function isValidParticipantStatus(value: unknown): boolean {
  return typeof value === 'string' && VALID_PARTICIPANT_STATUSES.has(value)
}

/**
 * Coerce a model-supplied list field to a string array.
 *
 * parseTurnOutput is a bare JSON.parse + cast, and `unique()` spreads a string
 * character-by-character — so `{"work":{"files":"src/App.tsx"}}` became
 * ["s","r","c",...] in participant.json, overlapped with every other agent that
 * made the same slip, and emitted high-priority "same files" hints durably.
 */
export function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

/**
 * True when a directory entry can be a relay storage id.
 *
 * listParticipants/listChannels mapped every readdir entry through
 * validateStorageId, and that throw inside `.map()` rejected the whole
 * Promise.all — so the broad catch returned [], indistinguishable from "no
 * participants", with no log. One stray dotfile silently stalled the relay.
 */
export function isListableStorageId(name: string): boolean {
  if (!name || typeof name !== 'string') return false
  if (name.startsWith('.')) return false
  return !INVALID_ID_PATTERN.test(name)
}
