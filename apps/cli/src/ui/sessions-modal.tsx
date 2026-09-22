import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { SessionInfo } from "../types/index";
import { truncate } from "../utils/text";
import type { Theme } from "./theme";

function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

export interface SessionsRow {
  session: SessionInfo;
  isActive: boolean;
}

export function buildSessionsRows(
  sessions: SessionInfo[],
  currentSessionId: string | null,
  query: string,
): SessionsRow[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? sessions.filter(
        (s) =>
          s.id.toLowerCase().includes(q) ||
          (s.title?.toLowerCase().includes(q) ?? false) ||
          s.model.toLowerCase().includes(q) ||
          s.mode.toLowerCase().includes(q),
      )
    : sessions;
  return filtered.map((session) => ({
    session,
    isActive: session.id === currentSessionId,
  }));
}

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function SessionsBrowserModal({
  t,
  width,
  height,
  selectedIndex,
  searchQuery,
  rows,
  scope = "local",
}: {
  t: Theme;
  width: number;
  height: number;
  selectedIndex: number;
  searchQuery: string;
  rows: SessionsRow[];
  scope?: "local" | "global";
}) {
  const listRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    const selected = rows[selectedIndex];
    if (!selected) return;
    listRef.current?.scrollChildIntoView(`session-${selected.session.id}`);
  }, [rows, selectedIndex]);

  const itemCount = Math.max(rows.length, 1);
  const contentHeight = itemCount * 2 + 7;
  const maxHeight = Math.floor(height * 0.68);
  const panelHeight = Math.min(contentHeight, maxHeight);
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
        width={Math.min(96, width - 4)}
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
            <b>{"Sessions"}</b>
            <span style={{ fg: t.textMuted }}>{"  · "}</span>
            <span style={{ fg: scope === "global" ? t.diffAddedFg : t.text }}>
              {scope === "global" ? "global" : "local"}
            </span>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={t.text}>{searchQuery || <span style={{ fg: t.textMuted }}>{"Search sessions..."}</span>}</text>
        </box>
        <scrollbox ref={listRef} flexGrow={1} minHeight={0}>
          {rows.length === 0 ? (
            <box paddingLeft={2} paddingRight={2}>
              <text fg={t.textMuted}>
                {searchQuery ? "No sessions match your search." : "No saved sessions in this workspace yet."}
              </text>
            </box>
          ) : (
            rows.map((row, idx) => {
              const selected = idx === selectedIndex;
              const { session, isActive } = row;
              const title = session.title?.trim() || "Untitled session";
              const primaryColor = isActive ? t.diffAddedFg : selected ? t.selected : t.text;
              return (
                <box
                  key={`session-${session.id}`}
                  id={`session-${session.id}`}
                  backgroundColor={selected ? t.selectedBg : undefined}
                  paddingLeft={2}
                  paddingRight={2}
                >
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={primaryColor}>
                      {isActive ? "● " : "  "}
                      {truncate(title, 70)}
                    </text>
                    <text fg={t.textMuted}>{formatRelativeTime(session.updatedAt)}</text>
                  </box>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={t.textMuted}>
                      {session.id.slice(0, 8)}
                      {"  ·  "}
                      {session.model}
                      {"  ·  "}
                      {session.mode}
                    </text>
                    <text fg={t.textMuted}>{truncate(session.cwdLast, 40)}</text>
                  </box>
                </box>
              );
            })
          )}
        </scrollbox>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={1}>
          <text>
            <span style={{ fg: t.primary }}>{"enter "}</span>
            <span style={{ fg: t.textMuted }}>{"resume  ·  "}</span>
            <span style={{ fg: t.primary }}>{"tab "}</span>
            <span style={{ fg: t.textMuted }}>{"toggle scope  ·  "}</span>
            <span style={{ fg: t.primary }}>{"ctrl+x "}</span>
            <span style={{ fg: t.textMuted }}>{"delete  ·  "}</span>
            <span style={{ fg: t.primary }}>{"esc "}</span>
            <span style={{ fg: t.textMuted }}>{"close"}</span>
          </text>
        </box>
      </box>
    </box>
  );
}
