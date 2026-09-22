import { StringDecoder } from 'node:string_decoder'

export const MANAGED_LOCAL_PROXY_LIMITS = Object.freeze({
  requestBodyBytes: 1024 * 1024,
  backendBodyBytes: 4 * 1024 * 1024,
  backendProbeBytes: 64 * 1024,
  streamLineBytes: 256 * 1024,
  streamAggregateBytes: 8 * 1024 * 1024,
  streamBackpressureBytes: 512 * 1024,
})

export type LocalProxyLimitKind =
  | 'request-body'
  | 'backend-body'
  | 'stream-line'
  | 'stream-aggregate'
  | 'stream-backpressure'

export class LocalProxyLimitError extends Error {
  readonly kind: LocalProxyLimitKind
  readonly maxBytes: number

  constructor(kind: LocalProxyLimitKind, maxBytes: number) {
    super(`Managed local proxy ${kind} exceeded ${maxBytes} bytes`)
    this.name = 'LocalProxyLimitError'
    this.kind = kind
    this.maxBytes = maxBytes
  }
}

export class BoundedProxyBody {
  private readonly chunks: Buffer[] = []
  private readonly maxBytes: number
  private readonly kind: Extract<LocalProxyLimitKind, 'request-body' | 'backend-body'>
  private totalBytes = 0

  constructor(
    maxBytes: number,
    kind: Extract<LocalProxyLimitKind, 'request-body' | 'backend-body'>,
  ) {
    this.maxBytes = maxBytes
    this.kind = kind
  }

  append(chunk: Uint8Array | string): void {
    const value = typeof chunk === 'string'
      ? Buffer.from(chunk, 'utf8')
      : Buffer.from(chunk)
    if (this.totalBytes + value.byteLength > this.maxBytes) {
      throw new LocalProxyLimitError(this.kind, this.maxBytes)
    }
    this.chunks.push(value)
    this.totalBytes += value.byteLength
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.totalBytes).toString('utf8')
  }

  get byteLength(): number {
    return this.totalBytes
  }
}

export class BoundedProxyLineDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private readonly maxLineBytes: number
  private readonly maxAggregateBytes: number
  private partial = ''
  private aggregateBytes = 0

  constructor(
    maxLineBytes: number,
    maxAggregateBytes: number,
  ) {
    this.maxLineBytes = maxLineBytes
    this.maxAggregateBytes = maxAggregateBytes
  }

  push(chunk: Uint8Array | string): string[] {
    const value = typeof chunk === 'string'
      ? Buffer.from(chunk, 'utf8')
      : Buffer.from(chunk)
    if (this.aggregateBytes + value.byteLength > this.maxAggregateBytes) {
      throw new LocalProxyLimitError('stream-aggregate', this.maxAggregateBytes)
    }
    this.aggregateBytes += value.byteLength
    return this.acceptDecoded(this.decoder.write(value))
  }

  flush(): string | null {
    this.acceptDecoded(this.decoder.end())
    if (!this.partial) return null
    this.assertLineFits(this.partial)
    const line = this.partial.endsWith('\r')
      ? this.partial.slice(0, -1)
      : this.partial
    this.partial = ''
    return line
  }

  private acceptDecoded(decoded: string): string[] {
    if (!decoded) return []

    const complete = `${this.partial}${decoded}`.split('\n')
    this.partial = complete.pop() ?? ''
    this.assertLineFits(this.partial)

    return complete.map(rawLine => {
      this.assertLineFits(rawLine)
      return rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    })
  }

  private assertLineFits(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
      throw new LocalProxyLimitError('stream-line', this.maxLineBytes)
    }
  }

  get byteLength(): number {
    return this.aggregateBytes
  }
}

export class BoundedProxyLineQueue {
  private lines: string[] = []
  private totalBytes = 0
  private readonly maxBytes: number

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
  }

  append(line: string): void {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1
    if (this.totalBytes + lineBytes > this.maxBytes) {
      throw new LocalProxyLimitError('stream-backpressure', this.maxBytes)
    }
    this.lines.push(line)
    this.totalBytes += lineBytes
  }

  drain(): string[] {
    const lines = this.lines
    this.lines = []
    this.totalBytes = 0
    return lines
  }

  get byteLength(): number {
    return this.totalBytes
  }

  get length(): number {
    return this.lines.length
  }
}

