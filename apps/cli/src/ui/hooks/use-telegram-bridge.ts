// Telegram bridge lifecycle — all Telegram bridge callbacks extracted from
// app.tsx.
//
// This hook owns the Telegram bridge: creating per-user agents, wiring their
// subagent-status subscriptions into the UI, appending user/assistant/tool
// messages from the bridge, and starting/stopping the long-poll loop. The
// actual turn state machine (beginLiveTurn, finalizeActiveTurn, etc.) is
// owned by useTurnEngine and passed in; message/subagent/plan setters come
// from useConversationState; bridge/agent refs come from useTelegram.

import { type RefObject, useCallback, useEffect, useRef } from "react";
import { Agent } from "../../agent/agent";
import { listPlugins } from "../../core/plugins";
import type { ToolCall, ToolResult } from "../../types/index";
import type { SandboxMode, SandboxSettings } from "../../utils/settings";
import { getTelegramBotToken, loadUserSettings, saveUserSettings } from "../../utils/settings";
import type { ActiveTurnState, AppStartupConfig } from "../app-helpers";
import { useConversationState } from "../context/conversation-state-context.js";
import { useTelegram } from "../context/telegram-context.js";
import { useToast } from "../context/toast-context.js";
import { setStreamContent } from "../stream-store.js";
import {
  buildUserEntry,
  getTelegramSourceLabel,
  getUnflushedTelegramAssistantContent,
  markTelegramTurnStopped,
} from "../telegram-turn-ui";
import { sanitizeContent } from "../utils/sanitize-content.js";

// Auto-start (on mount, with no explicit user action) must respect the
// "Telegram Bridge" extension's enabled state — disabling it via /extensions
// is how users turn Telegram off, and previously this hook ignored that
// entirely, polling on nothing but a saved bot token. Explicit user actions
// (submitting a new token, /connect) intentionally bypass this check —
// those are the user actively asking to turn Telegram on.
const TELEGRAM_BRIDGE_EXTENSION_ID = "builtin.tools.telegram";

function isTelegramBridgeExtensionEnabled(): boolean {
  return listPlugins().find((ext) => ext.id === TELEGRAM_BRIDGE_EXTENSION_ID)?.enabled !== false;
}

export interface TelegramBridgeParams {
  agent: Agent;
  beginLiveTurn: (turn: Omit<ActiveTurnState, "latestAssistantText" | "flushedAssistantChars">) => void;
  scrollToBottom: () => void;
  finalizeActiveTurn: (options?: { wasInterrupted?: boolean; hadError?: boolean }) => void;
  showLiveToolCalls: (toolCalls: ToolCall[]) => void;
  appendLiveToolResult: (toolCall: ToolCall, toolResult: ToolResult) => void;
  startupConfig: AppStartupConfig;
  getApiKey: () => string | undefined;
  sandboxMode: SandboxMode;
  sandboxSettings: SandboxSettings;
}

export interface UseTelegramBridgeReturn {
  startTelegramBridgeRef: RefObject<() => boolean>;
  wireTelegramAgentUi: (userId: number, telegramAgent: Agent) => void;
  getTelegramAgent: (userId: number) => Agent;
  appendTelegramUserMessage: (event: { turnKey: string; userId: number; content: string }) => void;
  upsertTelegramAssistantMessage: (event: { turnKey: string; userId: number; content: string; done: boolean }) => void;
  showTelegramToolCalls: (event: { turnKey: string; userId: number; toolCalls: ToolCall[] }) => void;
  appendTelegramToolResult: (event: {
    turnKey: string;
    userId: number;
    toolCall: ToolCall;
    toolResult: ToolResult;
  }) => void;
  startTelegramBridge: () => boolean;
  handleTelegramTurnAborted: (event: { turnKey: string; userId: number }) => void;
  applyTelegramAssistantPreview: (fullContent: string) => void;
}

