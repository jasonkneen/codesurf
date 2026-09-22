// Claude Agent SDK settings picker. Three groups shown as a single flat list
// so Up/Down traversal is continuous; group headers are skipped during
// navigation. Enter applies the selected row's value immediately, closes the
// modal, and the caller fires a confirmation toast.

import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { Theme } from "./theme";

export type ClaudeAgentGroup = "thinking" | "effort" | "permission";

export interface ClaudeAgentOption {
  kind: "option";
  group: ClaudeAgentGroup;
  value: string;
  label: string;
  description: string;
}

export interface ClaudeAgentHeader {
  kind: "header";
  group: ClaudeAgentGroup;
  title: string;
  subtitle: string;
}

export type ClaudeAgentRow = ClaudeAgentHeader | ClaudeAgentOption;

export interface ClaudeAgentValues {
  thinking: string;
  effort: string;
  permission: string;
}

const THINKING_OPTIONS: Array<Omit<ClaudeAgentOption, "kind" | "group">> = [
  { value: "adaptive", label: "Adaptive", description: "Claude decides when and how much to think" },
  { value: "enabled", label: "Enabled", description: "Always think — budget guided by effort" },
  { value: "disabled", label: "Disabled", description: "Skip extended thinking" },
];

const EFFORT_OPTIONS: Array<Omit<ClaudeAgentOption, "kind" | "group">> = [
  { value: "low", label: "Low", description: "Fastest, minimal thinking" },
  { value: "medium", label: "Medium", description: "Balanced" },
  { value: "high", label: "High", description: "Deep reasoning (default)" },
  { value: "xhigh", label: "Extra high", description: "Opus 4.7 only (falls back elsewhere)" },
  { value: "max", label: "Max", description: "Maximum effort (select models only)" },
];

const PERMISSION_OPTIONS: Array<Omit<ClaudeAgentOption, "kind" | "group">> = [
  { value: "default", label: "Default", description: "Prompt for every tool" },
  { value: "bypassPermissions", label: "Always approve (yolo)", description: "Skip every tool permission prompt" },
  { value: "acceptEdits", label: "Accept edits", description: "Auto-approve file edits only" },
  { value: "plan", label: "Plan", description: "Read-only planning, no tool use" },
  { value: "dontAsk", label: "Don't ask", description: "No host prompts — CLI deny rules still apply" },
  { value: "auto", label: "Auto", description: "Let Claude choose" },
];

export interface BuildClaudeAgentRowsOptions {
  /**
   * When set, only emit these groups. Used by `/permissions` so the modal is a
   * universal permission picker (not Claude thinking/effort chrome).
   */
  onlyGroups?: readonly ClaudeAgentGroup[];
}

/** All selectable groups in display order. */
export const CLAUDE_AGENT_GROUP_ORDER: ClaudeAgentGroup[] = ["thinking", "effort", "permission"];

export function buildClaudeAgentRows(opts?: BuildClaudeAgentRowsOptions): ClaudeAgentRow[] {
  const include = new Set<ClaudeAgentGroup>(opts?.onlyGroups ?? CLAUDE_AGENT_GROUP_ORDER);
  const rows: ClaudeAgentRow[] = [];
  if (include.has("thinking")) {
    rows.push({
      kind: "header",
      group: "thinking",
      title: "Thinking",
      subtitle: "Next fresh session",
    });
    for (const o of THINKING_OPTIONS) rows.push({ kind: "option", group: "thinking", ...o });
  }
  if (include.has("effort")) {
    rows.push({
      kind: "header",
      group: "effort",
      title: "Effort",
      subtitle: "Next fresh session",
    });
    for (const o of EFFORT_OPTIONS) rows.push({ kind: "option", group: "effort", ...o });
  }
  if (include.has("permission")) {
    rows.push({
      kind: "header",
      group: "permission",
      title: "Permission mode",
      subtitle: include.size === 1 ? "Applies to every adapter that supports it" : "Takes effect on the next tool call",
    });
    for (const o of PERMISSION_OPTIONS) rows.push({ kind: "option", group: "permission", ...o });
  }
  return rows;
}

