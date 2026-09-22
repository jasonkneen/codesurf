import type { TextareaRenderable } from "@opentui/core";
import { type RefObject, useEffect } from "react";
import type { Theme } from "./theme";

const EDITOR_KEYBINDINGS = [{ name: "return", action: "submit" as const }];

function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

export interface ProviderAuthModalProps {
  t: Theme;
  width: number;
  height: number;
  /** Adapter being configured (e.g. "anthropic.api-key"). */
  adapterId: string;
  /** Human-readable adapter title shown in the header. */
  title: string;
  /** Optional subtitle (e.g. "Required for Claude models"). */
  subtitle?: string;
  /** Hint from the adapter's credentialCheck — what's missing and why. */
  reason?: string;
  /** Env var name to show as a tip (e.g. "ANTHROPIC_API_KEY"). */
  envVarHint?: string;
  /** Forced re-sync when the value is cleared/replaced programmatically. */
  syncKey: number;
  /** Last submission error, if any. */
  error: string | null;
  /** Ref for the textarea so app.tsx can call `.plainText` on submit. */
  inputRef: RefObject<TextareaRenderable | null>;
  onSubmit: () => void;
}

export function ProviderAuthModal({
  t,
  width,
  height,
  title,
  subtitle,
  reason,
  envVarHint,
  syncKey,
  error,
  inputRef,
  onSubmit,
}: ProviderAuthModalProps) {
  const panelHeight = Math.min(16, Math.floor(height * 0.55));
  const overlayBg = "#000000cc" as string;

  // Force-clear the textarea whenever the caller bumps syncKey so re-opening
  // the modal never leaves stale input around.
  // biome-ignore lint/correctness/useExhaustiveDependencies: syncKey is an intentional cache-bust
  useEffect(() => {
    inputRef.current?.clear();
  }, [syncKey, inputRef]);

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
        width={Math.min(76, width - 6)}
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
            <b>{`Configure ${title}`}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>

        {subtitle ? (
          <box flexShrink={0} paddingLeft={2} paddingRight={2}>
            <text fg={t.textMuted}>{subtitle}</text>
          </box>
        ) : null}

        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={t.text}>{reason ?? "Paste your API key to enable this provider."}</text>
        </box>

        <box flexShrink={0} paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>{"API key"}</text>
          <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1}>
            <textarea
              ref={inputRef}
              focused={true}
              placeholder={envVarHint ? `or set ${envVarHint}` : "sk-..."}
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

        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          {error ? (
            <text fg={t.diffRemovedFg}>{error}</text>
          ) : (
            <text>
              <span style={{ fg: t.primary }}>{"enter "}</span>
              <span style={{ fg: t.textMuted }}>{"save  \u00b7  "}</span>
              <span style={{ fg: t.primary }}>{"esc "}</span>
              <span style={{ fg: t.textMuted }}>{"cancel"}</span>
            </text>
          )}
        </box>
      </box>
    </box>
  );
}
