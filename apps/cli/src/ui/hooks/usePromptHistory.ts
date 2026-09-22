// Shell-style Up/Down prompt recall for the TUI composer.
//
// Behavior matches zsh/bash history:
//   - Up    → recall the previous (older) entry; stashes current draft on
//             first recall so it can be restored on Down past the newest
//             entry.
//   - Down  → recall the next (newer) entry; returning past the newest
//             entry restores the stashed draft.
//   - Esc / any text edit → reset() clears the cursor back to "tail" (live
//             draft) without changing the current textarea text.
//   - record(text) → store a submitted prompt (called by handleSubmit after
//             clearing the composer). `text` must be the REPLAYABLE prompt:
//             pasted blocks inlined and file chips as `@/abs/path` mentions,
//             never the raw composer text. The raw text only holds
//             `[Pasted #n …]` / `[File: name]` placeholders whose backing
//             blocks are cleared on submit, so recalling it would resubmit the
//             literal placeholders instead of the content.
//
// Key-interception precedence (callers must check before calling recall*):
//   1. typeahead visible        → arrows belong to typeahead; do not call recall
//   2. slash menu open          → arrows belong to slash menu; do not call recall
//   3. BTW overlay active       → do not call recall
//   4. Up from the first line   → recallPrev(); otherwise let textarea handle
//   5. Down from the last line  → recallNext(); otherwise let textarea handle
//
// The hook is purely logic — it doesn't register any event listeners itself.
// Wiring happens in app.tsx's handleKey, keeping all input priorities in one
// place (see the INPUT PRIORITY CONTRACT comment near line 3175).

import type { TextareaRenderable } from "@opentui/core";
import { useCallback, useEffect, useRef } from "react";
import { loadPromptHistory, recordPrompt } from "../../storage/prompt-history";

export interface PromptHistoryHandle {
  /** Record a submitted prompt in its replayable form (paste blocks inlined,
   *  file chips as `@/abs/path`), so recalling and resubmitting it sends the
   *  same content. Call after clearing the composer. */
  record(text: string): void;
  /** Move one step back in history. Returns true if recall happened (caller
   *  should NOT let the textarea handle the Up key); false if already at the
   *  oldest entry or history is empty. */
  recallPrev(): boolean;
  /** Move one step forward in history. Returns true if recall happened; false
   *  if already past the newest entry (draft restored, Up key handled). */
  recallNext(): boolean;
  /** Reset the cursor to "tail" without touching the textarea. Call on Esc or
   *  when the user starts editing the recalled text. */
  reset(): void;
}

export function usePromptHistory(
  inputRef: React.RefObject<TextareaRenderable | null>,
  workspaceId: string | null | undefined,
): PromptHistoryHandle {
  // All state lives in refs so callbacks are stable (no re-render cycle).
  const entriesRef = useRef<string[]>([]);
  // cursor === entriesRef.current.length means "at tail" (live draft).
  const cursorRef = useRef<number>(-1); // -1 sentinel = not in recall mode
  const draftRef = useRef<string>("");

  // Load history once when workspaceId is first known.
  useEffect(() => {
    if (!workspaceId) return;
    const entries = loadPromptHistory(workspaceId, 200);
    entriesRef.current = entries;
    cursorRef.current = entries.length; // start at tail
  }, [workspaceId]);

  const record = useCallback(
    (text: string) => {
      if (!workspaceId || !text.trim()) return;
      // Consecutive-dedup is also enforced in the storage layer, but we mirror
      // it in-memory so the in-session entries are consistent immediately.
      const entries = entriesRef.current;
      if (entries.length > 0 && entries[entries.length - 1] === text) return;
      entries.push(text);
      recordPrompt({ workspaceId, text });
      // Reset cursor to new tail so the next Up goes to this entry.
      cursorRef.current = entries.length;
      draftRef.current = "";
    },
    [workspaceId],
  );

  const reset = useCallback(() => {
    cursorRef.current = entriesRef.current.length;
    draftRef.current = "";
  }, []);

  const recallPrev = useCallback((): boolean => {
    const entries = entriesRef.current;
    if (entries.length === 0) return false;

    const cursor = cursorRef.current;
    const tail = entries.length;

    // Already at the oldest entry — can't go further back.
    if (cursor === 0) return false;

    // First recall: stash the current draft so Down can restore it.
    if (cursor === tail) {
      draftRef.current = inputRef.current?.plainText ?? "";
    }

    const newCursor = cursor === -1 ? tail - 1 : cursor - 1;
    cursorRef.current = newCursor;
    const text = entries[newCursor] ?? "";
    if (inputRef.current) {
      inputRef.current.setText(text);
      inputRef.current.cursorOffset = text.length;
    }
    return true;
  }, [inputRef]);

  const recallNext = useCallback((): boolean => {
    const entries = entriesRef.current;
    const cursor = cursorRef.current;
    const tail = entries.length;

    // Not in recall mode — nothing to do.
    if (cursor === tail || cursor === -1) return false;

    const newCursor = cursor + 1;
    cursorRef.current = newCursor;

    if (newCursor === tail) {
      // Returned past the newest entry — restore the stashed draft.
      const draft = draftRef.current;
      if (inputRef.current) {
        inputRef.current.setText(draft);
        inputRef.current.cursorOffset = draft.length;
      }
      draftRef.current = "";
      return true;
    }

    const text = entries[newCursor] ?? "";
    if (inputRef.current) {
      inputRef.current.setText(text);
      inputRef.current.cursorOffset = text.length;
    }
    return true;
  }, [inputRef]);

  return { record, recallPrev, recallNext, reset };
}
