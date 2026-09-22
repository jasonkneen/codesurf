import type { ScrollBoxRenderable } from "@opentui/core";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { countHooksForTool } from "../../hooks/count.js";
import type { ChatEntry, ToolCall } from "../../types/index";
import { truncate } from "../../utils/text";

import { Reasoning, ReasoningContent, ReasoningTrigger } from "../ai-elements/reasoning";
import { Source, Sources, SourcesContent, SourcesTrigger } from "../ai-elements/sources";
import { StreamingResponse } from "../ai-elements/streaming-response";
import { type ArtifactItem, ArtifactList } from "../ai-output/artifact-list";
import { ChainOfThought, type Thought } from "../ai-output/chain-of-thought";
import {
  estimateInlineImageRows,
  extractImagePaths,
  InlineImage,
  setInlineImageClipBounds,
  stripImagePaths,
} from "../ai-output/inline-image";
import { type ParallelAgentStep, ParallelAgents } from "../ai-output/parallel-agents";
import { TaskInspector } from "../ai-output/task-inspector";
import { ThinkingBlock } from "../ai-output/thinking-block";
import { ToolCallBlockList } from "../ai-output/tool-call-block-list.js";
import { type ToolCallRecord, ToolCallRow, ToolChipGroup } from "../ai-output/tool-calls.js";
import { Markdown } from "../markdown";
import type { LocalFileLinkTarget } from "../markdown-links";
import { PlanView } from "../plan";
import { useStreamContent, useStreamReasoning, useStreamReasoningStartedAt } from "../stream-store";
import { TerminalSessionView } from "../terminal/session-view";
import type { Theme } from "../theme";

import { LspDiagnosticsView, LspResultView } from "./diff-lsp-views.js";
import {
  BackgroundProcessLine,
  DelegationListView,
  DelegationResultView,
  DelegationTaskLine,
  InlineTool,
  MediaAutoOpenView,
  MediaToolResultView,
  ProcessLogsView,
  SubagentTaskLine,
  TaskResultView,
  ToolTextOutputView,
  UserMessageContent,
} from "./message-views.js";
import { toolArgs, toolLabel, tryParseArg } from "./tool-format.js";

// Re-exported so existing importers of the message-list helpers keep working.
export { toolArgs, toolLabel, tryParseArg } from "./tool-format.js";

// Border chars for user messages
const SPLIT = {
  topLeft: "",
  bottomLeft: "",
  vertical: "┃",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
};

const VIEWPORT_POLL_FAST_MS = 16;
const VIEWPORT_POLL_IDLE_MS = 250;

// Helpers (moved from app.tsx)

function upperBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((values[mid] ?? 0) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((values[mid] ?? 0) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Pull `http(s)://…` URLs out of a tool result body. Dedupes by URL, caps at
 *  16 entries so a chatty result can't spam the Sources panel. Title is the
 *  preceding line if it looks like a heading, otherwise the bare URL. */
function harvestSourcesFromContent(
  content: string | undefined,
  kind: "web" | "docs" | "rag" | "tool",
): Array<{ id?: string; url: string; title?: string; kind?: typeof kind }> {
  if (!content) return [];
  const seen = new Set<string>();
  const out: Array<{ id?: string; url: string; title?: string; kind: typeof kind }> = [];
  const lines = content.split(/\r?\n/);
  // Match URLs, trimming common trailing punctuation that's almost never part
  // of the link itself.
  const urlRe = /\bhttps?:\/\/[^\s)<>"'`\]}]+/g;
  // Non-global twin used for `.test()` checks; sharing the /g instance would
  // advance lastIndex between calls and skip matches.
  const urlReTest = /\bhttps?:\/\/[^\s)<>"'`\]}]+/;
  for (let i = 0; i < lines.length && out.length < 16; i++) {
    const line = lines[i];
    const matches = line.match(urlRe);
    if (!matches) continue;
    for (const raw of matches) {
      const url = raw.replace(/[.,;:!?)]+$/, "");
      if (seen.has(url)) continue;
      seen.add(url);
      // If the URL is alone on its line, look one line back for a heading-ish
      // candidate (no URL, short, non-empty). Markdown-style `[title](url)`
      // also produces a sensible title via the immediately-preceding capture.
      let title: string | undefined;
      const mdMatch = line.match(/\[([^\]]+)\]\(\s*[^\s)]+\s*\)/);
      if (mdMatch) {
        title = mdMatch[1];
      } else if (i > 0) {
        const prev = lines[i - 1].trim();
        if (prev && prev.length <= 120 && !urlReTest.test(prev)) {
          title = prev.replace(/^[-*#>\d.\s]+/, "").trim() || undefined;
        }
      }
      out.push({ id: url, url, title, kind });
    }
  }
  return out;
}

export interface MessageViewProps {
  entry: ChatEntry;
  index: number;
  t: Theme;
  modeColor: string;
  expandedMessages?: Set<number>;
  onOpenTerminal?: (sessionId?: string) => void;
  onOpenFileLink?: (target: LocalFileLinkTarget) => void;
  topGap?: number;
}

function MessageViewImpl({
  entry,
  index,
  t,
  modeColor,
  expandedMessages,
  onOpenTerminal,
  onOpenFileLink,
  topGap = 1,
}: MessageViewProps) {
  if (entry.terminalSessionId) {
    const sessionId = entry.terminalSessionId;
    return (
      <box
        paddingLeft={3}
        marginTop={topGap}
        flexShrink={0}
        flexDirection="column"
        onMouseDown={onOpenTerminal ? () => onOpenTerminal(sessionId) : undefined}
      >
        <TerminalSessionView sessionId={sessionId} t={t} chrome="inline" />
      </box>
    );
  }

  switch (entry.type) {
    case "user": {
      const imagePaths = extractImagePaths(entry.content);
      // Image paths are shown as previews (with a filename caption) below, so
      // strip the raw temp path from the displayed text. When the message was
      // only a path, bodyText is empty and we skip the text block entirely.
      const bodyText = imagePaths.length > 0 ? stripImagePaths(entry.content) : entry.content;
      return (
        <box border={["left"]} customBorderChars={SPLIT} borderColor={entry.modeColor || modeColor} marginTop={topGap}>
          <box
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={t.backgroundPanel}
            flexShrink={0}
            flexDirection="column"
          >
            {entry.sourceLabel ? <text fg={t.textMuted}>{entry.sourceLabel}</text> : null}
            {imagePaths.length > 0 && (
              <box flexDirection="column" marginBottom={1}>
                {imagePaths.map((p) => (
                  <box key={p} flexDirection="column">
                    <InlineImage src={p} t={t} />
                    <text fg={t.textMuted} wrapMode="none">
                      {p.split("/").pop() || p}
                    </text>
                  </box>
                ))}
              </box>
            )}
            {bodyText.trim().length > 0 && (
              <UserMessageContent content={bodyText} t={t} expanded={expandedMessages?.has(index) ?? false} />
            )}
          </box>
        </box>
      );
    }

    case "assistant":
      return (
        <box paddingLeft={3} marginTop={topGap} flexShrink={0} flexDirection="column">
          {entry.sourceLabel ? <text fg={t.textMuted}>{entry.sourceLabel}</text> : null}
          {entry.sources && entry.sources.length > 0 ? (
            <Sources t={t}>
              <SourcesTrigger count={entry.sources.length} />
              <SourcesContent>
                {entry.sources.map((s) => (
                  <Source key={s.id ?? s.url} href={s.url} title={s.title ?? s.url}>
                    {s.title ?? s.url}
                  </Source>
                ))}
              </SourcesContent>
            </Sources>
          ) : null}
          {entry.reasoningText
            ? (() => {
                const paragraphs = entry
                  .reasoningText!.split(/\n\s*\n/)
                  .map((p) => p.trim())
                  .filter(Boolean);
                if (paragraphs.length >= 2) {
                  const thoughts: Thought[] = paragraphs.map((text, i) => ({
                    id: `r${i}`,
                    text,
                    status: "done",
                  }));
                  return <ChainOfThought t={t} thoughts={thoughts} isThinking={false} collapsed />;
                }
                return (
                  <Reasoning
                    t={t}
                    isStreaming={false}
                    defaultOpen={false}
                    duration={
                      entry.reasoningDurationMs !== undefined ? Math.ceil(entry.reasoningDurationMs / 1000) : undefined
                    }
                  >
                    <ReasoningTrigger />
                    <ReasoningContent>{entry.reasoningText}</ReasoningContent>
                  </Reasoning>
                );
              })()
            : null}
          <Markdown content={entry.content} t={t} onOpenFileLink={onOpenFileLink} />
        </box>
      );

    case "system": {
      // UI-only notice rows: a failed turn, the turn-end summary, or an
      // informational line (compaction, finished delegation). Distinct from
      // assistant prose so a transport failure never reads like an answer.
      const kind = entry.systemKind ?? "info";
      const glyphColor = kind === "error" ? t.diffRemovedFg : kind === "summary" ? t.diffAddedFg : t.textMuted;
      const glyph = kind === "error" ? "✗ " : kind === "info" ? "· " : "";
      const body = kind === "summary" ? entry.content.replace(/^[✓■✗] /, "") : entry.content;
      const lead = kind === "summary" ? `${entry.content.slice(0, 2)}` : glyph;
      return (
        <box paddingLeft={3} marginTop={topGap} flexShrink={0}>
          <text fg={kind === "error" ? t.text : t.textMuted}>
            <span style={{ fg: glyphColor }}>{lead}</span>
            {body}
          </text>
        </box>
      );
    }

    case "tool_call":
      return (
        <box paddingLeft={3} marginTop={topGap}>
          <text>
            <span style={{ fg: entry.modeColor || modeColor }}>{"▣ "}</span>
            <span style={{ fg: t.textMuted }}>{entry.content.replace("▣  ", "")}</span>
          </text>
        </box>
      );

    case "tool_result": {
      const name = entry.toolCall?.function.name || "tool";
      const args = toolArgs(entry.toolCall);
      const plan = entry.toolResult?.plan;

      if (name === "generate_plan" && plan) {
        // PlanView is the canonical generate_plan render (numbered steps with
        // descriptions + file paths). The live TodoWrite tracker already owns
        // the PlanUpdate checklist surface (pinned at app top), so we don't
        // duplicate the title/summary here.
        return <PlanView plan={plan} t={t} />;
      }

      if (name === "task" && entry.toolResult?.task) {
        const task = entry.toolResult.task;
        return (
          <box flexDirection="column">
            <TaskInspector
              t={t}
              task={{
                title: task.description,
                status: "done",
                owner: task.agent,
                currentStep: task.activity,
                lastTool: task.summary
                  ? `summary · ${task.summary.slice(0, 60)}${task.summary.length > 60 ? "..." : ""}`
                  : undefined,
              }}
            />
            <TaskResultView t={t} entry={entry} />
          </box>
        );
      }

      if (name === "delegate" && entry.toolResult?.delegation) {
        return <DelegationResultView t={t} entry={entry} />;
      }

      if (name === "delegation_list") {
        return <DelegationListView t={t} content={entry.content} />;
      }

      if (name === "delegation_read") {
        return (
          <ToolTextOutputView
            t={t}
            label={toolLabel(entry.toolCall!)}
            content={entry.content}
            onOpenFileLink={onOpenFileLink}
          />
        );
      }

      if (name === "lsp") {
        const lspOp = tryParseArg(entry.toolCall, "operation") || "query";
        const lspFile = tryParseArg(entry.toolCall, "filePath") || "";
        const lspLine = tryParseArg(entry.toolCall, "line");
        const lspPos = lspLine ? `:${lspLine}` : "";
        return (
          <box gap={0} marginTop={1}>
            <InlineTool t={t} pending={false}>
              {`lsp ${lspOp} ${lspFile}${lspPos}`}
            </InlineTool>
            <LspResultView t={t} operation={lspOp} filePath={lspFile} position={lspPos} content={entry.content} />
          </box>
        );
      }

      if ((entry.toolResult?.media?.length ?? 0) > 0) {
        if (name === "generate_image" || name === "generate_video") {
          const mediaArtifacts: ArtifactItem[] = (entry.toolResult?.media ?? []).map((m) => ({
            path: m.path,
            status: "generated",
            note: m.kind,
          }));
          return (
            <box flexDirection="column">
              <MediaAutoOpenView t={t} label={toolLabel(entry.toolCall!)} toolResult={entry.toolResult!} />
              <ArtifactList t={t} title="generated" artifacts={mediaArtifacts} />
            </box>
          );
        }
        return (
          <MediaToolResultView
            t={t}
            label={toolLabel(entry.toolCall!)}
            toolResult={entry.toolResult!}
            onOpenFileLink={onOpenFileLink}
          />
        );
      }

      // write_file / edit_file fall through to the generic chip path so file
      // ops render consistently with every other tool. LSP diagnostics still
      // need to surface — render the chip then append diagnostics inline.
      if ((name === "write_file" || name === "edit_file") && (entry.toolResult?.lspDiagnostics?.length ?? 0) > 0) {
        const record: ToolCallRecord = {
          id: entry.toolCall?.id ?? `tc-${index}`,
          toolName: name,
          status: entry.toolResult?.success === false ? "error" : "done",
          args: (() => {
            try {
              return entry.toolCall ? JSON.parse(entry.toolCall.function.arguments) : args;
            } catch {
              return args;
            }
          })(),
          output: entry.toolResult?.output || entry.content,
          error: entry.toolResult?.error,
        };
        return (
          <box flexDirection="column" paddingLeft={3} marginTop={topGap}>
            <ToolCallRow t={t} call={record} onOpenFileLink={onOpenFileLink} />
            <LspDiagnosticsView t={t} diagnostics={entry.toolResult?.lspDiagnostics ?? []} />
          </box>
        );
      }

      if (name === "bash" && entry.toolResult?.backgroundProcess) {
        const bp = entry.toolResult.backgroundProcess;
        return <BackgroundProcessLine t={t} id={bp.id} pid={bp.pid} command={bp.command} />;
      }

      if (name === "process_logs") {
        return <ProcessLogsView t={t} content={entry.content} />;
      }

      if (name === "process_stop" || name === "process_list") {
        return (
          <InlineTool t={t} pending={false}>
            {entry.content}
          </InlineTool>
        );
      }

      if (name === "search_web" || name === "search_x") {
        const harvested = harvestSourcesFromContent(entry.content, name === "search_web" ? "web" : "tool");
        return (
          <box flexDirection="column">
            <InlineTool t={t} pending={false}>
              {name === "search_web" ? "Web" : "X"} {` Search "${truncate(args, 60)}"`}
            </InlineTool>
            {harvested.length > 0 && (
              <Sources t={t}>
                <SourcesTrigger count={harvested.length} />
                <SourcesContent>
                  {harvested.map((s) => (
                    <Source key={s.id ?? s.url} href={s.url} title={s.title ?? s.url}>
                      {s.title ?? s.url}
                    </Source>
                  ))}
                </SourcesContent>
              </Sources>
            )}
          </box>
        );
      }

      const record: ToolCallRecord = {
        id: entry.toolCall?.id ?? `tc-${index}`,
        toolName: name,
        status: entry.toolResult?.success === false ? "error" : "done",
        args: (() => {
          try {
            return entry.toolCall ? JSON.parse(entry.toolCall.function.arguments) : args;
          } catch {
            return args;
          }
        })(),
        output: entry.toolResult?.output || entry.content,
        error: entry.toolResult?.error,
      };
      return (
        <box paddingLeft={3} marginTop={topGap}>
          <ToolCallRow t={t} call={record} onOpenFileLink={onOpenFileLink} />
        </box>
      );
    }

    default:
      return <text fg={t.textMuted}>{entry.content}</text>;
  }
}

const MessageView = memo(MessageViewImpl, (prev, next) => {
  if (prev.entry !== next.entry) return false;
  if (prev.index !== next.index) return false;
  if (prev.t !== next.t) return false;
  if (prev.modeColor !== next.modeColor) return false;
  if (prev.topGap !== next.topGap) return false;
  if (prev.onOpenTerminal !== next.onOpenTerminal) return false;
  if (prev.onOpenFileLink !== next.onOpenFileLink) return false;
  const prevExp = prev.expandedMessages?.has(prev.index) ?? false;
  const nextExp = next.expandedMessages?.has(next.index) ?? false;
  if (prevExp !== nextExp) return false;
  return true;
});

// --- FULL VIRTUALIZATION (B) ---

type GroupedItem =
  | { kind: "single"; msg: ChatEntry; index: number }
  | { kind: "chips"; entries: Array<{ msg: ChatEntry; index: number }>; firstIndex: number };

type ChipEntries = Extract<GroupedItem, { kind: "chips" }>["entries"];

/** Memo boundary for committed tool-chip groups. `entries` comes from the
 *  `items` useMemo (stable identity across viewport-poll re-renders), so chip
 *  records — including the per-call JSON.parse in entryToChipRecord — are
 *  rebuilt only when the transcript itself changes, not on every frame. */
const ChipsItem = memo(function ChipsItem({
  entries,
  t,
  toolCallsPanel,
  dimToolChips,
  onOpenFileLink,
}: {
  entries: ChipEntries;
  t: Theme;
  toolCallsPanel: boolean;
  dimToolChips: boolean;
  onOpenFileLink?: (target: LocalFileLinkTarget) => void;
}) {
  const records = useMemo(() => entries.map(({ msg, index }) => entryToChipRecord(msg, `tc-${index}`)), [entries]);
  const thoughtCount = useMemo(() => entries.filter(({ msg }) => msg.reasoningText?.trim()).length, [entries]);
  return toolCallsPanel ? (
    <ToolCallBlockList t={t} calls={records} />
  ) : (
    <ToolChipGroup
      t={t}
      calls={records}
      thoughtCount={thoughtCount}
      dimToolChips={dimToolChips}
      onOpenFileLink={onOpenFileLink}
    />
  );
});

/** Per-entry cache for extractImagePaths so the full-transcript scan in
 *  `hasInlineImages` and the per-item height estimator don't re-run the regex
 *  on every message commit. Keyed by entry object identity; the `content`
 *  equality check keeps this safe even if an entry is mutated while streaming. */
const imagePathsCache = new WeakMap<object, { content: string; paths: string[] }>();
function cachedImagePaths(entry: { content?: string }): string[] {
  const content = entry.content || "";
  const hit = imagePathsCache.get(entry);
  if (hit && hit.content === content) return hit.paths;
  const paths = extractImagePaths(content);
  imagePathsCache.set(entry, { content, paths });
  return paths;
}

interface MessageListProps {
  messages: ChatEntry[];
  t: Theme;
  modeColor: string;
  expandedMessages: Set<number>;
  onOpenTerminal: (sessionId?: string) => void;
  onOpenFileLink?: (target: LocalFileLinkTarget) => void;
  scrollRef?: React.RefObject<ScrollBoxRenderable | null>;
  liveTurnSourceLabel?: string | null;
  activeToolCalls?: ToolCall[];
  isProcessing?: boolean;
  /** When false, skip prefix-sum/virtualization and render every item. */
  virtualize?: boolean;
  /** When false, hide the pinned streaming-reasoning (thinking) block. */
  showThinking?: boolean;
  /** When true, render the live reasoning trace as ChainOfThought (split into
   *  discrete steps) instead of the default ThinkingBlock. Driven by the
   *  `render.reasoning.liveChainOfThought` feature flag in app.tsx. */
  liveReasoningChainOfThought?: boolean;
  /** When true, render committed tool-call groups as Grok Build-style ◆ block
   *  rows instead of compact CAPITAL chips. Driven by `render.toolCalls.panel`. */
  toolCallsPanel?: boolean;
  /** When true, compact tool-call chips use the darker subdued treatment. */
  dimToolChips?: boolean;
  /** When false, hide pinned live tool-call chips + subagent/delegate cards. */
  showLiveTools?: boolean;
  /** When true, hide live tool chips — an external status line owns tool activity. */
  compactLiveStatus?: boolean;
  /** Notifies the parent when the "unseen content" status changes. Fires
   *  `true` only when the user has scrolled away from the tail AND new
   *  content has arrived since they did so — i.e. there are messages they
   *  haven't seen. Fires `false` when they're back at the tail (or never
   *  left). Drives the "↓ new messages" indicator that the parent renders
   *  inside the InterruptBar above the composer. */
  onHasNewMessagesChange?: (hasNew: boolean) => void;
  /** Notifies the parent when automatic tail-following is allowed. This flips
   *  false as soon as the measured scroll position moves upward, and only
   *  returns true after the viewport reaches the bottom again. */
  onAutoFollowChange?: (enabled: boolean) => void;
  /** Rendered inside the scrollbox after the last message and the live
   *  streaming preview. Used for inline approval prompts (tool gate,
   *  payment, file edit) so they scroll with the transcript instead of
   *  living in a floating panel above the composer. */
  trailingSlot?: React.ReactNode;
  /** Rendered above the scrollbox (outside it) — a pinned panel that stays
   *  visible even when the transcript scrolls. Used for session-level state
   *  surfaces like PlanUpdate (todos), AgentRoster (active subagents), or
   *  any "sticky overview" widget. Falsy values render nothing. */
  pinnedTopSlot?: React.ReactNode;
  /** Rendered below the scrollbox (outside it), shown only when the agent is
   *  idle (not processing a turn). Used for Suggestions / next-prompt hints.
   *  Falsy values render nothing. */
  idleSuggestionsSlot?: React.ReactNode;
}

// ── Leaf-isolated live views ────────────────────────────────────────────────
// These subscribe to the module-level stream-store so a streamed token
// re-renders ONLY the relevant leaf — never MessageList or the App above it.
// They render in the exact same scrollbox slots the inline JSX used, so the
// documented anti-flicker / anti-"jump-up-at-end-of-stream" placement is
// unchanged. See src/ui/stream-store.ts.

/** Live assistant text. Returns null when idle (no content). */
function StreamingResponseLive({ t, isProcessing }: { t: Theme; isProcessing: boolean }) {
  const content = useStreamContent();
  if (!content) return null;
  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0}>
      <StreamingResponse t={t} content={content} streaming={isProcessing} />
    </box>
  );
}

