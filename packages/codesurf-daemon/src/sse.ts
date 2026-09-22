import type { DaemonChatJobEvent } from './types.js'
const KIB = 1024
const MIB = 1024 * KIB

export const DAEMON_SSE_LIMITS = Object.freeze({
  maxFrameBytes: MIB,
  maxWireBytes: 16 * MIB,
  maxEventPayloadBytes: 8 * MIB,
  maxErrorBodyBytes: 64 * KIB,
  maxStringBytes: 512 * KIB,
  maxArrayItems: 128,
  maxQuestions: 16,
  maxQuestionOptions: 32,
})

export type DaemonSseLimitKind =
  | 'frame'
  | 'wire'
  | 'event-payload'
  | 'string'
  | 'array'

export class DaemonSseLimitError extends Error {
  readonly kind: DaemonSseLimitKind
  readonly actual: number
  readonly limit: number

  constructor(kind: DaemonSseLimitKind, actual: number, limit: number) {
    super(`Daemon SSE ${kind} limit exceeded (${actual} > ${limit})`)
    this.name = 'DaemonSseLimitError'
    this.kind = kind
    this.actual = actual
    this.limit = limit
  }
}

export class DaemonChatEventValidationError extends Error {
  constructor(message: string) {
    super(`Invalid daemon chat event: ${message}`)
    this.name = 'DaemonChatEventValidationError'
  }
}

export interface ParsedSseJsonBuffer<T> {
  events: T[]
  errors: Error[]
  remaining: string
}

export interface ParseSseJsonBufferOptions {
  maxFrameBytes?: number
}

export interface BoundedSseJsonDecoderOptions extends ParseSseJsonBufferOptions {
  maxWireBytes?: number
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || Number(value) <= 0) return fallback
  return Math.max(1, Math.trunc(Number(value)))
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function assertLimit(kind: DaemonSseLimitKind, actual: number, limit: number): void {
  if (actual > limit) throw new DaemonSseLimitError(kind, actual, limit)
}

function findFrameBoundary(value: string): RegExpExecArray | null {
  return /\r?\n\r?\n/.exec(value)
}

export function parseSseJsonBuffer<T = unknown>(
  buffer: string,
  options: ParseSseJsonBufferOptions = {},
): ParsedSseJsonBuffer<T> {
  const maxFrameBytes = boundedPositiveInteger(
    options.maxFrameBytes,
    DAEMON_SSE_LIMITS.maxFrameBytes,
  )
  const events: T[] = []
  const errors: Error[] = []
  let remaining = buffer
  let boundary = findFrameBoundary(remaining)

  while (boundary) {
    const chunk = remaining.slice(0, boundary.index)
    assertLimit('frame', utf8Bytes(chunk), maxFrameBytes)
    remaining = remaining.slice(boundary.index + boundary[0].length)
    const dataLines = chunk
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())

    if (dataLines.length > 0) {
      try {
        events.push(JSON.parse(dataLines.join('\n')) as T)
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }

    boundary = findFrameBoundary(remaining)
  }

  // This check is what bounds a delimiter-free peer. It runs after all complete
  // frames have been consumed, so a large network chunk containing many small
  // valid frames is accepted while an unending partial frame is not.
  assertLimit('frame', utf8Bytes(remaining), maxFrameBytes)
  return { events, errors, remaining }
}

/** Incremental UTF-8 SSE decoder with per-frame and whole-stream wire limits. */
export class BoundedSseJsonDecoder<T = unknown> {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly maxFrameBytes: number
  private readonly maxWireBytes: number
  private remaining = ''
  private wireBytes = 0
  private finished = false

  constructor(options: BoundedSseJsonDecoderOptions = {}) {
    this.maxFrameBytes = boundedPositiveInteger(
      options.maxFrameBytes,
      DAEMON_SSE_LIMITS.maxFrameBytes,
    )
    this.maxWireBytes = boundedPositiveInteger(
      options.maxWireBytes,
      DAEMON_SSE_LIMITS.maxWireBytes,
    )
  }

  push(chunk: Uint8Array): ParsedSseJsonBuffer<T> {
    if (this.finished) throw new Error('Daemon SSE decoder is already finished')
    this.wireBytes += chunk.byteLength
    assertLimit('wire', this.wireBytes, this.maxWireBytes)
    return this.append(this.decoder.decode(chunk, { stream: true }))
  }

