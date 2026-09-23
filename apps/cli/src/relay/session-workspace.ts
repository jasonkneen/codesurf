// Node-side validation of a session's workspace (the folder a front asks a
// session to run in). Kept out of session-stream.ts so that module stays free
// of node:fs for the web bundle.

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import { normalizeSandboxSettings } from "../utils/settings";
import type { SessionWorkspace, SessionWorkspaceOptions } from "./host";
import type { NodeInfo } from "./session-stream";

/** What a node serves: any folder ("user", the default) or one project tree. */
export type NodeScope = NodeInfo;

/**
 * Resolve a create request's workspace: `cwd` must be an absolute path to an
 * existing directory and is returned as its realpath; unset means the node's
 * own folder (a project server's root). A project server also requires the
 * folder to be its root or inside it. Throws with a front-readable message.
 */
export function resolveSessionWorkspace(
  options: SessionWorkspaceOptions = {},
  scope: NodeScope = { scope: "user" },
): SessionWorkspace {
  const requested = options.cwd;
  if (requested !== undefined && (typeof requested !== "string" || !isAbsolute(requested))) {
    throw new Error(`session cwd must be an absolute path: ${String(requested)}`);
  }
  const project = scope.scope === "project" ? scope.project : undefined;
  const folder = requested ?? project ?? process.cwd();
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
  const cwd = realpathSync(folder);
  if (project && cwd !== project && !cwd.startsWith(project.endsWith(sep) ? project : project + sep)) {
    throw new Error(`this is a project server for ${project}; ${cwd} is outside it`);
  }
  return {
    cwd,
    ...(mode !== undefined ? { sandboxMode: mode } : {}),
    ...(options.sandboxSettings !== undefined
      ? { sandboxSettings: normalizeSandboxSettings(options.sandboxSettings) }
      : {}),
  };
}

/** Validate `codesurf node --project <root>` and return the node's scope. */
export function resolveNodeScope(options: { project?: string; name?: string }): NodeScope {
  const name = options.name?.trim() || undefined;
  if (!options.project) return { scope: "user", ...(name ? { name } : {}) };
  if (!isAbsolute(options.project)) throw new Error(`--project must be an absolute path: ${options.project}`);
  let isDirectory = false;
  try {
    isDirectory = statSync(options.project).isDirectory();
  } catch {
    throw new Error(`--project does not exist: ${options.project}`);
  }
  if (!isDirectory) throw new Error(`--project is not a directory: ${options.project}`);
  return { scope: "project", project: realpathSync(options.project), ...(name ? { name } : {}) };
}
