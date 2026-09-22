// Composer actions — handleSubmit and handlePaste extracted from app.tsx.
//
// This hook owns the two composer-action callbacks that AppInner previously
// defined inline:
//   • handleSubmit — composer Enter: queue dispatch, slash commands, shell
//     mode, model-readiness checks, mention expansion, and processMessage.
//   • handlePaste  — paste-event handling: file-drop detection, multi-line
//     paste-block creation, and clearing queue/agents focus on mutation.

import { decodePasteBytes, type PasteEvent } from "@opentui/core";
import { useCallback } from "react";
import type { Agent } from "../../agent/agent";
import { getHostServices as kernelGetHostServices } from "../../core/plugins";
import { extractFileDropPaths, getFileMentionToken, getPasteBlockToken, type PasteBlock } from "../app-helpers";
import { buildQueuedPreviewText } from "../components/claude-code-pending-messages.js";
import { useComposer } from "../context/composer-context.js";
import { useConversationState } from "../context/conversation-state-context.js";
import { useQueue } from "../context/queue-context.js";
import { useRunningAgents } from "../context/running-agents-context.js";
import { buildAssistantEntry } from "../telegram-turn-ui";
import { reserveQueuedSubmission } from "./queue-submissions.js";
import type { ProcessMessageOptions } from "./use-turn-engine.js";

type ProcessMessageFn = (text: string, displayText?: string, options?: ProcessMessageOptions) => Promise<void> | void;

export interface ComposerActionsOptions {
  dispatchQueueHead: () => boolean;
  dispatchQueueAt: (id?: string) => boolean;
  openAgentsPopup: () => void;
  openApiKeyModal: () => void;
  scrollToBottom: () => void;
  spawnInlineTerminal: (command: string) => void;
  activeModelAdapterId: string | null;
  activeModelCanRun: boolean;
}

