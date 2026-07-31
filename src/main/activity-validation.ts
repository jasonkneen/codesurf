import type {
  ActivityMetadata,
  ActivityQuery,
  ActivityRecord,
  ActivityStatus,
  ActivityType,
  ActivityUpsertInput,
} from '../shared/activity-types.ts'
import { ACTIVITY_LIMITS } from '../shared/activity-types.ts'
import { MAX_ACTIVITY_RECORDS } from './activity-cap.ts'
import { assertSafeWorkspaceArtifactId } from './storage/workspaceArtifacts.ts'

export const ACTIVITY_DOCUMENT_VERSION = 1
export const MAX_ACTIVITY_FILE_BYTES = 32 * 1024 * 1024
export const MAX_ACTIVITY_WORKSPACE_ID_LENGTH = ACTIVITY_LIMITS.workspaceId
export const MAX_ACTIVITY_TILE_ID_LENGTH = ACTIVITY_LIMITS.tileId
export const MAX_ACTIVITY_ID_LENGTH = ACTIVITY_LIMITS.id
export const MAX_ACTIVITY_TITLE_LENGTH = ACTIVITY_LIMITS.title
export const MAX_ACTIVITY_DETAIL_LENGTH = ACTIVITY_LIMITS.detail
export const MAX_ACTIVITY_AGENT_LENGTH = ACTIVITY_LIMITS.agent
export const MAX_ACTIVITY_METADATA_BYTES = ACTIVITY_LIMITS.metadataBytes
export const MAX_ACTIVITY_QUERY_LIMIT = 500
export const MAX_ACTIVITY_QUERY_RESPONSE_BYTES = 1024 * 1024

const ACTIVITY_TYPES = new Set<ActivityType>(['task', 'tool', 'skill', 'context'])
const ACTIVITY_STATUSES = new Set<ActivityStatus>(['pending', 'running', 'done', 'error', 'paused'])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const MAX_METADATA_KEY_LENGTH = 128
const MAX_METADATA_STRING_LENGTH = ACTIVITY_LIMITS.metadataString

export interface ParsedActivityDocument {
  records: ActivityRecord[]
  needsRewrite: boolean
}

export interface RecoveredActivityDocument extends ParsedActivityDocument {
  requiresQuarantine: boolean
  issueCode?: string
}

export class ActivityValidationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ActivityValidationError'
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new ActivityValidationError(code, message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail('invalid_object', `${label} must be an object`)
  return value
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('unknown_field', `${label} contains unknown field "${key}"`)
  }
}

function boundedString(
  value: unknown,
  label: string,
  maxLength: number,
  options: { allowEmpty?: boolean, identifier?: boolean } = {},
): string {
  if (typeof value !== 'string') fail('invalid_string', `${label} must be a string`)
  if (value.length > maxLength) fail('input_too_large', `${label} exceeds ${maxLength} characters`)
  if (!options.allowEmpty && value.length === 0) fail('invalid_string', `${label} cannot be empty`)
  if (value !== value.trim()) fail('non_canonical_string', `${label} cannot have surrounding whitespace`)
  if (CONTROL_CHARACTERS.test(value)) fail('invalid_string', `${label} contains control characters`)
  if (options.identifier && (value === '.' || value === '..')) {
    fail('invalid_identifier', `${label} is not a valid identifier`)
  }
  return value
}

function optionalBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
  options: { allowEmpty?: boolean, identifier?: boolean } = {},
): string | undefined {
  if (value === undefined) return undefined
  return boundedString(value, label, maxLength, options)
}

export function validateActivityWorkspaceId(value: unknown): string {
  const workspaceId = boundedString(
    value,
    'workspaceId',
    MAX_ACTIVITY_WORKSPACE_ID_LENGTH,
    { identifier: true },
  )
  try {
    assertSafeWorkspaceArtifactId(workspaceId)
  } catch {
    fail('invalid_workspace_id', 'workspaceId is not a canonical workspace artifact identifier')
  }
  return workspaceId
}

export function validateActivityTileId(value: unknown): string {
  return boundedString(value, 'tileId', MAX_ACTIVITY_TILE_ID_LENGTH, { identifier: true })
}

export function validateActivityId(value: unknown): string {
  return boundedString(value, 'activity id', MAX_ACTIVITY_ID_LENGTH, { identifier: true })
}

function validateActivityType(value: unknown): ActivityType {
  if (typeof value !== 'string' || !ACTIVITY_TYPES.has(value as ActivityType)) {
    fail('invalid_activity_type', 'type is not a supported activity type')
  }
  return value as ActivityType
}

function validateActivityStatus(value: unknown): ActivityStatus {
  if (typeof value !== 'string' || !ACTIVITY_STATUSES.has(value as ActivityStatus)) {
    fail('invalid_activity_status', 'status is not a supported activity status')
  }
  return value as ActivityStatus
}

