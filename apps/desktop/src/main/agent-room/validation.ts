import type { RoomEvent } from './types.ts'

export const TRUNCATION_MARKER = '[truncated]'
export const MAX_TILE_ID_BYTES = 128
export const MAX_ROOM_MEMBERS = 64
export const MAX_ROOMS = 64
export const MAX_GLOBAL_MEMBERS = 512
export const MAX_TILE_TYPE_BYTES = 64
export const MAX_DISPLAY_NAME_BYTES = 128
export const MAX_MEMBER_TASK_BYTES = 4096
export const MAX_MEMBER_FILES = 64
export const MAX_MEMBER_FILE_BYTES = 1024
export const MAX_TODOS_PER_TILE = 64
export const MAX_TODO_TEXT_BYTES = 1024
export const MAX_TOTAL_TODOS = 2048
export const MAX_EVENT_TEXT_BYTES = 4096
export const MAX_EVENT_TARGETS = 32
export const MAX_METADATA_BYTES = 16 * 1024
export const MAX_METADATA_DEPTH = 6
export const MAX_METADATA_NODES = 256
export const MAX_METADATA_LEAVES = 192
export const MAX_METADATA_OBJECT_KEYS = 64
export const MAX_METADATA_ARRAY_ITEMS = 64
export const MAX_METADATA_STRING_BYTES = 2048
export const MAX_EVENTS_PER_ROOM = 500
export const MAX_RETAINED_EVENT_BYTES = 1024 * 1024
export const MAX_GLOBAL_RETAINED_EVENT_BYTES = 8 * 1024 * 1024
export const MAX_PROMPT_BYTES = 8 * 1024
export const MAX_PROMPT_ESTIMATED_TOKENS = 1024
export const MAX_SNAPSHOT_BYTES = 96 * 1024
export const MAX_SNAPSHOT_ESTIMATED_TOKENS = 24 * 1024
export const MAX_PERSISTED_ROOM_BYTES = 128 * 1024
export const MAX_PERSISTED_ROOM_ESTIMATED_TOKENS = 32 * 1024
export const MAX_PEER_STATE_BYTES = 64 * 1024
export const MAX_PEER_STATE_ESTIMATED_TOKENS = 16 * 1024
export const MAX_MCP_RESULT_BYTES = 8 * 1024
export const MAX_MCP_RESULT_ESTIMATED_TOKENS = 1024
export const MAX_DIGEST_BYTES = 112 * 1024
export const MAX_DIGEST_ESTIMATED_TOKENS = 28 * 1024
export const MAX_CONSUME_BYTES = 128 * 1024
export const MAX_CONSUME_ESTIMATED_TOKENS = 32 * 1024
export const MAX_PROJECTED_MEMBER_TASK_BYTES = 512
export const MAX_PROJECTED_MEMBER_FILES = 8
export const MAX_PROJECTED_MEMBER_FILE_BYTES = 256
export const MAX_PROJECTED_EVENT_TEXT_BYTES = 2 * 1024
export const MAX_PROJECTED_EVENT_TARGETS = 16
export const MAX_PROJECTED_EVENT_METADATA_BYTES = 2 * 1024
export const MAX_PROJECTED_TODOS = 32
export const MAX_PROJECTED_TODO_TEXT_BYTES = 512

const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const WINDOWS_DEVICE_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const BLOCKED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export class AgentRoomValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentRoomValidationError'
  }
}

export function isValidAgentRoomId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_TILE_ID_BYTES) return false
  if (!SAFE_ID.test(value)) return false
  if (value === '.' || value === '..' || value.includes('..') || value.endsWith('.')) return false
  if (WINDOWS_DEVICE_ID.test(value)) return false
  return true
}

export function assertValidAgentRoomId(value: unknown, label = 'tileId'): string {
  if (!isValidAgentRoomId(value)) {
    throw new AgentRoomValidationError(`Invalid ${label}`)
  }
  return value
}

