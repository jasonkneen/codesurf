// Distributed tracing (Phase 4 -> "full traceroutes"). A traceId rides the relay
// delegate path; the hub records a span for every hop (route/forward, worker
// run, reply) and merges worker-reported spans, so a single request produces an
// ordered path: submit -> forward -> run -> reply. renderTraceTrajectory() turns
// spans into a DSH-app-style trajectory/timeline so the full route is visible.

import type { Span } from "./protocol";

export function nextTraceId(): string {
  return `tr-${Date.now().toString(36)}-${((Math.random() * 1e9) | 0).toString(36)}`;
}

export function nextSpanId(): string {
  return `sp-${((Math.random() * 1e9) | 0).toString(36)}-${((Math.random() * 1e9) | 0).toString(36)}`;
}

/** In-memory trace store aggregated at a hub (the shared rendezvous). */
export class TraceStore {
  private readonly spansByTrace = new Map<string, Span[]>();
  private readonly maxSpans: number;

  constructor(maxSpans = 5000) {
    this.maxSpans = maxSpans;
  }

  record(span: Span): void {
    const list = this.spansByTrace.get(span.traceId) ?? [];
    list.push(span);
    if (list.length > this.maxSpans) list.splice(0, list.length - this.maxSpans);
    this.spansByTrace.set(span.traceId, list);
  }

  /** Spans for a trace, ordered by recorded time. */
  trace(traceId: string): Span[] {
    return [...(this.spansByTrace.get(traceId) ?? [])].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  clear(traceId: string): void {
    this.spansByTrace.delete(traceId);
  }

  /** Drop traces whose most recent span is older than ttlMs. */
  reap(ttlMs = 60 * 60_000): number {
    const cutoff = Date.now() - ttlMs;
    let removed = 0;
    for (const [traceId, spans] of [...this.spansByTrace]) {
      const newest = spans[spans.length - 1];
      if (newest && Date.parse(newest.at) < cutoff) {
        this.spansByTrace.delete(traceId);
        removed++;
      }
    }
    return removed;
  }
}

const STEP = ["│", "└"]; // box-drawing rail: │ └

/**
 * Render a trace's spans as a DSH-app-style trajectory/timeline (the full
 * traceroute): one rail per hop with step number, outbound mark, event, node
 * path, timing, and status.
 */
export function renderTraceTrajectory(spans: Span[]): string {
  if (spans.length === 0) return "trace: (no spans recorded)";
  const lines: string[] = [];
  const first = spans[0];
  lines.push(`trace ${first.traceId} (${first.at})`);
  spans.forEach((span, i) => {
    const rail = `${STEP[i % STEP.length]} `;
    const ev = span.event.padEnd(8);
    const where = span.detail ? `  [${span.detail}]` : "";
    const t = span.durMs !== undefined ? `  ${span.durMs.toFixed(1)}ms` : "";
    const st = span.status === "failed" ? "  ✗ failed" : span.status === "ok" ? "  ✓ ok" : "";
    lines.push(`  ${rail}${i + 1} ${ev} ${span.node}${where}${t}${st}`);
  });
  return lines.join("\n");
}