/** Live reasoning ("thinking") trace. Chain-of-thought mode keeps a stable
 *  header during active turns so live tool rows cannot mount first and then
 *  jump downward when the first reasoning token arrives. */
function LiveReasoning({
  t,
  isProcessing,
  liveReasoningChainOfThought,
}: {
  t: Theme;
  isProcessing: boolean;
  liveReasoningChainOfThought: boolean;
}) {
  const reasoning = useStreamReasoning();
  const reasoningStartedAt = useStreamReasoningStartedAt();
  if (!reasoning) {
    if (!isProcessing || !liveReasoningChainOfThought) return null;
    return (
      <box paddingLeft={3} marginTop={1} flexShrink={0}>
        <ChainOfThought t={t} thoughts={[]} isThinking />
      </box>
    );
  }
  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0}>
      {liveReasoningChainOfThought ? (
        (() => {
          // Split the live trace into discrete thoughts on blank-line
          // boundaries. The last one stays "active" while we're still
          // processing; all prior thoughts are "done". When the trace has no
          // boundaries yet, fall back to a single active step so the panel
          // still renders meaningfully early in the turn.
          const paragraphs = reasoning
            .split(/\n\s*\n/)
            .map((p) => p.trim())
            .filter(Boolean);
          const thoughts: Thought[] =
            paragraphs.length > 0
              ? paragraphs.map((text, i) => ({
                  id: `r${i}`,
                  text,
                  status: isProcessing && i === paragraphs.length - 1 ? "active" : "done",
                }))
              : [{ id: "r0", text: reasoning, status: isProcessing ? "active" : "done" }];
          return <ChainOfThought t={t} thoughts={thoughts} isThinking={isProcessing} />;
        })()
      ) : (
        <ThinkingBlock t={t} reasoningText={reasoning} isThinking={isProcessing} startedAtMs={reasoningStartedAt} />
      )}
    </box>
  );
}

