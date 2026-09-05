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