export function validateActivityMetadata(value: unknown): ActivityMetadata | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) fail('invalid_metadata', 'metadata must be an object')
  const rawEntries = Object.entries(value)
  if (rawEntries.length > ACTIVITY_LIMITS.metadataKeys) {
    fail('metadata_too_complex', `metadata exceeds ${ACTIVITY_LIMITS.metadataKeys} fields`)
  }
  const entries: Array<[string, string | number | boolean | null]> = []
  for (const [key, child] of rawEntries) {
    if (!key || key.length > MAX_METADATA_KEY_LENGTH || CONTROL_CHARACTERS.test(key)) {
      fail('invalid_metadata', 'metadata contains an invalid key')
    }
    if (child === null || typeof child === 'boolean') {
      entries.push([key, child])
    } else if (typeof child === 'number' && Number.isFinite(child)) {
      entries.push([key, child])
    } else if (typeof child === 'string') {
      if (child.length > MAX_METADATA_STRING_LENGTH) {
        fail('input_too_large', `metadata.${key} exceeds ${MAX_METADATA_STRING_LENGTH} characters`)
      }
      entries.push([key, child])
    } else {
      fail('invalid_metadata', 'metadata values must be scalar JSON values')
    }
  }
  const metadata = Object.fromEntries(entries)
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_ACTIVITY_METADATA_BYTES) {
    fail('input_too_large', `metadata exceeds ${MAX_ACTIVITY_METADATA_BYTES} bytes`)
  }
  return metadata as ActivityMetadata
}

export function validateActivityUpsertInput(value: unknown): ActivityUpsertInput {
  const data = assertObject(value, 'activity')
  assertKnownKeys(data, new Set([
    'id',
    'tileId',
    'type',
    'status',
    'title',
    'detail',
    'metadata',
    'agent',
  ]), 'activity')

  const id = optionalBoundedString(data.id, 'activity id', MAX_ACTIVITY_ID_LENGTH, { identifier: true })
  const status = data.status === undefined ? undefined : validateActivityStatus(data.status)
  const detail = optionalBoundedString(
    data.detail,
    'detail',
    MAX_ACTIVITY_DETAIL_LENGTH,
    { allowEmpty: true },
  )
  const agent = optionalBoundedString(data.agent, 'agent', MAX_ACTIVITY_AGENT_LENGTH)
  const metadata = validateActivityMetadata(data.metadata)

  return {
    ...(id === undefined ? {} : { id }),
    tileId: validateActivityTileId(data.tileId),
    type: validateActivityType(data.type),
    ...(status === undefined ? {} : { status }),
    title: boundedString(data.title, 'title', MAX_ACTIVITY_TITLE_LENGTH),
    ...(detail === undefined ? {} : { detail }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(agent === undefined ? {} : { agent }),
  }
}

export function validateActivityQuery(value: unknown): ActivityQuery {
  const query = assertObject(value, 'query')
  assertKnownKeys(query, new Set([
    'workspaceId',
    'tileId',
    'type',
    'status',
    'agent',
    'limit',
  ]), 'query')

  let limit: number | undefined
  if (query.limit !== undefined) {
    if (!Number.isSafeInteger(query.limit) || (query.limit as number) < 1 || (query.limit as number) > MAX_ACTIVITY_QUERY_LIMIT) {
      fail('invalid_limit', `limit must be an integer between 1 and ${MAX_ACTIVITY_QUERY_LIMIT}`)
    }
    limit = query.limit as number
  }

  const tileId = query.tileId === undefined ? undefined : validateActivityTileId(query.tileId)
  const type = query.type === undefined ? undefined : validateActivityType(query.type)
  const status = query.status === undefined ? undefined : validateActivityStatus(query.status)
  const agent = optionalBoundedString(query.agent, 'agent', MAX_ACTIVITY_AGENT_LENGTH)
  return {
    workspaceId: validateActivityWorkspaceId(query.workspaceId),
    ...(tileId === undefined ? {} : { tileId }),
    ...(type === undefined ? {} : { type }),
    ...(status === undefined ? {} : { status }),
    ...(agent === undefined ? {} : { agent }),
    ...(limit === undefined ? {} : { limit }),
  }
}

function validateTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('invalid_timestamp', `${label} must be a non-negative integer`)
  }
  return value as number
}

