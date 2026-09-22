import { TuiDialogRow, TuiDialogTitle } from "../controls/tui-dialog.js";
import type { Theme } from "../theme.js";

const MAX_VISIBLE = 8;

export function SuggestionOverlay({
  t,
  suggestions,
  selectedIndex,
  mode = "opencode",
  title,
}: {
  t: Theme;
  suggestions: string[];
  selectedIndex: number;
  /** When "claude-code", render termcast-style (title row + full-width
   *  accent selected row). No outer border — the composer's accent border
   *  already frames the area. */
  mode?: "opencode" | "claude-code";
  /** Optional title when mode=claude-code (e.g. "Commands", "Files"). */
  title?: string;
}) {
  if (suggestions.length === 0) return null;

  const visible = suggestions.slice(0, MAX_VISIBLE);

  if (mode === "claude-code") {
    return (
      <box flexDirection="column" paddingLeft={0} paddingRight={0}>
        {title && (
          <TuiDialogTitle
            t={t}
            title={title}
            meta={`${suggestions.length} item${suggestions.length === 1 ? "" : "s"}`}
            hint=""
          />
        )}
        {visible.map((filePath, i) => {
          const isSelected = i === selectedIndex;
          return (
            <TuiDialogRow key={filePath} t={t} selected={isSelected}>
              <text fg={isSelected ? t.background : t.text} wrapMode="none">
                {filePath}
              </text>
            </TuiDialogRow>
          );
        })}
        {suggestions.length > MAX_VISIBLE && (
          <text fg={t.textMuted} wrapMode="none">
            {`  +${suggestions.length - MAX_VISIBLE} more`}
          </text>
        )}
      </box>
    );
  }

  return (
    <box paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} flexShrink={0}>
      {visible.map((filePath, i) => {
        const isSelected = i === selectedIndex;
        return (
          <box
            key={filePath}
            height={1}
            backgroundColor={isSelected ? t.selectedBg : undefined}
            flexDirection="row"
            gap={1}
          >
            <text fg={isSelected ? t.accent : t.textDim}>{isSelected ? "›" : " "}</text>
            <text fg={isSelected ? t.selected : t.text}>{filePath}</text>
          </box>
        );
      })}
      {suggestions.length > MAX_VISIBLE && <text fg={t.textDim}>{`  +${suggestions.length - MAX_VISIBLE} more`}</text>}
    </box>
  );
}
