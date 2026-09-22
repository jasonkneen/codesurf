import { existsSync } from "fs";
import path from "path";
import { getCurrentLspSettings } from "../utils/settings";
import { createWorkspaceLspManager, summarizeLspDiagnostics, type WorkspaceLspManager } from "./manager";
import type { LspDiagnosticFile, LspQueryInput, LspToolResponse } from "./types";

const managers = new Map<string, WorkspaceLspManager>();

export async function queryLsp(cwd: string, input: LspQueryInput, abortSignal?: AbortSignal): Promise<LspToolResponse> {
  const manager = getOrCreateManager(cwd);
  return manager.query(
    {
      ...input,
      filePath: path.isAbsolute(input.filePath) ? input.filePath : path.resolve(cwd, input.filePath),
    },
    abortSignal,
  );
}

export async function syncFileWithLsp(
  cwd: string,
  filePath: string,
  content: string,
  save = true,
  waitForDiagnostics = true,
): Promise<LspDiagnosticFile[]> {
  const manager = getOrCreateManager(cwd);
  return manager.syncFile(
    path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath),
    content,
    save,
    waitForDiagnostics,
  );
}

export function isLspToolEnabled(_cwd: string): boolean {
  const settings = getCurrentLspSettings();
  return settings.enabled && settings.tool;
}

export function summarizeDiagnostics(diagnostics: LspDiagnosticFile[]): string | null {
  return summarizeLspDiagnostics(diagnostics);
}

export async function shutdownWorkspaceLspManager(cwd: string): Promise<void> {
  const key = resolveManagerKey(cwd);
  const manager = managers.get(key);
  if (!manager) return;
  managers.delete(key);
  await manager.close();
}

function getOrCreateManager(cwd: string): WorkspaceLspManager {
  const key = resolveManagerKey(cwd);
  const existing = managers.get(key);
  if (existing) return existing;

  const manager = createWorkspaceLspManager(key, getCurrentLspSettings());
  managers.set(key, manager);
  return manager;
}

const WORKSPACE_MARKERS = [".codesurf", ".grok", ".git"];

/**
 * Workspace identity for LSP manager sharing: the nearest ancestor (including
 * `cwd` itself) carrying a CodeSurf or repository marker. Unmarked workspaces
 * keep their own cwd as the key; previously they all collapsed onto the
 * filesystem root and shared one manager, settings snapshot and shutdown.
 * Exported for tests.
 */
export function resolveManagerKey(cwd: string): string {
  const start = path.resolve(cwd);
  let current = start;
  while (true) {
    if (WORKSPACE_MARKERS.some((marker) => existsSync(path.join(current, marker)))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}
