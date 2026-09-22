// Self-learning loop glue.
//
// The durable signal is still the SQLite trace store. This module adds:
//   - dev-mode human-readable JSONL conversation logs (0600, redacted/truncated)
//   - periodic skill-overlay mining from traces
//   - a small prompt-visible generated notes file used as weak local priors

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultCodesurfHome } from "@codesurf/daemon";
import { getTrace, listTraceSteps, listTraces, type StoredTrace, type TraceInput } from "../../storage/index";
import { optimizeSkillsFromTraces } from "./skill-optimizer";

const DEV_LOG_DIR = "dev-conversations";
const LEARNING_DIR = "learning";
const STATE_FILE = "state.json";
const PROMPT_NOTES_FILE = "prompt-notes.md";
const MIN_NEW_TRACES = 8;
const MIN_TOTAL_TRACES = 3;
const TRACE_LIMIT = 200;
const PROMPT_NOTE_TRACE_LIMIT = 50;
const MAX_FIELD_CHARS = 12_000;

/**
 * Refresh watermark. `listTraces({ limit: TRACE_LIMIT })` is a bounded sample
 * window, so its length stops moving once the store holds TRACE_LIMIT traces —
 * a count-based "new traces" check permanently stalled there (A7). Instead we
 * remember the newest trace seen at the last refresh and count the traces in
 * the window that started after it; that stays monotonic however many traces
 * scroll out of the window.
 */
interface LearningState {
  /** Newest trace (by started_at) seen at the last refresh. */
  lastTraceId?: string;
  /** ISO started_at of `lastTraceId`. */
  lastTraceStartedAt?: string;
  /** Size of the sample window at the last refresh (informational). */
  traceWindow?: number;
  /** Legacy pre-watermark field; only read so old state files parse cleanly. */
  lastTraceCount?: number;
  updatedAt?: string;
}

function learningDir(): string {
  return path.join(defaultCodesurfHome(), LEARNING_DIR);
}

function statePath(): string {
  return path.join(learningDir(), STATE_FILE);
}

function promptNotesPath(): string {
  return path.join(learningDir(), PROMPT_NOTES_FILE);
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readState(): LearningState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as LearningState) : {};
  } catch {
    return {};
  }
}

/**
 * How many traces in the sample window started after the persisted watermark.
 * Returns null when there is no usable watermark — first run, a legacy
 * count-only state file, or the watermark trace no longer exists (the store
 * was deleted/reset) — so the caller refreshes and re-anchors.
 */
function countTracesSinceWatermark(traces: StoredTrace[], state: LearningState): number | null {
  if (!state.lastTraceId || !state.lastTraceStartedAt) return null;
  const watermarkMs = Date.parse(state.lastTraceStartedAt);
  if (Number.isNaN(watermarkMs)) return null;
  if (!getTrace(state.lastTraceId)) return null;
  return traces.filter((trace) => trace.startedAt.getTime() > watermarkMs).length;
}

