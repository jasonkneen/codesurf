// ToolCalls — grouped tool call records with status icons and expandable
// args/output/error panes. Ported from termcast's agent-output/tool-calls.tsx.
//
// Supports two modes:
//   - controlled: caller passes `expandedIds` and `onToggle` — used when
//     the host tracks a reducer (e.g. live streaming feed with persisted
//     expansion state).
//   - uncontrolled (default): when `onToggle` is omitted, the widget keeps
//     its own expansion state. Clicks work out of the box without any
//     wiring — matches the "drop in /showcase and it just works" pattern.

import { memo, useMemo, useState } from "react";
import { useIcon } from "../../core/plugins";
import { Markdown } from "../markdown";
import type { LocalFileLinkTarget } from "../markdown-links";
import type { Theme } from "../theme";
import { shortenToolChipName } from "./chip-name";
import {
  CHIP_GROUP_THRESHOLD,
  CHIP_MEGA_THRESHOLD,
  type ChipDisplayItem,
  compactChipDurationLabel,
  compactGroupDurationLabel,
  deriveChipDisplay,
  formatChipDuration,
  type ToolCallRecord,
  type ToolCallStatus,
} from "./tool-calls-collation";
import { resolveToolChipColors } from "./tool-chip-colors";

// Re-export the pure-helper API so existing callers keep importing from
// `./tool-calls` even though the algorithm now lives in a sibling .ts file.
export {
  CHIP_GROUP_THRESHOLD,
  CHIP_MEGA_THRESHOLD,
  type ChipDisplayItem,
  compactChipDurationLabel,
  compactGroupDurationLabel,
  deriveChipDisplay,
  formatChipDuration,
  type ToolCallRecord,
  type ToolCallStatus,
};

interface ToolCallsProps {
  t: Theme;
  calls: ToolCallRecord[];
  onOpenFileLink?: (target: LocalFileLinkTarget) => void;
  /** Ids whose detail is currently expanded. Caller owns the set. */
  expandedIds?: ReadonlySet<string>;
  /** Invoked when a call row is clicked; caller toggles the id in
   *  expandedIds. Optional — if omitted, rows are click-inert. */
  onToggle?: (id: string) => void;
}

const CALL_ICON: Record<ToolCallStatus, string> = {
  pending: "○",
  running: "◌",
  done: "✓",
  error: "✗",
};

