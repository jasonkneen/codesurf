// FileNavigator — scrollable line view with cursor, match highlighting, and
// navigation pills. Ported from termcast's file-navigator.tsx. Internal
// state (cursor position) kept local since navigation is inherent to the
// widget's purpose; search query + match jumping still work through pill
// clicks via the exposed onNavigate handlers.

import { useEffect, useState } from "react";
import type { Theme } from "../theme";
import { AgentPanel, PanelPill } from "./panel-frame";

export interface FileNavigatorData {
  path: string;
  lines: string[];
  currentLine?: number;
  query?: string;
  viewportSize?: number;
  statusLabel?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function findMatches(lines: string[], query?: string): number[] {
  if (!query) return [];
  const normalized = query.toLowerCase();
  return lines
    .map((line, index) => (line.toLowerCase().includes(normalized) ? index : -1))
    .filter((index) => index >= 0);
}

export function FileNavigator({ t, file }: { t: Theme; file: FileNavigatorData }) {
  const viewportSize = Math.max(4, file.viewportSize ?? 8);
  const [cursorLine, setCursorLine] = useState(
    clamp((file.currentLine ?? 1) - 1, 0, Math.max(0, file.lines.length - 1)),
  );

  useEffect(() => {
    setCursorLine(clamp((file.currentLine ?? 1) - 1, 0, Math.max(0, file.lines.length - 1)));
  }, [file.currentLine, file.lines]);

  const matches = findMatches(file.lines, file.query);
  const windowStart = clamp(
    cursorLine - Math.floor(viewportSize / 2),
    0,
    Math.max(0, file.lines.length - viewportSize),
  );
  const windowEnd = Math.min(file.lines.length, windowStart + viewportSize);
  const visibleLines = file.lines.slice(windowStart, windowEnd);

  function moveCursor(delta: number): void {
    setCursorLine((current) => clamp(current + delta, 0, Math.max(0, file.lines.length - 1)));
  }

  function jumpToMatch(direction: 1 | -1): void {
    if (matches.length === 0) return;
    const target =
      direction === 1
        ? (matches.find((m) => m > cursorLine) ?? matches[0])
        : ([...matches].reverse().find((m) => m < cursorLine) ?? matches[matches.length - 1]);
    setCursorLine(target);
  }

  return (
    <AgentPanel
      t={t}
      title="file navigator"
      meta={`${cursorLine + 1}/${Math.max(1, file.lines.length)}  ${matches.length} matches`}
      statusLabel={file.statusLabel}
      statusColor={t.accent}
    >
      <box flexDirection="column">
        <text fg={t.text} wrapMode="none">
          <b>{file.path}</b>
        </text>
        <box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
          <PanelPill t={t} label="Up" onSelect={() => moveCursor(-1)} />
          <PanelPill t={t} label="Down" onSelect={() => moveCursor(1)} />
          <PanelPill t={t} label="Page up" onSelect={() => moveCursor(-viewportSize)} />
          <PanelPill t={t} label="Page down" onSelect={() => moveCursor(viewportSize)} />
          <PanelPill t={t} label="Prev match" onSelect={() => jumpToMatch(-1)} />
          <PanelPill t={t} label="Next match" onSelect={() => jumpToMatch(1)} />
          {file.query && <PanelPill t={t} label={`search: ${file.query}`} fg={t.accent} />}
        </box>
        <box flexDirection="column" marginTop={1}>
          {visibleLines.map((line, offset) => {
            const lineIndex = windowStart + offset;
            const lineNumber = String(lineIndex + 1).padStart(4, " ");
            const isCurrent = lineIndex === cursorLine;
            const isMatch = matches.includes(lineIndex);
            return (
              <box
                key={`${file.path}-${lineIndex}`}
                flexDirection="row"
                backgroundColor={isCurrent ? t.backgroundPanel : undefined}
              >
                <box width={6} flexShrink={0}>
                  <text fg={isCurrent ? t.accent : t.textMuted} wrapMode="none">
                    {isCurrent ? <b>{lineNumber}</b> : lineNumber}
                  </text>
                </box>
                <text fg={isMatch ? t.accent : t.text}>{isCurrent ? <b>{line}</b> : line}</text>
              </box>
            );
          })}
        </box>
      </box>
    </AgentPanel>
  );
}

export function makeExampleFileNavigator(): FileNavigatorData {
  return {
    path: "src/modules/messages/bubble.tsx",
    currentLine: 12,
    query: "tool",
    viewportSize: 8,
    statusLabel: "inline review",
    lines: [
      'import { Showcase } from "../agent-output/showcase"',
      'import { ChainOfThought } from "../agent-output/chain-of-thought"',
      'import type { Thought } from "../agent-output/chain-of-thought"',
      'import { ToolCalls } from "../agent-output/tool-calls"',
      'import type { ToolCall } from "../agent-output/tool-calls"',
      'import { Steps } from "../agent-output/steps"',
      'import type { Step } from "../agent-output/steps"',
      'import { ActivityStatus } from "../agent-output/activity-status"',
      'import type { ActivityStatusData } from "../agent-output/activity-status"',
      'import { PlanUpdate } from "../agent-output/plan-update"',
      'import type { PlanUpdateData } from "../agent-output/plan-update"',
      'if (msg.meta?.type === "tool-calls") {',
      "  return <ToolCalls calls={(msg.meta.calls ?? []) as ToolCall[]} width={width} />",
      "}",
      'if (msg.meta?.type === "steps") {',
      '  return <Steps steps={(msg.meta.steps ?? []) as Step[]} title="Tasks" />',
      "}",
    ],
  };
}
