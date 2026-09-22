// TextEditor — inline/popup textarea with dirty tracking, save/reset pills,
// and line+char meta. Ported from termcast's text-editor.tsx.
//
// Termcast used a surface-focus coordinator (useFocusTarget / requestSurface-
// Focus) to hand focus between editor + chat input without wrestling with
// browser-style focus semantics. Codesurf doesn't have that abstraction yet,
// so this port uses the OpenTUI `<textarea>`'s native `focused` flag driven
// by a local useState. Click the bordered box to start editing; save/reset
// buttons don't auto-return focus to the chat input (caller can pass an
// `onBlur` to plumb that in when it matters).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Theme } from "../theme";
import { AgentPanel, PanelPill } from "./panel-frame";

interface TextareaHandle {
  plainText?: string;
  clear?: () => void;
  focus?: () => void;
  setText?: (text: string) => void;
}

export interface TextEditorProps {
  t: Theme;
  title?: string;
  path?: string;
  initialContent: string;
  placeholder?: string;
  mode?: "inline" | "popup";
  compact?: boolean;
  readOnly?: boolean;
  editorHeight?: number;
  saveLabel?: string;
  resetLabel?: string;
  onRequestPopup?: () => void;
  onRequestInline?: () => void;
  onSave?: (content: string) => boolean | undefined;
  onReset?: (content: string) => void;
  /** Fires after save/reset so the caller can route focus back elsewhere. */
  onBlur?: () => void;
}

function lineCountOf(content: string): number {
  if (!content) return 1;
  return content.split("\n").length;
}

export function TextEditor({
  t,
  title = "text editor",
  path,
  initialContent,
  placeholder = "Type here…",
  mode = "inline",
  compact = false,
  readOnly = false,
  editorHeight = 12,
  saveLabel = "Save",
  resetLabel = "Reset",
  onRequestPopup,
  onRequestInline,
  onSave,
  onReset,
  onBlur,
}: TextEditorProps) {
  const textareaRef = useRef<TextareaHandle | null>(null);
  const [content, setContent] = useState(initialContent);
  const [savedContent, setSavedContent] = useState(initialContent);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editorFocused, setEditorFocused] = useState(false);

  useEffect(() => {
    setContent(initialContent);
    setSavedContent(initialContent);
    setSaveError(null);
    textareaRef.current?.setText?.(initialContent);
  }, [initialContent]);

  const dirty = content !== savedContent;
  const lineCount = useMemo(() => lineCountOf(content), [content]);
  const charCount = content.length;
  const effectiveHeight = Math.max(4, editorHeight);

  const focusEditor = useCallback(() => {
    if (readOnly) return;
    setEditorFocused(true);
    setTimeout(() => textareaRef.current?.focus?.(), 0);
  }, [readOnly]);

  const releaseFocus = useCallback(() => {
    setEditorFocused(false);
    onBlur?.();
  }, [onBlur]);

  const handleChange = useCallback(() => {
    setSaveError(null);
    setContent(textareaRef.current?.plainText ?? "");
  }, []);

  const handleSave = useCallback(() => {
    if (readOnly) return;
    const nextContent = textareaRef.current?.plainText ?? content;
    try {
      const saveResult = onSave?.(nextContent);
      if (saveResult === false) return;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      return;
    }
    setSaveError(null);
    setContent(nextContent);
    setSavedContent(nextContent);
    releaseFocus();
  }, [content, onSave, readOnly, releaseFocus]);

  const handleReset = useCallback(() => {
    const resetContent = savedContent;
    setSaveError(null);
    setContent(resetContent);
    textareaRef.current?.setText?.(resetContent);
    onReset?.(resetContent);
    releaseFocus();
  }, [onReset, releaseFocus, savedContent]);

  const body = (
    <box flexDirection="column">
      <box flexDirection="row" height={1}>
        <text fg={t.text} wrapMode="none">
          <b>{title}</b>
        </text>
        {path && (
          <text fg={t.textMuted} wrapMode="none">
            {`  ${path}`}
          </text>
        )}
        <box flexGrow={1} />
        <text fg={dirty ? t.accent : t.diffAddedFg} wrapMode="none">
          <b>{dirty ? "dirty" : "saved"}</b>
        </text>
      </box>
      <box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
        {!readOnly && (
          <PanelPill
            t={t}
            label={dirty ? `${saveLabel}*` : saveLabel}
            fg={t.background}
            bg={t.diffAddedFg}
            bold
            onSelect={handleSave}
          />
        )}
        {!readOnly && <PanelPill t={t} label={resetLabel} onSelect={handleReset} />}
        {!readOnly && <PanelPill t={t} label="Focus" onSelect={focusEditor} />}
        {mode === "inline" && onRequestPopup && <PanelPill t={t} label="Popup" onSelect={onRequestPopup} />}
        {mode === "popup" && onRequestInline && <PanelPill t={t} label="Inline" onSelect={onRequestInline} />}
        {path && <PanelPill t={t} label={path} fg={t.textMuted} />}
      </box>
      <box
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={editorFocused ? t.accent : t.border}
        marginTop={1}
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={focusEditor}
      >
        <textarea
          // biome-ignore lint/suspicious/noExplicitAny: OpenTUI's textarea ref has a nominal type we don't expose.
          ref={textareaRef as any}
          initialValue={initialContent}
          height={effectiveHeight}
          flexGrow={1}
          wrapMode="word"
          placeholder={placeholder}
          focused={editorFocused && !readOnly}
          onContentChange={handleChange}
        />
      </box>
      <box flexDirection="row" marginTop={1}>
        <text fg={t.textMuted}>{`${lineCount} line${lineCount === 1 ? "" : "s"}  ${charCount} chars`}</text>
        <box flexGrow={1} />
        <text fg={saveError ? t.diffRemovedFg : t.textMuted}>
          {saveError ? saveError : readOnly ? "read only" : "click editor to type  ·  save/reset releases focus"}
        </text>
      </box>
    </box>
  );

  if (compact) return body;

  return (
    <AgentPanel
      t={t}
      title="text editor"
      meta={path}
      statusLabel={dirty ? "dirty" : "saved"}
      statusColor={dirty ? t.accent : t.diffAddedFg}
    >
      {body}
    </AgentPanel>
  );
}

export function makeExampleTextEditor(): Omit<TextEditorProps, "t"> {
  return {
    title: "notes.md",
    path: "docs/notes.md",
    initialContent: [
      "# Notes",
      "",
      "- tighten popup focus handoff",
      "- add inline image and editor surfaces",
      "- keep terminal sessions interactive",
    ].join("\n"),
  };
}
