import { BoundedSseJsonDecoder, readBoundedResponseDiagnostic } from '@codesurf/daemon/sse'
import type { DaemonChatJobEvent } from '@codesurf/daemon'
import { DaemonRendererStreamBoundary } from './daemon-stream-boundary.ts'

type Endpoint = { baseUrl: string; token: string | null }
type ActiveJob = {
  jobId: string
  sequence: number
  boundary: DaemonRendererStreamBoundary
  emit: (event: DaemonChatJobEvent) => void
  finish: (error?: unknown) => void
}

/** One physical connection per workspace/card/endpoint, not per turn. */
export class DaemonCardStream {
  private readonly lifetime = new AbortController()
  private connection: AbortController | null = null
  private started = false
  private unsupported = false
  private awaitingJob = false
  private early: Record<string, unknown>[] = []
  private earlyBytes = 0
  private replay = false
  private active: ActiveJob | null = null
  private readonly ready: Promise<boolean>
  private resolveReady!: (supported: boolean) => void
  private rejectReady!: (error: unknown) => void

  private readonly endpoint: Endpoint
  private readonly cardId: string

  constructor(endpoint: Endpoint, cardId: string) {
    this.endpoint = endpoint
    this.cardId = cardId
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // Closing before the first prepare must not create an unhandled rejection.
    void this.ready.catch(() => {})
  }

  async prepare(): Promise<boolean> {
    this.awaitingJob = true
    this.clearEarly()
    this.replay = false
    return this.connect()
  }

