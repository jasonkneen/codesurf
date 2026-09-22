import { TuiDialogRow, TuiDialogTitle } from "./controls/tui-dialog";
import { slashMenuIndexStore, useIndexStore } from "./menu-nav-store.js";
import type { SlashMenuItem } from "./slash-menu";
import type { Theme } from "./theme";

const COMMAND_COLUMN_WIDTH = 24;
const DESCRIPTION_MAX_WIDTH = 44;
const MAX_VISIBLE = 8;

interface SlashMenuInlineProps {
  t: Theme;
  selectedIndex: number;
  filteredItems: SlashMenuItem[];
}

/**
 * Leaf wrapper that reads the selection index from the external store so an
 * arrow-key re-renders ONLY this menu, not the App. The App renders this and
 * passes `filteredItems`; it does not hold or read the index, so navigating the
 * menu never reconciles the App tree. See src/ui/menu-nav-store.ts.
 */
export function SlashMenuInlineLive({ t, filteredItems }: { t: Theme; filteredItems: SlashMenuItem[] }) {
  const selectedIndex = useIndexStore(slashMenuIndexStore);
  return <SlashMenuInline t={t} selectedIndex={selectedIndex} filteredItems={filteredItems} />;
}

export function SlashMenuInline({ t, selectedIndex, filteredItems }: SlashMenuInlineProps) {
  const safeIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, filteredItems.length - 1));
  const visibleStart =
    filteredItems.length <= MAX_VISIBLE
      ? 0
      : Math.min(Math.max(0, safeIndex - MAX_VISIBLE + 1), filteredItems.length - MAX_VISIBLE);
  const windowed = filteredItems.slice(visibleStart, visibleStart + MAX_VISIBLE);
  const overflow = Math.max(0, filteredItems.length - MAX_VISIBLE);

  return (
    <box flexDirection="column" flexShrink={0}>
      <TuiDialogTitle
        t={t}
        title="Commands"
        meta={`${filteredItems.length} item${filteredItems.length === 1 ? "" : "s"}`}
        hint="tab fill · enter run"
      />
      {filteredItems.length === 0 ? (
        <text fg={t.textMuted} wrapMode="none">
          {"No commands match your search"}
        </text>
      ) : (
        windowed.map((item, i) => {
          const absoluteIdx = visibleStart + i;
          const isSelected = absoluteIdx === safeIndex;
          const row = formatSlashMenuInlineRow(item);
          return (
            <TuiDialogRow key={item.id} t={t} selected={isSelected}>
              <box flexDirection="row" overflow="hidden">
                <box width={COMMAND_COLUMN_WIDTH} flexShrink={0} overflow="hidden">
                  <text fg={isSelected ? t.background : row.isAsk ? t.primary : t.text} wrapMode="none">
                    {row.command}
                  </text>
                </box>
                <box flexGrow={1} />
                <text fg={isSelected ? t.background : t.textMuted} wrapMode="none">
                  {row.description}
                </text>
              </box>
            </TuiDialogRow>
          );
        })
      )}
      {overflow > 0 && (
        <text fg={t.textMuted} wrapMode="none">
          {`  +${overflow} more`}
        </text>
      )}
    </box>
  );
}

export function formatSlashMenuInlineRow(item: SlashMenuItem): {
  command: string;
  description: string;
  isAsk: boolean;
} {
  const isAsk = item.id === "__ask__";
  return {
    command: truncateCell(`${isAsk ? "" : "/"}${item.label}`, COMMAND_COLUMN_WIDTH),
    description: truncateCell(item.description ?? "", DESCRIPTION_MAX_WIDTH),
    isAsk,
  };
}

function truncateCell(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return "…";
  return `${text.slice(0, maxWidth - 1)}…`;
}
