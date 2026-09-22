// Per-turn trace accumulator for the learning loop.
//
// One collector is created per `Agent.processMessage` turn (internally, not by
// the caller — so headless/programmatic/Telegram turns are captured too). It
// gathers generate/tool steps, token usage, and timing, then writes a single
// `traces` row (+ `trace_steps`) on turn end via the store in
// ../storage/traces. Outcome is auto-derived: success when the turn's Stop
// hook fires, failure when StopFailure fires, and cancelled for a user abort.
//
// Deliberately decoupled from the agent's observer types: callers pass plain
// primitives, so this is unit-testable without the Agent and there's no
// circular import. The Agent adapts its ProcessMessageObserver payloads to
// these calls.

import { randomUUID } from "node:crypto";
// Persist through the ../storage/index barrel (not ./traces directly) so the
// agent's import graph keeps a single storage seam — vitest agent tests mock
// ../storage/index, which keeps bun:sqlite out of the node test runtime.
import { recordTrace, type TraceOutcome, type TraceStepInput } from "../storage/index";
import { maybeRefreshLearningArtifacts, recordDevConversationLog } from "./learning/self-learning";
import { classifyQuery, type QueryClass } from "./routing/classify";

export interface TraceCollectorParams {
  sessionId: string;
  query: string;
  model: string;
  cwd: string;
  agentMode?: string | null;
  /** ISO timestamp captured at turn start. Defaults to now. */
  startedAtIso?: string;
  /** Epoch ms at turn start, for latency. Defaults to Date.now(). */
  startedAtMs?: number;
  /** Override the generated trace id (mainly for tests). */
  traceId?: string;
}

interface PendingTool {
  toolName: string;
  input: unknown;
  startedAtMs: number;
  /** Session cwd when the call started; see `onToolStart`. */
  cwd?: string;
}

export class TraceCollector {
  readonly traceId: string;
  private readonly sessionId: string;
  private readonly query: string;
  private readonly model: string;
  private readonly cwd: string;
  private readonly agentMode: string | null;
  private readonly queryClass: QueryClass;
  private readonly startedAtIso: string;
  private readonly startedAtMs: number;

  private readonly steps: TraceStepInput[] = [];
  private readonly pendingTools = new Map<string, PendingTool>();
  private totalTokens = 0;
  private settled = false;

  constructor(params: TraceCollectorParams) {
    this.traceId = params.traceId ?? randomUUID();
    this.sessionId = params.sessionId;
    this.query = params.query;
    this.model = params.model;
    this.cwd = params.cwd;
    this.agentMode = params.agentMode ?? null;
    this.queryClass = classifyQuery(params.query);
    this.startedAtMs = params.startedAtMs ?? Date.now();
    this.startedAtIso = params.startedAtIso ?? new Date(this.startedAtMs).toISOString();
  }

  /** A model generation step completed (text/tool-call decision). */
  onGenerateStep(info: { finishReason?: string; timestampMs?: number }): void {
    if (this.settled) return;
    this.steps.push({
      stepIndex: this.steps.length,
      stepType: "generate",
      metadata: info.finishReason ? { finishReason: info.finishReason } : null,
    });
  }

  /** A tool call started. Keyed by tool-call id so the result can match it. */
  onToolStart(info: {
    toolCallId: string;
    toolName: string;
    input: unknown;
    timestampMs?: number;
    /**
     * Directory this call resolved relative paths against, captured at START.
     * A `cd` later in the same turn moves the session cwd, so the trace's own
     * cwd is not what an earlier `read_file` used — which is why skill
     * attribution silently dropped relative reads after a directory change.
     */
    cwd?: string;
  }): void {
    if (this.settled) return;
    this.pendingTools.set(info.toolCallId, {
      toolName: info.toolName,
      input: info.input,
      startedAtMs: info.timestampMs ?? Date.now(),
      cwd: info.cwd,
    });
  }

  /** A tool call finished. Appends a tool_call step, computing duration. */
  onToolFinish(info: {
    toolCallId: string;
    toolName: string;
    output: unknown;
    success: boolean;
    timestampMs?: number;
    /** Optional provenance, e.g. the skill that drove this call. */
    metadata?: Record<string, unknown> | null;
  }): void {
    if (this.settled) return;
    const pending = this.pendingTools.get(info.toolCallId);
    this.pendingTools.delete(info.toolCallId);
    const finishedAt = info.timestampMs ?? Date.now();
    const durationMs = pending ? Math.max(0, finishedAt - pending.startedAtMs) : null;
    this.steps.push({
      stepIndex: this.steps.length,
      stepType: "tool_call",
      toolName: info.toolName,
      input: pending?.input,
      output: info.output,
      success: info.success,
      durationMs,
      // The start-time cwd travels in metadata: no schema change, and a step
      // that never had one simply has no `cwd` key.
      metadata: pending?.cwd ? { ...(info.metadata ?? {}), cwd: pending.cwd } : (info.metadata ?? null),
    });
  }

  /** Accumulate token usage from the turn's "message"-source usage events. */
  addUsage(usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): void {
    if (this.settled || !usage) return;
    const total = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    if (total > 0) this.totalTokens += total;
  }

  /**
   * Finalize and persist the trace. Idempotent — only the first call writes.
   * Never throws: a trace-store failure must not break the turn.
   */
  finish(outcome: TraceOutcome, result?: string | null): void {
    if (this.settled) return;
    this.settled = true;
    const endedAtMs = Date.now();
    try {
      const trace = {
        traceId: this.traceId,
        sessionId: this.sessionId,
        query: this.query,
        agentMode: this.agentMode,
        model: this.model,
        queryClass: this.queryClass,
        result: result ?? null,
        outcome,
        startedAt: this.startedAtIso,
        endedAt: new Date(endedAtMs).toISOString(),
        totalTokens: this.totalTokens,
        totalLatencyMs: Math.max(0, endedAtMs - this.startedAtMs),
        steps: this.steps,
      };
      recordTrace(trace);
      recordDevConversationLog(trace);
      maybeRefreshLearningArtifacts({ cwd: this.cwd });
    } catch (err) {
      // Best effort — tracing must never break a turn.
      console.error("[trace] failed to record trace:", err instanceof Error ? err.message : String(err));
    }
  }
}
