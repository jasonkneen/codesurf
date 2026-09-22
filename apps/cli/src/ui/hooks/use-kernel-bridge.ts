// Kernel sink wiring — binds the extension kernel's host services to this
// app instance (moved verbatim out of app.tsx).
//
// Command extensions (e.g. workflow-prompts, /loop) call
// services.chat.dispatch / services.chat.appendAssistant /
// services.workspace.cwd at handler-invocation time, so every sink reads
// through a ref or closure to stay current. The effect tears all sinks down
// on unmount so a remount never leaves stale closures bound in the kernel.

import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { type RefObject, useEffect } from "react";
import type { Agent } from "../../agent/agent";
import {
  type ChatDispatchOptions,
  type ContextBreakdown,
  type ContextStats,
  type HostAction,
  type HostToast,
  setActiveModelAdapterIdProvider as kernelSetActiveModelAdapterIdProvider,
  setAssistantSink as kernelSetAssistantSink,
  setChatSink as kernelSetChatSink,
  setContextBreakdownProvider as kernelSetContextBreakdownProvider,
  setContextCompactProvider as kernelSetContextCompactProvider,
  setContextStatsProvider as kernelSetContextStatsProvider,
  setCwdProvider as kernelSetCwdProvider,
  setInputSink as kernelSetInputSink,
  setKeyboardHookProvider as kernelSetKeyboardHookProvider,
  setSessionIdProvider as kernelSetSessionIdProvider,
  setSessionReconnectProvider as kernelSetSessionReconnectProvider,
  setToastSink as kernelSetToastSink,
  setUiActionSink as kernelSetUiActionSink,
} from "../../core/plugins";

export interface QueuedMessage {
  id: string;
  text: string;
  displayText: string;
}

export interface KernelBridgeDeps {
  agent: Agent;
  /** Append a toast (id assigned by the bridge) and schedule its expiry. */
  pushToast: (toast: HostToast) => void;
  /** Route a HostAction emitted by an extension command. */
  handleUiAction: (action: HostAction) => void;
  isProcessingRef: RefObject<boolean>;
  queuedMessagesRef: RefObject<QueuedMessage[]>;
  nextQueueIdRef: RefObject<number>;
  setQueuedMessages: (messages: QueuedMessage[]) => void;
  scrollToBottom: () => void;
  processMessageRef: RefObject<(text: string, displayText?: string) => Promise<void> | void>;
  appendAssistantMessage: (content: string) => void;
  contextStatsRef: RefObject<ContextStats>;
  contextBreakdownRef: RefObject<ContextBreakdown>;
  activeModelAdapterIdRef: RefObject<string | null>;
  inputRef: RefObject<TextareaRenderable | null>;
}

export function useKernelBridge(deps: KernelBridgeDeps): void {
  const {
    agent,
    pushToast,
    handleUiAction,
    isProcessingRef,
    queuedMessagesRef,
    nextQueueIdRef,
    setQueuedMessages,
    scrollToBottom,
    processMessageRef,
    appendAssistantMessage,
    contextStatsRef,
    contextBreakdownRef,
    activeModelAdapterIdRef,
    inputRef,
  } = deps;

  useEffect(() => {
    kernelSetToastSink(pushToast);
    kernelSetChatSink((prompt: string, options?: ChatDispatchOptions) => {
      const displayText = options?.displayText ?? prompt;
      if (isProcessingRef.current) {
        const id = `q${nextQueueIdRef.current++}`;
        queuedMessagesRef.current.push({ id, text: prompt, displayText });
        setQueuedMessages([...queuedMessagesRef.current]);
        setTimeout(scrollToBottom, 10);
        return;
      }
      const fn = processMessageRef.current;
      if (fn) void fn(prompt, displayText);
    });
    kernelSetAssistantSink(appendAssistantMessage);
    kernelSetUiActionSink((action) => {
      handleUiAction(action);
    });
    kernelSetCwdProvider(() => agent.getCwd());
    kernelSetSessionIdProvider(() => agent.getSessionId());
    kernelSetSessionReconnectProvider(() => agent.reconnectProviderSession());
    kernelSetContextStatsProvider(() => contextStatsRef.current);
    kernelSetContextBreakdownProvider(() => contextBreakdownRef.current);
    kernelSetContextCompactProvider(() => agent.manualCompact());
    kernelSetActiveModelAdapterIdProvider(() => activeModelAdapterIdRef.current);
    // Renderer keyboard hook — lets screen extensions consume keyboard input
    // through services.input.useKeyboard without importing @opentui/react.
    kernelSetKeyboardHookProvider(useKeyboard);
    // Input sink — exposes the prompt textarea to extensions (voice
    // push-to-talk, future snippet/completion plugins). All accessors read
    // inputRef.current lazily so a stale closure doesn't break after re-mount.
    kernelSetInputSink({
      getValue: () => inputRef.current?.plainText ?? "",
      getCursor: () => inputRef.current?.cursorOffset ?? 0,
      setValueWithCursor: (value: string, cursor: number) => {
        const ta = inputRef.current;
        if (!ta) return;
        ta.setText(value);
        ta.cursorOffset = cursor;
      },
      insertText: (text: string) => {
        inputRef.current?.insertText(text);
      },
      clear: () => {
        inputRef.current?.clear();
        inputRef.current?.requestRender();
      },
      isFocused: () => inputRef.current?.focused ?? false,
    });
    return () => {
      kernelSetToastSink(null);
      kernelSetChatSink(null);
      kernelSetAssistantSink(null);
      kernelSetUiActionSink(null);
      kernelSetCwdProvider(null);
      kernelSetSessionIdProvider(null);
      kernelSetSessionReconnectProvider(null);
      kernelSetContextStatsProvider(null);
      kernelSetContextBreakdownProvider(null);
      kernelSetContextCompactProvider(null);
      kernelSetActiveModelAdapterIdProvider(null);
      kernelSetKeyboardHookProvider(null);
      kernelSetInputSink(null);
    };
    // The ref objects are stable; only the callbacks and agent can change.
  }, [
    agent,
    pushToast,
    handleUiAction,
    appendAssistantMessage,
    setQueuedMessages,
    scrollToBottom,
    isProcessingRef,
    queuedMessagesRef,
    nextQueueIdRef,
    processMessageRef,
    contextStatsRef,
    contextBreakdownRef,
    activeModelAdapterIdRef,
    inputRef,
  ]);
}
