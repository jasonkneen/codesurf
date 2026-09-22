export interface ElectrobunProcessOutputLimits {
  maxStdoutBytes: number
  maxStderrBytes: number
  maxLineBytes: number
  maxAggregateBytes: number
}

export const DEFAULT_ELECTROBUN_PROCESS_OUTPUT_LIMITS: ElectrobunProcessOutputLimits = {
  maxStdoutBytes: 8 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  maxLineBytes: 1024 * 1024,
  maxAggregateBytes: 8 * 1024 * 1024,
}

function positiveLimit(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback
}

export function normalizeElectrobunProcessOutputLimits(
  limits: Partial<ElectrobunProcessOutputLimits> | undefined,
): ElectrobunProcessOutputLimits {
  return {
    maxStdoutBytes: positiveLimit(
      limits?.maxStdoutBytes,
      DEFAULT_ELECTROBUN_PROCESS_OUTPUT_LIMITS.maxStdoutBytes,
    ),
    maxStderrBytes: positiveLimit(
      limits?.maxStderrBytes,
      DEFAULT_ELECTROBUN_PROCESS_OUTPUT_LIMITS.maxStderrBytes,
    ),
    maxLineBytes: positiveLimit(
      limits?.maxLineBytes,
      DEFAULT_ELECTROBUN_PROCESS_OUTPUT_LIMITS.maxLineBytes,
    ),
    maxAggregateBytes: positiveLimit(
      limits?.maxAggregateBytes,
      DEFAULT_ELECTROBUN_PROCESS_OUTPUT_LIMITS.maxAggregateBytes,
    ),
  }
}

type ProcessStreamName = 'stdout' | 'stderr'

export class ElectrobunProcessOutputBudget {
  private stdoutBytes = 0
  private stderrBytes = 0
  private stdoutLineBytes = 0
  private stderrLineBytes = 0
  private readonly limits: ElectrobunProcessOutputLimits

  constructor(limits: ElectrobunProcessOutputLimits) {
    this.limits = limits
  }

  accept(stream: ProcessStreamName, chunk: Buffer | string): string | null {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const nextLineBytes = this.scanLineBytes(
      stream === 'stdout' ? this.stdoutLineBytes : this.stderrLineBytes,
      bytes,
    )
    if (stream === 'stdout') this.stdoutLineBytes = nextLineBytes
    else this.stderrLineBytes = nextLineBytes
    if (nextLineBytes > this.limits.maxLineBytes) {
      return `Provider ${stream} line exceeded the ${this.limits.maxLineBytes}-byte limit.`
    }

    if (stream === 'stdout') {
      this.stdoutBytes += bytes.length
      if (this.stdoutBytes > this.limits.maxStdoutBytes) {
        return `Provider stdout exceeded the ${this.limits.maxStdoutBytes}-byte limit.`
      }
    } else {
      this.stderrBytes += bytes.length
      if (this.stderrBytes > this.limits.maxStderrBytes) {
        return `Provider stderr exceeded the ${this.limits.maxStderrBytes}-byte limit.`
      }
    }

    if (this.stdoutBytes + this.stderrBytes > this.limits.maxAggregateBytes) {
      return `Provider output exceeded the ${this.limits.maxAggregateBytes}-byte aggregate limit.`
    }
    return null
  }

  private scanLineBytes(initial: number, bytes: Buffer): number {
    let current = initial
    for (const byte of bytes) {
      current = byte === 0x0a ? 0 : current + 1
      if (current > this.limits.maxLineBytes) return current
    }
    return current
  }
}