/** Returns the index of the first option row in a given group. */
export function firstIndexForGroup(rows: ClaudeAgentRow[], group: ClaudeAgentGroup): number {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.kind === "option" && row.group === group) return i;
  }
  return 0;
}

/** Finds the first selectable (option) row — used to initialize focus. */
export function firstSelectableIndex(rows: ClaudeAgentRow[]): number {
  return rows.findIndex((r) => r.kind === "option");
}

/** Steps the index up or down, skipping headers. */
export function stepIndex(rows: ClaudeAgentRow[], current: number, direction: 1 | -1): number {
  let i = current + direction;
  while (i >= 0 && i < rows.length) {
    if (rows[i].kind === "option") return i;
    i += direction;
  }
  return current;
}

function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

export function ClaudeAgentModal({
  t,
  width,
  height,
  rows,
  selectedIndex,
  currentValues,
  title = "Claude Agent SDK",
}: {
  t: Theme;
  width: number;
  height: number;
  rows: ClaudeAgentRow[];
  selectedIndex: number;
  currentValues: ClaudeAgentValues;
  /** Override the modal chrome title (e.g. "Permission mode" for /permissions). */
  title?: string;
}) {
  const listRef = useRef<ScrollBoxRenderable>(null);
  const groupsInView = Array.from(new Set(rows.map((r) => r.group)));
  const showGroupTabHint = groupsInView.length > 1;

  useEffect(() => {
    const row = rows[selectedIndex];
    if (!row) return;
    const id = row.kind === "header" ? `h-${row.group}` : `o-${row.group}-${row.value}`;
    listRef.current?.scrollChildIntoView(id);
  }, [rows, selectedIndex]);

  const panelHeight = Math.min(rows.length * 2 + 8, Math.floor(height * 0.85));
  const overlayBg = "#000000cc" as string;

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={bottomAlignedModalTop(height, panelHeight)}
      backgroundColor={overlayBg}
    >
      <box
        width={Math.min(92, width - 4)}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        border
        borderStyle="rounded"
        borderColor={t.accent}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>
            <b>{title}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <scrollbox ref={listRef} flexGrow={1} minHeight={0} paddingTop={1}>
          {rows.map((row, idx) => {
            if (row.kind === "header") {
              return (
                <box
                  key={`h-${row.group}`}
                  id={`h-${row.group}`}
                  paddingLeft={2}
                  paddingRight={2}
                  paddingTop={idx === 0 ? 0 : 1}
                >
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={t.primary}>
                      <b>{row.title}</b>
                    </text>
                    <text fg={t.textMuted}>{row.subtitle}</text>
                  </box>
                </box>
              );
            }
            const selected = idx === selectedIndex;
            const current = currentValues[row.group] === row.value;
            const marker = current ? "\u25cf" : "\u25cb";
            const fg = current ? t.accent : selected ? t.selected : t.text;
            return (
              <box
                key={`o-${row.group}-${row.value}`}
                id={`o-${row.group}-${row.value}`}
                backgroundColor={selected ? t.selectedBg : undefined}
                paddingLeft={4}
                paddingRight={2}
              >
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={fg}>
                    {marker}
                    {"  "}
                    {row.label}
                  </text>
                  <text fg={t.textMuted}>{row.description}</text>
                </box>
              </box>
            );
          })}
        </scrollbox>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={0}>
          <text>
            <span style={{ fg: t.primary }}>{"↑↓ "}</span>
            <span style={{ fg: t.textMuted }}>{"move  \u00b7  "}</span>
            {showGroupTabHint ? (
              <>
                <span style={{ fg: t.primary }}>{"tab "}</span>
                <span style={{ fg: t.textMuted }}>{"group  \u00b7  "}</span>
              </>
            ) : null}
            <span style={{ fg: t.primary }}>{"space "}</span>
            <span style={{ fg: t.textMuted }}>{"set  \u00b7  "}</span>
            <span style={{ fg: t.primary }}>{"enter "}</span>
            <span style={{ fg: t.textMuted }}>{"set & close  \u00b7  "}</span>
            <span style={{ fg: t.primary }}>{"esc "}</span>
            <span style={{ fg: t.textMuted }}>{"close"}</span>
          </text>
        </box>
      </box>
    </box>
  );
}
