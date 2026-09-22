import { RGBA, SyntaxStyle } from "@opentui/core";
import { useMemo } from "react";
import {
  type LocalFileLinkTarget,
  localFileLinkTargetFromHref,
  normalizeMarkdownLocalFileLinks,
} from "./markdown-links";
import type { Theme } from "./theme";

function buildSyntaxStyle(t: Theme): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromHex(t.text) },
    "markup.heading": { fg: RGBA.fromHex(t.mdHeading), bold: true },
    "markup.heading.1": { fg: RGBA.fromHex(t.mdHeading), bold: true },
    "markup.heading.2": { fg: RGBA.fromHex(t.mdHeading), bold: true },
    "markup.heading.3": { fg: RGBA.fromHex(t.mdHeading), bold: true },
    "markup.bold": { fg: RGBA.fromHex(t.mdBold), bold: true },
    "markup.italic": { fg: RGBA.fromHex(t.mdItalic), italic: true },
    "markup.raw": { fg: RGBA.fromHex(t.mdCode) },
    "markup.link": { fg: RGBA.fromHex(t.mdLink), underline: true },
    "markup.link.label": { fg: RGBA.fromHex(t.mdLinkText) },
    "markup.list": { fg: RGBA.fromHex(t.mdListBullet) },
    "markup.quote": { fg: RGBA.fromHex(t.mdItalic), italic: true },
    "markup.separator": { fg: RGBA.fromHex(t.mdHr) },
    code: { fg: RGBA.fromHex(t.mdCodeBlockFg), bg: RGBA.fromHex(t.mdCodeBlockBg) },
  });
}

const TABLE_OPTIONS = {
  widthMode: "full" as const,
  columnFitter: "balanced" as const,
  wrapMode: "word" as const,
  // 0: OpenTUI applies cellPadding to ALL sides — 1 adds a blank line above
  // and below every row (3-line rows). No per-axis knob in 0.1.107.
  cellPadding: 0,
  borders: true,
  outerBorder: true,
  borderStyle: "rounded" as const,
  borderColor: "#333333",
};

const MARKDOWN_LINK_RE = /\[([^\]\n]*(?:\\.[^\]\n]*)*)\]\((?:<([^>\n]+)>|([^\s)\n]+))\)/g;

export interface LocalFileLinkSegment {
  text: string;
  target?: LocalFileLinkTarget;
}

export type OpenFileLinkHandler = (target: LocalFileLinkTarget) => void;

function unescapeMarkdownLabel(value: string): string {
  return value.replace(/\\([\\[\]])/g, "$1");
}

export function parseLocalFileLinkSegments(content: string): LocalFileLinkSegment[][] | null {
  let found = false;
  const lines = content.split("\n").map((line) => {
    MARKDOWN_LINK_RE.lastIndex = 0;
    const segments: LocalFileLinkSegment[] = [];
    let lastIndex = 0;

    for (let match = MARKDOWN_LINK_RE.exec(line); match; match = MARKDOWN_LINK_RE.exec(line)) {
      const href = match[2] ?? match[3] ?? "";
      const target = localFileLinkTargetFromHref(href);
      if (!target) continue;

      if (match.index > lastIndex) {
        segments.push({ text: line.slice(lastIndex, match.index) });
      }
      segments.push({ text: unescapeMarkdownLabel(match[1] || target.path), target });
      lastIndex = match.index + match[0].length;
      found = true;
    }

    if (lastIndex < line.length) {
      segments.push({ text: line.slice(lastIndex) });
    }
    return segments.length > 0 ? segments : [{ text: " " }];
  });

  return found ? lines : null;
}

export type MarkdownRenderBlock =
  | { kind: "markdown"; content: string }
  | { kind: "links"; lines: LocalFileLinkSegment[][] };