export function validateActivityRecord(value: unknown, workspaceId: string): ActivityRecord {
  const record = assertObject(value, 'activity record')
  assertKnownKeys(record, new Set([
    'id',
    'tileId',
    'workspaceId',
    'type',
    'status',
    'title',
    'detail',
    'metadata',
    'agent',
    'createdAt',
    'updatedAt',
  ]), 'activity record')
  const recordWorkspaceId = validateActivityWorkspaceId(record.workspaceId)
  if (recordWorkspaceId !== workspaceId) {
    fail('workspace_mismatch', 'activity record belongs to a different workspace')
  }
  const createdAt = validateTimestamp(record.createdAt, 'createdAt')
  const updatedAt = validateTimestamp(record.updatedAt, 'updatedAt')
  if (updatedAt < createdAt) fail('invalid_timestamp', 'updatedAt cannot precede createdAt')

  const detail = optionalBoundedString(
    record.detail,
    'detail',
    MAX_ACTIVITY_DETAIL_LENGTH,
    { allowEmpty: true },
  )
  const metadata = validateActivityMetadata(record.metadata)
  const agent = optionalBoundedString(record.agent, 'agent', MAX_ACTIVITY_AGENT_LENGTH)
  return {
    id: validateActivityId(record.id),
    tileId: validateActivityTileId(record.tileId),
    workspaceId: recordWorkspaceId,
    type: validateActivityType(record.type),
    status: validateActivityStatus(record.status),
    title: boundedString(record.title, 'title', MAX_ACTIVITY_TITLE_LENGTH),
    ...(detail === undefined ? {} : { detail }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(agent === undefined ? {} : { agent }),
    createdAt,
    updatedAt,
  }
}

function compactRecoveredRecords(
  entries: Array<{ record: ActivityRecord, order: number }>,
): {
  entries: Array<{ record: ActivityRecord, order: number }>
  hadDuplicates: boolean
} {
  entries.sort((left, right) => (
    right.record.updatedAt - left.record.updatedAt
    || right.order - left.order
  ))
  const identities = new Set<string>()
  const compacted: typeof entries = []
  let hadDuplicates = false
  for (const entry of entries) {
    const identity = `${entry.record.tileId}\0${entry.record.id}`
    if (identities.has(identity)) {
      hadDuplicates = true
      continue
    }
    identities.add(identity)
    compacted.push(entry)
    if (compacted.length === MAX_ACTIVITY_RECORDS) break
  }
  return { entries: compacted, hadDuplicates }
}

/**
 * Recover independently valid rows while retaining at most two cap-sized
 * batches during validation. The source JSON is separately byte-bounded by
 * persistence before this function is called.
 */
export function recoverActivityDocument(
  value: unknown,
  workspaceIdValue: unknown,
): RecoveredActivityDocument {
  const workspaceId = validateActivityWorkspaceId(workspaceIdValue)
  let rawRecords: unknown[]
  let needsRewrite = false
  let requiresQuarantine = false
  let issueCode: string | undefined

  if (Array.isArray(value)) {
    rawRecords = value
    needsRewrite = true
  } else {
    if (!isPlainObject(value)) {
      return {
        records: [],
        needsRewrite: true,
        requiresQuarantine: true,
        issueCode: 'invalid_object',
      }
    }
    const document = value
    if (!Number.isSafeInteger(document.version)) {
      return {
        records: [],
        needsRewrite: true,
        requiresQuarantine: true,
        issueCode: 'invalid_document_version',
      }
    }
    if ((document.version as number) > ACTIVITY_DOCUMENT_VERSION) {
      fail('future_document_version', 'activity document was written by a newer CodeSurf version')
    }
    if (document.version !== ACTIVITY_DOCUMENT_VERSION) {
      return {
        records: [],
        needsRewrite: true,
        requiresQuarantine: true,
        issueCode: 'invalid_document_version',
      }
    }
    for (const key of Object.keys(document)) {
      if (key !== 'version' && key !== 'records') {
        requiresQuarantine = true
        needsRewrite = true
        issueCode ??= 'unknown_field'
      }
    }
    if (!Array.isArray(document.records)) {
      return {
        records: [],
        needsRewrite: true,
        requiresQuarantine: true,
        issueCode: 'invalid_records',
      }
    }
    rawRecords = document.records
  }

  if (rawRecords.length > MAX_ACTIVITY_RECORDS) needsRewrite = true
  let retained: Array<{ record: ActivityRecord, order: number }> = []
  for (let order = 0; order < rawRecords.length; order += 1) {
    try {
      retained.push({
        record: validateActivityRecord(rawRecords[order], workspaceId),
        order,
      })
    } catch (error) {
      requiresQuarantine = true
      needsRewrite = true
      issueCode ??= error instanceof ActivityValidationError ? error.code : 'invalid_record'
    }
    if (retained.length >= MAX_ACTIVITY_RECORDS * 2) {
      const compacted = compactRecoveredRecords(retained)
      retained = compacted.entries
      if (compacted.hadDuplicates) {
        requiresQuarantine = true
        needsRewrite = true
        issueCode ??= 'duplicate_activity_identity'
      }
    }
  }
  const compacted = compactRecoveredRecords(retained)
  if (compacted.hadDuplicates) {
    requiresQuarantine = true
    needsRewrite = true
    issueCode ??= 'duplicate_activity_identity'
  }
  return {
    records: compacted.entries.map(entry => entry.record),
    needsRewrite,
    requiresQuarantine,
    ...(issueCode === undefined ? {} : { issueCode }),
  }
}

export function parseActivityDocument(value: unknown, workspaceIdValue: unknown): ParsedActivityDocument {
  const recovered = recoverActivityDocument(value, workspaceIdValue)
  if (recovered.requiresQuarantine) {
    fail(
      recovered.issueCode ?? 'invalid_document',
      'activity document contains invalid or conflicting data',
    )
  }
  return {
    records: recovered.records,
    needsRewrite: recovered.needsRewrite,
  }
}
