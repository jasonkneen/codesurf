import { createTwoFilesPatch } from "diff";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { open } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";
import { summarizeDiagnostics, syncFileWithLsp } from "../lsp/runtime";
import type { LspDiagnosticFile } from "../lsp/types";
import { getCodesurfConfigDir } from "../utils/config-dir";
import { getCurrentSandboxMode, type SandboxMode } from "../utils/settings";

export interface FileDiff {
  filePath: string;
  additions: number;
  removals: number;
  patch: string;
  isNew: boolean;
}

export interface FileResult {
  success: boolean;
  output: string;
  diff?: FileDiff;
  lspDiagnostics?: LspDiagnosticFile[];
}

function resolvePath(filePath: string, cwd: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Write-path policy
//
// The file tools write on the host even when bash runs inside Shuru, so a
// path check here is what keeps sandbox mode a sandbox: without it a model
// (or a prompt-injected repo) could write hooks into user settings, or a
// shell rc file, and get host execution. Paths are compared after resolving
// symlinks on the nearest existing ancestor, so `workspace/link -> ~` does
// not count as inside the workspace.
// ─────────────────────────────────────────────────────────────────────────────

export type WritePathClass = "workspace" | "outside" | "config" | "shell-rc";

export interface FileWriteOptions {
  /** Defaults to the settings-derived mode. Callers with a live agent should pass its current mode. */
  sandboxMode?: SandboxMode;
}

const SHELL_RC_FILES = [
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".zlogout",
  ".config/fish/config.fish",
];

/** Config-dir files that are never writable through the file tools, even from inside that dir. */
const PROTECTED_CONFIG_FILES = [
  "user-settings.json",
  "workspace-trust.json",
  "credentials.json",
  "extensions.json",
  "settings.json",
];

/** Resolve symlinks on the longest existing prefix of `p`, keeping the not-yet-created tail. */
function realpathLenient(p: string): string {
  let current = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return join(current, ...tail);
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function classifyWritePath(absolutePath: string, cwd: string, home = homedir()): WritePathClass {
  const target = realpathLenient(absolutePath);
  const workspace = realpathLenient(cwd);
  const realHome = realpathLenient(home);

  for (const rc of SHELL_RC_FILES) {
    if (target === join(realHome, rc)) return "shell-rc";
  }
  // Codesurf's own configuration (user settings with hooks and MCP servers,
  // workspace trust decisions, credentials). The files that decide what runs
  // on the host are always protected; the rest of a config dir only when it is
  // outside the workspace (e.g. developing an extension under it stays possible).
  const configDirs = [getCodesurfConfigDir(), join(home, ".codesurf"), join(home, ".grok")].map(realpathLenient);
  for (const dir of configDirs) {
    if (!isWithin(target, dir)) continue;
    if (PROTECTED_CONFIG_FILES.includes(relative(dir, target))) return "config";
    if (!isWithin(target, workspace)) return "config";
  }
  return isWithin(target, workspace) ? "workspace" : "outside";
}

/**
 * Hard refusals applied at execution time, after any approval. Codesurf's own
 * config is never writable through the file tools (it decides what runs on
 * the host). Under Shuru the tools may only write inside the workspace.
 * Returns the refusal message, or null when the write may proceed.
 */
export function getWritePathRefusal(absolutePath: string, cwd: string, options: FileWriteOptions = {}): string | null {
  const kind = classifyWritePath(absolutePath, cwd);
  if (kind === "config") {
    return `Refusing to write ${absolutePath}: CodeSurf configuration files can only be edited by the user directly.`;
  }
  const sandboxMode = options.sandboxMode ?? getCurrentSandboxMode();
  if (sandboxMode === "shuru" && kind !== "workspace") {
    return `Refusing to write ${absolutePath}: sandbox mode only allows file writes inside the workspace (${cwd}).`;
  }
  return null;
}

/**
 * True when a write must be confirmed by the user even under the
 * "accept-all" edit policy: anything outside the workspace or a shell rc file.
 */
export function writePathRequiresApproval(absolutePath: string, cwd: string): boolean {
  return classifyWritePath(absolutePath, cwd) !== "workspace";
}

function replaceFirstLiteral(input: string, needle: string, replacement: string): string {
  const index = input.indexOf(needle);
  if (index === -1) return input;
  return `${input.slice(0, index)}${replacement}${input.slice(index + needle.length)}`;
}

function computeDiff(filePath: string, before: string, after: string): FileDiff {
  const patch = createTwoFilesPatch(filePath, filePath, before, after, "", "", {
    context: 3,
  });

  let additions = 0;
  let removals = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { filePath, additions, removals, patch, isNew: before === "" };
}

const CHUNK_SIZE = 64 * 1024;
const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 512 * 1024;
const MAX_LINE_LENGTH = 2000;
const BINARY_EXTENSIONS = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".exe",
  ".dll",
  ".so",
  ".class",
  ".jar",
  ".war",
  ".7z",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".bin",
  ".dat",
  ".obj",
  ".o",
  ".a",
  ".lib",
  ".wasm",
  ".pyc",
  ".pyo",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tiff",
  ".pdf",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
]);

function isBinaryByExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function isBinaryByBytes(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  for (const byte of bytes) {
    if (byte === 0) return true;
  }
  let nonPrintable = 0;
  for (const byte of bytes) {
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable++;
  }
  return nonPrintable / bytes.length > 0.3;
}

export interface ReadFileOptions {
  signal?: AbortSignal;
}

export async function readFile(
  filePath: string,
  cwd: string,
  startLine?: number,
  endLine?: number,
  options: ReadFileOptions = {},
): Promise<FileResult> {
  const signal = options.signal;
  const cancelled = (): FileResult => ({ success: false, output: `Read cancelled: ${filePath}` });
  try {
    const full = resolvePath(filePath, cwd);
    if (!existsSync(full)) {
      return { success: false, output: `File not found: ${filePath}` };
    }

    if (isBinaryByExtension(filePath)) {
      return { success: false, output: `Cannot read binary file: ${filePath}` };
    }

    if (signal?.aborted) return cancelled();

    const handle = await open(full, "r");
    try {
      const stat = await handle.stat();
      const size = stat.size;

      const first = Buffer.alloc(CHUNK_SIZE);
      const { bytesRead: firstRead } = await handle.read(first, 0, CHUNK_SIZE, 0);
      const firstChunk = first.subarray(0, firstRead);

      if (isBinaryByBytes(firstChunk)) {
        return { success: false, output: `Cannot read binary file: ${filePath}` };
      }

      const start = Math.max(0, (startLine ?? 1) - 1);
      const endLineResolved = endLine ?? Number.MAX_SAFE_INTEGER;

      const lines: string[] = [];
      const decoder = new TextDecoder("utf-8", { fatal: true });
      // `pending` never grows past MAX_LINE_LENGTH + 1 characters: once a line
      // is known to overflow the display cap, the rest of it is discarded.
      let pending = "";
      let pendingOverflow = false;
      let lineNum = 0;
      let lastEmitted = 0;
      let outputBytes = 0;
      let fileOffset = 0;
      let stoppedEarly = false;
      let outputLimited = false;
      let moreContent = false;

      const appendPending = (piece: string): void => {
        if (pendingOverflow || piece.length === 0) return;
        const room = MAX_LINE_LENGTH + 1 - pending.length;
        if (piece.length > room) {
          pending += piece.slice(0, room);
          pendingOverflow = true;
        } else {
          pending += piece;
        }
      };

      const emitLine = (line: string, overflow: boolean): void => {
        const truncated = overflow || line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}...` : line;
        lines.push(`${lineNum + 1} | ${truncated}`);
        lastEmitted = lineNum + 1;
        outputBytes += Buffer.byteLength(truncated, "utf-8");
      };

      // Returns true when scanning should stop before end of file.
      const consumeChunk = (chunk: Buffer): boolean => {
        fileOffset += chunk.length;
        const text = decoder.decode(chunk, { stream: true });
        let pos = 0;
        for (;;) {
          const idx = text.indexOf("\n", pos);
          if (idx === -1) {
            appendPending(text.slice(pos));
            return false;
          }
          const line = pendingOverflow ? pending : pending + text.slice(pos, idx);
          const overflow = pendingOverflow;
          pending = "";
          pendingOverflow = false;
          pos = idx + 1;

          const inRange = lineNum >= start && lineNum < endLineResolved;
          if (inRange) emitLine(line, overflow);
          lineNum++;

          const hitOutputLimit = inRange && (lines.length >= MAX_READ_LINES || outputBytes >= MAX_READ_BYTES);
          const hitEnd = lineNum >= endLineResolved;
          if (hitOutputLimit || hitEnd) {
            stoppedEarly = true;
            outputLimited = hitOutputLimit;
            moreContent = pos < text.length || fileOffset < size;
            return true;
          }
        }
      };

      let done = consumeChunk(firstChunk);
      if (!done && firstRead > 0) {
        const buf = Buffer.alloc(CHUNK_SIZE);
        while (!done) {
          if (signal?.aborted) return cancelled();
          const { bytesRead: read } = await handle.read(buf, 0, CHUNK_SIZE, fileOffset);
          if (read === 0) break;
          done = consumeChunk(buf.subarray(0, read));
        }
      }

      if (!done) {
        appendPending(decoder.decode());
        if (pending.length > 0) {
          if (lineNum >= start && lineNum < endLineResolved) emitLine(pending, pendingOverflow);
          lineNum++;
        }
      }

      const complete = !stoppedEarly || !moreContent;
      const rangeLabel = endLine !== undefined ? `${start + 1}-${endLine}` : `${start + 1}-end`;

      if (lines.length === 0) {
        const known = complete ? `file has ${lineNum} line${lineNum === 1 ? "" : "s"}` : "total not counted";
        return { success: true, output: `[${filePath}: no lines in range ${rangeLabel}; ${known}]` };
      }

      let header: string;
      if (complete) {
        header = `[${filePath}: lines ${start + 1}-${lastEmitted} of ${lineNum}]`;
      } else {
        const why = outputLimited ? "output limit reached, file continues" : "file continues";
        header = `[${filePath}: lines ${start + 1}-${lastEmitted}; ${why} (total not counted; continue with start_line=${lastEmitted + 1})]`;
      }
      return { success: true, output: `${header}\n${lines.join("\n")}` };
    } finally {
      await handle.close();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Failed to read file: ${msg}` };
  }
}