export function useTelegramBridge(params: TelegramBridgeParams): UseTelegramBridgeReturn {
  const {
    agent: _agent,
    beginLiveTurn,
    scrollToBottom,
    finalizeActiveTurn,
    showLiveToolCalls,
    appendLiveToolResult,
    startupConfig,
    getApiKey: getApiKeyParam,
    sandboxMode,
    sandboxSettings,
  } = params;

  const { activeTurnRef, contentAccRef, setMessages, setActiveSubagent } = useConversationState();
  const {
    coordinatorRef,
    bridgeRef,
    telegramAgentsRef,
    telegramEntryCountsRef,
    telegramSubagentUnsubsRef,
    stoppedTelegramTurnKeysRef,
  } = useTelegram();
  const { pushToast: _pushToast } = useToast();

  const startTelegramBridgeRef = useRef<() => boolean>(() => false);

  const applyTelegramAssistantPreview = useCallback(
    (fullContent: string) => {
      const activeTurn = activeTurnRef.current;
      if (!activeTurn || activeTurn.kind !== "telegram") return;

      activeTurn.latestAssistantText = fullContent;
      contentAccRef.current = getUnflushedTelegramAssistantContent(fullContent, activeTurn.flushedAssistantChars);
      setStreamContent(sanitizeContent(contentAccRef.current));
    },
    [activeTurnRef.current, contentAccRef.current, contentAccRef],
  );

  const wireTelegramAgentUi = useCallback(
    (userId: number, telegramAgent: Agent) => {
      if (!telegramEntryCountsRef.current.has(userId)) {
        telegramEntryCountsRef.current.set(userId, telegramAgent.getChatEntries().length);
      }

      if (telegramSubagentUnsubsRef.current.has(userId)) {
        return;
      }

      const unsubscribe = telegramAgent.onSubagentStatus((status) => {
        if (activeTurnRef.current?.agent !== telegramAgent) return;
        setActiveSubagent(status);
      });
      telegramSubagentUnsubsRef.current.set(userId, unsubscribe);
    },
    [
      activeTurnRef.current?.agent,
      setActiveSubagent,
      telegramSubagentUnsubsRef.current.has,
      telegramEntryCountsRef.current.has,
      telegramSubagentUnsubsRef.current.set,
      telegramEntryCountsRef.current.set,
    ],
  );

  const getTelegramAgent = useCallback(
    (userId: number) => {
      const map = telegramAgentsRef.current;
      const existing = map.get(userId);
      if (existing) {
        wireTelegramAgentUi(userId, existing);
        return existing;
      }

      const apiKey = getApiKeyParam() ?? startupConfig.apiKey;

      const u = loadUserSettings();
      const sid = u.telegram?.sessionsByUserId?.[String(userId)];
      const a = new Agent(apiKey, startupConfig.baseURL, startupConfig.model, startupConfig.maxToolRounds, {
        session: sid,
        modelAdapterId: startupConfig.modelAdapterId,
        sandboxMode,
        sandboxSettings,
      });
      if (!sid && a.getSessionId()) {
        saveUserSettings({
          telegram: {
            ...u.telegram,
            sessionsByUserId: {
              ...u.telegram?.sessionsByUserId,
              [String(userId)]: a.getSessionId()!,
            },
          },
        });
      }
      wireTelegramAgentUi(userId, a);
      map.set(userId, a);
      return a;
    },
    [sandboxMode, sandboxSettings, startupConfig, wireTelegramAgentUi, telegramAgentsRef.current, getApiKeyParam],
  );
  // The bridge keeps the getTelegramAgent it was created with for its whole
  // life. Hand it this ref-backed wrapper so agents created later pick up the
  // CURRENT sandbox mode/settings, not the ones from when polling started.
  const getTelegramAgentRef = useRef(getTelegramAgent);
  getTelegramAgentRef.current = getTelegramAgent;

  const appendTelegramUserMessage = useCallback(
    (event: { turnKey: string; userId: number; content: string }) => {
      const telegramAgent = getTelegramAgent(event.userId);
      beginLiveTurn({
        kind: "telegram",
        agent: telegramAgent,
        remoteKey: event.turnKey,
        userId: event.userId,
        sourceLabel: getTelegramSourceLabel("assistant", event.userId),
      });
      setMessages((prev) => [
        ...prev,
        buildUserEntry(event.content, {
          remoteKey: event.turnKey,
          sourceLabel: getTelegramSourceLabel("user", event.userId),
        }),
      ]);
      setTimeout(scrollToBottom, 10);
    },
    [beginLiveTurn, getTelegramAgent, scrollToBottom, setMessages],
  );

  const upsertTelegramAssistantMessage = useCallback(
    (event: { turnKey: string; userId: number; content: string; done: boolean }) => {
      // Late output of a turn the user stopped: the UI already released it.
      if (stoppedTelegramTurnKeysRef.current.has(event.turnKey)) return;
      if (activeTurnRef.current?.remoteKey !== event.turnKey) {
        const telegramAgent = getTelegramAgent(event.userId);
        beginLiveTurn({
          kind: "telegram",
          agent: telegramAgent,
          remoteKey: event.turnKey,
          userId: event.userId,
          sourceLabel: getTelegramSourceLabel("assistant", event.userId),
        });
      }

      applyTelegramAssistantPreview(event.content);
      if (event.done) {
        finalizeActiveTurn();
      }
    },
    [
      applyTelegramAssistantPreview,
      beginLiveTurn,
      finalizeActiveTurn,
      getTelegramAgent,
      activeTurnRef.current?.remoteKey,
      stoppedTelegramTurnKeysRef.current.has,
    ],
  );

  const showTelegramToolCalls = useCallback(
    (event: { turnKey: string; userId: number; toolCalls: ToolCall[] }) => {
      if (stoppedTelegramTurnKeysRef.current.has(event.turnKey)) return;
      if (activeTurnRef.current?.remoteKey !== event.turnKey) {
        const telegramAgent = getTelegramAgent(event.userId);
        beginLiveTurn({
          kind: "telegram",
          agent: telegramAgent,
          remoteKey: event.turnKey,
          userId: event.userId,
          sourceLabel: getTelegramSourceLabel("assistant", event.userId),
        });
      }
      showLiveToolCalls(event.toolCalls);
    },
    [
      beginLiveTurn,
      getTelegramAgent,
      showLiveToolCalls,
      activeTurnRef.current?.remoteKey,
      stoppedTelegramTurnKeysRef.current.has,
    ],
  );

  const appendTelegramToolResult = useCallback(
    (event: { turnKey: string; userId: number; toolCall: ToolCall; toolResult: ToolResult }) => {
      if (stoppedTelegramTurnKeysRef.current.has(event.turnKey)) return;
      if (activeTurnRef.current?.remoteKey !== event.turnKey) {
        const telegramAgent = getTelegramAgent(event.userId);
        beginLiveTurn({
          kind: "telegram",
          agent: telegramAgent,
          remoteKey: event.turnKey,
          userId: event.userId,
          sourceLabel: getTelegramSourceLabel("assistant", event.userId),
        });
      }
      appendLiveToolResult(event.toolCall, event.toolResult);
    },
    [
      appendLiveToolResult,
      beginLiveTurn,
      getTelegramAgent,
      activeTurnRef.current?.remoteKey,
      stoppedTelegramTurnKeysRef.current.has,
    ],
  );

  // The bridge aborted a turn (coordinator reset, bridge stop): no `done`
  // event follows. Mark the key stopped so any straggler is dropped, and if
  // the UI still shows that turn live, close it as interrupted — which also
  // releases the processing latch.
  const handleTelegramTurnAborted = useCallback(
    (event: { turnKey: string; userId: number }) => {
      markTelegramTurnStopped(stoppedTelegramTurnKeysRef, { kind: "telegram", remoteKey: event.turnKey });
      const active = activeTurnRef.current;
      if (active?.kind === "telegram" && active.remoteKey === event.turnKey) {
        finalizeActiveTurn({ wasInterrupted: true });
      }
    },
    [activeTurnRef, finalizeActiveTurn, stoppedTelegramTurnKeysRef],
  );

  // Guards the async gap below: two rapid start calls would both pass the
  // `bridgeRef.current` check before the dynamic import resolves.
  const bridgeStartingRef = useRef(false);

  /** Returns false when there is no bot token (nothing was started). */
  const startTelegramBridge = useCallback((): boolean => {
    const token = getTelegramBotToken();
    if (!token) return false;
    if (bridgeRef.current || bridgeStartingRef.current) return true;
    bridgeStartingRef.current = true;

    // `telegram/bridge` pulls in grammy, which is heavyweight and only needed
    // once a bridge actually starts — a static import would evaluate it on
    // every interactive TUI launch.
    void import("../../telegram/bridge")
      .then(({ createTelegramBridge }) => {
        if (bridgeRef.current) return;
        const bridge = createTelegramBridge({
          token,
          getApprovedUserIds: () => loadUserSettings().telegram?.approvedUserIds ?? [],
          coordinator: coordinatorRef.current,
          getTelegramAgent: (userId) => getTelegramAgentRef.current(userId),
          onUserMessage: appendTelegramUserMessage,
          onAssistantMessage: upsertTelegramAssistantMessage,
          onToolCalls: showTelegramToolCalls,
          onToolResult: appendTelegramToolResult,
          onTurnAborted: handleTelegramTurnAborted,
          onError: (msg) => {
            setMessages((p) => [
              ...p,
              {
                type: "assistant",
                content: `Telegram: ${msg}`,
                timestamp: new Date(),
              },
            ]);
          },
        });
        bridgeRef.current = bridge;
        bridge.start();
      })
      .catch((err) => {
        setMessages((p) => [
          ...p,
          {
            type: "assistant",
            content: `Telegram: bridge failed to load: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date(),
          },
        ]);
      })
      .finally(() => {
        bridgeStartingRef.current = false;
      });
    return true;
  }, [
    appendTelegramToolResult,
    handleTelegramTurnAborted,
    appendTelegramUserMessage,
    showTelegramToolCalls,
    upsertTelegramAssistantMessage,
    setMessages,
    coordinatorRef.current,
    bridgeRef,
  ]);

  // Always a real starter — it used to be assigned only inside a successful
  // start, so with no token/extension at launch it stayed a no-op forever and
  // a token added later never started polling.
  startTelegramBridgeRef.current = startTelegramBridge;

  useEffect(() => {
    if (!getTelegramBotToken()) return;
    if (!isTelegramBridgeExtensionEnabled()) return;
    startTelegramBridge();
  }, [startTelegramBridge]);

  // Unmount-only cleanup. Do NOT depend on `bridgeRef.current?.stop` — that
  // identity flips from undefined → fn when the bridge starts, which re-runs
  // this effect and kills a live connection mid-session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount-only cleanup
  useEffect(() => {
    return () => {
      void bridgeRef.current?.stop();
      bridgeRef.current = null;
    };
  }, []);

  return {
    startTelegramBridgeRef,
    wireTelegramAgentUi,
    getTelegramAgent,
    appendTelegramUserMessage,
    upsertTelegramAssistantMessage,
    showTelegramToolCalls,
    appendTelegramToolResult,
    startTelegramBridge,
    handleTelegramTurnAborted,
    applyTelegramAssistantPreview,
  };
}
