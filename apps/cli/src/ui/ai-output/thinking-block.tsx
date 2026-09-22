// ThinkingBlock — collapsible reasoning panel. Ported from termcast's
// agent-output/thinking-block.tsx. The Raycast Spinner + LoadingText
// shimmer animation is replaced with a simple accent-tinted header; grok's
// existing ShimmerText / LoadingSpinner can be wired in later if we decide
// the static look is too plain.
//
// Controlled + uncontrolled: pass `collapsed`+`onToggle` for caller-owned
// state; omit both for internal state (auto-expand while thinking, auto-
// collapse when thinking finishes, toggle on header click).

import { useEffect, useState } from "react";
import { Markdown } from "../markdown";
import type { Theme } from "../theme";

interface ThinkingBlockProps {
  t: Theme;
  thinkingText?: string;
  reasoningText: string;
  isThinking: boolean;
  /** When reasoning began (epoch ms); drives the live elapsed in the header. */
  startedAtMs?: number | null;
  /** Total reasoning time once finished, shown after the line count. */
  durationMs?: number;
  collapsed?: boolean;
  /** Called when the header row is clicked. Caller toggles `collapsed`. */
  onToggle?: () => void;
}

export function getThinkingBlockMeta(
  reasoningText: string,
  isThinking: boolean,
): {
  hasReasoning: boolean;
  lineCount: number;
} {
  // During an active stream, rendering must not walk the full growing trace
  // merely to display a line count that is hidden anyway. Once settled, trim
  // and count lines for the finished summary label.
  if (isThinking) {
    return { hasReasoning: reasoningText.length > 0, lineCount: 0 };
  }

  const trimmed = reasoningText.trim();
  if (!trimmed) return { hasReasoning: false, lineCount: 0 };

  let lineCount = 1;
  for (const char of trimmed) {
    if (char === "\n") lineCount++;
  }
  return { hasReasoning: true, lineCount };
}

function roundSeconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** Header text: `◌ Thinking 4s` while live, `Reasoned  12 lines · 8s` when done. */
export function formatThinkingHeader(input: {
  isThinking: boolean;
  thinkingText?: string;
  elapsedMs?: number;
  lineCount?: number;
  durationMs?: number;
}): string {
  if (input.isThinking) {
    const label = `◌ ${input.thinkingText ?? "Thinking"}`;
    return input.elapsedMs !== undefined ? `${label} ${roundSeconds(input.elapsedMs)}` : label;
  }
  const parts = ["Reasoned"];
  if (input.lineCount && input.lineCount > 0) {
    parts.push(`  ${input.lineCount} line${input.lineCount !== 1 ? "s" : ""}`);
  }
  if (input.durationMs !== undefined && input.durationMs >= 500) {
    parts.push(` · ${roundSeconds(input.durationMs)}`);
  }
  return parts.join("");
}

export function ThinkingBlock({
  t,
  thinkingText = "Thinking",
  reasoningText,
  isThinking,
  startedAtMs,
  durationMs,
  collapsed: controlledCollapsed,
  onToggle,
}: ThinkingBlockProps) {
  // Live clock: one tick per second while thinking and a start is known.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isThinking || !startedAtMs) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isThinking, startedAtMs]);
  const elapsedMs = isThinking && startedAtMs ? now - startedAtMs : undefined;
  // Uncontrolled default mirrors termcast: expanded while thinking,
  // collapsed once thinking ends. Clicking the header flips whichever
  // state we're in.
  const [internalCollapsed, setInternalCollapsed] = useState<boolean | null>(null);
  const defaultCollapsed = !isThinking;
  const effectiveCollapsed = controlledCollapsed ?? internalCollapsed ?? defaultCollapsed;
  const effectiveToggle = onToggle ? onToggle : () => setInternalCollapsed((prev) => !(prev ?? defaultCollapsed));

  const { hasReasoning, lineCount } = getThinkingBlockMeta(reasoningText, isThinking);

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
      <box flexDirection="row" height={1} onMouseDown={effectiveToggle}>
        {isThinking ? (
          <text fg={t.accent} wrapMode="none">
            <b>{formatThinkingHeader({ isThinking: true, thinkingText, elapsedMs })}</b>
          </text>
        ) : (
          <>
            <text fg={t.diffAddedFg} wrapMode="none">
              {"✓ "}
            </text>
            <text fg={t.textMuted} wrapMode="none">
              <b>{"Reasoned"}</b>
              {formatThinkingHeader({
                isThinking: false,
                lineCount: hasReasoning ? lineCount : 0,
                durationMs,
              }).slice("Reasoned".length)}
            </text>
          </>
        )}
        <box flexGrow={1} />
        {hasReasoning && (
          <text fg={t.textMuted} wrapMode="none">
            {effectiveCollapsed ? "▸ expand" : "▾ collapse"}
          </text>
        )}
      </box>
      {!effectiveCollapsed && hasReasoning && (
        <box paddingLeft={2} paddingTop={1}>
          <Markdown content={reasoningText} t={t} streaming={isThinking} />
        </box>
      )}
    </box>
  );
}

export function makeExampleThinkingBlock(): {
  thinkingText: string;
  reasoningText: string;
  isThinking: boolean;
} {
  return {
    thinkingText: "Thinking",
    reasoningText:
      "The user asked for a refactor. I should first understand the existing `Agent` class before suggesting changes — it currently handles three concerns (turn loop, tool dispatch, session persistence). Splitting them cleanly means figuring out where the shared state lives.\n\nI'll propose pulling the session-persistence concern into a `SessionStore` class keyed by conversation id. That keeps the turn loop pure and lets future features (multi-account, export) attach via the same interface.",
    isThinking: false,
  };
}
