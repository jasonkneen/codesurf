// Composer key handling — extracted from app.tsx handleKey.
//
// This hook owns the composer-layer keyboard logic that runs AFTER all modal
// early-return guards have passed:
//   1. Shell mode: esc/backspace on empty input exits, `!` on empty enters
//   2. Ctrl+X: abort active run
//   3. Esc: dismiss active overlay
//   4. Ctrl+E: toggle expanded messages
//   5. Ctrl+Shift+C / Ctrl+Y / Cmd+C / Ctrl+C: copy / clear / exit
//   6. Typeahead: up/down/tab/enter/esc navigation
//   7. Prompt history: up/down recall
//   8. Queue focus: up/down/esc navigation
//   9. Agents footer focus: up/down/esc navigation
//  10. Shift+Tab: cycle mode

import type { KeyEvent } from "@opentui/core";
import { useCallback } from "react";
import type { Agent } from "../../agent/agent";
import { useBtw } from "../context/btw-context.js";
import { useComposer } from "../context/composer-context.js";
import { useConversationState } from "../context/conversation-state-context.js";
import { useModalVisibility } from "../context/modal-context.js";
import { useQueue } from "../context/queue-context.js";
import { useRunningAgents } from "../context/running-agents-context.js";

function isEscapeKey(key: KeyEvent): boolean {
  return (
    key.name === "escape" ||
    key.code === "Escape" ||
    key.baseCode === 27 ||
    key.sequence === "\u001b" ||
    key.raw === "\u001b"
  );
}

export interface UseComposerKeysParams {
  agent: Agent;
  handleExit: () => void;
  abortActiveRun: (key?: KeyEvent) => boolean;
  dismissActiveOverlay: (key?: KeyEvent) => boolean;
  dispatchQueueHead: () => boolean;
  cycleMode: (direction: 1 | -1) => void;
  copyTuiSelectionToHost: () => boolean;
}