export class OneShotProxyLifecycle {
  private terminal = false

  get active(): boolean {
    return !this.terminal
  }

  finish(): boolean {
    if (this.terminal) return false
    this.terminal = true
    return true
  }

  runIfActive(effect: () => void): boolean {
    if (this.terminal) return false
    effect()
    return true
  }
}

export class ProxyBackpressureGate {
  private blocked = false
  private terminal = false

  get isBlocked(): boolean {
    return this.blocked
  }

  block(pause: () => void): boolean {
    if (this.terminal || this.blocked) return false
    this.blocked = true
    pause()
    return true
  }

  release(): boolean {
    if (this.terminal || !this.blocked) return false
    this.blocked = false
    return true
  }

  finish(): void {
    this.terminal = true
    this.blocked = false
  }
}

export class LocalProxyProtocolTerminalTracker {
  private readonly decoder: BoundedProxyLineDecoder
  private proven = false
  private invalid = false
  private malformed = false
  private limitViolation: LocalProxyLimitError | null = null

  constructor(
    maxLineBytes = MANAGED_LOCAL_PROXY_LIMITS.streamLineBytes,
    maxAggregateBytes = MANAGED_LOCAL_PROXY_LIMITS.streamAggregateBytes,
  ) {
    this.decoder = new BoundedProxyLineDecoder(maxLineBytes, maxAggregateBytes)
  }

  push(chunk: Uint8Array | string): void {
    if (this.proven) return
    if (this.limitViolation) throw this.limitViolation
    if (this.invalid) return
    try {
      for (const line of this.decoder.push(chunk)) this.inspect(line)
    } catch (error) {
      this.invalid = true
      if (error instanceof LocalProxyLimitError) {
        this.limitViolation = error
        throw error
      }
      throw error
    }
  }

  private inspect(line: string): void {
    // Match the actual parser grammar exactly. In particular, leading
    // whitespace and `data:` without the required space are not valid proof:
    // parseClaudeStream ignores those lines and must not later accept its
    // synthetic EOF `done` as an explicitly terminated provider response.
    if (!line.startsWith('data: ')) return
    const data = line.slice(6).trim()
    if (data === '[DONE]') {
      this.proven = !this.malformed
      return
    }
    try {
      const parsed = JSON.parse(data) as unknown
      if (parsed
        && typeof parsed === 'object'
        && !Array.isArray(parsed)
        && (parsed as { type?: unknown }).type === 'message_stop') {
        this.proven = !this.malformed
      }
    } catch {
      // Malformed data is not evidence of provider acceptance.
      this.malformed = true
    }
  }

  get hasProvenTerminal(): boolean {
    return this.proven
  }

  get hasViolation(): boolean {
    return this.limitViolation !== null
  }
}

export type LocalProxyParserDoneClassification =
  | 'complete'
  | 'missing-terminal'
  | 'reported-error'

export function classifyLocalProxyParserDone(
  hasProvenTerminal: boolean,
  hasReportedError: boolean,
): LocalProxyParserDoneClassification {
  if (hasProvenTerminal) return 'complete'
  return hasReportedError ? 'reported-error' : 'missing-terminal'
}

export function monitorLocalProxyProtocolChunk(
  tracker: LocalProxyProtocolTerminalTracker,
  chunk: Uint8Array | string,
  reportViolation: (error: LocalProxyLimitError) => void,
): boolean {
  try {
    tracker.push(chunk)
    return true
  } catch (error) {
    if (!(error instanceof LocalProxyLimitError)) throw error
    reportViolation(error)
    return false
  }
}

export class SerializedProxyOperationLane {
  private tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

/**
 * Invalidates lifecycle operations that were queued before a stop request.
 * Capturing the epoch at API entry (rather than when a serialized operation
 * eventually starts) prevents an older queued start from resurrecting a proxy
 * after stop has already revoked the current listener.
 */
export class ProxyLifecycleEpoch {
  private epoch = 0

  capture(): number {
    return this.epoch
  }