  private connect(): Promise<boolean> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('Card stream closed'))
    if (!this.started) {
      this.started = true
      void this.run()
    }
    return this.ready
  }

  finishPreparation(): void {
    this.awaitingJob = false
    this.clearEarly()
  }

  async consumeJob(
    jobId: string,
    since: number,
    signal: AbortSignal,
    emit: (event: DaemonChatJobEvent) => void,
  ): Promise<void> {
    const supported = await this.connect()
    if (signal.aborted) return
    if (!supported) return this.consumeLegacy(jobId, since, signal, emit)
    this.active?.finish(new Error('Daemon job stream superseded'))
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => finish()
      const finish = (error?: unknown): void => {
        signal.removeEventListener('abort', abort)
        if (this.active === active) this.active = null
        if (error) reject(error)
        else resolve()
      }
      const active: ActiveJob = {
        jobId, sequence: since, emit, finish,
        boundary: new DaemonRendererStreamBoundary(jobId, since),
      }
      this.active = active
      signal.addEventListener('abort', abort, { once: true })
      // A resume has no pre-POST buffer; force replay from its supplied cursor.
      const mustReplay = !this.awaitingJob || this.replay
      this.awaitingJob = false
      if (!mustReplay) for (const event of this.early) this.deliver(event)
      this.clearEarly()
      if (mustReplay) this.connection?.abort()
    })
  }

  close(): void {
    this.lifetime.abort()
    this.connection?.abort()
    this.active?.finish()
    this.finishPreparation()
    this.rejectReady(new Error('Card stream closed'))
  }

  private clearEarly(): void {
    this.early = []
    this.earlyBytes = 0
  }

  private deliver(payload: Record<string, unknown>): void {
    const active = this.active
    if (!active || payload.jobId !== active.jobId) return
    try {
      const batch = active.boundary.push(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`))
      if (batch.errors.length) throw batch.errors[0]
      for (const event of batch.events) {
        active.emit(event)
        active.sequence = event.sequence
      }
      if (batch.terminal) active.finish()
    } catch (error) {
      active.finish(error)
    }
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'text/event-stream',
      ...(this.endpoint.token ? { Authorization: `Bearer ${this.endpoint.token}` } : {}),
    }
  }

  private async run(): Promise<void> {
    let failures = 0
    while (!this.lifetime.signal.aborted && !this.unsupported) {
      const connection = new AbortController()
      this.connection = connection
      const params = new URLSearchParams({ cardId: this.cardId })
      if (this.active) {
        params.set('jobId', this.active.jobId)
        params.set('since', String(this.active.sequence))
      }
      const timer = setTimeout(() => connection.abort(), 5_000)
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        const response = await fetch(`${this.endpoint.baseUrl}/chat/card/events?${params}`, {
          headers: this.headers(),
          signal: AbortSignal.any([connection.signal, this.lifetime.signal]),
        })
        clearTimeout(timer)
        if (response.status === 404 || response.status === 405) {
          this.unsupported = true
          await response.body?.cancel()
          this.resolveReady(false)
          // A server downgraded during reconnect: caller can resume via legacy.
          this.active?.finish(new Error('Persistent card SSE became unavailable; resume the job'))
          return
        }
        if (!response.ok || !response.body) {
          throw new Error(await readBoundedResponseDiagnostic(response) || `Card SSE returned ${response.status}`)
        }
        this.resolveReady(true)
        reader = response.body.getReader()
        // The wire budget rotates the physical stream; turn budgets live in the boundary.
        const decoder = new BoundedSseJsonDecoder<Record<string, unknown>>()
        while (!this.lifetime.signal.aborted) {
          const { done, value } = await reader.read()
          if (done) break
          const batch = decoder.push(value)
          if (batch.errors.length) throw batch.errors[0]
          failures = 0
          for (const payload of batch.events) {
            if (!payload || typeof payload.jobId !== 'string') continue
            if (this.active) this.deliver(payload)
            else if (this.awaitingJob && !this.replay) {
              const bytes = Buffer.byteLength(JSON.stringify(payload))
              if (this.early.length >= 256 || this.earlyBytes + bytes > 1024 * 1024) {
                this.clearEarly()
                this.replay = true
              } else {
                this.early.push(payload)
                this.earlyBytes += bytes
              }
            }
          }
        }
        if (!connection.signal.aborted && !this.lifetime.signal.aborted) {
          throw new Error('Daemon card SSE disconnected')
        }
      } catch (error) {
        if (!this.lifetime.signal.aborted && ++failures >= 10) {
          this.rejectReady(error)
          this.active?.finish(error)
        }
      } finally {
        clearTimeout(timer)
        await reader?.cancel().catch(() => {})
        reader?.releaseLock()
        if (this.awaitingJob) this.replay = true
      }
      if (this.lifetime.signal.aborted) return
      // Abort is also used to request immediate replay on attach.
      if (!connection.signal.aborted) await this.wait(Math.min(250 * ++failures, 2_000))
    }
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise(resolve => {
      const finish = (): void => {
        clearTimeout(timer)
        this.lifetime.signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, milliseconds)
      timer.unref?.()
      this.lifetime.signal.addEventListener('abort', finish, { once: true })
    })
  }

  private async consumeLegacy(jobId: string, since: number, signal: AbortSignal, emit: ActiveJob['emit']): Promise<void> {
    const controller = new AbortController()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const params = new URLSearchParams({ jobId, since: String(since) })
      const response = await fetch(`${this.endpoint.baseUrl}/chat/job/events?${params}`, {
        headers: this.headers(),
        signal: AbortSignal.any([signal, controller.signal, this.lifetime.signal]),
      })
      if (!response.ok || !response.body) throw new Error(await readBoundedResponseDiagnostic(response) || `Job SSE returned ${response.status}`)
      reader = response.body.getReader()
      const boundary = new DaemonRendererStreamBoundary(jobId, since)
      while (true) {
        const { done, value } = await reader.read()
        const batch = done ? boundary.finish() : boundary.push(value)
        if (batch.errors.length) throw batch.errors[0]
        for (const event of batch.events) emit(event)
        if (batch.terminal || done) break
      }
    } finally {
      controller.abort()
      await reader?.cancel().catch(() => {})
      reader?.releaseLock()
    }
  }
}
