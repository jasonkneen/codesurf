import {
  BoundedSseJsonDecoder,
  DaemonChatEventBudget,
  DaemonSseLimitError,
  type BoundedSseJsonDecoderOptions,
  type DaemonChatEventBudgetOptions,
  type ParsedSseJsonBuffer,
} from '@codesurf/daemon/sse'
import type { DaemonChatJobEvent } from '@codesurf/daemon'

export interface DaemonRendererStreamBatch {
  events: DaemonChatJobEvent[]
  errors: Error[]
  terminal: boolean
}

export interface DaemonRendererStreamBoundaryOptions
  extends BoundedSseJsonDecoderOptions,
  Pick<DaemonChatEventBudgetOptions, 'maxEventPayloadBytes'> {}

export class DaemonRendererStreamSequenceError extends Error {
  constructor(jobId: string, expected: number, received: number) {
    super(`Daemon event stream sequence gap for job ${jobId}: expected ${expected}, received ${received}`)
    this.name = 'DaemonRendererStreamSequenceError'
  }
}

/** Pure boundary used by Electron before daemon SSE reaches renderer IPC. */
export class DaemonRendererStreamBoundary {
  private readonly jobId: string
  private readonly decoder: BoundedSseJsonDecoder<unknown>
  private readonly eventBudget: DaemonChatEventBudget
  private lastSequence: number
  private terminal = false

  constructor(
    jobId: string,
    sinceSequence = 0,
    options: DaemonRendererStreamBoundaryOptions = {},
  ) {
    this.jobId = jobId
    this.lastSequence = Math.max(0, Math.trunc(sinceSequence))
    this.decoder = new BoundedSseJsonDecoder(options)
    this.eventBudget = new DaemonChatEventBudget({
      expectedJobId: jobId,
      maxEventPayloadBytes: options.maxEventPayloadBytes,
    })
  }

  push(chunk: Uint8Array): DaemonRendererStreamBatch {
    return this.accept(this.decoder.push(chunk))
  }

  finish(): DaemonRendererStreamBatch {
    return this.accept(this.decoder.finish())
  }

  private accept(parsed: ParsedSseJsonBuffer<unknown>): DaemonRendererStreamBatch {
    const events: DaemonChatJobEvent[] = []
    const errors = [...parsed.errors]
    if (this.terminal) return { events, errors, terminal: true }

    for (const payload of parsed.events) {
      let event: DaemonChatJobEvent
      try {
        event = this.eventBudget.sanitize(payload)
      } catch (error) {
        if (error instanceof DaemonSseLimitError) throw error
        errors.push(error instanceof Error ? error : new Error(String(error)))
        continue
      }

      if (event.sequence <= this.lastSequence) continue
      const expected = this.lastSequence + 1
      if (event.sequence !== expected) {
        throw new DaemonRendererStreamSequenceError(this.jobId, expected, event.sequence)
      }

      this.eventBudget.consume(event)
      events.push(event)
      this.lastSequence = event.sequence
      if (event.type === 'done') {
        this.terminal = true
        break
      }
    }

    return { events, errors, terminal: this.terminal }
  }
}
