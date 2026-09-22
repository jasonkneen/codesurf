// AgentRoster — list of subagents with role + kind color coding.
// Ported from termcast's agent-roster.tsx.

import type { Theme } from "../theme";
import { AgentPanel } from "./panel-frame";

export interface AgentRosterEntry {
  id: string;
  name: string;
  role: string;
  kind?: "user" | "builtin" | "worker" | "system";
  description?: string;
  /** Lifecycle of this sub-agent's run. Without it a finished entry looks
   *  identical to one still working. */
  status?: "running" | "done" | "error";
}

export interface AgentRosterData {
  title?: string;
  entries: AgentRosterEntry[];
}

/** Leading glyph for a roster row: ◌ running, ✓ done, ✗ failed. */
export function rosterStatusGlyph(status: AgentRosterEntry["status"]): string {
  if (status === "done") return "✓ ";
  if (status === "error") return "✗ ";
  if (status === "running") return "◌ ";
  return "";
}

function statusColor(t: Theme, status: AgentRosterEntry["status"]): string {
  if (status === "done") return t.diffAddedFg;
  if (status === "error") return t.diffRemovedFg;
  return t.accent;
}

function kindColor(t: Theme, kind: AgentRosterEntry["kind"]): string {
  switch (kind) {
    case "builtin":
      return t.accent;
    case "worker":
      return t.diffAddedFg;
    case "system":
      return t.textMuted;
    default:
      return t.text;
  }
}

export function AgentRoster({
  t,
  roster,
  onSelect,
}: {
  t: Theme;
  roster: AgentRosterData;
  onSelect?: (id: string) => void;
}) {
  const entries = roster.entries ?? [];
  return (
    <AgentPanel
      t={t}
      title={roster.title ?? "subagent list"}
      statusLabel={`${entries.length} agents`}
      statusColor={t.accent}
    >
      <box flexDirection="column">
        {entries.map((entry, index) => (
          <box
            key={entry.id}
            flexDirection="column"
            marginBottom={index < entries.length - 1 ? 1 : 0}
            onMouseDown={onSelect ? () => onSelect(entry.id) : undefined}
          >
            <box flexDirection="row" overflow="hidden">
              {entry.status ? (
                <text fg={statusColor(t, entry.status)} wrapMode="none">
                  {rosterStatusGlyph(entry.status)}
                </text>
              ) : null}
              <text fg={kindColor(t, entry.kind)} wrapMode="none">
                <b>{`- ${entry.name}`}</b>
              </text>
              <text fg={t.textMuted} wrapMode="none">
                {` (${entry.role})`}
              </text>
            </box>
            {entry.description && (
              <box paddingLeft={2}>
                <text fg={t.textMuted}>{entry.description}</text>
              </box>
            )}
          </box>
        ))}
      </box>
    </AgentPanel>
  );
}

export function makeExampleAgentRoster(): AgentRosterData {
  return {
    title: "subagent list",
    entries: [
      {
        id: "code",
        name: "code",
        role: "user",
        kind: "user",
        description: "Autonomous coding agent for analysis, review, refactoring, and implementation",
      },
      {
        id: "context-builder",
        name: "context-builder",
        role: "builtin",
        kind: "builtin",
        description: "Analyzes requirements and codebase, generates context and meta-prompt",
      },
      {
        id: "gsd",
        name: "gsd-planner",
        role: "worker",
        kind: "worker",
        description: "Planning worker for roadmap, wave split, and execution guidance",
      },
    ],
  };
}