export function truncateUtf8(
  rawValue: unknown,
  maxBytes: number,
  options: { marker?: string, trim?: boolean, maxEstimatedTokens?: number } = {},
): string {
  const marker = options.marker ?? TRUNCATION_MARKER
  let value: string
  try {
    const coerced = String(rawValue ?? '')
    value = options.trim === false ? coerced : coerced.trim()
  } catch {
    value = marker
  }
  const maxTokenUnits = options.maxEstimatedTokens === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, options.maxEstimatedTokens * 4)
  if (
    Buffer.byteLength(value, 'utf8') <= maxBytes
    && estimatedTokenUnits(value) <= maxTokenUnits
  ) return value

  const markerBytes = Buffer.byteLength(marker, 'utf8')
  const markerTokenUnits = estimatedTokenUnits(marker)
  if (markerBytes >= maxBytes || markerTokenUnits >= maxTokenUnits) {
    let markerOnly = ''
    let markerOnlyBytes = 0
    let markerOnlyTokenUnits = 0
    for (const char of marker) {
      const charBytes = Buffer.byteLength(char, 'utf8')
      const charTokenUnits = estimatedTokenUnits(char)
      if (
        markerOnlyBytes + charBytes > maxBytes
        || markerOnlyTokenUnits + charTokenUnits > maxTokenUnits
      ) break
      markerOnly += char
      markerOnlyBytes += charBytes
      markerOnlyTokenUnits += charTokenUnits
    }
    return markerOnly
  }

  const contentBudget = maxBytes - markerBytes
  const contentTokenUnits = maxTokenUnits - markerTokenUnits
  let result = ''
  let usedBytes = 0
  let usedTokenUnits = 0
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    const charTokenUnits = estimatedTokenUnits(char)
    if (
      usedBytes + charBytes > contentBudget
      || usedTokenUnits + charTokenUnits > contentTokenUnits
    ) break
    result += char
    usedBytes += charBytes
    usedTokenUnits += charTokenUnits
  }
  return `${result}${marker}`
}

function estimatedTokenUnits(value: string): number {
  let units = 0
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint > 0x7f) {
      units += 4
    } else if (
      (codePoint >= 0x30 && codePoint <= 0x39)
      || (codePoint >= 0x41 && codePoint <= 0x5a)
      || (codePoint >= 0x61 && codePoint <= 0x7a)
      || codePoint === 0x20
      || codePoint === 0x0a
      || codePoint === 0x09
    ) {
      units += 1
    } else {
      units += 2
    }
  }
  return units
}

export function estimateTokenCount(value: string): number {
  return Math.ceil(estimatedTokenUnits(value) / 4)
}

export interface SerializedBudget {
  maxBytes: number
  maxEstimatedTokens: number
}

export function serializedMetrics(value: unknown): {
  json: string
  bytes: number
  estimatedTokens: number
} | null {
  try {
    const json = JSON.stringify(value)
    return {
      json,
      bytes: Buffer.byteLength(json, 'utf8'),
      estimatedTokens: estimateTokenCount(json),
    }
  } catch {
    return null
  }
}

export function fitsSerializedBudget(value: unknown, budget: SerializedBudget): boolean {
  const metrics = serializedMetrics(value)
  return Boolean(
    metrics
    && metrics.bytes <= budget.maxBytes
    && metrics.estimatedTokens <= budget.maxEstimatedTokens,
  )
}

export function boundTileType(value: unknown): string {
  return truncateUtf8(value || 'unknown', MAX_TILE_TYPE_BYTES) || 'unknown'
}

export function boundDisplayName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return truncateUtf8(value, MAX_DISPLAY_NAME_BYTES)
}

export function boundMemberTask(value: unknown): string {
  return truncateUtf8(value, MAX_MEMBER_TASK_BYTES)
}

export function boundMemberFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const limit = value.length > MAX_MEMBER_FILES
    ? MAX_MEMBER_FILES - 1
    : MAX_MEMBER_FILES
  for (const item of value.slice(0, MAX_MEMBER_FILES)) {
    if (typeof item !== 'string') continue
    result.push(truncateUtf8(item, MAX_MEMBER_FILE_BYTES))
    if (result.length >= limit) break
  }
  if (value.length > MAX_MEMBER_FILES) result.push(TRUNCATION_MARKER)
  return result
}

export function boundEventText(value: unknown): string {
  return truncateUtf8(value, MAX_EVENT_TEXT_BYTES)
}

export function boundTargetTileIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value.slice(0, MAX_EVENT_TARGETS)) {
    if (!isValidAgentRoomId(item) || seen.has(item)) continue
    seen.add(item)
    result.push(item)
    if (result.length >= MAX_EVENT_TARGETS) break
  }
  return result
}

interface MetadataBudget {
  nodes: number
  leaves: number
  truncated: boolean
  seen: WeakSet<object>
}

function metadataMarker(reason: string): string {
  return `[truncated: ${reason}]`
}

