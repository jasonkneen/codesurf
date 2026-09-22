// PermissionPrompt — fine-grained permission request panel with radio-style
// options and per-option description. Ported from termcast's
// agent-output/permission-prompt.tsx.
//
// Controlled via caller-owned `prompt.selectedOptionId` + `onSelect`; if
// `onSelect` is omitted, the widget keeps its own selection state so clicks
// update the radio row visibly in /showcase and elsewhere.

import { useState } from "react";
import type { Theme } from "../theme";
import { AgentPanel, PanelPill } from "./panel-frame";

export type PermissionStatus = "pending" | "granted" | "denied";
export type PermissionOptionTone = "default" | "safe" | "warning" | "danger";

export interface PermissionOption {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;
  tone?: PermissionOptionTone;
}

export interface PermissionPromptData {
  title: string;
  scope: string;
  target?: string;
  summary?: string;
  rationale?: string;
  status?: PermissionStatus;
  selectedOptionId?: string;
  options?: PermissionOption[];
}

function statusColor(t: Theme, status: PermissionStatus): string {
  switch (status) {
    case "granted":
      return t.diffAddedFg;
    case "denied":
      return t.diffRemovedFg;
    default:
      return t.accent;
  }
}

function optionColors(t: Theme, tone: PermissionOptionTone): { fg: string; bg: string } {
  switch (tone) {
    case "safe":
      return { fg: t.background, bg: t.diffAddedFg };
    case "warning":
      return { fg: t.background, bg: t.accent };
    case "danger":
      return { fg: t.background, bg: t.diffRemovedFg };
    default:
      return { fg: t.text, bg: t.backgroundPanel };
  }
}

export function PermissionPrompt({
  t,
  prompt,
  onSelect,
}: {
  t: Theme;
  prompt: PermissionPromptData;
  /** Called when a permission option is clicked. Caller is responsible for
   *  updating `selectedOptionId` (or resolving the prompt outright). */
  onSelect?: (id: string) => void;
}) {
  const options = prompt.options ?? [];
  const initialSelected = prompt.selectedOptionId ?? options[0]?.id;
  const [internalSelected, setInternalSelected] = useState<string | undefined>(initialSelected);
  // Controlled when caller passes onSelect AND keeps selectedOptionId in
  // sync; otherwise we source the selection from internal state so clicks
  // visibly flip the radio.
  const effectiveSelectedId = onSelect ? (prompt.selectedOptionId ?? internalSelected) : internalSelected;
  const handleSelect = (id: string): void => {
    setInternalSelected(id);
    onSelect?.(id);
  };
  const selected = options.find((opt) => opt.id === effectiveSelectedId);
  const status = prompt.status ?? "pending";
  return (
    <AgentPanel
      t={t}
      title="permission prompt"
      meta={prompt.scope}
      statusLabel={status}
      statusColor={statusColor(t, status)}
    >
      <box flexDirection="column">
        <text fg={t.text}>
          <b>{prompt.title}</b>
        </text>
        {prompt.target && (
          <box marginTop={1}>
            <PanelPill t={t} label={`target: ${prompt.target}`} fg={t.accent} />
          </box>
        )}
        {prompt.summary && <text fg={t.textMuted}>{prompt.summary}</text>}
        {prompt.rationale && <text fg={t.textMuted}>{prompt.rationale}</text>}
        {options.length > 0 && (
          <box flexDirection="column" marginTop={1}>
            {options.map((option) => {
              const colors = optionColors(t, option.tone ?? "default");
              const isSelected = option.id === effectiveSelectedId;
              const label = option.shortcut ? `${option.label} (${option.shortcut})` : option.label;
              return (
                <box
                  key={option.id}
                  flexDirection="column"
                  marginBottom={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={isSelected ? t.backgroundPanel : undefined}
                  onMouseDown={() => handleSelect(option.id)}
                >
                  <box flexDirection="row" height={1}>
                    <text fg={isSelected ? t.accent : t.textMuted} wrapMode="none">
                      {isSelected ? "● " : "○ "}
                    </text>
                    <PanelPill t={t} label={label} fg={colors.fg} bg={colors.bg} bold />
                  </box>
                  {option.description && (
                    <box paddingLeft={2}>
                      <text fg={t.textMuted}>{option.description}</text>
                    </box>
                  )}
                </box>
              );
            })}
          </box>
        )}
        {selected && (
          <box marginTop={1}>
            <text fg={t.textMuted}>{"selected permission: "}</text>
            <text fg={t.text}>
              <b>{selected.label}</b>
            </text>
          </box>
        )}
      </box>
    </AgentPanel>
  );
}

export function makeExamplePermissionPrompt(): PermissionPromptData {
  return {
    title: "Allow network access for dependency verification",
    scope: "network",
    target: "registry.npmjs.org",
    summary: "The next validation step needs package metadata before the agent can run a true install-based check.",
    rationale: "Denying this keeps the run local-only and may hide dependency issues until later.",
    status: "pending",
    selectedOptionId: "once",
    options: [
      {
        id: "once",
        label: "Allow once",
        shortcut: "o",
        tone: "safe",
        description: "Permit this step and ask again the next time network access is needed.",
      },
      {
        id: "always",
        label: "Always allow",
        shortcut: "a",
        tone: "warning",
        description: "Permit networked verification for the rest of the session.",
      },
      {
        id: "deny",
        label: "Deny",
        shortcut: "d",
        tone: "danger",
        description: "Skip the networked check and continue with local validation only.",
      },
    ],
  };
}
