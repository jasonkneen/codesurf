import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { workspaceRoot } from "../utils/workspace-scope";

export interface CommandLookupOptions {
  /** Directory the command will be spawned in; relative commands and PATH entries resolve against it. */
  cwd?: string;
  /** Environment the command will be spawned with; its PATH, when set, replaces the host PATH. */
  env?: Record<string, string | undefined>;
}

/**
 * Resolve `command` the way `child_process.spawn` will when given the same
 * `cwd` and `env`, so misconfigured MCP servers fail fast with a clear
 * "command not found" error instead of an opaque ENOENT from `spawn`.
 *
 * A command containing a path separator is taken relative to `cwd`. Otherwise
 * each PATH entry is searched in order — `env.PATH` when the caller configured
 * one (the stdio transport spreads `server.env` over its inherited defaults,
 * so a configured PATH replaces the host PATH rather than extending it), else
 * the host PATH — with relative entries again resolving against `cwd`. On
 * Windows the working directory is searched first and PATHEXT is applied,
 * mirroring CreateProcess.
 *
 * Returns the resolved executable path, or `null` when nothing matches.
 */
export function resolveCommandPath(command: string, options: CommandLookupOptions = {}): string | null {
  const name = command.trim();
  if (!name) return null;

  const cwd = options.cwd ?? workspaceRoot();
  const roots = hasPathSeparator(name) ? [cwd] : pathEntries(options.env).map((entry) => resolve(cwd, entry));

  for (const root of roots) {
    for (const candidate of withExecutableExtensions(resolve(root, name))) {
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Whether `command` resolves to an executable in the given spawn context (host cwd/PATH by default). */
export function commandExists(command: string, options: CommandLookupOptions = {}): boolean {
  return resolveCommandPath(command, options) !== null;
}

function hasPathSeparator(name: string): boolean {
  return name.includes("/") || (process.platform === "win32" && name.includes("\\"));
}

function pathEntries(env?: Record<string, string | undefined>): string[] {
  const configured = env ? Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] : undefined;
  const entries = (configured ?? process.env.PATH ?? "").split(delimiter);
  return process.platform === "win32" ? ["", ...entries] : entries;
}

function withExecutableExtensions(candidate: string): string[] {
  if (process.platform !== "win32") return [candidate];
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const lower = candidate.toLowerCase();
  if (extensions.some((ext) => lower.endsWith(ext.toLowerCase()))) return [candidate];
  return [candidate, ...extensions.map((ext) => `${candidate}${ext}`)];
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