  finish(): ParsedSseJsonBuffer<T> {
    if (this.finished) return { events: [], errors: [], remaining: '' }
    this.finished = true
    const parsed = this.append(this.decoder.decode())
    if (!parsed.remaining.trim()) {
      this.remaining = ''
      return { ...parsed, remaining: '' }
    }

    // Preserve the prior daemon-client behavior of accepting a final data frame
    // without a closing blank line, while still checking that tail as a frame.
    const trailing = parseSseJsonBuffer<T>(`${parsed.remaining}\n\n`, {
      maxFrameBytes: this.maxFrameBytes,
    })
    this.remaining = trailing.remaining
    return {
      events: [...parsed.events, ...trailing.events],
      errors: [...parsed.errors, ...trailing.errors],
      remaining: trailing.remaining,
    }
  }

  private append(decoded: string): ParsedSseJsonBuffer<T> {
    const parsed = parseSseJsonBuffer<T>(`${this.remaining}${decoded}`, {
      maxFrameBytes: this.maxFrameBytes,
    })
    this.remaining = parsed.remaining
    return parsed
  }
}

/** Drains a small HTTP diagnostic body and cancels the stream once capped. */
export async function readBoundedResponseDiagnostic(
  response: Response,
  maxBytes = DAEMON_SSE_LIMITS.maxErrorBodyBytes,
): Promise<string> {
  if (!response.body) return ''
  const limit = boundedPositiveInteger(maxBytes, DAEMON_SSE_LIMITS.maxErrorBodyBytes)
  const declaredBytes = Number(response.headers.get('content-length'))
  const omitted = `Response body omitted: exceeds ${limit} bytes`
  if (Number.isFinite(declaredBytes) && declaredBytes > limit) {
    void response.body.cancel().catch(() => {})
    return omitted
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      if (bytes + value.byteLength > limit) {
        const accepted = value.subarray(0, Math.max(0, limit - bytes))
        text += decoder.decode(accepted)
        void reader.cancel().catch(() => {})
        return `${text}\n...[${omitted}]`
      }
      bytes += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }
}

type JsonRecord = Record<string, unknown>

const DAEMON_CHAT_EVENT_TYPES = new Set([
  'session',
  'text',
  'thinking_start',
  'thinking',
  'reasoning',
  'tool_start',
  'tool_input',
  'tool_use',
  'tool_summary',
  'tool_progress',
  'ask_user_question',
  'tool_permission_request',
  'tool_permission_resolved',
  'block_stop',
  'error',
  'done',
])

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(
  record: JsonRecord,
  key: string,
  maxBytes = DAEMON_SSE_LIMITS.maxStringBytes,
): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new DaemonChatEventValidationError(`${key} must be a non-empty string`)
  }
  assertLimit('string', utf8Bytes(value), maxBytes)
  return value
}

function optionalString(
  record: JsonRecord,
  key: string,
  options: { maxBytes?: number; nullable?: boolean } = {},
): string | null | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (value === null && options.nullable) return null
  if (typeof value !== 'string') {
    throw new DaemonChatEventValidationError(`${key} must be a string${options.nullable ? ' or null' : ''}`)
  }
  assertLimit(
    'string',
    utf8Bytes(value),
    boundedPositiveInteger(options.maxBytes, DAEMON_SSE_LIMITS.maxStringBytes),
  )
  return value
}

function requiredInteger(record: JsonRecord, key: string, minimum = 0): number {
  const value = record[key]
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new DaemonChatEventValidationError(`${key} must be a safe integer >= ${minimum}`)
  }
  return Number(value)
}

function optionalFiniteNumber(
  record: JsonRecord,
  key: string,
  options: { integer?: boolean; minimum?: number } = {},
): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  const minimum = options.minimum ?? 0
  const valid = typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum
    && (!options.integer || Number.isSafeInteger(value))
  if (!valid) throw new DaemonChatEventValidationError(`${key} must be a finite number >= ${minimum}`)
  return value
}

function copyOptionalString(
  source: JsonRecord,
  target: JsonRecord,
  key: string,
  options: { maxBytes?: number; nullable?: boolean } = {},
): void {
  const value = optionalString(source, key, options)
  if (value !== undefined) target[key] = value
}

function copyOptionalNumber(
  source: JsonRecord,
  target: JsonRecord,
  key: string,
  options: { integer?: boolean; minimum?: number } = {},
): void {
  const value = optionalFiniteNumber(source, key, options)
  if (value !== undefined) target[key] = value
}

