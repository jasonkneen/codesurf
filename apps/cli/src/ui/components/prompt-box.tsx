// Composer / prompt input box. Extracted from app.tsx so both session layouts
// can render it without importing the god file.
//
// The outer chrome (accent border in claude-code mode, shell-mode colored
// border, or plain) is owned by the parent layout wrapper; PromptBox renders
// only the textarea, its suggestion overlay, image preview, and (when not
// `flat`) the model/context/hints footer row.

import type { PasteEvent, TextareaRenderable } from "@opentui/core";
import type React from "react";
import { useIcon } from "../../core/plugins/icons";
import type { getModelInfo } from "../../grok/models";
import type { ContextStats } from "../app-helpers";
import type { TypeaheadState } from "../hooks/useTypeahead";
import { TEXTAREA_KEYBINDINGS } from "../modal-helpers.js";
import type { Theme } from "../theme";
import { SHELL_MODE_COLOR } from "../ui-constants";
import { ComposerImagePreview, useComposerImageHover } from "./composer-image-preview.js";
import { ContextMeter } from "./context-meter.js";
import { PluginStatusIndicators } from "./extension-status-indicators.js";
import { SuggestionOverlay } from "./SuggestionOverlay.js";

export function PromptBox({
  t,
  inputRef,
  isProcessing,
  shellMode = false,
  captureOpen,
  onSubmit,
  onPaste,
  pasteBlocks,
  model,
  modelInfo,
  contextStats,
  placeholder,
  queuedCount,
  typeahead,
  textareaWidth = 80,
  flat = false,
  hasTodos = false,
  onToggleTodoPanel,
}: {
  t: Theme;
  inputRef: React.RefObject<TextareaRenderable | null>;
  isProcessing: boolean;
  /** When true the textarea is in shell mode — caret turns pink, the
   *  placeholder reads "Run a shell command" and submitted text is dispatched
   *  to spawnInlineTerminal instead of the AI model. The outer chrome (border)
   *  is owned by the parent wrapper. */
  shellMode?: boolean;
  /** True when any modal/overlay owns the keyboard. Blurs the composer textarea
   *  so it can't eat keystrokes meant for the modal in front of it. Single
   *  source of truth computed in App (`captureOpen`). */
  captureOpen: boolean;
  onSubmit: () => void;
  onPaste: (event: PasteEvent) => void;
  pasteBlocks: { id: number; content: string; lines: number; isImage?: boolean }[];
  model: string;
  modelInfo: ReturnType<typeof getModelInfo>;
  contextStats?: ContextStats | null;
  placeholder?: string;
  queuedCount?: number;
  typeahead?: TypeaheadState;
  textareaWidth?: number;
  /** In claude-code UI mode the outer chrome (accent border) owns the
   *  framing, so the PromptBox itself drops its own backgrounds and the
   *  vertical padding that gave the textarea a "grey slab" look. The input
   *  starts at 1 line tall and still grows up to maxHeight as the user types. */
  flat?: boolean;
  /** When true, a right-justified todo-list icon renders at the end of the
   *  prompt line; clicking it calls onToggleTodoPanel. */
  hasTodos?: boolean;
  onToggleTodoPanel?: () => void;
}) {
  const _modelIcon = useIcon("model");
  const todoIcon = useIcon("todo") || "☰";
  const showSuggestions = typeahead?.visible ?? false;
  const imageHover = useComposerImageHover({ pasteBlocks, inputRef, textareaWidth });

  return (
    <box backgroundColor={flat ? undefined : t.backgroundPanel}>
      <box>
        {showSuggestions && typeahead && (
          <SuggestionOverlay
            t={t}
            suggestions={typeahead.suggestions}
            selectedIndex={typeahead.selectedIndex}
            mode={flat ? "claude-code" : "opencode"}
            title={flat ? "Commands" : undefined}
          />
        )}
        {flat ? (
          <ComposerImagePreview t={t} hoveredBlock={imageHover.hoveredBlock} imageBlocks={imageHover.imageBlocks} />
        ) : null}
        {flat ? (
          <box flexDirection="row" alignItems="flex-start" flexShrink={0} gap={1}>
            <text fg={t.textMuted} wrapMode="none">
              {"❯"}
            </text>
            <box flexGrow={1}>
              <textarea
                key={flat ? "claude" : "open"}
                ref={inputRef}
                focused={!captureOpen}
                placeholder={
                  shellMode
                    ? placeholder || "Run a shell command"
                    : isProcessing
                      ? "Queue a follow-up... (ctrl+x to stop)"
                      : placeholder || ""
                }
                textColor={shellMode ? SHELL_MODE_COLOR : t.text}
                focusedTextColor={shellMode ? SHELL_MODE_COLOR : t.text}
                backgroundColor={undefined}
                placeholderColor={shellMode ? SHELL_MODE_COLOR : t.textMuted}
                minHeight={1}
                maxHeight={10}
                wrapMode="word"
                keyBindings={TEXTAREA_KEYBINDINGS}
                onSubmit={onSubmit as unknown as () => void}
                onPaste={onPaste as unknown as (event: PasteEvent) => void}
                onContentChange={typeahead?.refresh}
                onCursorChange={typeahead?.refresh}
                onMouseMove={imageHover.handleTextareaMouseMove}
                onMouseOut={imageHover.clearHover}
              />
            </box>
            {hasTodos && onToggleTodoPanel ? (
              <text fg={t.accent} flexShrink={0} wrapMode="none" onMouseDown={onToggleTodoPanel}>
                {todoIcon}
              </text>
            ) : null}
          </box>
        ) : (
          <box
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={t.backgroundElement}
            flexDirection="row"
            gap={2}
            alignItems="flex-start"
            flexShrink={0}
          >
            <box flexGrow={1}>
              <textarea
                key={flat ? "claude" : "open"}
                ref={inputRef}
                focused={!captureOpen}
                placeholder={
                  shellMode
                    ? placeholder || "Run a shell command"
                    : isProcessing
                      ? "Queue a follow-up... (ctrl+x to stop)"
                      : placeholder || "Message Grok..."
                }
                textColor={shellMode ? SHELL_MODE_COLOR : t.text}
                focusedTextColor={shellMode ? SHELL_MODE_COLOR : t.text}
                backgroundColor={t.backgroundElement}
                placeholderColor={shellMode ? SHELL_MODE_COLOR : t.textMuted}
                minHeight={1}
                maxHeight={10}
                wrapMode="word"
                keyBindings={TEXTAREA_KEYBINDINGS}
                onSubmit={onSubmit as unknown as () => void}
                onPaste={onPaste as unknown as (event: PasteEvent) => void}
                onContentChange={typeahead?.refresh}
                onCursorChange={typeahead?.refresh}
              />
            </box>
          </box>
        )}
      </box>
      {!flat && (
        <box
          flexDirection="row"
          justifyContent="space-between"
          alignItems="center"
          paddingLeft={2}
          paddingRight={2}
          height={1}
          flexShrink={0}
        >
          <box flexDirection="row" gap={1} alignItems="center" height={1}>
            <text fg={t.text}>{modelInfo?.name || model}</text>
            {contextStats ? <ContextMeter t={t} stats={contextStats} /> : null}
            <PluginStatusIndicators />
          </box>
          <box flexDirection="row" gap={1} alignItems="center" height={1}>
            {isProcessing ? (
              <box flexDirection="row" gap={1}>
                <text fg={t.text}>
                  {"enter "}
                  <span style={{ fg: t.textMuted }}>{"queue"}</span>
                </text>
                <text fg={t.text}>
                  {"esc "}
                  <span style={{ fg: t.textMuted }}>{(queuedCount ?? 0) > 0 ? "clear queue" : "interrupt"}</span>
                </text>
              </box>
            ) : showSuggestions ? (
              <box flexDirection="row" gap={1}>
                <text fg={t.text}>
                  {"tab "}
                  <span style={{ fg: t.textMuted }}>{"accept"}</span>
                </text>
                <text fg={t.text}>
                  {"↑↓ "}
                  <span style={{ fg: t.textMuted }}>{"navigate"}</span>
                </text>
                <text fg={t.text}>
                  {"esc "}
                  <span style={{ fg: t.textMuted }}>{"dismiss"}</span>
                </text>
              </box>
            ) : (
              <>
                <text fg={t.text}>
                  {"@ "}
                  <span style={{ fg: t.textMuted }}>{"files"}</span>
                </text>
                <text fg={t.text}>
                  {"shift+enter "}
                  <span style={{ fg: t.textMuted }}>{"new line"}</span>
                </text>
                <text fg={t.text}>
                  {"shift+tab "}
                  <span style={{ fg: t.textMuted }}>{"mode"}</span>
                </text>
              </>
            )}
          </box>
        </box>
      )}
    </box>
  );
}