  invalidate(): number {
    this.epoch += 1
    return this.epoch
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.epoch
  }
}

export interface ProxyResourceLease<T> {
  readonly generation: number
  readonly value: T
}

export class GenerationOwnedProxyResource<T> {
  private generation = 0
  private lease: ProxyResourceLease<T> | null = null

  claim(value: T): ProxyResourceLease<T> {
    const lease = { generation: ++this.generation, value }
    this.lease = lease
    return lease
  }

  owns(lease: ProxyResourceLease<T>): boolean {
    return this.lease === lease
  }

  release(lease: ProxyResourceLease<T>): boolean {
    if (!this.owns(lease)) return false
    this.lease = null
    return true
  }

  get currentLease(): ProxyResourceLease<T> | null {
    return this.lease
  }

  get current(): T | null {
    return this.lease?.value ?? null
  }
}

export function revokeManagedProxyResource<T>(
  owner: GenerationOwnedProxyResource<T>,
  lease: ProxyResourceLease<T>,
  closeResource: (value: T) => void,
): boolean {
  if (!owner.release(lease)) return false
  closeResource(lease.value)
  return true
}

export async function findFirstLiveLocalProxyBackend<T>(
  candidates: readonly T[],
  probe: (candidate: T, signal?: AbortSignal) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<T | null> {
  for (const candidate of candidates) {
    if (signal?.aborted) return null
    const live = await probe(candidate, signal)
    if (signal?.aborted) return null
    if (live) return candidate
  }
  return null
}

export function localProxyClientCanContinue(
  signal: AbortSignal | undefined,
  responseDestroyed: boolean,
  responseEnded: boolean,
): boolean {
  return signal?.aborted !== true && !responseDestroyed && !responseEnded
}

export type LocalProxyBackendProbeKind =
  | 'ollama-tags'
  | 'lmstudio-v1-models'
  | 'lmstudio-v0-models'
  | 'llamacpp-health'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'application/json' || mediaType?.endsWith('+json') === true
}

export function isVerifiedLocalProxyBackendProbe(
  kind: LocalProxyBackendProbeKind,
  statusCode: number | undefined,
  contentType: string | undefined,
  rawBody: string,
): boolean {
  if (statusCode !== 200 || !isJsonContentType(contentType)) return false

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return false
  }
  if (!isRecord(parsed)) return false

  switch (kind) {
    case 'ollama-tags':
      return Array.isArray(parsed.models)
        && parsed.models.every(model => (
          isRecord(model)
          && typeof model.name === 'string'
          && typeof model.model === 'string'
        ))
    case 'lmstudio-v1-models':
      return Array.isArray(parsed.models)
        && parsed.models.every(model => (
          isRecord(model)
          && (model.type === 'llm' || model.type === 'embedding')
          && typeof model.key === 'string'
        ))
    case 'lmstudio-v0-models':
      return parsed.object === 'list'
        && Array.isArray(parsed.data)
        && parsed.data.every(model => (
          isRecord(model)
          && model.object === 'model'
          && typeof model.id === 'string'
        ))
    case 'llamacpp-health':
      return parsed.status === 'ok'
  }
}

export function localProxyRequestCloseNeedsFailure(responseObserved: boolean): boolean {
  return !responseObserved
}

export interface ManagedProxyStreamFailureActions {
  backpressureBlocked: boolean
  writeError: () => boolean
  finishGracefully: () => void
  destroyTransport: (error: Error) => void
}

export function reportManagedProxyStreamFailure(
  message: string,
  actions: ManagedProxyStreamFailureActions,
): 'reported' | 'destroyed' {
  const destroy = (): 'destroyed' => {
    actions.destroyTransport(new Error(message))
    return 'destroyed'
  }
  if (actions.backpressureBlocked) return destroy()
  if (!actions.writeError()) return destroy()
  actions.finishGracefully()
  return 'reported'
}

export type ForwardableLocalProxyRole = 'user' | 'assistant'

export function assertForwardableLocalProxyRole(value: unknown): ForwardableLocalProxyRole {
  if (value === 'user' || value === 'assistant') return value
  throw new Error('Message role must be user or assistant')
}