const MARKDOWN_LINK_STRIP_RE = /\[[^\]\n]*(?:\\.[^\]\n]*)*\]\((?:<[^>\n]+>|[^\s)\n]+)\)/g;
const MARKDOWN_BLOCK_SYNTAX_RE = /^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|(?:[-*_]\s*){3,}$)/m;
const MARKDOWN_INLINE_SYNTAX_RE = /(?:^|[^\w\\])[*_]{1,3}\S|`[^`\n]+`|~~\S|\[[^\]\n]*\]\(/;

function hasMarkdownSyntax(block: string): boolean {
  const withoutLinks = block.replace(MARKDOWN_LINK_STRIP_RE, "");
  return MARKDOWN_BLOCK_SYNTAX_RE.test(withoutLinks) || MARKDOWN_INLINE_SYNTAX_RE.test(withoutLinks);
}

function splitMarkdownParagraphs(content: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === "") {
      if (current.length > 0) blocks.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks;
}

/**
 * Split a message into paragraphs so only plain-prose paragraphs that carry
 * local file links use the flat clickable renderer; everything else (and the
 * rest of the message) still renders as markdown. Returns null when no
 * paragraph needs the flat renderer.
 */
export function planMarkdownRenderBlocks(content: string): MarkdownRenderBlock[] | null {
  const blocks: MarkdownRenderBlock[] = [];
  let pendingMarkdown: string[] = [];
  let hasLinks = false;
  const flushMarkdown = () => {
    if (pendingMarkdown.length > 0) blocks.push({ kind: "markdown", content: pendingMarkdown.join("\n\n") });
    pendingMarkdown = [];
  };
  for (const paragraph of splitMarkdownParagraphs(content)) {
    const lines = hasMarkdownSyntax(paragraph) ? null : parseLocalFileLinkSegments(paragraph);
    if (lines) {
      flushMarkdown();
      blocks.push({ kind: "links", lines });
      hasLinks = true;
    } else {
      pendingMarkdown.push(paragraph);
    }
  }
  flushMarkdown();
  return hasLinks ? blocks : null;
}

function LocalFileLinkedText({
  lines,
  t,
  onOpenFileLink,
}: {
  lines: LocalFileLinkSegment[][];
  t: Theme;
  onOpenFileLink: OpenFileLinkHandler;
}) {
  return (
    <box flexDirection="column" flexShrink={0}>
      {lines.map((line, lineIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional text fragments.
        <box key={lineIndex} flexDirection="row" flexWrap="wrap" flexShrink={0}>
          {line.map((segment, segmentIndex) =>
            segment.target ? (
              <text
                // biome-ignore lint/suspicious/noArrayIndexKey: link segments are derived from immutable text order.
                key={segmentIndex}
                fg={t.mdLinkText}
                wrapMode="none"
                selectable={false}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenFileLink(segment.target!);
                }}
              >
                <u>{segment.text}</u>
              </text>
            ) : (
              <text
                // biome-ignore lint/suspicious/noArrayIndexKey: text segments are derived from immutable text order.
                key={segmentIndex}
                fg={t.text}
                wrapMode="none"
              >
                {segment.text}
              </text>
            ),
          )}
        </box>
      ))}
    </box>
  );
}

export function Markdown({
  content,
  t,
  streaming = false,
  raw = false,
  onOpenFileLink,
}: {
  content: string;
  t: Theme;
  streaming?: boolean;
  /** Render as literal text (tool/bash output): no markdown parsing or
   *  concealment, so `__init__.py` stays `__init__.py`. Local paths stay
   *  clickable when onOpenFileLink is set. */
  raw?: boolean;
  onOpenFileLink?: OpenFileLinkHandler;
}) {
  const syntaxStyle = useMemo(() => buildSyntaxStyle(t), [t]);
  const linkNormalizedContent = useMemo(
    () => (streaming ? content : normalizeMarkdownLocalFileLinks(content)),
    [content, streaming],
  );
  // Strip trailing whitespace/newlines — streamed assistant content often
  // ends with `\n\n` from paragraph terminators which the underlying
  // <markdown> renderable faithfully draws as blank rows, stacking on top
  // of the next entry's marginTop and producing visible extra gaps.
  // Local-file link normalization is intentionally deferred until commit;
  // doing it on every streamed token scans/splits/joins the full buffer.
  const trimmedContent = linkNormalizedContent.replace(/\s+$/, "");
  const renderBlocks = useMemo(
    () => (onOpenFileLink && !streaming && !raw ? planMarkdownRenderBlocks(trimmedContent) : null),
    [onOpenFileLink, streaming, raw, trimmedContent],
  );
  const rawLinkSegments = useMemo(
    () => (onOpenFileLink && !streaming && raw ? parseLocalFileLinkSegments(trimmedContent) : null),
    [onOpenFileLink, streaming, raw, trimmedContent],
  );

  if (raw) {
    if (rawLinkSegments && onOpenFileLink) {
      return <LocalFileLinkedText lines={rawLinkSegments} t={t} onOpenFileLink={onOpenFileLink} />;
    }
    return (
      <text fg={t.text} wrapMode="word" selectable={true} flexShrink={0}>
        {content.replace(/\s+$/, "")}
      </text>
    );
  }

  if (renderBlocks && onOpenFileLink) {
    return (
      <box flexDirection="column" flexShrink={0}>
        {renderBlocks.map((block, index) =>
          block.kind === "links" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional fragments of immutable text.
            <box key={index} marginTop={index === 0 ? 0 : 1} flexShrink={0}>
              <LocalFileLinkedText lines={block.lines} t={t} onOpenFileLink={onOpenFileLink} />
            </box>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional fragments of immutable text.
            <box key={index} marginTop={index === 0 ? 0 : 1} flexShrink={0}>
              <MarkdownBody content={block.content} syntaxStyle={syntaxStyle} streaming={false} />
            </box>
          ),
        )}
      </box>
    );
  }

  return <MarkdownBody content={trimmedContent} syntaxStyle={syntaxStyle} streaming={streaming} />;
}

function MarkdownBody({
  content,
  syntaxStyle,
  streaming,
}: {
  content: string;
  syntaxStyle: SyntaxStyle;
  streaming: boolean;
}) {
  return (
    <markdown
      content={content}
      syntaxStyle={syntaxStyle}
      conceal={true}
      // While streaming, keep the trailing block "unstable" so the OpenTUI
      // markdown parser only re-lexes the in-progress tail (incremental parse)
      // and partial code fences / tables render cleanly rather than briefly
      // mis-parsing. Committed messages pass false to finalize trailing tokens.
      streaming={streaming}
      // @ts-expect-error MarkdownProps omits inherited Renderable.selectable; needed for TUI text selection
      selectable={true}
      tableOptions={TABLE_OPTIONS}
      flexShrink={0}
    />
  );
}
