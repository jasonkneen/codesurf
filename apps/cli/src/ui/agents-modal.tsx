import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { type RefObject, useEffect, useRef, useState } from "react";
import { MODELS } from "../grok/models";
import type { CustomSubagentConfig } from "../utils/settings";
import { formatSubagentName } from "../utils/subagent-display";
import type { Theme } from "./theme";

const EDITOR_KEYBINDINGS = [{ name: "return", action: "submit" as const }];

export type SubagentBrowseRow = { kind: "agent"; agent: CustomSubagentConfig };
export const SUBAGENT_EDITOR_FIELDS = ["name", "model", "instruction"] as const;
export type SubagentEditorField = (typeof SUBAGENT_EDITOR_FIELDS)[number];

export function buildSubagentBrowseRows(agents: CustomSubagentConfig[], query: string): SubagentBrowseRow[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? agents.filter(
        (agent) =>
          agent.name.toLowerCase().includes(q) ||
          agent.model.toLowerCase().includes(q) ||
          agent.instruction.toLowerCase().includes(q),
      )
    : agents;

  return filtered.map((agent) => ({ kind: "agent" as const, agent }));
}

/**
 * Rows of panel chrome above and below the list.
 *
 * border (2) + panel padding (2) + title (1) + search block (2: its own
 * paddingTop plus the text) + footer (1) + the scrollbox's paddingTop (1) +
 * the scrollbox's trailing row (1).
 *
 * This was hard-coded as 7. Under-counting it starved the list of usable rows,
 * so a user with three sub-agents opened /agents and saw an empty box — not
 * even the "No custom sub-agents yet" placeholder, which made it look like the
 * agents had failed to save rather than failed to render.
 */
export const SUBAGENT_PANEL_CHROME_ROWS = 10;

/**
 * Height of the sub-agent picker: tall enough to show every row, capped so a
 * long list does not fill the screen. Content-sized on purpose — an empty list
 * should not render as a giant box.
 */
export function subagentPanelHeight(rowCount: number, screenHeight: number): number {
  const itemCount = Math.max(rowCount, 1);
  return Math.min(itemCount + SUBAGENT_PANEL_CHROME_ROWS, Math.floor(screenHeight * 0.55));
}

function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

function syncRef(ref: RefObject<TextareaRenderable | null>, value: string): void {
  ref.current?.clear();
  if (value) {
    ref.current?.insertText(value);
  }
}

export function SubagentsBrowserModal({
  t,
  width,
  height,
  selectedIndex,
  searchQuery,
  rows,
}: {
  t: Theme;
  width: number;
  height: number;
  selectedIndex: number;
  searchQuery: string;
  rows: SubagentBrowseRow[];
}) {
  const listRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    const selected = rows[selectedIndex];
    if (!selected) return;

    listRef.current?.scrollChildIntoView(`subagent-${selected.agent.name}`);
  }, [rows, selectedIndex]);

  // Compact picker — narrow width and content-sized height so an empty list
  // doesn't render as a giant box. Matches the command palette sizing.
  const panelHeight = subagentPanelHeight(rows.length, height);
  const panelWidth = Math.min(56, Math.max(40, width - 4));
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
        width={panelWidth}
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
            <b>{"Custom sub-agents"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={t.text}>
            {searchQuery || <span style={{ fg: t.textMuted }}>{"Search by name, model..."}</span>}
          </text>
        </box>
        <scrollbox ref={listRef} flexGrow={1} minHeight={0} paddingTop={1}>
          {rows.map((row, idx) => {
            const selected = idx === selectedIndex;

            return (
              <box
                key={`agent-${row.agent.name}`}
                id={`subagent-${row.agent.name}`}
                width="100%"
                backgroundColor={selected ? t.selectedBg : undefined}
                paddingLeft={2}
                paddingRight={2}
              >
                <box width="100%" flexDirection="row" justifyContent="space-between">
                  <text fg={selected ? t.primary : t.text}>
                    <b>{formatSubagentName(row.agent.name)}</b>
                  </text>
                  <text fg={t.textMuted}>{row.agent.model}</text>
                </box>
              </box>
            );
          })}
          {rows.length === 0 ? (
            <box paddingLeft={2} paddingRight={2}>
              <text fg={t.textMuted}>{"No custom sub-agents yet"}</text>
            </box>
          ) : null}
        </scrollbox>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text>
            <span style={{ fg: t.primary }}>{"enter "}</span>
            <span style={{ fg: t.textMuted }}>{"open selected · "}</span>
            <span style={{ fg: t.primary }}>{"ctrl+a "}</span>
            <span style={{ fg: t.textMuted }}>{"add"}</span>
          </text>
        </box>
      </box>
    </box>
  );
}

