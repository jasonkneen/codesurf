import {
  estimateTokenCount,
  MAX_PROMPT_BYTES,
  MAX_PROMPT_ESTIMATED_TOKENS,
} from '../agent-room/validation.ts'

export const EARLIER_OUTPUT_TRUNCATED = '[earlier output truncated]\n'
export const MAX_PROVIDER_ACCUMULATED_OUTPUT_BYTES = 256 * 1024
export const MAX_PROVIDER_DIAGNOSTIC_BYTES = 64 * 1024
export const MAX_PROVIDER_STREAM_FRAME_BYTES = 256 * 1024
export const MAX_PROVIDER_DEDUP_TAIL_BYTES = 64 * 1024

function utf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || !value) return ''
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.length <= maxBytes) return value

  let start = encoded.length - maxBytes
  while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start += 1
  return encoded.subarray(start).toString('utf8')
}

export function appendBoundedSuffix(current: string, chunk: string, maxBytes: number): string {
  if (!chunk || maxBytes <= 0) return maxBytes <= 0 ? '' : utf8Tail(current, maxBytes)

  const chunkBytes = Buffer.byteLength(chunk, 'utf8')
  if (chunkBytes >= maxBytes) return utf8Tail(chunk, maxBytes)

  const retainedCurrent = utf8Tail(current, maxBytes - chunkBytes)
  return `${retainedCurrent}${chunk}`
}

export class BoundedTextAccumulator {
  private retained = ''
  private didTruncate = false
  private readonly maxBytes: number
  private readonly marker: string

  constructor(maxBytes: number, marker = EARLIER_OUTPUT_TRUNCATED) {
    this.maxBytes = maxBytes
    this.marker = marker
  }

  append(chunk: string): void {
    if (!chunk) return
    if (this.maxBytes <= 0) {
      this.retained = ''
      this.didTruncate = true
      return
    }

    const currentBytes = Buffer.byteLength(this.retained, 'utf8')
    const chunkBytes = Buffer.byteLength(chunk, 'utf8')
    if (!this.didTruncate && currentBytes + chunkBytes <= this.maxBytes) {
      this.retained += chunk
      return
    }

    this.didTruncate = true
    const boundedMarker = utf8Tail(this.marker, this.maxBytes)
    const contentBudget = Math.max(0, this.maxBytes - Buffer.byteLength(boundedMarker, 'utf8'))
    const currentContent = this.retained.startsWith(boundedMarker)
      ? this.retained.slice(boundedMarker.length)
      : this.retained
    this.retained = `${boundedMarker}${appendBoundedSuffix(currentContent, chunk, contentBudget)}`
  }

  get value(): string {
    return this.retained
  }

  get truncated(): boolean {
    return this.didTruncate
  }
}

function fitsTextBudget(value: string, maxBytes: number, maxEstimatedTokens: number): boolean {
  return (
    Buffer.byteLength(value, 'utf8') <= maxBytes
    && estimateTokenCount(value) <= maxEstimatedTokens
  )
}

export function boundRecentText(
  value: string,
  maxBytes: number,
  maxEstimatedTokens: number,
  marker = EARLIER_OUTPUT_TRUNCATED,
): string {
  if (fitsTextBudget(value, maxBytes, maxEstimatedTokens)) return value

  const boundedMarker = utf8Tail(marker, maxBytes)
  if (!fitsTextBudget(boundedMarker, maxBytes, maxEstimatedTokens)) return ''

  const source = value.startsWith(marker) ? value.slice(marker.length) : value
  const contentByteBudget = Math.max(
    0,
    maxBytes - Buffer.byteLength(boundedMarker, 'utf8'),
  )
  // Bound by bytes before splitting into code points so a hostile provider
  // cannot make the token-bound search allocate an array for its whole output.
  const characters = Array.from(utf8Tail(source, contentByteBudget))
  let low = 0
  let high = characters.length
  while (low < high) {
    const midpoint = Math.floor((low + high) / 2)
    const candidate = `${boundedMarker}${characters.slice(midpoint).join('')}`
    if (fitsTextBudget(candidate, maxBytes, maxEstimatedTokens)) {
      high = midpoint
    } else {
      low = midpoint + 1
    }
  }

  return `${boundedMarker}${characters.slice(low).join('')}`
}

export function boundProviderHistoryText(value: string): string {
  return boundRecentText(value, MAX_PROMPT_BYTES, MAX_PROMPT_ESTIMATED_TOKENS)
}

/**
 * Bounds partial NDJSON/SSE frames. Once an incomplete frame crosses the
 * limit, the decoder drops bytes until the next newline and then resumes,
 * avoiding both unbounded retention and parsing a misleading truncated tail.
 */
export class BoundedLineDecoder {
  private partial = ''
  private droppingOversizedFrame = false
  private dropped = 0
  private readonly maxFrameBytes: number

  constructor(maxFrameBytes = MAX_PROVIDER_STREAM_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes
  }

  push(chunk: string): string[] {
    const lines: string[] = []
    let offset = 0

    while (offset < chunk.length) {
      if (this.droppingOversizedFrame) {
        const newline = chunk.indexOf('\n', offset)
        if (newline < 0) return lines
        this.droppingOversizedFrame = false
        offset = newline + 1
        continue
      }

      const newline = chunk.indexOf('\n', offset)
      const end = newline < 0 ? chunk.length : newline
      const segment = chunk.slice(offset, end)
      const segmentBytes = Buffer.byteLength(segment, 'utf8')
      const partialBytes = Buffer.byteLength(this.partial, 'utf8')

      if (partialBytes + segmentBytes > this.maxFrameBytes) {
        this.partial = ''
        this.dropped += 1
        if (newline < 0) this.droppingOversizedFrame = true
      } else if (newline < 0) {
        this.partial += segment
      } else {
        lines.push(`${this.partial}${segment}`)
        this.partial = ''
      }

      if (newline < 0) break
      offset = newline + 1
    }

    return lines
  }

  flush(): string | null {
    if (this.droppingOversizedFrame) {
      this.droppingOversizedFrame = false
      return null
    }
    const line = this.partial
    this.partial = ''
    return line || null
  }

  get droppedFrames(): number {
    return this.dropped
  }
}
