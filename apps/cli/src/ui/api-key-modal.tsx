import type { TextareaRenderable } from "@opentui/core";
import type React from "react";
import { TEXTAREA_KEYBINDINGS } from "./modal-helpers";
import type { Theme } from "./theme";

interface ApiKeyModalProps {
  t: Theme;
  width: number;
  height: number;
  inputRef: React.RefObject<TextareaRenderable | null>;
  error: string | null;
  onSubmit: () => void;
}

export function ApiKeyModal({ t, width, height, inputRef, error, onSubmit }: ApiKeyModalProps) {
  const overlayBg = "#000000cc" as string;
  const panelWidth = Math.min(68, width - 6);
  const panelHeight = 13;
  const top = Math.max(2, Math.floor((height - panelHeight) / 2));

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
            <b>{"API key"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={t.text}>{"Paste your default provider API key. You can replace it anytime with /api-key."}</text>
        </box>
        <box paddingLeft={2} paddingRight={2} paddingTop={1}>
          <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1} width="100%">
            <textarea
              ref={inputRef}
              focused={true}
              placeholder="API key..."
              textColor={t.text}
              backgroundColor={t.backgroundElement}
              placeholderColor={t.textMuted}
              minHeight={1}
              maxHeight={3}
              wrapMode="word"
              keyBindings={TEXTAREA_KEYBINDINGS}
              onSubmit={onSubmit as unknown as () => void}
            />
          </box>
        </box>
        <box flexGrow={1} minHeight={0} />
        <box paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={1}>
          {error ? (
            <text fg={t.diffRemovedFg}>{error}</text>
          ) : (
            <text>
              <span style={{ fg: t.primary }}>{"enter "}</span>
              <span style={{ fg: t.textMuted }}>{"save key  ·  "}</span>
              <span style={{ fg: t.primary }}>{"esc "}</span>
              <span style={{ fg: t.textMuted }}>{"hide"}</span>
            </text>
          )}
        </box>
      </box>
    </box>
  );
}