export function useComposerKeys(params: UseComposerKeysParams) {
  const { handleExit, abortActiveRun, dismissActiveOverlay, dispatchQueueHead, cycleMode, copyTuiSelectionToHost } =
    params;

  const { shellModeRef, setShellMode, isProcessing, messages, setExpandedMessages, pasteBlocksRef } =
    useConversationState();

  const { inputRef, commitComposer, replacePasteBlocks, typeaheadRef, promptHistoryRef } = useComposer();

  const { queuedMessagesRef, queueFocusId, setQueueFocusId } = useQueue();

  const { agentsFooterFocusedRef, setAgentsFooterFocused, runningAgentRowsRef } = useRunningAgents();

  const { btwStateRef } = useBtw();

  const { showSlashMenu } = useModalVisibility();

  return useCallback(
    (key: KeyEvent) => {
      // Shell mode: esc on empty input exits shell mode WITHOUT aborting any
      // active agent run. Must come BEFORE the interruptActiveRun branch below
      // — otherwise esc would fire the interrupt path instead of toggling off
      // shell mode.
      if (shellModeRef.current && isEscapeKey(key)) {
        const text = inputRef.current?.plainText || "";
        if (!text.trim()) {
          setShellMode(false);
          shellModeRef.current = false;
          key.preventDefault?.();
          key.stopPropagation?.();
          return;
        }
      }

      // Shell mode: backspace on empty input exits shell mode (mirrors the
      // claude-code UX where deleting the last char of an empty buffer cancels
      // the mode toggle).
      if (shellModeRef.current && (key.name === "backspace" || key.name === "delete")) {
        const text = inputRef.current?.plainText || "";
        if (!text.trim()) {
          setShellMode(false);
          shellModeRef.current = false;
          key.preventDefault?.();
          key.stopPropagation?.();
          return;
        }
      }

      // Ctrl+X stops the active agent run. Esc no longer aborts — it only
      // closes dialogs. Placed after all modal branches so this is a global
      // gesture that won't fire while a modal owns Ctrl+X.
      if (key.name === "x" && key.ctrl && abortActiveRun(key)) {
        return;
      }

      if (isEscapeKey(key) && dismissActiveOverlay(key)) {
        return;
      }

      // Shell mode trigger: `!` on empty input enters shell mode and swallows
      // the keystroke so the textarea doesn't insert a literal `!`.
      if (key.sequence === "!" && !isProcessing && !shellModeRef.current) {
        const text = inputRef.current?.plainText || "";
        if (!text.trim()) {
          setShellMode(true);
          shellModeRef.current = true;
          key.preventDefault?.();
          key.stopPropagation?.();
          return;
        }
      }

      // / is now handled by inputRouter.handleKey() (always available, even during turns)

      if (key.name === "e" && key.ctrl) {
        let lastUserIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]!.type === "user") {
            lastUserIdx = i;
            break;
          }
        }
        if (lastUserIdx >= 0) {
          setExpandedMessages((prev) => {
            const next = new Set(prev);
            if (next.has(lastUserIdx)) next.delete(lastUserIdx);
            else next.add(lastUserIdx);
            return next;
          });
        }
        return;
      }
      if (key.name === "c" && key.ctrl && key.shift) {
        if (copyTuiSelectionToHost()) {
          key.preventDefault();
          key.stopPropagation();
        }
        return;
      }
      // Ctrl+K is now handled by inputRouter.handleKey() above.
      if (key.name === "y" && key.ctrl && copyTuiSelectionToHost()) {
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      // Cmd+C: Kitty / iTerm report Command as `super`; some setups use `meta` instead.
      if (key.name === "c" && !key.ctrl && (key.meta || key.super)) {
        if (copyTuiSelectionToHost()) {
          key.preventDefault();
          key.stopPropagation();
          return;
        }
      }
      if (key.name === "c" && key.ctrl) {
        if (copyTuiSelectionToHost()) {
          key.preventDefault();
          key.stopPropagation();
          return;
        }
        const text = inputRef.current?.plainText || "";
        if (text.trim()) {
          commitComposer();
          replacePasteBlocks([]);
        } else {
          handleExit();
        }
        return;
      }
      if (typeaheadRef.current.visible) {
        if (key.name === "up") {
          typeaheadRef.current.navigateUp();
          return;
        }
        if (key.name === "down") {
          typeaheadRef.current.navigateDown();
          return;
        }
        if (key.name === "tab" || key.name === "return") {
          key.preventDefault();
          key.stopPropagation();
          typeaheadRef.current.accept();
          return;
        }
        if (isEscapeKey(key)) {
          typeaheadRef.current.dismiss();
          return;
        }
      }
      // Shell-style history recall: Up on the first cursor line goes back in
      // history; Down on the last line goes forward. Guards:
      //   - typeahead/BTW/slash menu/modals already handled above
      //   - not in shell mode (PTY owns arrows)
      //   - history must have entries
      //   - queued follow-ups are not waiting for up navigation/send-now
      // Any non-navigation keystroke (printable char) calls reset() to clear
      // the history cursor (standard bash/zsh behavior).
      if (
        !shellModeRef.current &&
        (key.name === "up" || key.name === "down") &&
        !key.ctrl &&
        !key.meta &&
        !showSlashMenu &&
        !btwStateRef.current &&
        queuedMessagesRef.current.length === 0 &&
        queueFocusId === null
      ) {
        const ta = inputRef.current;
        if (ta) {
          const logicalRow = ta.logicalCursor.row;
          const totalLines = ta.lineCount;
          if (key.name === "up" && logicalRow === 0) {
            const recalled = promptHistoryRef.current.recallPrev();
            if (recalled) {
              key.preventDefault?.();
              key.stopPropagation?.();
              return;
            }
          } else if (key.name === "down" && logicalRow === totalLines - 1) {
            const recalled = promptHistoryRef.current.recallNext();
            if (recalled) {
              key.preventDefault?.();
              key.stopPropagation?.();
              return;
            }
          }
        }
      }
      // Any printable key while in history recall mode resets the cursor.
      if (
        key.sequence &&
        key.sequence.length === 1 &&
        !key.ctrl &&
        !key.meta &&
        key.name !== "up" &&
        key.name !== "down" &&
        key.name !== "return" &&
        !isEscapeKey(key)
      ) {
        promptHistoryRef.current.reset();
        // Fall through — let the input receive the character normally.
      }

      // Up/Down/Esc on an empty composer drive queue focus-mode navigation. The
      // composer must be empty (no text, no pasted blocks) so this never
      // fights real cursor navigation in textareas. Behaviour:
      //
      //   Up + queue.length === 1 + not focused -> dispatch head ("send now",
      //                                          preserves Tier 2 shortcut)
      //   Up + queue.length  > 1 + not focused -> enter focus mode at tail
      //                                          (most recently queued msg)
      //   Up + already focused                 -> walk toward the head
      //   Down + already focused               -> walk toward the tail; falling
      //                                          off the end exits focus mode
      //   Esc + focused                        -> exit focus mode (does NOT
      //                                          interrupt the active run —
      //                                          Esc-to-interrupt only fires
      //                                          when the composer is fully
      //                                          empty AND no focus is held)
      //
      // Falls through to textarea cursor navigation if the gate doesn't match.
      const composerIsEmpty =
        !shellModeRef.current && !(inputRef.current?.plainText || "").trim() && pasteBlocksRef.current.length === 0;

      // Typing into the composer while focus is held -> drop focus so the
      // highlight doesn't stick on a row the user has visibly stopped
      // navigating. Detected via a printable single-char key.sequence with
      // no modifier; navigation keys (up/down/escape/enter) are exempt
      // because they're the focus controls themselves.
      if (
        queueFocusId !== null &&
        key.sequence &&
        key.sequence.length === 1 &&
        !key.ctrl &&
        !key.meta &&
        key.name !== "up" &&
        key.name !== "down" &&
        key.name !== "return" &&
        !isEscapeKey(key)
      ) {
        setQueueFocusId(null);
        // Fall through — let the input receive the character normally.
      }

      // Same clear-on-mutation rule for the running-subagents footer focus: any
      // printable keystroke releases the footer highlight back to the composer.
      if (
        agentsFooterFocusedRef.current &&
        key.sequence &&
        key.sequence.length === 1 &&
        !key.ctrl &&
        !key.meta &&
        key.name !== "up" &&
        key.name !== "down" &&
        key.name !== "return" &&
        !isEscapeKey(key)
      ) {
        setAgentsFooterFocused(false);
        // Fall through — let the input receive the character normally.
      }

      // Footer focus navigation (mirrors the queue-focus controls). UP or Esc
      // releases focus back to the composer; DOWN is swallowed (already at the
      // footer). Placed BEFORE the queue UP branch so UP-from-footer doesn't fall
      // through and jump into the queue.
      if (agentsFooterFocusedRef.current && composerIsEmpty) {
        if (key.name === "up" || isEscapeKey(key)) {
          setAgentsFooterFocused(false);
          key.preventDefault?.();
          key.stopPropagation?.();
          return;
        }
        if (key.name === "down") {
          key.preventDefault?.();
          key.stopPropagation?.();
          return;
        }
      }

      if (key.name === "up" && composerIsEmpty) {
        const queue = queuedMessagesRef.current;
        if (queueFocusId !== null) {
          const idx = queue.findIndex((m) => m.id === queueFocusId);
          if (idx > 0) setQueueFocusId(queue[idx - 1].id);
          key.preventDefault?.();
          key.stopPropagation?.();
          return;
        }
        if (queue.length === 1) {
          if (dispatchQueueHead()) {
            key.preventDefault?.();
            key.stopPropagation?.();
            return;
          }
        } else if (queue.length > 1) {
          setQueueFocusId(queue[queue.length - 1].id);
          key.preventDefault?.();
          key.stopPropagation?.();
          return;
        }
      }
      if (key.name === "down" && composerIsEmpty && queueFocusId !== null) {
        const queue = queuedMessagesRef.current;
        const idx = queue.findIndex((m) => m.id === queueFocusId);
        if (idx === -1 || idx === queue.length - 1) {
          setQueueFocusId(null);
        } else {
          setQueueFocusId(queue[idx + 1].id);
        }
        key.preventDefault?.();
        key.stopPropagation?.();
        return;
      }
      // DOWN from an empty composer with no queue focus moves focus to the
      // running-subagents footer (when any agents are running). Mutually
      // exclusive with the queue DOWN branch above (which requires queue focus).
      if (
        key.name === "down" &&
        composerIsEmpty &&
        queueFocusId === null &&
        !agentsFooterFocusedRef.current &&
        runningAgentRowsRef.current.length > 0
      ) {
        setAgentsFooterFocused(true);
        key.preventDefault?.();
        key.stopPropagation?.();
        return;
      }
      // Defensive redundancy: in the normal data path the prependInputHandler
      // above returns true for Esc-while-focused, which short-circuits opentui's
      // dispatch before processParsedKey runs — so this branch is unreachable.
      // Kept as a safety net (idempotent: setQueueFocusId(null) is a no-op when
      // focus is already cleared) in case the dispatch order ever changes.
      if (isEscapeKey(key) && composerIsEmpty && queueFocusId !== null) {
        setQueueFocusId(null);
        key.preventDefault?.();
        key.stopPropagation?.();
        return;
      }
      if (key.name === "tab" && key.shift && !shellModeRef.current) {
        cycleMode(1);
        key.preventDefault?.();
        key.stopPropagation?.();
        return;
      }
    },
    [
      abortActiveRun,
      dismissActiveOverlay,
      copyTuiSelectionToHost,
      handleExit,
      dispatchQueueHead,
      cycleMode,
      isProcessing,
      messages,
      showSlashMenu,
      queueFocusId,
      setShellMode,
      setExpandedMessages,
      setQueueFocusId,
      setAgentsFooterFocused,
      commitComposer,
      replacePasteBlocks,
      shellModeRef,
      inputRef,
      typeaheadRef,
      promptHistoryRef,
      pasteBlocksRef,
      btwStateRef,
      queuedMessagesRef,
      agentsFooterFocusedRef,
      runningAgentRowsRef,
    ],
  );
}