function boundedArray(record: JsonRecord, key: string, maxItems: number): unknown[] | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new DaemonChatEventValidationError(`${key} must be an array`)
  assertLimit('array', value.length, maxItems)
  return value
}

function sanitizeFileChanges(record: JsonRecord): JsonRecord[] | undefined {
  const values = boundedArray(record, 'fileChanges', DAEMON_SSE_LIMITS.maxArrayItems)
  if (!values) return undefined
  return values.map((value, index) => {
    if (!isRecord(value)) throw new DaemonChatEventValidationError(`fileChanges[${index}] must be an object`)
    const changeType = requiredString(value, 'changeType', 16)
    if (!['add', 'update', 'delete', 'move'].includes(changeType)) {
      throw new DaemonChatEventValidationError(`fileChanges[${index}].changeType is invalid`)
    }
    const result: JsonRecord = {
      path: requiredString(value, 'path', 4 * KIB),
      changeType,
      additions: requiredInteger(value, 'additions'),
      deletions: requiredInteger(value, 'deletions'),
      diff: optionalString(value, 'diff') ?? '',
    }
    copyOptionalString(value, result, 'previousPath', { maxBytes: 4 * KIB })
    return result
  })
}

function sanitizeCommandEntries(record: JsonRecord): JsonRecord[] | undefined {
  const values = boundedArray(record, 'commandEntries', DAEMON_SSE_LIMITS.maxArrayItems)
  if (!values) return undefined
  return values.map((value, index) => {
    if (!isRecord(value)) throw new DaemonChatEventValidationError(`commandEntries[${index}] must be an object`)
    const result: JsonRecord = { label: requiredString(value, 'label', 32 * KIB) }
    copyOptionalString(value, result, 'command', { maxBytes: 64 * KIB })
    copyOptionalString(value, result, 'output')
    const kind = optionalString(value, 'kind', { maxBytes: 16 })
    if (typeof kind === 'string' && !['search', 'read', 'command'].includes(kind)) {
      throw new DaemonChatEventValidationError(`commandEntries[${index}].kind is invalid`)
    }
    if (typeof kind === 'string') result.kind = kind
    return result
  })
}

function sanitizeQuestions(record: JsonRecord): JsonRecord[] | undefined {
  const questions = boundedArray(record, 'questions', DAEMON_SSE_LIMITS.maxQuestions)
  if (!questions) return undefined
  return questions.map((value, questionIndex) => {
    if (!isRecord(value)) throw new DaemonChatEventValidationError(`questions[${questionIndex}] must be an object`)
    const result: JsonRecord = {
      question: requiredString(value, 'question', 16 * KIB),
    }
    copyOptionalString(value, result, 'header', { maxBytes: KIB })
    if (value.multiSelect !== undefined) {
      if (typeof value.multiSelect !== 'boolean') {
        throw new DaemonChatEventValidationError(`questions[${questionIndex}].multiSelect must be a boolean`)
      }
      result.multiSelect = value.multiSelect
    }
    const options = boundedArray(value, 'options', DAEMON_SSE_LIMITS.maxQuestionOptions)
    if (options) {
      result.options = options.map((option, optionIndex) => {
        if (!isRecord(option)) {
          throw new DaemonChatEventValidationError(
            `questions[${questionIndex}].options[${optionIndex}] must be an object`,
          )
        }
        const sanitized: JsonRecord = { label: requiredString(option, 'label', 4 * KIB) }
        copyOptionalString(option, sanitized, 'description', { maxBytes: 8 * KIB })
        copyOptionalString(option, sanitized, 'preview', { maxBytes: 16 * KIB })
        return sanitized
      })
    }
    return result
  })
}

export interface SanitizeDaemonChatJobEventOptions {
  expectedJobId?: string
}

/**
 * Copies only renderer/CLI-supported daemon fields into a fresh plain object.
 * In particular, host-authored trust/provenance flags are never accepted from
 * SSE, and nested arrays are reconstructed from their documented fields.
 */