export function MessageList({
  messages,
  t,
  modeColor,
  expandedMessages,
  onOpenTerminal,
  onOpenFileLink,
  scrollRef,
  liveTurnSourceLabel,
  activeToolCalls = [],
  isProcessing = false,
  virtualize = true,
  showThinking = true,
  showLiveTools = true,
  compactLiveStatus = false,
  liveReasoningChainOfThought = false,
  toolCallsPanel = false,
  dimToolChips = true,
  onHasNewMessagesChange,
  onAutoFollowChange,
  trailingSlot,
  pinnedTopSlot,
  idleSuggestionsSlot,
}: MessageListProps) {
  // Internal ref fallback if parent does not provide one
  const internalRef = useRef<ScrollBoxRenderable | null>(null);
  const effectiveRef = scrollRef ?? internalRef;

  // Live viewport tracking (timer loop — reliable, no event dependency).
  // We track the *actual* scrollHeight from the ScrollBox alongside scrollTop
  // / viewport height so the bottom-anchored check is grounded in opentui's
  // real layout rather than our prefix-sum estimate (which drifts as items
  // mount/unmount and item heights are re-estimated). When that drift made
  // `totalHeight` underestimate true content height, `isAtBottom` flipped
  // back to true and the scrollbox would snap to the bottom mid-stream even
  // after a manual scroll-up.
  const [viewport, setViewport] = useState({ top: 0, height: 48, scrollH: 0 });
  const viewportPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTopRef = useRef(-999);
  const lastScrollHRef = useRef(-999);
  const [autoFollowEnabled, setAutoFollowEnabled] = useState(true);
  const autoFollowEnabledRef = useRef(true);

  const setAutoFollowEnabledSync = useCallback(
    (enabled: boolean) => {
      if (autoFollowEnabledRef.current === enabled) return;
      autoFollowEnabledRef.current = enabled;
      setAutoFollowEnabled(enabled);
      onAutoFollowChange?.(enabled);
    },
    [onAutoFollowChange],
  );

  const hasInlineImages = useMemo(() => messages.some((entry) => cachedImagePaths(entry).length > 0), [messages]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      const sb = effectiveRef.current as unknown as {
        scrollTop?: number;
        scrollHeight?: number;
        screenY?: number;
        // Visible region is the scrollbox's `viewport` BoxRenderable.
        // `viewport.screenY` / `viewport.height` are the real absolute-screen
        // clip bounds.
        viewport?: { screenY?: number; height?: number };
      } | null;
      if (sb) {
        const top = Math.max(0, Math.floor(sb.scrollTop ?? 0));
        const measuredHeight = Math.floor(sb.viewport?.height ?? 0);
        const h = Math.max(1, measuredHeight > 0 ? measuredHeight : viewport.height);
        const sh = Math.max(0, Math.floor(sb.scrollHeight ?? 0));
        const previousTop = lastTopRef.current;
        const measuredAtBottom = top + h >= sh - 3;
        if (measuredAtBottom) {
          setAutoFollowEnabledSync(true);
        } else if (previousTop >= 0 && top < previousTop - 2) {
          setAutoFollowEnabledSync(false);
        }

        // Publish the scrollbox's absolute screen-space bounds so inline Kitty
        // images can clip themselves to the list viewport (they paint above
        // OpenTUI's clip layer and would otherwise pin to the top / occlude the
        // footer when scrolled out of view).
        const vpTop = Math.floor(sb.viewport?.screenY ?? sb.screenY ?? 0);
        const vpHeight = Math.floor(sb.viewport?.height ?? h);
        setInlineImageClipBounds(vpTop, vpTop + vpHeight);

        // Only update viewport on significant changes:
        // - Scroll position changes >2px (avoids sub-pixel jitter)
        // - Height changes (client dimension changed)
        // - ScrollHeight changes >5px (avoids constant layout recalcs during streaming)
        const topChanged = Math.abs(top - lastTopRef.current) > 2;
        const heightChanged = h !== viewport.height;
        const scrollChanged = Math.abs(sh - lastScrollHRef.current) > 5;

        if (topChanged || heightChanged || scrollChanged) {
          lastTopRef.current = top;
          lastScrollHRef.current = sh;
          setViewport({ top, height: h, scrollH: sh });
        }
      }
      if (!cancelled) {
        const fastPoll = isProcessing || hasInlineImages || !autoFollowEnabledRef.current;
        viewportPollRef.current = setTimeout(tick, fastPoll ? VIEWPORT_POLL_FAST_MS : VIEWPORT_POLL_IDLE_MS);
      }
    };
    viewportPollRef.current = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      if (viewportPollRef.current) clearTimeout(viewportPollRef.current);
      viewportPollRef.current = null;
    };
  }, [effectiveRef, hasInlineImages, isProcessing, setAutoFollowEnabledSync, viewport.height]);

  // Grouping (same logic as before, now inside virtualized list owner)
  const items: GroupedItem[] = useMemo(() => {
    const out: GroupedItem[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      if (isChipEligibleToolResult(m, toolCallsPanel)) {
        const last = out[out.length - 1];
        if (last && last.kind === "chips") {
          last.entries.push({ msg: m, index: i });
          continue;
        }
        out.push({ kind: "chips", entries: [{ msg: m, index: i }], firstIndex: i });
      } else {
        out.push({ kind: "single", msg: m, index: i });
      }
    }
    return out;
  }, [messages, toolCallsPanel]);

  // Height estimation per GroupedItem (type + rough content size aware).
  // Wrapped in useCallback so the `prefix` memo below has a stable dep — without
  // this the prefix-sum recomputes every render and the virtualizer thrashes.
  const estimateItemHeight = useCallback(
    (item: GroupedItem): number => {
      if (item.kind === "chips") {
        // Block-list mode: one row per tool; chip mode: compact wrapped bar.
        return toolCallsPanel ? item.entries.length : 2 + Math.min(4, item.entries.length);
      }
      const e = item.msg;
      let h = 3;
      switch (e.type) {
        case "user": {
          h = 4 + Math.min(6, Math.floor((e.content?.length || 0) / 65));
          // Account for inline image attachments — each renders a preview box
          // (its decoded cell-height, +1 for margin) plus a one-line filename
          // caption. estimateInlineImageRows returns the cached decoded height
          // once known (falling back to ~17 before first decode), keeping this
          // prefix-sum in lockstep with InlineImage's actual reserved height so
          // the virtualizer's spacers don't drift (the cause of paste-time
          // flicker).
          for (const p of cachedImagePaths(e)) h += estimateInlineImageRows(p) + 1;
          break;
        }
        case "assistant":
          h = 5 + Math.min(42, Math.floor((e.content?.length || 0) / 48));
          if (e.reasoningText) h += Math.min(12, Math.floor(e.reasoningText.length / 60));
          break;
        case "tool_call":
          h = 2;
          break;
        case "system":
          h = 2 + Math.floor((e.content?.length || 0) / 80);
          break;
        case "tool_result": {
          const name = e.toolCall?.function.name || "";
          if (name === "write_file" || name === "edit_file" || e.toolResult?.diff) h = 16;
          else if (name === "bash" && e.toolResult?.backgroundProcess) h = 5;
          else if (name === "read_file") h = 7;
          else if (name === "generate_plan") h = 14;
          else if (name === "task" || name === "delegate") h = 6;
          else if ((e.toolResult?.media?.length ?? 0) > 0) h = 8;
          else h = 4 + Math.min(14, Math.floor((e.content?.length || 0) / 38));
          break;
        }
        default:
          h = 3;
      }
      // Allow a larger ceiling so multi-image user messages (up to ~4 images)
      // and big diff results aren't artificially compressed into the prefix
      // sum. 96 covers 4 images × 17 rows plus headers/text — past that we
      // clamp because per-item estimates beyond ~viewport are wasted anyway.
      return Math.max(2, Math.min(96, h));
    },
    [toolCallsPanel],
  );

  // Prefix sums for O(log n) visible range
  const { prefix, totalHeight } = useMemo(() => {
    const h = items.map(estimateItemHeight);
    const p: number[] = [0];
    for (let i = 0; i < h.length; i++) p.push(p[i] + h[i]);
    return { prefix: p, totalHeight: p[p.length - 1] };
  }, [items, estimateItemHeight]);

  // Auto-follow indicator: true only while the user has not manually scrolled
  // away from the tail. Once disabled, it stays disabled until the viewport is
  // measured at the bottom again.
  // Threshold gives 2-3 lines of slack so tiny content changes don't flip the state.
  // Use the *real* scrollHeight from the ScrollBox when available; fall back
  // to our prefix-sum estimate only before the first rAF tick has populated
  // `viewport.scrollH`. Mixing real and estimated values caused the snap-back
  // bug — estimates drift below actual content height during streaming, which
  // pushed `isAtBottom` back to true even while the user was scrolled up.
  const measuredIsAtBottom = useMemo(() => {
    const threshold = 3;
    const contentH = viewport.scrollH > 0 ? viewport.scrollH : totalHeight;
    return viewport.top + viewport.height >= contentH - threshold;
  }, [viewport.top, viewport.height, viewport.scrollH, totalHeight]);
  const isAtBottom = autoFollowEnabled && measuredIsAtBottom;

  // Strict "unseen messages" tracking. We snapshot content height the moment
  // the user scrolls away from the tail (isAtBottom → false). After that, the
  // hint only fires once `contentH` has grown beyond that snapshot by more
  // than the scroll-state threshold — so just scrolling up on a static
  // transcript will not surface a phantom "new messages" hint. Returning to
  // the tail clears the snapshot.
  const currentContentH = viewport.scrollH > 0 ? viewport.scrollH : totalHeight;
  const scrollAwayHeightRef = useRef<number | null>(null);
  const hasNewMessages = useMemo(() => {
    if (isAtBottom) return false;
    const snap = scrollAwayHeightRef.current;
    if (snap == null) return false;
    return currentContentH > snap + 1;
  }, [isAtBottom, currentContentH]);

  useEffect(() => {
    if (isAtBottom) {
      scrollAwayHeightRef.current = null;
    } else if (scrollAwayHeightRef.current == null) {
      scrollAwayHeightRef.current = currentContentH;
    }
  }, [isAtBottom, currentContentH]);

  const lastHasNewRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!onHasNewMessagesChange) return;
    if (lastHasNewRef.current === hasNewMessages) return;
    lastHasNewRef.current = hasNewMessages;
    onHasNewMessagesChange(hasNewMessages);
  }, [hasNewMessages, onHasNewMessagesChange]);

  // Visible window + overscan
  const OVERSCAN = 12;
  const { startIndex, endIndex } = useMemo(() => {
    if (items.length === 0) return { startIndex: 0, endIndex: -1 };

    // When pinned to the bottom (stickyScroll active), derive the window from
    // the TAIL rather than from scrollTop. `viewport.top` / `viewport.scrollH`
    // are REAL scrollbox pixels and lag the ESTIMATED `prefix` by a frame at
    // end-of-stream (a large message commits into `items` synchronously, but
    // the scrollbox hasn't re-laid-out yet). Trusting the stale scrollTop there
    // stops `endIndex` short of the tail, leaving a large estimated
    // `bottomSpacerH` (an empty box) that stickyScroll then scrolls into the
    // lower viewport — the "blank bottom half" flicker. Anchoring to the last
    // item collapses the bottom spacer to ~0 and keeps the tail always mounted.
    if (isAtBottom) {
      const e = items.length - 1;
      const minTop = (prefix[e + 1] ?? 0) - viewport.height * 2;
      const s = Math.max(0, Math.min(e, upperBound(prefix, minTop) - 1));
      return { startIndex: Math.max(0, s), endIndex: e };
    }

    const topLine = viewport.top;
    const botLine = topLine + viewport.height;

    // First/last items that intersect the viewport. Prefix sums are monotonic,
    // so this stays O(log n) as transcripts grow.
    let s = Math.max(0, Math.min(items.length - 1, upperBound(prefix, topLine) - 1));
    let e = Math.max(s, Math.min(items.length - 1, lowerBound(prefix, botLine) - 1));

    s = Math.max(0, s - OVERSCAN);
    e = Math.min(items.length - 1, e + OVERSCAN);

    // Reachability guard (REAL-pixel based — no estimate mixing). The window
    // above is computed in ESTIMATE space (`prefix`) but driven by the REAL
    // `viewport.top`. When the tail is mis-estimated — e.g. a transcript ending
    // in short tool_call/tool_result rows that estimate taller than they render
    // — that mismatch stops `endIndex` short of the last item, trapping the real
    // final messages inside the estimated bottom-spacer box: the user physically
    // can't scroll them into view (the "can't reach the bottom" bug; turning
    // virtualization off masks it because every item then mounts at real height).
    //
    // Fix: once the viewport is within one screen of the REAL bottom of rendered
    // content, mount the entire tail (slice becomes s..last, exactly like the
    // non-virtualized path). This collapses the bottom spacer to its true height
    // so the bottom is always reachable. Bounded: `s` already tracks `viewport.top`
    // and is near the tail when this triggers, so the mounted slice stays small.
    // The streaming/auto-follow path takes the `isAtBottom` branch above and
    // never reaches here, so this can't affect stickyScroll behaviour.
    const nearRealBottom = viewport.scrollH > 0 && viewport.top + viewport.height >= viewport.scrollH - viewport.height;
    if (nearRealBottom) e = items.length - 1;

    return { startIndex: s, endIndex: e };
  }, [viewport, items, prefix, isAtBottom]);

  // When virtualization is disabled, render the full list with no spacers.
  // The prefix/visible-range math still runs (cheap) but we override the
  // slice bounds + spacers so every item lives in the tree. Useful when
  // height estimates are off and the user wants to bypass the optimizer.
  const effectiveStart = virtualize ? startIndex : 0;
  const effectiveEnd = virtualize ? endIndex : Math.max(0, items.length - 1);
  const topSpacerH = virtualize ? (prefix[effectiveStart] ?? 0) : 0;
  const bottomSpacerH = virtualize ? Math.max(0, totalHeight - (prefix[effectiveEnd + 1] ?? totalHeight)) : 0;

  const specialToolCalls = useMemo(
    () => activeToolCalls.filter((tc) => tc.function.name === "task" || tc.function.name === "delegate"),
    [activeToolCalls],
  );

  const liveRegularToolRecords = useMemo(() => {
    if (!showLiveTools) return [];
    const regular = activeToolCalls.filter((tc) => tc.function.name !== "task" && tc.function.name !== "delegate");
    return regular.map<ToolCallRecord>((tc) => {
      let parsed: unknown = toolArgs(tc);
      try {
        parsed = JSON.parse(tc.function.arguments);
      } catch {}
      const rawName = tc.function.name;
      return enrichToolCallRecord({
        id: tc.id,
        toolName: friendlyToolName(rawName),
        rawToolName: rawName,
        status: "running",
        args: parsed,
        timestamp: new Date(),
      });
    });
  }, [activeToolCalls, showLiveTools]);

  return (
    <>
      {pinnedTopSlot && (
        <box flexShrink={0} paddingLeft={3} paddingRight={1} marginBottom={1}>
          {pinnedTopSlot}
        </box>
      )}
      <scrollbox
        ref={effectiveRef}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        stickyScroll={isAtBottom}
        // biome-ignore lint/suspicious/noExplicitAny: @opentui/core does not export the StickyStart union.
        stickyStart={"bottom" as any}
        scrollbarOptions={{ visible: false }}
      >
        {topSpacerH > 0 && <box height={topSpacerH} flexShrink={0} />}
        {items.slice(effectiveStart, effectiveEnd + 1).map((item, gi) => {
          const realGi = effectiveStart + gi; // for topGap logic we use absolute index in visible slice

          if (item.kind === "chips") {
            const topGap = realGi === 0 ? 0 : 1;
            return (
              <box key={`chips-${item.firstIndex}`} paddingLeft={3} marginTop={topGap} flexShrink={0}>
                <ChipsItem
                  entries={item.entries}
                  t={t}
                  toolCallsPanel={toolCallsPanel}
                  dimToolChips={dimToolChips}
                  onOpenFileLink={onOpenFileLink}
                />
              </box>
            );
          }

          const msg = item.msg;
          const i = item.index;

          const prevItem = realGi > 0 ? items[realGi - 1] : null;
          const prevType =
            prevItem?.kind === "single" ? prevItem.msg.type : prevItem?.kind === "chips" ? "tool_result" : null;
          const sameGroup =
            prevType !== null && prevType === msg.type && (msg.type === "tool_call" || msg.type === "tool_result");
          const topGap = realGi === 0 || sameGroup ? 0 : 1;

          return (
            <MessageView
              key={`${msg.timestamp.getTime()}-${i}-${msg.type}-${msg.remoteKey ?? ""}`}
              entry={msg}
              index={i}
              t={t}
              modeColor={modeColor}
              expandedMessages={expandedMessages}
              onOpenTerminal={onOpenTerminal}
              onOpenFileLink={onOpenFileLink}
              topGap={topGap}
            />
          );
        })}
        {bottomSpacerH > 0 && <box height={bottomSpacerH} flexShrink={0} />}

        {/* Live reasoning (Grok "thinking") rendered inside the scrollbox so
            stickyScroll + virtualization never cause layout flicker when it
            appears/grows at the bottom. Gated by `showThinking`. */}
        {showThinking && (
          <LiveReasoning t={t} isProcessing={isProcessing} liveReasoningChainOfThought={liveReasoningChainOfThought} />
        )}

        {/* Live streaming assistant text — rendered inside the scrollbox so it
            occupies the same slot the committed message will land in. Without
            this, the preview lived just above the composer and visibly "jumped
            up" into the transcript at end-of-stream when streamContent cleared
            and the message got appended to messages[]. */}
        <StreamingResponseLive t={t} isProcessing={isProcessing} />

        {/* In compact claude-code mode, keep live regular tool rows inside the
            transcript scrollbox. Rendering these below the scrollbox lets tall
            tool panels compete with the composer/footer and paint outside the
            transcript viewport. */}
        {compactLiveStatus && toolCallsPanel && liveRegularToolRecords.length > 0 ? (
          <box paddingLeft={3} marginTop={1} flexShrink={0} overflow="hidden">
            <ToolCallBlockList t={t} calls={liveRegularToolRecords} />
          </box>
        ) : null}

        {/* Inline approval cards (tool gate, payment, file edit). Rendered
            inside the scrollbox so they scroll with the transcript and don't
            collide with the agent status bar above the composer. */}
        {trailingSlot && (
          <box paddingLeft={3} marginTop={1} flexShrink={0}>
            {trailingSlot}
          </box>
        )}
      </scrollbox>

      {/* Idle-only suggestions row (Suggestions widget, next-prompt hints).
          Hidden while the agent is producing a turn so it can't fight for
          attention with streaming content. */}
      {!isProcessing && idleSuggestionsSlot && (
        <box flexShrink={0} paddingLeft={3} paddingRight={1} marginTop={1}>
          {idleSuggestionsSlot}
        </box>
      )}

      {/* "New messages" follow indicator was moved to the InterruptBar above
          the composer (see app.tsx — `hintRight`) so it sits next to the
          Stop chip instead of competing with the transcript. */}

      {/* Live turn output — always rendered (outside virtualized scrollbox).
          Source label appears with the tool surface, so gate on showLiveTools. */}
      {showLiveTools && !compactLiveStatus && liveTurnSourceLabel && (activeToolCalls.length > 0 || isProcessing) && (
        <box paddingLeft={3} marginTop={1} flexShrink={0}>
          <text fg={t.textMuted}>{liveTurnSourceLabel}</text>
        </box>
      )}

      {/* Active special tasks (task / delegate). ≥2 concurrent → ParallelAgents
          dashboard. Rendered in both layouts: the compact status line names
          only the head tool, so without these a running sub-agent is invisible
          in claude-code mode. */}
      {showLiveTools &&
        (() => {
          const specials = specialToolCalls;
          if (specials.length === 0) return null;
          if (specials.length >= 2) {
            const steps: ParallelAgentStep[] = specials.map((tc) => ({
              id: tc.id,
              title: toolArgs(tc) || (tc.function.name === "task" ? "Working" : "Background research"),
              task: tc.function.name === "task" ? "task" : "delegate",
              agent: tryParseArg(tc, "agent") || (tc.function.name === "task" ? "sub-agent" : "explore"),
              status: "running",
            }));
            return (
              <box paddingLeft={3} marginTop={1} flexShrink={0}>
                <ParallelAgents
                  t={t}
                  run={{
                    title: "concurrent subagents",
                    progressLabel: `${specials.length} running`,
                    steps,
                  }}
                />
              </box>
            );
          }
          return specials.map((tc) =>
            tc.function.name === "task" ? (
              <SubagentTaskLine
                key={tc.id}
                t={t}
                agent={tryParseArg(tc, "agent") || "sub-agent"}
                label={toolArgs(tc) || "Working"}
                pending
              />
            ) : (
              <DelegationTaskLine
                key={tc.id}
                t={t}
                label={toolArgs(tc) || "Background research"}
                pending
                id={undefined}
              />
            ),
          );
        })()}

      {/* Regular active tool calls — block list when panel mode is on. In
          compact (claude-code) mode only the block-list panel renders here;
          the status line below owns the secondary "Waiting…" chrome. */}
      {showLiveTools &&
        (() => {
          if (liveRegularToolRecords.length === 0) return null;
          if (compactLiveStatus) return null;
          return (
            <box paddingLeft={3} marginTop={compactLiveStatus ? 2 : 1} flexShrink={0}>
              {toolCallsPanel ? (
                <ToolCallBlockList t={t} calls={liveRegularToolRecords} />
              ) : (
                <ToolChipGroup
                  t={t}
                  calls={liveRegularToolRecords}
                  dimToolChips={dimToolChips}
                  onOpenFileLink={onOpenFileLink}
                />
              )}
            </box>
          );
        })()}
    </>
  );
}

