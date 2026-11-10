import { parseSseJsonBuffer } from "@codesurf/daemon/sse";

/** One authenticated SSE connection per conversation, including between turns. */
export class CodesurfCardStream {
  private lifetime = new AbortController();
  private connection: AbortController | null = null;
  private ready: Promise<boolean> | null = null;
  private unsupported = false;
  private active: { jobId: string; sequence: number; sink: ReadableStreamDefaultController<Uint8Array> } | null = null;
  private early: Array<{ jobId: string; sequence?: number; [key: string]: unknown }> = [];
  private earlyBytes = 0;
  private awaitingJob = false;
  private replayOnAttach = false;
  private failures = 0;
  private online = false;
  get connected(): boolean {
    return this.online && !this.lifetime.signal.aborted;
  }
  private detachJob: (() => void) | null = null;

  constructor(
    private baseUrl: string,
    private token: string,
    private cardId: string,
  ) {}

  /** Establish before POST so fast jobs cannot outrun subscription. */
  async prepare(signal?: AbortSignal): Promise<boolean> {
    this.awaitingJob = true;
    this.early = [];
    this.earlyBytes = 0;
    this.replayOnAttach = false;
    const ready = this.ensureConnected();
    if (!signal) return ready;
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      ready.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  openJob(jobId: string, since: number, signal: AbortSignal): Response {
    let detach = () => {};
    this.detachJob?.();
    const body = new ReadableStream<Uint8Array>(
      {
        start: (sink) => {
          this.active = { jobId, sequence: since, sink };
          this.awaitingJob = false;
          const abort = () => {
            if (this.active?.sink !== sink) return;
            this.active = null;
            sink.error(new DOMException("Aborted", "AbortError"));
          };
          signal.addEventListener("abort", abort, { once: true });
          detach = () => {
            signal.removeEventListener("abort", abort);
            if (this.active?.sink === sink) this.active = null;
          };
          this.detachJob = detach;
          if (!this.replayOnAttach) for (const event of this.early) this.deliver(event);
          this.early = [];
          this.earlyBytes = 0;
          if (signal.aborted) abort();
          if (this.replayOnAttach) {
            this.connection?.abort();
            this.ready = null;
          }
          void this.ensureConnected().catch((error) => {
            if (this.active?.sink === sink) {
              this.active = null;
              sink.error(error);
            }
          });
        },
        cancel: () => detach(),
      },
      { highWaterMark: 1024 * 1024, size: (chunk) => chunk?.byteLength ?? 0 },
    );
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  }

  finishJob(jobId?: string): void {
    if (jobId && this.active && this.active.jobId !== jobId) return;
    const active = this.active;
    this.detachJob?.();
    this.detachJob = null;
    this.active = null;
    // Cancel/release is owned by the caller's reader; do not close the physical SSE.
    try {
      active?.sink.close();
    } catch {}
    this.awaitingJob = false;
    this.early = [];
    this.earlyBytes = 0;
  }

  close(): void {
    this.online = false;
    this.lifetime.abort();
    this.connection?.abort();
    this.finishJob();
  }

  private ensureConnected(): Promise<boolean> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error("Card stream closed"));
    if (this.unsupported) return Promise.resolve(false);
    if (this.ready) return this.ready;
    const connection = new AbortController();
    this.connection = connection;
    const params = new URLSearchParams({ cardId: this.cardId });
    if (this.active) {
      params.set("jobId", this.active.jobId);
      params.set("since", String(this.active.sequence));
    }
    const signal = AbortSignal.any([connection.signal, this.lifetime.signal]);
    const headerTimer = setTimeout(() => connection.abort(), 5_000);
    const ready = fetch(`${this.baseUrl}/chat/card/events?${params}`, {
      headers: { Accept: "text/event-stream", Authorization: `Bearer ${this.token}` },
      signal,
    }).then((response) => {
      clearTimeout(headerTimer);
      if (signal.aborted) {
        void response.body?.cancel();
        throw new DOMException("Aborted", "AbortError");
      }
      if (response.status === 404 || response.status === 405) {
        this.unsupported = true;
        void response.body?.cancel();
        return false;
      }
      if (!response.ok || !response.body) {
        void response.body?.cancel();
        throw new Error(`chat/card/events returned ${response.status}`);
      }
      // The header timeout must not abort an otherwise healthy long-lived body.
      this.online = true;
      void this.consume(response, connection);
      return true;
    });
    this.ready = ready;
    ready.catch(() => {
      clearTimeout(headerTimer);
      if (this.connection === connection) this.ready = null;
    });
    return ready;
  }

  private deliver(event: { jobId: string; sequence?: number; [key: string]: unknown }): void {
    const active = this.active;
    if (!active || event.jobId !== active.jobId) return;
    if (typeof event.sequence === "number") {
      if (event.sequence <= active.sequence) return;
      active.sequence = event.sequence;
    }
    if ((active.sink.desiredSize ?? 0) <= 0) {
      active.sink.error(new Error("CodeSurf card event consumer fell behind"));
      this.active = null;
      return;
    }
    active.sink.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  }

  private async consume(response: Response, connection: AbortController): Promise<void> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    try {
      while (!this.lifetime.signal.aborted) {
        const { done, value } = await reader.read();
        if (done || this.connection !== connection || connection.signal.aborted) break;
        const parsed = parseSseJsonBuffer<{ jobId: string; sequence?: number; [key: string]: unknown }>(
          buffer + decoder.decode(value, { stream: true }),
        );
        buffer = parsed.remaining;
        for (const event of parsed.events) {
          if (!event || typeof event.jobId !== "string") continue;
          this.failures = 0;
          if (this.active) this.deliver(event);
          else if (this.awaitingJob) {
            this.earlyBytes += JSON.stringify(event).length;
            if (this.earlyBytes > 1024 * 1024 || this.early.length >= 256) {
              this.early = [];
              this.earlyBytes = 0;
              this.replayOnAttach = true;
            } else if (!this.replayOnAttach) this.early.push(event);
          }
        }
      }
    } catch {
      // Replay the active job from its last delivered sequence after reconnect.
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      if (this.connection === connection) {
        this.online = false;
        this.ready = null;
        if (this.awaitingJob) this.replayOnAttach = true;
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.lifetime.signal.aborted || this.unsupported) return;
    if (++this.failures > 10 && this.active) {
      this.active.sink.error(new Error("CodeSurf card stream repeatedly disconnected"));
      this.active = null;
    }
    const timer = setTimeout(
      () => {
        if (!this.lifetime.signal.aborted) void this.ensureConnected().catch(() => this.scheduleReconnect());
      },
      Math.min(250 * this.failures, 2_000),
    );
    timer.unref?.();
  }
}