export function useComposerActions(
  agent: Agent,
  processMessage: ProcessMessageFn,
  handleCommand: (message: string) => boolean,
  _dispatchExtensionCommand: (command: string) => void,
  options: ComposerActionsOptions,
) {
  const {
    dispatchQueueHead,
    dispatchQueueAt,
    openAgentsPopup,
    openApiKeyModal,
    scrollToBottom,
    spawnInlineTerminal,
    activeModelAdapterId,
    activeModelCanRun,
  } = options;

  const composer = useComposer();
  const { inputRef, commitComposer, promptHistory, replacePasteBlocks, insertDroppedFilePaths, fileMentionBlocksRef } =
    composer;

  const conv = useConversationState();
  const { setMessages, pasteBlocksRef, pasteCounterRef, shellModeRef, isProcessingRef } = conv;

  const queue = useQueue();
  const { queueFocusId, setQueueFocusId, queueFocusIdRef, queuedMessagesRef, setQueuedMessages, nextQueueIdRef } =
    queue;

  const agents = useRunningAgents();
  const { setAgentsFooterFocused, agentsFooterFocusedRef, showAgentsPopupRef, agentModalIdRef } = agents;

  const kernelServices = kernelGetHostServices();

  const handlePaste = useCallback(
    (event: PasteEvent) => {
      // Pasting into the composer while a queued message is focused → drop
      // focus. Mirrors the typing-exits-focus rule in handleKey: any visible
      // composer mutation should release the queue highlight so it doesn't
      // stick on a row the user has stopped navigating.
      if (queueFocusIdRef.current !== null) {
        setQueueFocusId(null);
      }
      // Same clear-on-mutation rule for the running-subagents footer focus.
      if (agentsFooterFocusedRef.current) {
        setAgentsFooterFocused(false);
      }

      const text = decodePasteBytes(event.bytes);
      const droppedPaths = extractFileDropPaths(text, agent.getCwd());
      if (insertDroppedFilePaths(droppedPaths)) {
        event.preventDefault();
        return;
      }
      const lineCount = text.split("\n").length;
      if (lineCount < 2) return;
      event.preventDefault();
      const id = ++pasteCounterRef.current;
      const block = {
        id,
        content: text,
        lines: lineCount,
      } satisfies PasteBlock;
      replacePasteBlocks([...pasteBlocksRef.current, block]);
      inputRef.current?.insertText(getPasteBlockToken(block));
    },
    [
      agent,
      insertDroppedFilePaths,
      replacePasteBlocks,
      setAgentsFooterFocused,
      agentsFooterFocusedRef.current,
      setQueueFocusId,
      queueFocusIdRef.current,
      pasteCounterRef,
      pasteBlocksRef.current,
      inputRef.current?.insertText,
    ],
  );

  const handleSubmit = useCallback(() => {
    // Running-subagents overlays own Enter while open. The popup/modal also
    // handle Enter in handleKey (with preventDefault), so this is the
    // belt-and-suspenders guard in case the textarea's onSubmit still fires:
    // never dispatch a message underneath an open overlay.
    if (agentModalIdRef.current !== null || showAgentsPopupRef.current) return;

    const raw = inputRef.current?.plainText || "";

    // Shell mode: route the buffer to a PTY-backed inline terminal session
    // instead of the AI model. Mode stays sticky across submissions (matches
    // claude-code UX) — user must hit esc/backspace on empty input to exit.
    if (shellModeRef.current && raw.trim()) {
      commitComposer();
      replacePasteBlocks([]);
      fileMentionBlocksRef.current = [];
      spawnInlineTerminal(raw.trim());
      return;
    }

    if (!raw.trim() && pasteBlocksRef.current.length === 0) {
      // Enter while the running-subagents footer is focused opens the popup
      // (mirrors the queue's ENTER-via-handleSubmit precedent — footer focus is
      // a lightweight focus state, not a capturing overlay).
      if (agentsFooterFocusedRef.current) {
        openAgentsPopup();
        return;
      }
      // Enter on an empty composer + queued messages + processing →
      // promote the head to "send now". If a queued message is focused
      // (Tier 3 navigation) dispatch THAT message out-of-order instead;
      // otherwise dispatch the head. Same shortcut as the ↑ key.
      // If the focused id has gone stale (e.g. the head shifted out from
      // under it during a chain transition), dispatchQueueAt returns false
      // and we fall through to dispatchQueueHead so Enter still does
      // something useful instead of silently no-oping.
      if (queueFocusId !== null) {
        if (!dispatchQueueAt(queueFocusId)) dispatchQueueHead();
      } else {
        dispatchQueueHead();
      }
      return;
    }
    commitComposer();
    let message = raw;
    const blocks = [...pasteBlocksRef.current];
    const fileBlocks = [...fileMentionBlocksRef.current];
    replacePasteBlocks([]);
    fileMentionBlocksRef.current = [];
    const previewDisplayText = buildQueuedPreviewText(raw, blocks, fileBlocks);
    for (const block of blocks) {
      message = message.replace(getPasteBlockToken(block), block.content);
    }
    const displayText = message.trim();
    for (const block of fileBlocks) {
      message = message.replace(getFileMentionToken(block), `@${block.path}`);
    }
    if (!message.trim()) return;
    // Record the replayable prompt for shell-style Up/Down recall: pasted
    // content inlined and file chips as canonical `@/abs/path` mentions. The
    // raw composer text only holds `[Pasted #n …]` / `[File: name]` tokens
    // whose backing blocks were just cleared, so recalling it would resubmit
    // the literal placeholders. Called after clear() so the in-memory cursor
    // resets to the new tail.
    promptHistory.record(message.trim());
    if (handleCommand(message)) return;
    if (!activeModelCanRun) {
      const provider = activeModelAdapterId ? kernelServices.models.getProvider(activeModelAdapterId) : undefined;
      if (!provider || provider.auth.mode === "api-key") {
        openApiKeyModal();
        return;
      }
      setMessages((prev) => [
        ...prev,
        buildAssistantEntry(
          `${provider.label} is not ready. Open /models, select the model again, and complete its auth flow.`,
        ),
      ]);
      return;
    }
    const messageForTurn = message.trim();
    const expandMentions = () =>
      // Prefer the shared codesurfd expander (consistent with the desktop
      // app); it falls back to the in-process expander if the daemon is
      // unreachable.
      kernelServices.mentions.expand(messageForTurn, agent.getCwd()).then(({ enhancedMessage }) => enhancedMessage);
    if (isProcessingRef.current) {
      // Reserve the id and the queue position NOW, in Enter order, and let the
      // expansion run while the current turn is still busy. Awaiting first
      // used to let the running turn drain an empty queue (stranding this
      // message with nothing left to dispatch it), let two overlapping
      // expansions land in completion order, and let a reset in between
      // insert into the replacement session's queue. Whoever drains the slot
      // forwards `prepareText` to processMessage, which awaits it under run
      // ownership (see queue-submissions.ts).
      reserveQueuedSubmission(
        { queuedMessagesRef, nextQueueIdRef },
        { text: messageForTurn, displayText: previewDisplayText, prepare: expandMentions },
      );
      setQueuedMessages([...queuedMessagesRef.current]);
      setTimeout(scrollToBottom, 10);
      return;
    }
    // The user bubble must render before asynchronous @-mention expansion or
    // a shared turn coordinator. `processMessage` records the display text
    // synchronously, then awaits this preparation function before the model
    // receives the richer prompt.
    processMessage(messageForTurn, displayText, { prepareText: expandMentions });
  }, [
    agent,
    activeModelAdapterId,
    activeModelCanRun,
    dispatchQueueHead,
    dispatchQueueAt,
    kernelServices,
    queueFocusId,
    handleCommand,
    openAgentsPopup,
    openApiKeyModal,
    processMessage,
    promptHistory,
    replacePasteBlocks,
    scrollToBottom,
    spawnInlineTerminal,
    commitComposer,
    showAgentsPopupRef.current,
    agentsFooterFocusedRef.current,
    agentModalIdRef.current,
    queuedMessagesRef,
    setQueuedMessages,
    nextQueueIdRef,
    pasteBlocksRef.current,
    setMessages,
    shellModeRef.current,
    isProcessingRef.current,
    inputRef.current?.plainText,
    fileMentionBlocksRef.current,
    fileMentionBlocksRef,
  ]);

  return { handleSubmit, handlePaste };
}
