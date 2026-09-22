// Skill few-shot mining (D2). Attributes each trace to the skill(s) it used,
// then mines top high-feedback {query, result} pairs per skill into overlays
// (see ./skill-overlay). Adapted from OpenJarvis skill_optimizer.py's
// non-DSPy fallback (top-feedback traces as few-shot examples).
//
// Attribution is derived from stored trace steps — in CodeSurf a skill is
// "used" when the model reads its SKILL.md via read_file (the activation
// convention from utils/skills.ts). No collection-time tagging needed.

import * as path from "node:path";
import { listTraceSteps, listTraces, SessionStore } from "../../storage/index";
import { discoverSkills } from "../../utils/skills";
import { type SkillFewShot, saveSkillOverlay } from "./skill-overlay";

export interface AttributionStep {
  toolName: string | null;
  /** Tool input; for read_file this carries `{ path }`. */
  input: unknown;
  /** Tool outcome; a failed read (missing file, binary) did not activate a skill. */
  success?: boolean | null;
  /** Step provenance; the collector records `cwd` here (see trace-collector). */
  metadata?: Record<string, unknown> | null;
}

/**
 * The directory this step actually resolved relative paths against.
 *
 * Prefers the cwd the collector recorded on the step itself, because a `cd`
 * partway through a turn means the trace-level cwd is not what an earlier call
 * used. Falls back to the trace cwd for steps recorded before this was stored.
 */
function stepCwd(step: AttributionStep, fallback: string | null | undefined): string | null | undefined {
  const recorded = step.metadata?.cwd;
  return typeof recorded === "string" && recorded.length > 0 ? recorded : fallback;
}

export interface SkillRef {
  name: string;
  skillMdPath: string;
}

export interface AttributionOptions {
  /**
   * Directory the trace's file tools resolved relative paths against (the
   * session cwd). Without it a relative read cannot be located, so it is not
   * attributed rather than guessed.
   */
  cwd?: string | null;
}

function readPathOf(step: AttributionStep): string | null {
  if (step.toolName !== "read_file") return null;
  if (step.success === false) return null;
  const input = step.input;
  if (input && typeof input === "object" && "path" in input) {
    const p = (input as { path?: unknown }).path;
    if (typeof p === "string" && p.length > 0) return p;
  }
  return null;
}

/**
 * Resolve a recorded read path the way src/tools/file.ts resolved it at
 * execution time: absolute as-is, relative against the execution cwd. Returns
 * null when a relative path has no cwd to resolve against.
 */
function resolveReadPath(readPath: string, cwd: string | null | undefined): string | null {
  if (path.isAbsolute(readPath)) return path.resolve(readPath);
  if (!cwd) return null;
  return path.resolve(cwd, readPath);
}

/**
 * Which skills a trace used, by scanning its tool steps for a read_file of a
 * known skill's SKILL.md. Pure — returns skill names (deduped, first-seen
 * order). Paths are compared whole after normalization: a bare `SKILL.md`
 * read only matches the skill whose directory was the execution cwd, never
 * every skill by suffix.
 */
export function attributeSkills(
  steps: AttributionStep[],
  skills: SkillRef[],
  options: AttributionOptions = {},
): string[] {
  const used = new Set<string>();
  for (const step of steps) {
    const readPath = readPathOf(step);
    if (!readPath) continue;
    const resolved = resolveReadPath(readPath, stepCwd(step, options.cwd));
    if (!resolved) continue;
    for (const skill of skills) {
      if (resolved === path.resolve(skill.skillMdPath)) used.add(skill.name);
    }
  }
  return [...used];
}

export interface MineSample {
  query: string;
  result: string | null;
  feedback: number | null;
  outcome: "success" | "failure" | "cancelled" | null;
}

export interface MineOptions {
  /** Keep traces with feedback >= this (or, when feedback is null, a success). Default 0.7. */
  minFeedback?: number;
  /** Max examples per skill. Default 4. */
  topN?: number;
}

/** Effective quality score for ranking: explicit feedback, else 0.7 for a
 *  success / 0 for a failure / 0.5 unknown. Cancelled turns are excluded
 *  before ranking because they do not describe model quality. */