export function SubagentEditorModal({
  t,
  width,
  height,
  draft,
  focusedField,
  modelIndex,
  error,
  title,
  nameRef,
  instructionRef,
  onSubmit,
  showRemoveHint,
}: {
  t: Theme;
  width: number;
  height: number;
  draft: { name: string; instruction: string };
  focusedField: SubagentEditorField;
  modelIndex: number;
  error: string | null;
  title: string;
  nameRef: RefObject<TextareaRenderable | null>;
  instructionRef: RefObject<TextareaRenderable | null>;
  onSubmit: () => void;
  showRemoveHint?: boolean;
}) {
  const model = MODELS[modelIndex] ?? MODELS[0];
  const panelWidth = Math.min(68, width - 6);
  const panelHeight = Math.min(28, Math.floor(height * 0.75));
  const overlayBg = "#000000cc" as string;

  useEffect(() => {
    syncRef(nameRef, draft.name);
    syncRef(instructionRef, draft.instruction);
  }, [draft, nameRef, instructionRef]);

  // Do not focus a field on the FIRST frame.
  //
  // This modal is opened by Enter on the picker, and the name field is a
  // textarea whose `onSubmit` saves and closes. The picker's key handler mounts
  // this component inside `flushSync`, so a field focused on that first frame
  // received the very Enter that opened the editor: it opened and saved in one
  // keypress, which looked like the editor flashing and vanishing.
  //
  // Focus lands one frame later, by which point that keypress is finished.
  const [focusArmed, setFocusArmed] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setFocusArmed(true), 0);
    return () => clearTimeout(id);
  }, []);
  const focused = (field: SubagentEditorField) => focusArmed && focusedField === field;

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
        width={panelWidth}
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
          <text fg={t.textMuted}>{"esc back"}</text>
        </box>
        <scrollbox flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <box paddingBottom={1}>
            <text fg={focusedField === "name" ? t.primary : t.textMuted}>{"Name (task tool agent value)"}</text>
            <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1}>
              <textarea
                ref={nameRef}
                focused={focused("name")}
                placeholder="e.g. security-review"
                textColor={t.text}
                backgroundColor={t.backgroundElement}
                placeholderColor={t.textMuted}
                minHeight={1}
                maxHeight={2}
                wrapMode="word"
                keyBindings={EDITOR_KEYBINDINGS}
                onSubmit={onSubmit as unknown as () => void}
              />
            </box>
          </box>
          <box paddingBottom={1}>
            <text fg={focusedField === "model" ? t.primary : t.textMuted}>
              {"Model - "}
              <span style={{ fg: t.text }}>{`${model.name} (${model.id})`}</span>
            </text>
            {focusedField === "model" ? <text fg={t.textMuted}>{"up/down or left/right to change model"}</text> : null}
          </box>
          <box paddingBottom={1}>
            <text fg={focusedField === "instruction" ? t.primary : t.textMuted}>{"Instruction (system prompt)"}</text>
            <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1}>
              <textarea
                ref={instructionRef}
                focused={focused("instruction")}
                placeholder="How this sub-agent should behave..."
                textColor={t.text}
                backgroundColor={t.backgroundElement}
                placeholderColor={t.textMuted}
                minHeight={4}
                maxHeight={12}
                wrapMode="word"
                keyBindings={EDITOR_KEYBINDINGS}
                onSubmit={onSubmit as unknown as () => void}
              />
            </box>
          </box>
          {error ? (
            <box paddingBottom={1}>
              <text fg={t.diffRemovedFg}>{error}</text>
            </box>
          ) : null}
        </scrollbox>
        <box
          flexShrink={0}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="column"
          gap={0}
        >
          {showRemoveHint ? (
            <text>
              <span style={{ fg: t.primary }}>{"ctrl+x "}</span>
              <span style={{ fg: t.textMuted }}>{"remove sub-agent"}</span>
            </text>
          ) : null}
          <text fg={t.textMuted}>{"tab fields · enter save"}</text>
        </box>
      </box>
    </box>
  );
}
