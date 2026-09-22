// Answer "is this CLI installed?" without executing it.
//
// The providers used to probe with `execFileSync(bin, ["--help"])`. That runs on
// the render-path credential check, and for a heavy binary the cost is brutal:
// `fractal --help` alone blocks the event loop for ~1.5s because it boots a whole
// runtime just to print help text. Together with sbx/opencode/codex that was a
// ~1.9s synchronous freeze on the first render — the boot stall.
//
// Executing the binary was always the wrong question. "Installed" means "present
// and executable on PATH", which is a stat, not a subprocess. Same answer, ~1000x
// cheaper, and still safe to call synchronously from render.
//
// Semantics note: a binary that exists but is broken now reports as installed
// (it used to report as missing, because `--help` exited non-zero). That is the
// more honest answer — it surfaces later as a connect/run error rather than
// masquerading as "not installed".

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { cachedCliCheck } from "./cli-check-cache.js";

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Uncached PATH lookup. Exported for tests; callers want `isBinaryInstalled`. */
export function findBinaryOnPath(bin: string): boolean {
  if (!bin) return false;
  // An explicit path (absolute or relative) is checked directly, not searched.
  if (bin.includes("/")) return isExecutableFile(bin);

  const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return entries.some((dir) => isExecutableFile(join(dir, bin)));
}

/** Memoized (30s TTL, shared with the other CLI probes) presence check. */
export function isBinaryInstalled(bin: string): boolean {
  return cachedCliCheck(`binary-installed:${bin}`, () => findBinaryOnPath(bin));
}
