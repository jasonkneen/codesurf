// Node-side validation of a session's workspace (the folder a front asks a
// session to run in). Kept out of session-stream.ts so that module stays free
// of node:fs for the web bundle.

import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { normalizeSandboxSettings } from "../utils/settings";
import type { SessionWorkspace, SessionWorkspaceOptions } from "./host";

/**
 * Resolve a create request's workspace: `cwd` must be an absolute path to an
 * existing directory and is returned as its realpath; unset means the node's
 * own folder. Throws with a front-readable message otherwise.
 */
export function resolveSessionWorkspace(options: SessionWorkspaceOptions = {}): SessionWorkspace {
  const requested = options.cwd;
  if (requested !== undefined && (typeof requested !== "string" || !isAbsolute(requested))) {
    throw new Error(`session cwd must be an absolute path: ${String(requested)}`);
  }
  const folder = requested ?? process.cwd();
  let isDirectory = false;
  try {
    isDirectory = statSync(folder).isDirectory();
  } catch {
    throw new Error(`session cwd does not exist: ${folder}`);
  }
  if (!isDirectory) throw new Error(`session cwd is not a directory: ${folder}`);

  const mode = options.sandboxMode;
  if (mode !== undefined && mode !== "off" && mode !== "shuru") {
    throw new Error(`unknown sandbox mode: ${String(mode)} (expected "off" or "shuru")`);
  }
  return {
    cwd: realpathSync(folder),
    ...(mode !== undefined ? { sandboxMode: mode } : {}),
    ...(options.sandboxSettings !== undefined
      ? { sandboxSettings: normalizeSandboxSettings(options.sandboxSettings) }
      : {}),
  };
}
