// Learning-loop trace store.
//
// One `traces` row per completed agent turn, plus ordered `trace_steps`
// capturing each generate / tool-call / result. This is the foundation the
// rest of the learning layer reads from — routing (by query_class + feedback),
// few-shot mining (by high-feedback traces), and tool-sequence discovery all
// query these tables. See src/storage/migrations.ts:createTraceSchema for the
// DDL. Modeled on the usage_events store in ./usage.ts.

import { getDatabase, withTransaction } from "./db";

/**
 * `cancelled` preserves evidence of a user-aborted turn without treating that
 * interruption as model or tool failure in downstream learning.
 */
export type TraceOutcome = "success" | "failure" | "cancelled";
export type TraceStepType = "generate" | "tool_call" | "result";

export interface TraceStepInput {
  stepIndex: number;
  stepType: TraceStepType;
  toolName?: string | null;
  /** Step input (e.g. tool args). Stored as JSON. */
  input?: unknown;
  /** Step output (e.g. tool result). Stored as JSON. */
  output?: unknown;
  success?: boolean | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface TraceInput {
  traceId: string;
  sessionId: string;
  messageSeq?: number | null;
  query: string;
  agentMode?: string | null;
  model: string;
  queryClass?: string | null;
  result?: string | null;
  outcome?: TraceOutcome | null;
  feedback?: number | null;
  /** ISO timestamp; defaults to now if omitted. */
  startedAt?: string;
  endedAt?: string | null;
  totalTokens?: number;
  totalLatencyMs?: number;
  steps?: TraceStepInput[];
}

export interface StoredTraceStep {
  id: number;
  traceId: string;
  stepIndex: number;
  stepType: TraceStepType;
  toolName: string | null;
  input: unknown;
  output: unknown;
  success: boolean | null;
  durationMs: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface StoredTrace {
  traceId: string;
  sessionId: string;
  messageSeq: number | null;
  query: string;
  agentMode: string | null;
  model: string;
  queryClass: string | null;
  result: string | null;
  outcome: TraceOutcome | null;
  feedback: number | null;
  startedAt: Date;
  endedAt: Date | null;
  totalTokens: number;
  totalLatencyMs: number;
  stepCount: number;
}

export interface TraceFilter {
  sessionId?: string;
  outcome?: TraceOutcome;
  queryClass?: string;
  /** Only traces with feedback >= this value. */
  minFeedback?: number;
  limit?: number;
}

interface TraceRow {
  trace_id: string;
  session_id: string;
  message_seq: number | null;
  query: string;
  agent_mode: string | null;
  model: string;
  query_class: string | null;
  result: string | null;
  outcome: TraceOutcome | null;
  feedback: number | null;
  started_at: string;
  ended_at: string | null;
  total_tokens: number;
  total_latency_ms: number;
  step_count: number;
}

interface TraceStepRow {
  id: number;
  trace_id: string;
  step_index: number;
  step_type: TraceStepType;
  tool_name: string | null;
  input_json: string | null;
  output_json: string | null;
  success: number | null;
  duration_ms: number | null;
  metadata_json: string | null;
  created_at: string;
}

function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function fromJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Insert a completed trace plus all its steps in a single transaction. The
 * TraceCollector calls this once at turn end. Idempotent on `trace_id` via
 * INSERT OR REPLACE so a retried write won't error.
 */
export function recordTrace(trace: TraceInput): void {
  const startedAt = trace.startedAt ?? new Date().toISOString();
  const steps = trace.steps ?? [];

  withTransaction((db) => {
    db.prepare(`
      INSERT OR REPLACE INTO traces (
        trace_id, session_id, message_seq, query, agent_mode, model, query_class,
        result, outcome, feedback, started_at, ended_at, total_tokens,
        total_latency_ms, step_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trace.traceId,
      trace.sessionId,
      trace.messageSeq ?? null,
      trace.query,
      trace.agentMode ?? null,
      trace.model,
      trace.queryClass ?? null,
      trace.result ?? null,
      trace.outcome ?? null,
      trace.feedback ?? null,
      startedAt,
      trace.endedAt ?? null,
      trace.totalTokens ?? 0,
      trace.totalLatencyMs ?? 0,
      steps.length,
    );

    // Replace any prior steps for this trace (idempotent re-record).
    db.prepare(`DELETE FROM trace_steps WHERE trace_id = ?`).run(trace.traceId);
    const insertStep = db.prepare(`
      INSERT INTO trace_steps (
        trace_id, step_index, step_type, tool_name, input_json, output_json,
        success, duration_ms, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const step of steps) {
      insertStep.run(
        trace.traceId,
        step.stepIndex,
        step.stepType,
        step.toolName ?? null,
        toJson(step.input),
        toJson(step.output),
        step.success === undefined || step.success === null ? null : step.success ? 1 : 0,
        step.durationMs ?? null,
        toJson(step.metadata),
        now,
      );
    }
  });
}

/** Set the [0,1] feedback score for a trace (via /feedback). */
export function setFeedback(traceId: string, score: number): void {
  const clamped = Math.max(0, Math.min(1, score));
  getDatabase().prepare(`UPDATE traces SET feedback = ? WHERE trace_id = ?`).run(clamped, traceId);
}

/** Override the auto-derived outcome for a trace. */
export function setOutcome(traceId: string, outcome: TraceOutcome): void {
  getDatabase().prepare(`UPDATE traces SET outcome = ? WHERE trace_id = ?`).run(outcome, traceId);
}

function mapTrace(row: TraceRow): StoredTrace {
  return {
    traceId: row.trace_id,
    sessionId: row.session_id,
    messageSeq: row.message_seq,
    query: row.query,
    agentMode: row.agent_mode,
    model: row.model,
    queryClass: row.query_class,
    result: row.result,
    outcome: row.outcome,
    feedback: row.feedback,
    startedAt: new Date(row.started_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : null,
    totalTokens: row.total_tokens,
    totalLatencyMs: row.total_latency_ms,
    stepCount: row.step_count,
  };
}

export function getTrace(traceId: string): StoredTrace | null {
  const row = getDatabase().prepare(`SELECT * FROM traces WHERE trace_id = ?`).get(traceId) as TraceRow | undefined;
  return row ? mapTrace(row) : null;
}

export function listTraces(filter: TraceFilter = {}): StoredTrace[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.sessionId) {
    clauses.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter.outcome) {
    clauses.push("outcome = ?");
    params.push(filter.outcome);
  }
  if (filter.queryClass) {
    clauses.push("query_class = ?");
    params.push(filter.queryClass);
  }
  if (filter.minFeedback !== undefined) {
    clauses.push("feedback IS NOT NULL AND feedback >= ?");
    params.push(filter.minFeedback);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = filter.limit && filter.limit > 0 ? `LIMIT ${Math.floor(filter.limit)}` : "";
  const rows = getDatabase()
    .prepare(`SELECT * FROM traces ${where} ORDER BY started_at DESC ${limit}`)
    .all(...params) as TraceRow[];
  return rows.map(mapTrace);
}

export function listTraceSteps(traceId: string): StoredTraceStep[] {
  const rows = getDatabase()
    .prepare(`SELECT * FROM trace_steps WHERE trace_id = ? ORDER BY step_index ASC`)
    .all(traceId) as TraceStepRow[];
  return rows.map((row) => ({
    id: row.id,
    traceId: row.trace_id,
    stepIndex: row.step_index,
    stepType: row.step_type,
    toolName: row.tool_name,
    input: fromJson(row.input_json),
    output: fromJson(row.output_json),
    success: row.success === null ? null : row.success === 1,
    durationMs: row.duration_ms,
    metadata: fromJson(row.metadata_json) as Record<string, unknown> | null,
    createdAt: new Date(row.created_at),
  }));
}