function normalizeMetadataValue(value: unknown, depth: number, budget: MetadataBudget): unknown {
  if (budget.nodes >= MAX_METADATA_NODES) {
    budget.truncated = true
    return metadataMarker('node limit')
  }
  if (budget.leaves >= MAX_METADATA_LEAVES) {
    budget.truncated = true
    return metadataMarker('leaf limit')
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    budget.leaves += 1
    budget.nodes += 1
    return typeof value === 'string'
      ? truncateUtf8(value, MAX_METADATA_STRING_BYTES)
      : value
  }
  if (typeof value === 'number') {
    budget.leaves += 1
    budget.nodes += 1
    return Number.isFinite(value) ? value : metadataMarker('non-finite number')
  }
  if (typeof value === 'bigint') {
    budget.leaves += 1
    budget.nodes += 1
    return truncateUtf8(value.toString(), MAX_METADATA_STRING_BYTES)
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    budget.truncated = true
    return metadataMarker('unsupported value')
  }
  if (depth >= MAX_METADATA_DEPTH) {
    budget.truncated = true
    return metadataMarker('maximum depth')
  }
  if (!value || typeof value !== 'object') return String(value)
  if (budget.seen.has(value)) {
    budget.truncated = true
    return metadataMarker('circular reference')
  }
  budget.nodes += 1
  budget.seen.add(value)
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = []
      const retainedLength = Math.min(value.length, MAX_METADATA_ARRAY_ITEMS)
      for (let index = 0; index < retainedLength; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !('value' in descriptor)) {
          budget.truncated = true
          output.push(metadataMarker('accessor or missing array item'))
        } else {
          output.push(normalizeMetadataValue(descriptor.value, depth + 1, budget))
        }
      }
      if (value.length > MAX_METADATA_ARRAY_ITEMS) {
        budget.truncated = true
        output.push(metadataMarker('additional array item(s)'))
      }
      return output
    }

    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      budget.truncated = true
      return metadataMarker('non-plain object')
    }

    const output: Record<string, unknown> = {}
    const boundedKeys = new Set<string>()
    let inspectedKeys = 0
    let hasAdditionalKeys = false
    for (const key in value as Record<string, unknown>) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor) continue
      inspectedKeys += 1
      if (inspectedKeys > MAX_METADATA_OBJECT_KEYS) {
        hasAdditionalKeys = true
        break
      }
      if (BLOCKED_OBJECT_KEYS.has(key)) {
        budget.truncated = true
        continue
      }
      const boundedKey = truncateUtf8(key, 128)
      if (boundedKeys.has(boundedKey)) {
        budget.truncated = true
        continue
      }
      boundedKeys.add(boundedKey)
      if (!('value' in descriptor)) {
        budget.truncated = true
        output[boundedKey] = metadataMarker('accessor property')
      } else {
        output[boundedKey] = normalizeMetadataValue(descriptor.value, depth + 1, budget)
      }
    }
    if (hasAdditionalKeys) {
      budget.truncated = true
      output.__codesurfTruncatedKeys = metadataMarker('additional object key(s)')
    }
    return output
  } finally {
    budget.seen.delete(value)
  }
}

export function boundMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  const budget: MetadataBudget = {
    nodes: 0,
    leaves: 0,
    truncated: false,
    seen: new WeakSet(),
  }
  let normalized: unknown
  try {
    normalized = normalizeMetadataValue(value, 0, budget)
  } catch {
    return { __codesurfTruncated: metadataMarker('metadata access failed') }
  }
  const record = normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized as Record<string, unknown>
    : { value: normalized }
  if (budget.truncated) record.__codesurfTruncated = TRUNCATION_MARKER

  let serialized: string
  try {
    serialized = JSON.stringify(record)
  } catch {
    return { __codesurfTruncated: metadataMarker('serialization failed') }
  }
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_METADATA_BYTES) return record
  return {
    __codesurfTruncated: metadataMarker(`metadata exceeded ${MAX_METADATA_BYTES} bytes`),
  }
}

export function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export function capRetainedEvents(events: RoomEvent[]): RoomEvent[] {
  let next = events
  if (next.length > MAX_EVENTS_PER_ROOM) {
    next = next.slice(next.length - MAX_EVENTS_PER_ROOM)
  }

  let total = next.reduce((sum, event) => sum + serializedBytes(event), 0)
  let start = 0
  while (start < next.length && total > MAX_RETAINED_EVENT_BYTES) {
    total -= serializedBytes(next[start])
    start += 1
  }
  return start > 0 ? next.slice(start) : next
}

export function retainedEventBytes(events: RoomEvent[]): number {
  return events.reduce((sum, event) => sum + serializedBytes(event), 0)
}
