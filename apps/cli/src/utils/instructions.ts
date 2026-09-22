import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { formatSteeringInstructions, loadSteeringPreferences } from "../core/persistence/steering";
import { executeEventHooks } from "../hooks/index";
import type { InstructionsLoadedHookInput } from "../hooks/types";
import { findGitRoot } from "./git-root";

const instructionsHookFiredFor = new Set<string>();

// Persona files loaded BEFORE AGENTS.md (define who you are and how you behave)
// Order: SOUL (values) → IDENTITY (self) → USER (owner profile) → TOOLS (capabilities)
const PERSONA_PRELUDE_FILES = ["SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md"] as const;

// Persona files loaded AFTER AGENTS.md (process docs + live state)
const PERSONA_POSTLUDE_FILES = ["DREAMING.md", "HEARTBEAT.md"] as const;

// Persistent memory lives in a subdirectory at every level it appears
const MEMORY_RELATIVE_PATH = path.join(".agent-memory", "MEMORY.md");
const MEMORY_SCRATCH_RELATIVE_PATH = path.join(".agent-memory", ".scratch.md");

// Hot-prompt budgets for persona/memory files. These cap the bytes any single
// file can contribute to the per-turn system prompt; oversized files are
// compacted (see `compactHeartbeat` / `compactMemory`) or middle-truncated
// (see `trimToBudget`). Values are empirical — tuned against typical agent
// memory growth so the prompt stays under ~80k chars total when all files are
// at-budget. Adjust together with the corresponding compaction strategy; do
// not raise without checking real-world prompt sizes.
const HEARTBEAT_MAX_CHARS = 18_000;
const MEMORY_MAX_CHARS = 32_000;
const SCRATCH_MAX_CHARS = 8_000;

function readNonEmptyFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const text = fs.readFileSync(filePath, "utf-8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function directoryChain(fromRoot: string, toCwd: string): string[] {
  const rel = path.relative(fromRoot, toCwd);
  if (rel === "") return [fromRoot];
  if (rel.startsWith("..")) return [toCwd];

  const segments = rel.split(path.sep).filter(Boolean);
  const chain: string[] = [];
  let acc = fromRoot;
  chain.push(acc);
  for (const segment of segments) {
    acc = path.join(acc, segment);
    chain.push(acc);
  }
  return chain;
}

/**
 * Middle-truncate `text` to fit `maxChars`. Keeps the head (45%) and tail
 * (55%) so the model sees both the introduction/context and the most recent
 * content, then injects a model-visible marker explaining the omission. The
 * tail is slightly larger because for memory/heartbeat files recent entries
 * are typically more relevant than older ones. Acts as the safety net for
 * the structural compactors below — those drop entire sections, then this
 * still runs to guarantee the budget.
 */
function trimToBudget(label: string, text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.45);
  const tailChars = maxChars - headChars;
  return [
    text.slice(0, headChars).trimEnd(),
    `[${label} compacted: ${text.length - maxChars} chars omitted from the middle of this hot-path prompt segment.]`,
    text.slice(-tailChars).trimStart(),
  ].join("\n\n");
}