export function sanitizeDaemonChatJobEvent(
  value: unknown,
  options: SanitizeDaemonChatJobEventOptions = {},
): DaemonChatJobEvent {
  if (!isRecord(value)) throw new DaemonChatEventValidationError('payload must be an object')
  const jobId = requiredString(value, 'jobId', KIB)
  if (options.expectedJobId !== undefined && jobId !== options.expectedJobId) {
    throw new DaemonChatEventValidationError('jobId does not match the requested stream')
  }
  const type = requiredString(value, 'type', 64)
  if (!DAEMON_CHAT_EVENT_TYPES.has(type)) {
    throw new DaemonChatEventValidationError(`unsupported type ${JSON.stringify(type)}`)
  }

  const event: JsonRecord = {
    jobId,
    sequence: requiredInteger(value, 'sequence', 1),
    timestamp: requiredInteger(value, 'timestamp'),
    type,
  }

  if (type === 'session' || type === 'done' || type === 'error') {
    copyOptionalString(value, event, 'sessionId', { maxBytes: 4 * KIB, nullable: true })
  }
  if (['text', 'thinking', 'reasoning', 'tool_input', 'tool_summary'].includes(type)) {
    copyOptionalString(value, event, 'text')
  }
  if (type === 'error') copyOptionalString(value, event, 'error')
  if (['thinking_start', 'thinking', 'reasoning', 'block_stop'].includes(type)) {
    copyOptionalString(value, event, 'thinkingId', { maxBytes: KIB, nullable: true })
  }
  if (type === 'block_stop') copyOptionalNumber(value, event, 'index', { integer: true })
  if (type.startsWith('tool_') || type === 'ask_user_question') {
    copyOptionalString(value, event, 'toolId', { maxBytes: KIB, nullable: true })
    copyOptionalString(value, event, 'toolName', { maxBytes: 4 * KIB, nullable: true })
    copyOptionalString(value, event, 'provider', { maxBytes: KIB, nullable: true })
  }
  if (type === 'tool_use') copyOptionalString(value, event, 'toolInput')
  if (type === 'tool_summary') {
    const fileChanges = sanitizeFileChanges(value)
    const commandEntries = sanitizeCommandEntries(value)
    if (fileChanges) event.fileChanges = fileChanges
    if (commandEntries) event.commandEntries = commandEntries
  }
  if (type === 'tool_progress') copyOptionalNumber(value, event, 'elapsed')
  if (type === 'ask_user_question') {
    const questions = sanitizeQuestions(value)
    if (questions) event.questions = questions
  }
  if (type === 'tool_permission_request') {
    copyOptionalString(value, event, 'title', { nullable: true })
    copyOptionalString(value, event, 'description', { nullable: true })
    copyOptionalString(value, event, 'blockedPath', { maxBytes: 4 * KIB, nullable: true })
    copyOptionalString(value, event, 'workspaceDir', { maxBytes: 4 * KIB, nullable: true })
  }
  if (type === 'tool_permission_resolved') {
    const decision = optionalString(value, 'decision', { maxBytes: 16 })
    if (typeof decision === 'string' && !['deny', 'never', 'once', 'session', 'today', 'forever'].includes(decision)) {
      throw new DaemonChatEventValidationError('decision is invalid')
    }
    if (typeof decision === 'string') event.decision = decision
  }
  if (type === 'done') {
    copyOptionalNumber(value, event, 'cost')
    copyOptionalNumber(value, event, 'turns', { integer: true })
  }

  return event as DaemonChatJobEvent
}

export interface DaemonChatEventBudgetOptions extends SanitizeDaemonChatJobEventOptions {
  maxEventPayloadBytes?: number
}

/** Whole-turn budget for sanitized, model-visible daemon event payloads. */
export class DaemonChatEventBudget {
  private readonly options: SanitizeDaemonChatJobEventOptions
  private readonly maxEventPayloadBytes: number
  private eventPayloadBytes = 0

  constructor(options: DaemonChatEventBudgetOptions = {}) {
    this.options = { expectedJobId: options.expectedJobId }
    this.maxEventPayloadBytes = boundedPositiveInteger(
      options.maxEventPayloadBytes,
      DAEMON_SSE_LIMITS.maxEventPayloadBytes,
    )
  }

  sanitize(value: unknown): DaemonChatJobEvent {
    return sanitizeDaemonChatJobEvent(value, this.options)
  }

  consume(event: DaemonChatJobEvent): DaemonChatJobEvent {
    this.eventPayloadBytes += utf8Bytes(JSON.stringify(event))
    assertLimit('event-payload', this.eventPayloadBytes, this.maxEventPayloadBytes)
    return event
  }

  accept(value: unknown): DaemonChatJobEvent {
    return this.consume(this.sanitize(value))
  }
}