// Grouping helpers
function isChipEligibleToolResult(entry: ChatEntry, toolCallsPanel = false): boolean {
  if (entry.type !== "tool_result") return false;
  const name = entry.toolCall?.function.name || "tool";
  const result = entry.toolResult;
  if (name === "generate_plan" && result?.plan) return false;
  if (name === "task" && result?.task) return false;
  if (name === "delegate" && result?.delegation) return false;
  if (name === "delegation_list") return false;
  if (name === "delegation_read") return false;
  if (name === "lsp") return false;
  if ((result?.media?.length ?? 0) > 0) return false;
  if (name === "write_file" || name === "edit_file") return false;
  if (name === "bash" && result?.backgroundProcess) return false;
  if (name === "process_logs") return false;
  if (name === "process_stop" || name === "process_list") return false;
  if (name === "read_file") return toolCallsPanel;
  if (name === "search_web" || name === "search_x") return false;
  return true;
}

function entryToChipRecord(entry: ChatEntry, fallbackId: string): ToolCallRecord {
  const rawName = entry.toolCall?.function.name || "tool";
  const friendly = friendlyToolName(rawName);
  let parsedArgs: unknown = entry.toolCall ? entry.toolCall.function.arguments : undefined;
  if (entry.toolCall) {
    try {
      parsedArgs = JSON.parse(entry.toolCall.function.arguments);
    } catch {}
  }
  return enrichToolCallRecord({
    id: entry.toolCall?.id ?? fallbackId,
    toolName: friendly,
    rawToolName: rawName,
    status: entry.toolResult?.success === false ? "error" : "done",
    args: parsedArgs,
    output: entry.toolResult?.output || entry.content,
    error: entry.toolResult?.error,
    timestamp: entry.timestamp,
    durationMs: entry.durationMs,
  });
}