function writeState(state: LearningState): void {
  const dir = learningDir();
  ensurePrivateDir(dir);
  fs.writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function truncate(value: string, max = MAX_FIELD_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated ${value.length - max} chars]`;
}

function redactString(value: string): string {
  return truncate(
    value
      .replace(/(api[_-]?key|token|authorization|password|secret)(["'\s:=]+)([^"',\s]+)/gi, "$1$2[REDACTED]")
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
      .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]"),
  );
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/api[_-]?key|token|authorization|password|secret/i.test(key)) out[key] = "[REDACTED]";
    else out[key] = redactValue(child);
  }
  return out;
}

export function isDevConversationLoggingEnabled(): boolean {
  const raw = process.env.CODESURF_DEV_CONVERSATION_LOGS ?? process.env.CODESURF_DEV_LOGS;
  if (raw !== undefined) return /^(1|true|yes|on)$/i.test(raw);
  if (process.env.NODE_ENV === "development") return true;
  return process.argv.some((arg) => /(^|\/)src\/index\.ts$/.test(arg));
}

export function recordDevConversationLog(trace: TraceInput): void {
  if (!isDevConversationLoggingEnabled()) return;
  try {
    const dir = path.join(defaultCodesurfHome(), DEV_LOG_DIR);
    ensurePrivateDir(dir);
    const day = (trace.endedAt ?? trace.startedAt ?? new Date().toISOString()).slice(0, 10);
    const file = path.join(dir, `${day}.jsonl`);
    const entry = {
      traceId: trace.traceId,
      sessionId: trace.sessionId,
      query: redactString(trace.query),
      result: trace.result ? redactString(trace.result) : null,
      outcome: trace.outcome ?? null,
      model: trace.model,
      agentMode: trace.agentMode ?? null,
      queryClass: trace.queryClass ?? null,
      startedAt: trace.startedAt ?? null,
      endedAt: trace.endedAt ?? null,
      totalTokens: trace.totalTokens ?? 0,
      totalLatencyMs: trace.totalLatencyMs ?? 0,
      steps: (trace.steps ?? []).map((step) => ({
        stepIndex: step.stepIndex,
        stepType: step.stepType,
        toolName: step.toolName ?? null,
        success: step.success ?? null,
        durationMs: step.durationMs ?? null,
        input: redactValue(step.input),
        output: redactValue(step.output),
      })),
    };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // Dev logs are best effort; never affect the product turn.
  }
}

interface NoteTrace {
  traceId: string;
  queryClass: string | null;
  outcome: "success" | "failure" | "cancelled" | null;
  feedback: number | null;
  model: string;
  totalLatencyMs: number;
}

function pct(numerator: number, denominator: number): string {
  if (denominator <= 0) return "0%";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function topEntries(counts: Map<string, number>, limit: number): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => `${name} (${count})`);
}

export function buildLearningPromptNotes(traces: NoteTrace[], toolSequences: string[][]): string {
  const completed = traces.filter((trace) => trace.outcome !== "cancelled");
  const total = completed.length;
  const cancelled = traces.length - completed.length;
  const successes = completed.filter((trace) => trace.outcome === "success").length;
  const failures = completed.filter((trace) => trace.outcome === "failure").length;
  const classFailures = new Map<string, number>();
  const modelSuccesses = new Map<string, number>();
  const toolCounts = new Map<string, number>();

  for (const trace of completed) {
    if (trace.outcome === "failure") {
      const key = trace.queryClass ?? "unknown";
      classFailures.set(key, (classFailures.get(key) ?? 0) + 1);
    }
    if (trace.outcome === "success") {
      modelSuccesses.set(trace.model, (modelSuccesses.get(trace.model) ?? 0) + 1);
    }
  }

  for (const sequence of toolSequences) {
    for (const tool of sequence) toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
  }

  const lines = [
    "# Local Learning Notes",
    "",
    "Generated from local CodeSurf traces. Treat these as weak priors and override them when the current task provides better evidence.",
    "",
    `- Recent trace window: ${traces.length} turn${traces.length === 1 ? "" : "s"}; completed ${total}; success ${successes}/${total} (${pct(
      successes,
      total,
    )}), failure ${failures}/${total}${cancelled > 0 ? `; cancelled ${cancelled}.` : "."}`,
  ];

  const riskyClasses = topEntries(classFailures, 3);
  if (riskyClasses.length > 0) {
    lines.push(`- Query classes with recent failures: ${riskyClasses.join(", ")}. Slow down and verify these paths.`);
  }

  const successfulModels = topEntries(modelSuccesses, 3);
  if (successfulModels.length > 0) {
    lines.push(`- Models with recent successful traces: ${successfulModels.join(", ")}.`);
  }

  const successfulTools = topEntries(toolCounts, 6);
  if (successfulTools.length > 0) {
    lines.push(`- Tools common in successful traces: ${successfulTools.join(", ")}.`);
  }

  return `${lines.join("\n")}\n`;
}

export function maybeRefreshLearningArtifacts(params: { cwd: string }): void {
  try {
    const traces = listTraces({ limit: TRACE_LIMIT });
    if (traces.length < MIN_TOTAL_TRACES) return;
    const state = readState();
    const newTraces = countTracesSinceWatermark(traces, state);
    if (newTraces !== null && newTraces < MIN_NEW_TRACES) return;

    optimizeSkillsFromTraces({ cwd: params.cwd });

    const recent = traces.slice(0, PROMPT_NOTE_TRACE_LIMIT);
    const successfulToolSequences = recent
      .filter((trace) => trace.outcome === "success")
      .map((trace) =>
        listTraceSteps(trace.traceId)
          .map((step) => step.toolName)
          .filter((name): name is string => !!name),
      );
    const notes = buildLearningPromptNotes(recent, successfulToolSequences);
    const dir = learningDir();
    ensurePrivateDir(dir);
    fs.writeFileSync(promptNotesPath(), notes, { mode: 0o600 });
    // listTraces orders by started_at DESC, so traces[0] is the newest.
    writeState({
      lastTraceId: traces[0].traceId,
      lastTraceStartedAt: traces[0].startedAt.toISOString(),
      traceWindow: traces.length,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // Learning artifacts must never break the turn path.
  }
}

export function loadLearningPromptNotes(): string | null {
  try {
    const text = fs.readFileSync(promptNotesPath(), "utf8").trim();
    return text.length > 0 ? truncate(text, 8_000) : null;
  } catch {
    return null;
  }
}
