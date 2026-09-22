import { existsSync, readFileSync, statSync } from "fs";
import { isAbsolute, resolve } from "path";
import { daemonClient, getDaemonStatus } from "../daemon/codesurf-daemon";

const MAX_FILE_SIZE = 100 * 1024; // 100 KB

const UNQUOTED_AT_RE = /(?:^|\s)@([\w\-./\\~][\w\-./\\~:]*)/g;
const QUOTED_AT_RE = /(?:^|\s)@"([^"]+)"/g;

export interface AtMentionedFile {
  raw: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
}

export interface ProcessedMentions {
  enhancedMessage: string;
  mentionedFiles: string[];
}

function parseLineRange(raw: string): { filePath: string; startLine?: number; endLine?: number } {
  const hashIdx = raw.lastIndexOf("#");
  if (hashIdx === -1) return { filePath: raw };

  const filePath = raw.slice(0, hashIdx);
  const fragment = raw.slice(hashIdx + 1);
  const rangeMatch = fragment.match(/^L(\d+)(?:-L?(\d+))?$/);
  if (!rangeMatch) return { filePath: raw };

  const startLine = Number.parseInt(rangeMatch[1]!, 10);
  const endLine = rangeMatch[2] ? Number.parseInt(rangeMatch[2], 10) : undefined;
  return { filePath, startLine, endLine };
}

export function extractAtMentionedFiles(text: string): AtMentionedFile[] {
  const mentions: AtMentionedFile[] = [];
  const seen = new Set<string>();

  for (const re of [QUOTED_AT_RE, UNQUOTED_AT_RE]) {
    re.lastIndex = 0;
    while (true) {
      const m = re.exec(text);
      if (m === null) break;
      const raw = m[1]!;
      if (seen.has(raw)) continue;
      seen.add(raw);
      const parsed = parseLineRange(raw);
      mentions.push({ raw, ...parsed });
    }
  }
  return mentions;
}

function resolvePath(filePath: string, cwd: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

function readFileContent(
  filePath: string,
  cwd: string,
  startLine?: number,
  endLine?: number,
): { content: string; truncated: boolean; resolvedPath: string } | null {
  const full = resolvePath(filePath, cwd);
  if (!existsSync(full)) return null;

  try {
    const stat = statSync(full);
    if (stat.isDirectory()) return null;

    const raw = readFileSync(full, "utf-8");
    const lines = raw.split("\n");
    const totalLines = lines.length;

    const start = Math.max(0, (startLine ?? 1) - 1);
    const end = Math.min(totalLines, endLine ?? totalLines);
    const slice = lines.slice(start, end);
    const joined = slice.map((line, i) => `${start + i + 1} | ${line}`).join("\n");

    const truncated = raw.length > MAX_FILE_SIZE;
    const content = truncated ? joined.slice(0, MAX_FILE_SIZE) : joined;
    const header = `[${full}: lines ${start + 1}-${end} of ${totalLines}]`;

    return { content: `${header}\n${content}`, truncated, resolvedPath: full };
  } catch {
    return null;
  }
}

export function processAtMentions(text: string, cwd: string): ProcessedMentions {
  const mentions = extractAtMentionedFiles(text);
  if (mentions.length === 0) {
    return { enhancedMessage: text, mentionedFiles: [] };
  }

  const fileBlocks: string[] = [];
  const mentionedFiles: string[] = [];

  for (const mention of mentions) {
    const result = readFileContent(mention.filePath, cwd, mention.startLine, mention.endLine);
    if (!result) continue;

    mentionedFiles.push(result.resolvedPath);
    let block = `<file path="${result.resolvedPath}">\n${result.content}\n</file>`;
    if (result.truncated) {
      block += `\n<!-- Note: ${result.resolvedPath} was truncated (exceeded ${MAX_FILE_SIZE / 1024}KB). Use read_file for the full content. -->`;
    }
    fileBlocks.push(block);
  }

  if (fileBlocks.length === 0) {
    return { enhancedMessage: text, mentionedFiles: [] };
  }

  const attachedBlock = `<attached_files>\n${fileBlocks.join("\n\n")}\n</attached_files>`;
  return {
    enhancedMessage: `${attachedBlock}\n\n${text}`,
    mentionedFiles,
  };
}

/**
 * Async @-mention expansion that prefers the shared `codesurfd` daemon's
 * `expandFileReferences` route when the daemon is reachable, and falls back
 * to the in-process expander when offline.
 *
 * Behavioral differences with the daemon path (vs. local fallback):
 *   - Caps at 6 references per message (daemon default)
 *   - 16 KB per file (daemon default), vs. 100 KB locally
 *   - Wraps each reference in `<<<BEGIN FILE …>>> / <<<END FILE …>>>`
 *     markers rather than `<file>` XML
 *   - Detects binaries / images / PDFs and emits a structured stub instead
 *     of raw bytes
 *   - Resolves files relative to the supplied `cwd` (treated as the
 *     workspace dir) and refuses to escape it via `..`
 *
 * The in-process expander stays available as `processAtMentions` for sync
 * call sites (e.g. queued-message preview) and as the offline fallback.
 */
export async function processAtMentionsAsync(text: string, cwd: string): Promise<ProcessedMentions> {
  // Quick out: no `@` at all? Skip both daemon and local work.
  if (!/(^|\s)@/.test(text)) {
    return { enhancedMessage: text, mentionedFiles: [] };
  }

  // Try the daemon first. Tight timeout via getDaemonStatus to avoid
  // blocking input handling when the daemon hasn't been started.
  try {
    const status = await getDaemonStatus();
    if (status.running) {
      const result = await daemonClient.expandFileReferences({
        message: text,
        workspaceDir: cwd,
        executionTarget: "local",
      });
      if (result.changed) {
        return {
          enhancedMessage: result.message,
          mentionedFiles: result.references
            .map((ref) => ref.resolvedPath)
            .filter((path): path is string => typeof path === "string" && path.length > 0),
        };
      }
      // Daemon ran but didn't change anything (no references found, or none
      // resolved). Don't fall back — the daemon is the source of truth.
      return { enhancedMessage: result.message, mentionedFiles: [] };
    }
  } catch {
    // Daemon unreachable or errored; fall through to local expander.
  }

  return processAtMentions(text, cwd);
}