function qualityOf(s: MineSample): number {
  if (s.feedback !== null) return s.feedback;
  if (s.outcome === "success") return 0.7;
  if (s.outcome === "failure") return 0;
  return 0.5;
}

/**
 * Mine the best few-shot examples from attributed samples: keep high-quality
 * ones with a non-empty result, rank by quality, dedupe by query, take topN.
 * Pure.
 */
export function mineFewShot(samples: MineSample[], opts: MineOptions = {}): SkillFewShot[] {
  const minFeedback = opts.minFeedback ?? 0.7;
  const topN = opts.topN ?? 4;

  const eligible = samples.filter((s) => {
    if (s.outcome === "cancelled") return false;
    if (!s.result || s.result.trim().length === 0) return false;
    if (s.feedback !== null) return s.feedback >= minFeedback;
    return s.outcome === "success";
  });

  eligible.sort((a, b) => qualityOf(b) - qualityOf(a));

  const seen = new Set<string>();
  const out: SkillFewShot[] = [];
  for (const s of eligible) {
    const key = s.query.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ query: s.query, result: s.result as string });
    if (out.length >= topN) break;
  }
  return out;
}

export interface OptimizeResult {
  skill: string;
  /** Stable skill identity (its SKILL.md path); the overlay is scoped to it. */
  source: string;
  examples: number;
  sampleCount: number;
}

/**
 * Read traces + steps, attribute them to skills, mine few-shot examples, and
 * write overlays. Storage-reading wrapper (kept separate from the pure cores).
 * Returns a per-skill summary of what was written.
 *
 * Traces are global, so each trace's relative reads are resolved against its
 * own session cwd. Sessions live in workspaces; only sessions from this cwd's
 * workspace can be looked up, so traces from other workspaces attribute by
 * absolute path only — a shared user-scope skill still matches from anywhere,
 * a same-named project skill elsewhere never does.
 */
export function optimizeSkillsFromTraces(params: {
  cwd: string;
  minFeedback?: number;
  topN?: number;
}): OptimizeResult[] {
  const skills = discoverSkills(params.cwd).map((s) => ({ name: s.name, skillMdPath: s.skillMdPath }));
  if (skills.length === 0) return [];
  const sourceByName = new Map(skills.map((s) => [s.name, s.skillMdPath]));

  const sessions = new SessionStore(params.cwd);
  const sessionCwds = new Map<string, string | null>();
  const traceCwd = (sessionId: string): string | null => {
    const cached = sessionCwds.get(sessionId);
    if (cached !== undefined) return cached;
    const session = sessions.getSessionById(sessionId);
    const cwd = session?.cwdLast || session?.cwdAtStart || null;
    sessionCwds.set(sessionId, cwd);
    return cwd;
  };

  // Bucket samples by attributed skill.
  const buckets = new Map<string, MineSample[]>();
  for (const trace of listTraces({ limit: 2000 })) {
    if (trace.outcome === "cancelled") continue;
    const steps = listTraceSteps(trace.traceId).map((s) => ({
      toolName: s.toolName,
      input: s.input,
      success: s.success,
      metadata: s.metadata,
    }));
    const used = attributeSkills(steps, skills, { cwd: traceCwd(trace.sessionId) });
    if (used.length === 0) continue;
    const sample: MineSample = {
      query: trace.query,
      result: trace.result,
      feedback: trace.feedback,
      outcome: trace.outcome,
    };
    for (const name of used) {
      const arr = buckets.get(name) ?? [];
      arr.push(sample);
      buckets.set(name, arr);
    }
  }

  const results: OptimizeResult[] = [];
  for (const [skill, samples] of buckets) {
    const fewShot = mineFewShot(samples, { minFeedback: params.minFeedback, topN: params.topN });
    if (fewShot.length === 0) continue;
    const source = sourceByName.get(skill);
    if (!source) continue;
    saveSkillOverlay({ skill, source, fewShot, sampleCount: samples.length, updatedAt: new Date().toISOString() });
    results.push({ skill, source, examples: fewShot.length, sampleCount: samples.length });
  }
  return results;
}
