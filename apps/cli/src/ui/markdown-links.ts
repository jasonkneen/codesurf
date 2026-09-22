import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostFiles } from "./host-files.js";

const BACKTICK = "`";
const ABSOLUTE_LOCAL_PATH = String.raw`(?:\/|~\/)(?:(?:\\[^\n]|[^\s${BACKTICK}<>\[\](){}])+)`;
const MARKDOWN_LINK_DESTINATION = new RegExp(String.raw`\]\((${ABSOLUTE_LOCAL_PATH})\)`, "g");
const BARE_LOCAL_PATH = new RegExp(
  String.raw`(^|[\s])(${ABSOLUTE_LOCAL_PATH}\.[A-Za-z0-9]{1,12}(?::\d+)?)(?=$|[\s.,;:!?])`,
  "g",
);
const INLINE_CODE_SPAN = /`+[^`]*`+/g;
const MARKDOWN_LINK = /\[[^\]\n]*(?:\\.[^\]\n]*)*\]\((?:<[^>\n]*>|[^)\n]*)\)/g;
const LINE_SUFFIX_RE = /^(.*\.[A-Za-z0-9]{1,12})(?::(\d+))$/;

export interface LocalFileLinkTarget {
  href: string;
  path: string;
  line?: number;
}

function shellUnescapePath(value: string): string {
  return value.replace(/\\([^\n])/g, "$1");
}

function expandTildePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function splitLineSuffix(value: string): { path: string; line?: number } {
  const match = value.match(LINE_SUFFIX_RE);
  if (!match) return { path: value };
  const line = Number.parseInt(match[2], 10);
  return Number.isFinite(line) && line > 0 ? { path: match[1], line } : { path: value };
}

function fileHrefForLocalPath(value: string): string {
  const { path, line } = splitLineSuffix(shellUnescapePath(value));
  return hostFiles.hrefForPath(expandTildePath(path), line);
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function collectRanges(content: string, patterns: RegExp[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

function isInsideRanges(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function normalizeMarkdownLocalFileLinksBlock(content: string): string {
  const withNormalizedDestinations = content.replace(MARKDOWN_LINK_DESTINATION, (_match, destination: string) => {
    return `](<${fileHrefForLocalPath(destination)}>)`;
  });

  const skipRanges = collectRanges(withNormalizedDestinations, [INLINE_CODE_SPAN, MARKDOWN_LINK]);
  return withNormalizedDestinations.replace(
    BARE_LOCAL_PATH,
    (match, prefix: string, rawPath: string, offset: number) => {
      const pathOffset = offset + prefix.length;
      if (isInsideRanges(pathOffset, skipRanges)) return match;
      const label = escapeMarkdownLabel(shellUnescapePath(rawPath));
      return `${prefix}[${label}](<${fileHrefForLocalPath(rawPath)}>)`;
    },
  );
}

export function normalizeMarkdownLocalFileLinks(content: string): string {
  const lines = content.split(/(\n)/);
  let inFence = false;
  return lines
    .map((part) => {
      if (part === "\n") return part;
      if (/^\s*(```|~~~)/.test(part)) {
        inFence = !inFence;
        return part;
      }
      return inFence ? part : normalizeMarkdownLocalFileLinksBlock(part);
    })
    .join("");
}

export function localFileLinkTargetFromHref(href: string): LocalFileLinkTarget | null {
  try {
    const url = new URL(href);
    const hashLine = url.hash.match(/^#L?(\d+)$/);
    const lineFromHash = hashLine ? Number.parseInt(hashLine[1], 10) : undefined;

    if (url.protocol === "file:") {
      url.hash = "";
      const fromUrl = splitLineSuffix(fileURLToPath(url));
      const line = lineFromHash && lineFromHash > 0 ? lineFromHash : fromUrl.line;
      return {
        href,
        path: fromUrl.path,
        ...(line ? { line } : null),
      };
    }

    if (url.pathname === "/files" || url.pathname.endsWith("/files")) {
      const path = url.searchParams.get("path");
      if (!path) return null;
      return {
        href,
        path,
        ...(lineFromHash && lineFromHash > 0 ? { line: lineFromHash } : null),
      };
    }
    return null;
  } catch {
    return null;
  }
}