/** Attach hook/skill metadata used by block-list rendering. */
export function enrichToolCallRecord(record: ToolCallRecord): ToolCallRecord {
  const raw = record.rawToolName ?? record.toolName;
  const hooksCount = record.hooksCount ?? countHooksForTool(raw);

  const skills = record.skills ?? extractSkillsFromRecord(record);
  return { ...record, hooksCount, skills: skills.length > 0 ? skills : undefined };
}

function extractSkillsFromRecord(record: ToolCallRecord): string[] {
  const raw = record.rawToolName ?? record.toolName;
  if (raw.startsWith("skill:")) return [raw.slice("skill:".length)];
  if (record.toolName.startsWith("skill:")) return [record.toolName.slice("skill:".length)];

  const args = argRecord(record.args);
  const fromArg = args?.skill_name;
  if (typeof fromArg === "string" && fromArg.length > 0) return [fromArg];

  if (raw === "skills_loaded" || record.toolName === "Skills") {
    const names = args?.skills ?? args?.skill_names;
    if (Array.isArray(names)) {
      return names.filter((n): n is string => typeof n === "string" && n.length > 0);
    }
  }
  return [];
}

function argRecord(args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return args as Record<string, unknown>;
}

function friendlyToolName(name: string): string {
  const map: Record<string, string> = {
    bash: "Bash",
    read_file: "Read",
    write_file: "Write",
    edit_file: "Edit",
    search_web: "Web",
    search_x: "X",
    grep: "Grep",
    glob: "Glob",
    ls: "Ls",
    process_list: "Processes",
    process_stop: "Stop",
    process_logs: "Logs",
    generate_image: "Image",
    generate_video: "Video",
    fetch: "Fetch",
    web_fetch: "Fetch",
    skills_loaded: "Skills",
  };
  if (map[name]) return map[name]!;
  return name
    .split("_")
    .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join("");
}
