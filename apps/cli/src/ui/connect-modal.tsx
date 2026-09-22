import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { Theme } from "./theme";

interface ConnectModalProps {
  t: Theme;
  width: number;
  height: number;
  selectedIndex: number;
  channels: { id: string; label: string; description: string }[];
}

export function ConnectModal({ t, width, height, selectedIndex, channels }: ConnectModalProps) {
  const listRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    const ch = channels[selectedIndex];
    if (ch) listRef.current?.scrollChildIntoView(`connect-${ch.id}`);
  }, [selectedIndex, channels]);

  const panelHeight = Math.min(channels.length + 9, Math.floor(height * 0.5));
  const top = Math.max(2, Math.floor((height - panelHeight) / 2));
  const overlayBg = "#000000cc" as string;

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={top}
      backgroundColor={overlayBg}
    >
      <box
        width={Math.min(56, width - 6)}
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
            <b>{"Connect"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={t.textMuted}>{"Choose a channel"}</text>
        </box>
        <scrollbox ref={listRef} flexGrow={1} minHeight={0}>
          {channels.map((ch, idx) => (
            <box
              key={ch.id}
              id={`connect-${ch.id}`}
              backgroundColor={idx === selectedIndex ? t.selectedBg : undefined}
              paddingLeft={2}
              paddingRight={2}
            >
              <box flexDirection="row" justifyContent="space-between">
                <text fg={idx === selectedIndex ? t.selected : t.text}>{ch.label}</text>
                <text fg={t.textMuted}>{ch.description}</text>
              </box>
            </box>
          ))}
        </scrollbox>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={1}>
          <text>
            <span style={{ fg: t.primary }}>{"enter "}</span>
            <span style={{ fg: t.textMuted }}>{"select  ·  "}</span>
            <span style={{ fg: t.primary }}>{"↑↓ "}</span>
            <span style={{ fg: t.textMuted }}>{"navigate  ·  "}</span>
            <span style={{ fg: t.primary }}>{"esc "}</span>
            <span style={{ fg: t.textMuted }}>{"close"}</span>
          </text>
        </box>
      </box>
    </box>
  );
}
