// Loop-state persistence — `<configDir>/loops.json`.
//
// The kernel loop manager (src/core/plugins/loops.ts) is an in-memory map;
// this module gives it durability across CLI restarts. A loop that was
// `running` when the process died rehydrates as `stopped` (a restart is an
// implicit interrupt) with its iteration counter and history intact, so
// `/loop <name>` resumes where it left off.
//
// Same dependency-light posture as steering.ts: fs + config-dir only, so it
// stays trivially unit-testable.

import * as fs from "fs";
import * as path from "path";
import { getCodesurfConfigDir } from "../../utils/config-dir";
import type { LoopState } from "../plugins/api";

function resolveLoopsFile(): { dir: string; file: string } {
  const dir = getCodesurfConfigDir();
  return { dir, file: path.join(dir, "loops.json") };
}

interface LoopsPersistence {
  version: 1;
  loops: LoopState[];
}

function isLoopState(value: unknown): value is LoopState {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<LoopState>;
  return (
    !!v.spec &&
    typeof v.spec === "object" &&
    typeof (v.spec as { name?: unknown }).name === "string" &&
    typeof v.currentIteration === "number" &&
    typeof v.status === "string" &&
    Array.isArray(v.history)
  );
}

/**
 * Load persisted loop states. Invalid or unreadable files yield an empty
 * list (a fresh start beats crashing the kernel bootstrap). Previously
 * `running` loops come back as `stopped`.
 */
export function loadPersistedLoops(): LoopState[] {
  try {
    const { file } = resolveLoopsFile();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<LoopsPersistence>;
    const loops = Array.isArray(parsed.loops) ? parsed.loops.filter(isLoopState) : [];
    for (const state of loops) {
      if (state.status === "running") {
        state.status = "stopped";
        state.lastMessage = `Loop "${state.spec.name}" was running when the session ended; resume with /loop ${state.spec.name}.`;
      }
    }
    return loops;
  } catch {
    return [];
  }
}

/** Persist the full loop list. Best-effort: failures never break the loop manager. */
export function savePersistedLoops(loops: LoopState[]): void {
  try {
    const { dir, file } = resolveLoopsFile();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload: LoopsPersistence = { version: 1, loops };
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  } catch {
    // Best-effort — an unwritable config dir must not break loop control.
  }
}