export async function writeFile(
  filePath: string,
  content: string,
  cwd: string,
  options: FileWriteOptions = {},
): Promise<FileResult> {
  try {
    const full = resolvePath(filePath, cwd);
    const refusal = getWritePathRefusal(full, cwd, options);
    if (refusal) return { success: false, output: refusal };
    const before = existsSync(full) ? readFileSync(full, "utf-8") : "";
    const dir = dirname(full);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(full, content, "utf-8");

    const diff = computeDiff(filePath, before, content);
    const verb = before === "" ? "Created" : "Updated";
    const lspDiagnostics = await syncFileWithLsp(cwd, full, content, true, true).catch(() => [] as LspDiagnosticFile[]);
    const lspSummary = summarizeDiagnostics(lspDiagnostics);
    return {
      success: true,
      output: `${verb} ${filePath} (+${diff.additions} -${diff.removals})${lspSummary ? `\n${lspSummary}` : ""}`,
      diff,
      lspDiagnostics,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Failed to write file: ${msg}` };
  }
}

export async function editFile(
  filePath: string,
  oldString: string,
  newString: string,
  cwd: string,
  options: FileWriteOptions = {},
): Promise<FileResult> {
  try {
    const full = resolvePath(filePath, cwd);
    const refusal = getWritePathRefusal(full, cwd, options);
    if (refusal) return { success: false, output: refusal };
    if (!existsSync(full)) {
      return { success: false, output: `File not found: ${filePath}` };
    }
    const before = readFileSync(full, "utf-8");
    if (oldString === "") {
      return { success: false, output: "old_string must be non-empty" };
    }
    const count = before.split(oldString).length - 1;

    if (count === 0) {
      return { success: false, output: `old_string not found in ${filePath}` };
    }
    if (count > 1) {
      return {
        success: false,
        output: `old_string is not unique in ${filePath} (${count} occurrences). Include more surrounding context to make it unique.`,
      };
    }

    const after = replaceFirstLiteral(before, oldString, newString);
    writeFileSync(full, after, "utf-8");

    const diff = computeDiff(filePath, before, after);
    const lspDiagnostics = await syncFileWithLsp(cwd, full, after, true, true).catch(() => [] as LspDiagnosticFile[]);
    const lspSummary = summarizeDiagnostics(lspDiagnostics);
    return {
      success: true,
      output: `Edited ${filePath} (+${diff.additions} -${diff.removals})${lspSummary ? `\n${lspSummary}` : ""}`,
      diff,
      lspDiagnostics,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Failed to edit file: ${msg}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval pre-execution preview
//
// Computes the prospective diff for a write_file / edit_file call WITHOUT
// touching disk. Used by the agent's tool-approval-request handler so the UI
// can show the user the exact pending change before they accept or reject.
//
// Returns null on filesystem errors or invalid inputs — the approval flow
// falls back to showing path + tool name in that case.
// ─────────────────────────────────────────────────────────────────────────────

export interface EditPreview {
  filePath: string;
  absolutePath: string;
  isNew: boolean;
  additions: number;
  removals: number;
  patch: string;
  /** True when the resulting content would be byte-identical to the existing
   *  file — useful to suppress no-op approvals (we return null here and the
   *  agent falls back to a generic prompt). */
  noop: boolean;
}

export function computeEditPreview(
  toolName: "write_file" | "edit_file",
  input: { path?: string; content?: string; old_string?: string; new_string?: string },
  cwd: string,
): EditPreview | null {
  try {
    const filePath = input.path;
    if (!filePath || typeof filePath !== "string") return null;
    const absolutePath = resolvePath(filePath, cwd);
    const exists = existsSync(absolutePath);
    const before = exists ? readFileSync(absolutePath, "utf-8") : "";

    let after: string;
    if (toolName === "write_file") {
      if (typeof input.content !== "string") return null;
      after = input.content;
    } else {
      if (!exists) return null;
      const oldString = input.old_string ?? "";
      const newString = input.new_string ?? "";
      if (oldString === "") return null;
      const count = before.split(oldString).length - 1;
      // For non-unique / missing old_string we still want to surface SOMETHING
      // so the user sees why this will fail — return a synthetic preview with
      // empty after-text so the diff renders as a deletion of old_string.
      if (count !== 1) {
        after = before; // identical; we'll mark noop=false so UI still renders
        const diag = computeDiff(filePath, before, after);
        return {
          filePath,
          absolutePath,
          isNew: false,
          additions: 0,
          removals: 0,
          patch: `${diag.patch}
# WARNING: old_string ${count === 0 ? "not found" : `matched ${count} times`} in ${filePath}`,
          noop: false,
        };
      }
      after = replaceFirstLiteral(before, oldString, newString);
    }

    const diff = computeDiff(filePath, before, after);
    return {
      filePath,
      absolutePath,
      isNew: !exists,
      additions: diff.additions,
      removals: diff.removals,
      patch: diff.patch,
      noop: before === after,
    };
  } catch {
    return null;
  }
}
