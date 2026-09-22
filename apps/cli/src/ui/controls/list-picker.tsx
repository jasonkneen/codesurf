// ListPicker — generic scrollable single-select list. Ported from termcast's
// ui/controls/list-picker.tsx.
//
// Stays stateless (caller owns selectedIndex + onSelectIndex/onConfirmIndex)
// so it drops into any keyboard flow — typical consumer pattern:
//
//   const [idx, setIdx] = useState(0);
//   <ListPicker items={rows} selectedIndex={idx} onSelectIndex={setIdx}
//               onConfirmIndex={(i) => apply(rows[i])} ... />
//
// The viewport windows items around `selectedIndex` so lists longer than
// `maxVisibleItems` scroll without a nested scrollbox. Caller still handles
// arrow-key nav (increment/decrement + clamp selectedIndex); mouse move +
// click are wired internally.

import type { ReactNode } from "react";
import type { Theme } from "../theme";

interface ListPickerProps<T> {
  t: Theme;
  title?: string;
  items: readonly T[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  onConfirmIndex?: (index: number) => void;
  renderItem: (args: { item: T; index: number; absoluteIndex: number; selected: boolean }) => ReactNode;
  getKey: (item: T, absoluteIndex: number) => string;
  rowHeight?: number;
  maxVisibleItems?: number;
  minVisibleItems?: number;
  marginBottom?: number;
  emptyLabel?: string;
  countLabel?: (count: number) => string;
  bordered?: boolean;
}

export function ListPicker<T>({
  t,
  title,
  items,
  selectedIndex,
  onSelectIndex,
  onConfirmIndex,
  renderItem,
  getKey,
  rowHeight = 1,
  maxVisibleItems = 8,
  minVisibleItems = 1,
  marginBottom = 1,
  emptyLabel = "No matches.",
  countLabel = (count) => `${count} items`,
  bordered = true,
}: ListPickerProps<T>) {
  const boundedMinRows = Math.max(1, Math.min(minVisibleItems, maxVisibleItems));
  const visibleRows = Math.max(boundedMinRows, Math.min(items.length || boundedMinRows, maxVisibleItems));
  const safeSelectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, items.length - 1)));
  const maxStart = Math.max(0, items.length - visibleRows);
  const windowStart = items.length === 0 ? 0 : Math.max(0, Math.min(safeSelectedIndex - visibleRows + 1, maxStart));
  const renderedItems = items.slice(windowStart, windowStart + visibleRows);
  const headerHeight = title ? 1 : 0;
  const borderHeight = bordered ? 2 : 0;
  const bodyHeight = items.length === 0 ? rowHeight : visibleRows * rowHeight;

  return (
    <box
      width="100%"
      flexDirection="column"
      border={bordered}
      borderStyle={bordered ? "rounded" : undefined}
      borderColor={bordered ? t.border : undefined}
      backgroundColor={t.backgroundPanel}
      marginBottom={marginBottom}
      height={headerHeight + bodyHeight + borderHeight}
      overflow="hidden"
    >
      {title ? (
        <box flexDirection="row" height={1} paddingLeft={1} paddingRight={1}>
          <text fg={t.primary} wrapMode="none">
            <b>{title}</b>
          </text>
          <box flexGrow={1} />
          <text fg={t.textMuted} wrapMode="none">
            {countLabel(items.length)}
          </text>
        </box>
      ) : null}
      <box flexDirection="column" flexGrow={1}>
        {items.length === 0 ? (
          <box height={rowHeight} paddingLeft={1} paddingRight={1}>
            <text fg={t.textMuted}>{emptyLabel}</text>
          </box>
        ) : (
          renderedItems.map((item, index) => {
            const absoluteIndex = windowStart + index;
            return (
              <box
                key={getKey(item, absoluteIndex)}
                height={rowHeight}
                onMouseMove={() => onSelectIndex(absoluteIndex)}
                onMouseDown={() => {
                  onSelectIndex(absoluteIndex);
                  onConfirmIndex?.(absoluteIndex);
                }}
              >
                {renderItem({
                  item,
                  index,
                  absoluteIndex,
                  selected: absoluteIndex === safeSelectedIndex,
                })}
              </box>
            );
          })
        )}
      </box>
    </box>
  );
}