function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  return `\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``;
}

function statusColor(t: Theme, status: ToolCallStatus): string {
  switch (status) {
    case "done":
      return t.diffAddedFg;
    case "running":
      return t.accent;
    case "error":
      return t.diffRemovedFg;
    default:
      return t.textMuted;
  }
}

function handleChipMouseDown(event: { preventDefault?: () => void; stopPropagation?: () => void } | undefined): void {
  event?.preventDefault?.();
}

export function ToolCallRow({
  t,
  call,
  expanded: controlledExpanded,
  onToggle,
  onOpenFileLink,
}: {
  t: Theme;
  call: ToolCallRecord;
  expanded?: boolean;
  onToggle?: (id: string) => void;
  onOpenFileLink?: (target: LocalFileLinkTarget) => void;
}) {
  // Uncontrolled fallback when used as a standalone row (no ToolCalls parent
  // to provide expandedIds + onToggle).
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const effectiveToggle = onToggle ? onToggle : () => setLocalExpanded((v) => !v);
  const color = statusColor(t, call.status);
  const hasContent = call.args !== undefined || !!call.output || !!call.error;
  const durationLabel = compactChipDurationLabel(call.status, call.durationMs);
  return (
    <box flexDirection="column" onMouseDown={hasContent ? () => effectiveToggle(call.id) : undefined}>
      <box flexDirection="row" height={1} paddingLeft={1} paddingRight={1}>
        <box width={2} flexShrink={0}>
          <text fg={color} wrapMode="none">
            {CALL_ICON[call.status]}
          </text>
        </box>
        <text fg={t.text} wrapMode="none">
          {call.status === "running" ? <b>{call.toolName}</b> : call.toolName}
        </text>
        {durationLabel && (
          <text fg={t.textMuted} wrapMode="none">
            {`  ${durationLabel}`}
          </text>
        )}
        {hasContent && (
          <text fg={t.textMuted} wrapMode="none">
            {expanded ? "  [-]" : "  [+]"}
          </text>
        )}
      </box>
      {expanded && (
        <box flexDirection="column" paddingLeft={3} paddingRight={1} marginBottom={1}>
          {call.args !== undefined && (
            <box flexDirection="column" marginBottom={call.output || call.error ? 1 : 0}>
              <text fg={t.textMuted} wrapMode="none">
                <b>{"input"}</b>
              </text>
              <Markdown content={formatArgs(call.args)} t={t} onOpenFileLink={onOpenFileLink} />
            </box>
          )}
          {call.output && (
            <box flexDirection="column" marginBottom={call.error ? 1 : 0}>
              <text fg={t.textMuted} wrapMode="none">
                <b>{"output"}</b>
              </text>
              <Markdown content={call.output} t={t} raw onOpenFileLink={onOpenFileLink} />
            </box>
          )}
          {call.error && (
            <box flexDirection="column">
              <text fg={t.diffRemovedFg} wrapMode="none">
                <b>{"error"}</b>
              </text>
              <text fg={t.diffRemovedFg} wrapMode="none">
                {call.error}
              </text>
            </box>
          )}
        </box>
      )}
    </box>
  );
}

export function ToolCalls({ t, calls, expandedIds, onToggle, onOpenFileLink }: ToolCallsProps) {
  // Uncontrolled fallback: when the caller doesn't own the expansion state,
  // store it locally so clicks still toggle.
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(() => new Set());
  const effectiveExpanded = expandedIds ?? internalExpanded;
  const effectiveToggle = onToggle
    ? onToggle
    : (id: string) => {
        setInternalExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      };

  if (calls.length === 0) return null;
  const runningCount = calls.filter((c) => c.status === "running").length;
  const doneCount = calls.filter((c) => c.status === "done").length;
  return (
    <box flexDirection="column" border borderColor={t.border} marginBottom={1} marginLeft={1} marginRight={1}>
      <box flexDirection="row" height={1} paddingLeft={1} backgroundColor={t.backgroundPanel}>
        <text fg={t.primary} wrapMode="none">
          <b>{"tool calls"}</b>
        </text>
        <text fg={t.textMuted} wrapMode="none">
          {`  ${doneCount}/${calls.length}`}
          {runningCount > 0 ? `  ${runningCount} running` : ""}
        </text>
      </box>
      {calls.map((call) => (
        <ToolCallRow
          key={call.id}
          t={t}
          call={call}
          expanded={effectiveExpanded.has(call.id)}
          onToggle={effectiveToggle}
          onOpenFileLink={onOpenFileLink}
        />
      ))}
    </box>
  );
}

/**
 * ToolChip — compact one-line pill that renders a tool call as a single-line
 * filled block: subdued dark-grey background (`textDim`) with normal text
 * (`text`), e.g. `BASH ✓`. No border — the filled background IS the
 * visual container. Used by {@link ToolChipGroup}
 * to pack many consecutive tool calls into a horizontally-wrapping row.
 *
 * Click toggles expansion; expansion panels live in {@link ToolChipGroup} so
 * the chip itself stays one line and wrapping behavior is preserved.
 */
export function ToolChip({
  t,
  call,
  expanded = false,
  dimToolChips = true,
  onToggle,
}: {
  t: Theme;
  call: ToolCallRecord;
  expanded?: boolean;
  dimToolChips?: boolean;
  onToggle?: (id: string) => void;
}) {
  const hasContent = call.args !== undefined || !!call.output || !!call.error;
  const clickable = hasContent && onToggle;
  // Visual state: expanded chips switch to the accent background and append a
  // down chevron; collapsed-but-clickable chips get a right chevron hint so
  // users know they can be opened. Non-expandable chips show no chevron.
  //
  // Chevron source: prefer the Nerd Font glyph (when /nerd-icons is on) and
  // fall back to the larger Unicode triangle ▶/▼ (the non-"SMALL" variants
  // are visually heavier than the previous ▸/▾).
  const nerdRight = useIcon("chevron_right");
  const nerdDown = useIcon("chevron_down");
  const toolIcon = useIcon("tool");
  const { background: bg, foreground } = resolveToolChipColors(t, { dimToolChips, expanded });
  const chevronGlyph = expanded ? nerdDown || "▼" : nerdRight || "▶";
  const chevron = clickable ? ` ${chevronGlyph}` : "";
  const labelPrefix = toolIcon ? `${toolIcon} ` : "";
  const durationLabel = compactChipDurationLabel(call.status, call.durationMs);
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      height={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={bg}
      onMouseDown={
        clickable
          ? (event) => {
              handleChipMouseDown(event);
              onToggle(call.id);
            }
          : undefined
      }
    >
      <text fg={foreground} bg={bg} wrapMode="none" selectable={false}>
        <b>{`${labelPrefix}${shortenToolChipName(call.toolName)}`}</b>
      </text>
      <text fg={foreground} bg={bg} wrapMode="none" selectable={false}>
        <b>
          {" "}
          {CALL_ICON[call.status]}
          {durationLabel ? ` ${durationLabel}` : ""}
          {chevron}
        </b>
      </text>
    </box>
  );
}

// State buckets (owned by ToolChipGroup):
//   • explodedGroups:  Set<string> of synthetic ids that should render their
//                      parts instead of their summary (see MEGA_ID and
//                      GROUP_ID_PREFIX in tool-calls-collation.ts).
//   • expandedDetails: Set<string> of ToolCallRecord.id whose args/output
//                      panel is currently shown. Same semantics as before
//                      the chip-collation refactor.

/**
 * GroupChip — visual sibling of {@link ToolChip} that renders a tier-1 summary
 * like `3xBASH ✓`. Clicking explodes the group back into its individual chips
 * via the parent's `explodedGroups` set.
 */
export function GroupChip({
  t,
  id,
  toolName,
  count,
  durationLabel,
  expanded = false,
  dimToolChips = true,
  onToggle,
}: {
  t: Theme;
  id: string;
  toolName: string;
  count: number;
  durationLabel?: string | null;
  expanded?: boolean;
  dimToolChips?: boolean;
  onToggle: (id: string) => void;
}) {
  const nerdRight = useIcon("chevron_right");
  const nerdDown = useIcon("chevron_down");
  const toolIcon = useIcon("tools");
  // Mirror ToolChip's expanded styling so all three chip kinds share the
  // same "open" visual language: accent background + ▼ when expanded.
  const { background: bg, foreground } = resolveToolChipColors(t, { dimToolChips, expanded });
  const chevronGlyph = expanded ? nerdDown || "▼" : nerdRight || "▶";
  const labelPrefix = toolIcon ? `${toolIcon} ` : "";
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      height={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={bg}
      onMouseDown={(event) => {
        handleChipMouseDown(event);
        onToggle(id);
      }}
    >
      <text fg={foreground} bg={bg} wrapMode="none" selectable={false}>
        <b>{`${labelPrefix}${count}x${shortenToolChipName(toolName)}`}</b>
      </text>
      <text fg={foreground} bg={bg} wrapMode="none" selectable={false}>
        <b>{` ${CALL_ICON.done}${durationLabel ? ` ${durationLabel}` : ""} ${chevronGlyph}`}</b>
      </text>
    </box>
  );
}

/**
 * MegaChip — tier-2 summary that rolls every tier-1 group into one
 * `12xTOOLS ✓` chip. Clicking explodes it back to the tier-1 group chips
 * (each of which can then be exploded independently).
 */
export function CategoryChip({
  t,
  id,
  category,
  count,
  expanded = false,
  dimToolChips = true,
  onToggle,
}: {
  t: Theme;
  id: string;
  category: string;
  count: number;
  expanded?: boolean;
  dimToolChips?: boolean;
  onToggle: (id: string) => void;
}) {
  const nerdRight = useIcon("chevron_right");
  const nerdDown = useIcon("chevron_down");
  const toolIcon = useIcon("tools");
  // Same "open" visual treatment as GroupChip / ToolChip.
  const { background: bg, foreground } = resolveToolChipColors(t, { dimToolChips, expanded });
  const chevronGlyph = expanded ? nerdDown || "▼" : nerdRight || "▶";
  const _labelPrefix = toolIcon ? `${toolIcon} ` : "";
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      height={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={bg}
      onMouseDown={(event) => {
        handleChipMouseDown(event);
        onToggle(id);
      }}
    >
      <text fg={foreground} bg={bg} wrapMode="none" selectable={false}>
        <b>{`[${category} x${count}]`}</b>
      </text>
      <text fg={foreground} bg={bg} wrapMode="none" selectable={false}>
        <b>{` ${CALL_ICON.done} ${chevronGlyph}`}</b>
      </text>
    </box>
  );
}

/**
 * ToolChipGroup — renders a horizontal-wrapping row of chips with two-tier
 * collation (see {@link deriveChipDisplay}) and click-to-expand details below.
 *
 * Layout (with collation in effect):
 *   12xTOOLS ✓  BASH ⠋  BASH ✗            ← mega + running + error
 *     ↳ click mega → 5xBASH ✓ 4xREAD ✓ 3xWRITE ✓ ...
 *     ↳ click 5xBASH → BASH ✓ BASH ✓ BASH ✓ BASH ✓ BASH ✓
 *     ↳ click an individual chip → its args/output panel renders below.
 */
export const ToolChipGroup = memo(function ToolChipGroup({
  t,
  calls,
  thoughtCount = 0,
  onOpenFileLink,
  dimToolChips = true,
}: {
  t: Theme;
  calls: ToolCallRecord[];
  /** Reasoning blocks to fold into the row as a `[Thought ×N]` chip. */
  thoughtCount?: number;
  onOpenFileLink?: (target: LocalFileLinkTarget) => void;
  /** Default-on flag that keeps compact tool calls visually quiet. */
  dimToolChips?: boolean;
}) {
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(() => new Set());
  const [explodedGroups, setExplodedGroups] = useState<Set<string>>(() => new Set());
  const items = useMemo(() => deriveChipDisplay(calls, explodedGroups), [calls, explodedGroups]);
  if (calls.length === 0 && thoughtCount === 0) return null;

  const toggleDetails = (id: string) =>
    setExpandedDetails((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleGroup = (id: string) =>
    setExplodedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Detail panels render only for individual chips that are currently visible
  // AND whose details the user has explicitly opened. We filter against the
  // derived items so that detail panels for chips currently hidden inside a
  // collapsed group/mega disappear from the row until that group is exploded
  // again — otherwise expanded details would orphan below a mega chip with no
  // visible owner.
  const visibleIndividualIds = new Set(items.flatMap((it) => (it.kind === "individual" ? [it.call.id] : [])));
  const expandedCalls = calls.filter((c) => expandedDetails.has(c.id) && visibleIndividualIds.has(c.id));

  return (
    <box flexDirection="column">
      <box flexDirection="row" flexWrap="wrap" gap={1}>
        {thoughtCount > 0 ? (
          <box backgroundColor="#2a2440" paddingLeft={1} paddingRight={1} paddingTop={0} paddingBottom={0}>
            <text fg="#a78bff">{"[Thought ×" + thoughtCount + "]"}</text>
          </box>
        ) : null}
        {items.map((item) => {
          if (item.kind === "individual") {
            return (
              <ToolChip
                key={item.call.id}
                t={t}
                call={item.call}
                expanded={expandedDetails.has(item.call.id)}
                dimToolChips={dimToolChips}
                onToggle={toggleDetails}
              />
            );
          }
          if (item.kind === "group") {
            return (
              <GroupChip
                key={item.id}
                t={t}
                id={item.id}
                toolName={item.toolName}
                count={item.calls.length}
                durationLabel={compactGroupDurationLabel(item.calls)}
                expanded={item.expanded}
                dimToolChips={dimToolChips}
                onToggle={toggleGroup}
              />
            );
          }
          return (
            <CategoryChip
              key={item.id}
              t={t}
              id={item.id}
              category={item.category}
              count={item.calls.length}
              expanded={item.expanded}
              dimToolChips={dimToolChips}
              onToggle={toggleGroup}
            />
          );
        })}
      </box>
      {expandedCalls.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          {expandedCalls.map((c) => (
            <box key={`${c.id}-detail`} flexDirection="column" marginBottom={1}>
              <box flexDirection="row" height={1}>
                <text fg={t.textMuted} wrapMode="none">
                  <b>{c.toolName}</b>
                </text>
                {compactChipDurationLabel(c.status, c.durationMs) && (
                  <text
                    fg={t.textMuted}
                    wrapMode="none"
                  >{`  ${compactChipDurationLabel(c.status, c.durationMs)}`}</text>
                )}
              </box>
              {c.args !== undefined && (
                <box flexDirection="column" marginBottom={c.output || c.error ? 1 : 0}>
                  <text fg={t.textMuted} wrapMode="none">
                    <b>{"input"}</b>
                  </text>
                  <Markdown content={formatArgs(c.args)} t={t} onOpenFileLink={onOpenFileLink} />
                </box>
              )}
              {c.output && (
                <box flexDirection="column" marginBottom={c.error ? 1 : 0}>
                  <text fg={t.textMuted} wrapMode="none">
                    <b>{"output"}</b>
                  </text>
                  <Markdown content={c.output} t={t} raw onOpenFileLink={onOpenFileLink} />
                </box>
              )}
              {c.error && (
                <box flexDirection="column">
                  <text fg={t.diffRemovedFg} wrapMode="none">
                    <b>{"error"}</b>
                  </text>
                  <text fg={t.diffRemovedFg} wrapMode="none">
                    {c.error}
                  </text>
                </box>
              )}
            </box>
          ))}
        </box>
      )}
    </box>
  );
});

export function makeExampleToolCalls(): ToolCallRecord[] {
  return [
    {
      id: "tc1",
      toolName: "read_file",
      status: "done",
      durationMs: 23,
      args: { path: "src/core/store.tsx" },
      output: "File read — 142 lines, 4.2 KB.\n\nExports: `useAppState`, `BUILT_IN_MODELS`, `makeMessageId`",
    },
    {
      id: "tc2",
      toolName: "bash",
      status: "done",
      durationMs: 1_842,
      args: { command: "bun test --reporter=verbose 2>&1 | tail -20" },
      output: "```\n23 passed  2 failed\n\nFAIL src/core/store.test.tsx\n  expect(result).toBe(true)\n```",
    },
    {
      id: "tc3",
      toolName: "write_file",
      status: "running",
      args: { path: "src/core/store.tsx", operation: "patch" },
    },
    {
      id: "tc4",
      toolName: "bash",
      status: "pending",
      args: { command: "bun test --reporter=verbose" },
    },
  ];
}

/**
 * makeExampleManyToolCalls — synthesises a noisy stream that triggers BOTH
 * tiers of collapse so the showcase can demonstrate the collation:
 *
 *   5×bash done + 4×read_file done + 3×write_file done + 3×grep done
 *     → 4 groupable tools (≥3 each) → tier 2 fires (4 ≥ 3 mega threshold)
 *   1×search done                 → loose individual (below threshold)
 *   1×bash running                → escapes (status = running)
 *   1×bash error                  → escapes (status = error)
 *
 * Initial render: `15xTOOLS ✓  search ✓  bash ⠋  bash ✗`  (4 chips).
 * Click the mega → `5xBASH ✓ 4xREAD_FILE ✓ 3xWRITE_FILE ✓ 3xGREP ✓` plus the
 * loose / running / error chips. Click a group → its individual chips render.
 */
export function makeExampleManyToolCalls(): ToolCallRecord[] {
  const out: ToolCallRecord[] = [];
  let n = 0;
  const push = (toolName: string, status: ToolCallStatus, extras: Partial<ToolCallRecord> = {}) => {
    n += 1;
    out.push({ id: `tcm${n}`, toolName, status, ...extras });
  };
  for (let i = 0; i < 5; i++) {
    push("bash", "done", {
      durationMs: 100 + i * 50,
      args: { command: `echo bash-${i}` },
      output: `bash output ${i}`,
    });
  }
  for (let i = 0; i < 4; i++) {
    push("read_file", "done", {
      durationMs: 20 + i * 5,
      args: { path: `src/file-${i}.ts` },
      output: `file ${i} contents`,
    });
  }
  for (let i = 0; i < 3; i++) {
    push("write_file", "done", {
      durationMs: 50 + i * 10,
      args: { path: `dist/out-${i}.js` },
      output: "wrote",
    });
  }
  for (let i = 0; i < 3; i++) {
    push("grep", "done", {
      durationMs: 80 + i * 5,
      args: { pattern: `pattern-${i}` },
      output: "matches",
    });
  }
  // loose done — below per-tool threshold
  push("search", "done", {
    durationMs: 30,
    args: { query: "anything" },
    output: "results",
  });
  // running — escapes
  push("bash", "running", { args: { command: "sleep 30" } });
  // error — escapes
  push("bash", "error", {
    durationMs: 12,
    args: { command: "false" },
    error: "exit code 1",
  });
  return out;
}