function splitH2Sections(text: string): Array<{ heading: string; content: string }> {
  const matches = [...text.matchAll(/^## .+$/gm)];
  if (matches.length === 0) return [{ heading: "", content: text }];

  const sections: Array<{ heading: string; content: string }> = [];
  const firstIndex = matches[0]?.index ?? 0;
  if (firstIndex > 0) {
    sections.push({ heading: "", content: text.slice(0, firstIndex).trimEnd() });
  }

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const start = match.index ?? 0;
    const end = matches[i + 1]?.index ?? text.length;
    sections.push({ heading: match[0], content: text.slice(start, end).trimEnd() });
  }

  return sections.filter((section) => section.content.trim().length > 0);
}

/**
 * Compact an oversized HEARTBEAT.md for the hot prompt. Strategy: keep only
 * the structural sections that describe live state ("Conventions", "State",
 * "Pending", "Recurring", "Next heartbeat", "Notes for next agent"); drop
 * everything else (completed-work logs, postmortems, archival narrative) and
 * leave a marker telling the model to `read_file` the raw HEARTBEAT.md when
 * historical context matters.
 *
 * The allowlist below is STRUCTURAL — any H2 heading not in this regex is
 * silently dropped from the model's view. If you rename `## State` to
 * `## Current State`, that section disappears from the prompt with no
 * warning. Update this regex whenever you add or rename a live-state section.
 */
function compactHeartbeat(text: string): string {
  if (text.length <= HEARTBEAT_MAX_CHARS) return text;

  const keepHeading = /^(## (Conventions|State|Pending|Recurring|Next heartbeat|Notes for next agent))/i;
  const kept = splitH2Sections(text).filter((section) => section.heading === "" || keepHeading.test(section.heading));
  const compacted = [
    ...kept.map((section) => section.content),
    "[HEARTBEAT completed-history sections omitted from the hot prompt. Read HEARTBEAT.md directly when old completed work matters.]",
  ].join("\n\n");

  return trimToBudget("HEARTBEAT.md", compacted, HEARTBEAT_MAX_CHARS);
}

/**
 * Return the suffix of `section` containing only the most recent `count`
 * bold-bullet list items (`- **...**`). Used to truncate MEMORY update logs.
 *
 * The `- **` recognizer is intentional: MEMORY update entries are written as
 * `- **YYYY-MM-DD** — note...`. A plain `- entry` would not match — the
 * function would short-circuit and return the section unchanged. Update the
 * regex if the update-log entry format changes.
 */
function lastMarkdownListItems(section: string, count: number): string {
  const matches = [...section.matchAll(/^- \*\*/gm)];
  if (matches.length <= count) return section.trim();
  const start = matches[Math.max(0, matches.length - count)]?.index ?? 0;
  return section.slice(start).trim();
}

/**
 * Compact an oversized MEMORY.md for the hot prompt. Strategy:
 *  1. Keep curated reference sections ("Owner", "Project", "Open threads",
 *     "Lessons learned") in full.
 *  2. For "Update log", keep only the 12 most recent bold-bullet entries.
 *  3. Drop everything else (large archival sections) and leave a marker
 *     telling the model to `read_file` MEMORY.md for older context.
 *  4. Run `trimToBudget` as the final safety net.
 *
 * The keep-heading regex is STRUCTURAL — any H2 heading not in this regex is
 * silently dropped from the model's view. Renaming `## Project` to
 * `## Project Facts` would remove that section from the prompt with no
 * warning. Update this regex when you add or rename a reference section.
 *
 * The update-log "keep last 12 entries" cap is empirical — recent enough to
 * give the model a sense of trajectory without burning the whole budget.
 */
function compactMemory(text: string): string {
  if (text.length <= MEMORY_MAX_CHARS) return text;

  const sections = splitH2Sections(text);
  const keepHeading = /^(## (Owner|Project|Open threads|Lessons learned))/i;
  const kept = sections.filter((section) => section.heading === "" || keepHeading.test(section.heading));
  const updateLog = sections.find((section) => /^## Update log/i.test(section.heading));
  if (updateLog) {
    const body = updateLog.content.replace(updateLog.heading, "").trim();
    kept.push({
      heading: updateLog.heading,
      content: `${updateLog.heading}\n\n[Older MEMORY update-log entries omitted from the hot prompt.]\n\n${lastMarkdownListItems(
        body,
        12,
      )}`,
    });
  }

  const compacted = [
    ...kept.map((section) => section.content),
    "[MEMORY archival sections omitted from the hot prompt. Use read_file on .agent-memory/MEMORY.md for older details.]",
  ].join("\n\n");

  return trimToBudget("MEMORY.md", compacted, MEMORY_MAX_CHARS);
}

function readPersonaFile(filePath: string): string | null {
  const text = readNonEmptyFile(filePath);
  if (!text) return null;
  return path.basename(filePath) === "HEARTBEAT.md" ? compactHeartbeat(text) : text;
}

function readMemoryFile(filePath: string): string | null {
  const text = readNonEmptyFile(filePath);
  return text ? compactMemory(text) : null;
}

function readScratchFile(filePath: string): string | null {
  const text = readNonEmptyFile(filePath);
  return text ? trimToBudget(".agent-memory/.scratch.md", text, SCRATCH_MAX_CHARS) : null;
}

/**
 * Load all instruction-shaped files for a single directory in canonical
 * order: persona prelude → AGENTS.md (or override) → persona postlude → memory.
 *
 * Empty or missing files are skipped silently.
 */
function loadDirectorySegments(dir: string): string[] {
  const segments: string[] = [];

  for (const file of PERSONA_PRELUDE_FILES) {
    const text = readPersonaFile(path.join(dir, file));
    if (text) segments.push(text);
  }

  const overridePath = path.join(dir, "AGENTS.override.md");
  if (fs.existsSync(overridePath)) {
    const overrideText = readNonEmptyFile(overridePath);
    if (overrideText) segments.push(overrideText);
  } else {
    const agentsText = readNonEmptyFile(path.join(dir, "AGENTS.md"));
    if (agentsText) segments.push(agentsText);
  }

  for (const file of PERSONA_POSTLUDE_FILES) {
    const text = readPersonaFile(path.join(dir, file));
    if (text) segments.push(text);
  }

  const memoryText = readMemoryFile(path.join(dir, MEMORY_RELATIVE_PATH));
  if (memoryText) segments.push(memoryText);

  const scratchText = readScratchFile(path.join(dir, MEMORY_SCRATCH_RELATIVE_PATH));
  if (scratchText) {
    segments.push(`# Agent Memory Scratch\n\n${scratchText}`);
  }

  return segments;
}

function loadAgentsSegments(canonicalCwd: string): string[] {
  const segments: string[] = [];

  const globalDir = path.join(os.homedir(), ".grok");
  segments.push(...loadDirectorySegments(globalDir));

  const root = findGitRoot(canonicalCwd) ?? canonicalCwd;
  for (const dir of directoryChain(root, canonicalCwd)) {
    segments.push(...loadDirectorySegments(dir));
  }

  return segments;
}

export function loadCustomInstructions(cwd: string): string | null {
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(cwd);
  } catch {
    canonical = path.resolve(cwd);
  }

  const fileSegments = loadAgentsSegments(canonical);
  const parts: string[] = [...fileSegments];

  // Project any persisted /steer selections as a trailing instruction block so
  // recency weights them as active session directives. Absent when unset.
  const steering = formatSteeringInstructions(loadSteeringPreferences());
  if (steering) parts.push(steering);

  if (parts.length === 0) return null;

  // The InstructionsLoaded hook reports loaded *files*; steering is derived
  // state, not a file, so gate + count on fileSegments only.
  if (fileSegments.length > 0 && !instructionsHookFiredFor.has(canonical)) {
    instructionsHookFiredFor.add(canonical);
    const hookInput: InstructionsLoadedHookInput = {
      hook_event_name: "InstructionsLoaded",
      files_loaded: fileSegments.length,
      cwd: canonical,
    };
    executeEventHooks(hookInput, canonical).catch(() => {});
  }

  return parts.join("\n\n");
}
