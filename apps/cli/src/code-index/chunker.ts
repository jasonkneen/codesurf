import { extname } from "node:path";
import type { CodeChunk } from "./types.js";

const DEFAULT_MAX_CHARS = 1_000;
const DEFAULT_OVERLAP_LINES = 4;

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".vue": "vue",
  ".svelte": "svelte",
  ".md": "markdown",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".sql": "sql",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
};

const BOUNDARY_PATTERNS: Record<string, RegExp> = {
  typescript: /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+[\w$]+/gm,
  javascript: /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+[\w$]+/gm,
  python: /^(?:async\s+)?(?:def|class)\s+\w+/gm,
  ruby: /^(?:def|class|module)\s+\w+/gm,
  go: /^(?:func|type)\s+\w+/gm,
  rust: /^(?:pub\s+)?(?:fn|struct|enum|impl|trait|mod)\s+\w+/gm,
  java: /^(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|enum|void|int|String)\s+\w+/gm,
  swift: /^(?:func|class|struct|enum|protocol)\s+\w+/gm,
};

const FUNCTION_PATTERNS: Record<string, RegExp> = {
  typescript: /(?:function|class|interface|type|enum)\s+([\w$]+)/,
  javascript: /(?:function|class)\s+([\w$]+)/,
  python: /(?:def|class)\s+(\w+)/,
  ruby: /(?:def|class|module)\s+(\w+)/,
  go: /(?:func|type)\s+(\w+)/,
  rust: /(?:fn|struct|enum|impl|trait|mod)\s+(\w+)/,
  java: /(?:class|interface|enum)\s+(\w+)|(\w+)\s*\(/,
  swift: /(?:func|class|struct|enum|protocol)\s+(\w+)/,
};

export function detectLanguage(filePath: string): string {
  return EXTENSION_TO_LANGUAGE[extname(filePath).toLowerCase()] ?? "unknown";
}

export function chunkCode(content: string, filePath: string, maxChars = DEFAULT_MAX_CHARS): CodeChunk[] {
  if (!content.trim()) return [];
  const language = detectLanguage(filePath);
  const structural = chunkByStructure(content, language, maxChars);
  return structural.length > 0 ? structural : chunkByLines(content, language, maxChars);
}

function chunkByStructure(content: string, language: string, maxChars: number): CodeChunk[] {
  const pattern = BOUNDARY_PATTERNS[language];
  if (!pattern) return [];

  const matches: Array<{ index: number }> = [];
  const re = new RegExp(pattern.source, pattern.flags);
  while (true) {
    const match = re.exec(content);
    if (match === null) break;
    matches.push({ index: match.index });
  }
  if (matches.length === 0) return [];

  const chunks: CodeChunk[] = [];
  // Every offset queried below is non-decreasing (preamble, then each
  // declaration's start and end in order), so one forward-only cursor replaces
  // a full rescan from offset zero per declaration.
  const lineAt = createLineCursor(content);

  // Preamble: shebangs, imports, configuration, comments and decorators that
  // precede the first recognized declaration. Kept as its own chunk so search
  // can still reach it; line coordinates cover its first to last non-blank char.
  const preamble = content.slice(0, matches[0]!.index);
  const preambleStart = preamble.search(/\S/);
  if (preambleStart !== -1) {
    const body = preamble.trim();
    const startLine = lineAt(preambleStart);
    const endLine = lineAt(preambleStart + body.length - 1);
    if (body.length <= maxChars) {
      chunks.push({ content: body, metadata: { startLine, endLine, language } });
    } else {
      chunks.push(...chunkByLines(body, language, maxChars, startLine));
    }
  }

  for (let i = 0; i < matches.length; i++) {
    const startIndex = matches[i]!.index;
    const endIndex = i + 1 < matches.length ? matches[i + 1]!.index : content.length;
    const body = content.slice(startIndex, endIndex).trim();
    if (!body) continue;
    const startLine = lineAt(startIndex);
    const endLine = lineAt(Math.max(startIndex, endIndex - 1));
    const functionName = extractFunctionName(body, language);
    if (body.length <= maxChars) {
      chunks.push({ content: body, metadata: { startLine, endLine, language, functionName } });
    } else {
      chunks.push(...chunkByLines(body, language, maxChars, startLine, functionName));
    }
  }
  return chunks;
}

function chunkByLines(
  content: string,
  language: string,
  maxChars: number,
  baseLine = 1,
  functionName?: string,
): CodeChunk[] {
  const lines = content.split("\n");
  const chunks: CodeChunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length && (size === 0 || size + lines[end]!.length + 1 <= maxChars)) {
      size += lines[end]!.length + 1;
      end++;
    }
    const body = lines.slice(start, end).join("\n").trim();
    if (body) {
      chunks.push({
        content: body,
        metadata: {
          startLine: baseLine + start,
          endLine: baseLine + Math.max(start, end - 1),
          language,
          functionName,
        },
      });
    }
    if (end >= lines.length) break;
    start = Math.max(end - DEFAULT_OVERLAP_LINES, start + 1);
  }
  return chunks;
}

function extractFunctionName(content: string, language: string): string | undefined {
  const match = FUNCTION_PATTERNS[language]?.exec(content);
  return match?.[1] ?? match?.[2];
}

/**
 * Returns a 1-based line lookup that only ever scans forward. Equivalent to
 * counting newlines in `[0, index)` on every call, but a sequence of
 * non-decreasing offsets costs O(content) in total instead of O(content) each.
 * A smaller offset than the previous one rewinds and rescans, so the result is
 * always correct regardless of call order.
 */
function createLineCursor(content: string): (index: number) => number {
  let cursorIndex = 0;
  let cursorLine = 1;
  return (index: number): number => {
    if (index < cursorIndex) {
      cursorIndex = 0;
      cursorLine = 1;
    }
    for (; cursorIndex < index; cursorIndex++) {
      if (content.charCodeAt(cursorIndex) === 10) cursorLine++;
    }
    return cursorLine;
  };
}
