import { useCallback } from "react";
import type { Agent } from "../../../agent/agent";
import { getHostServices as kernelGetHostServices, listPlugins as kernelListExtensions } from "../../../core/plugins";
import { buildFileNavigatorData, FILES_SCREEN_ID } from "../../../core/plugins/native/files-command";
import type { ScheduleDaemonStatus, StoredSchedule } from "../../../tools/schedule";
import type { ChatEntry } from "../../../types/index";
import { getTelegramBotToken, loadUserSettings, saveUserSettings } from "../../../utils/settings";
import { runUpdate } from "../../../utils/update-checker";
import type { AppStartupConfig } from "../../app-helpers";
import { useComposer } from "../../context/composer-context.js";
import { useConversationState } from "../../context/conversation-state-context.js";
import { useModalVisibility } from "../../context/modal-context.js";
import { useRunningAgents } from "../../context/running-agents-context.js";
import { useServerMode } from "../../context/server-mode-context.js";
import { useTelegram } from "../../context/telegram-context.js";
import { useToast } from "../../context/toast-context.js";
import { getFeatureFlag } from "../../feature-flags";
import type { LocalFileLinkTarget } from "../../markdown-links";
import type { SlashMenuItem } from "../../slash-menu";
import { buildAssistantEntry } from "../../telegram-turn-ui";
import { spawnTerminalSession, type TerminalSessionSnapshot } from "../../terminal/manager";

function formatScheduleDetails(schedule: StoredSchedule, daemonStatus: ScheduleDaemonStatus): string {
  const daemonText = daemonStatus.running
    ? `running${daemonStatus.pid ? ` (pid ${daemonStatus.pid})` : ""}`
    : "not running";
  return [
    `Schedule: ${schedule.name}`,
    `ID: ${schedule.id}`,
    `Type: ${schedule.cron ? "recurring" : "one-time"}`,
    `Cron: ${schedule.cron ?? "runs once immediately"}`,
    `Enabled: ${schedule.enabled ? "yes" : "no"}`,
    `Model: ${schedule.model}`,
    `Directory: ${schedule.directory}`,
    `Last run: ${schedule.lastRunAt ?? "never"}`,
    `Daemon: ${daemonText}`,
    "",
    "Instruction:",
    schedule.instruction,
  ].join("\n");
}

export function useTelegramMiscActions({
  agent,
  startupConfig,
  onExit,
  terminalSessions,
  startTelegramBridge,
  openRecapPicker,
}: {
  agent: Agent;
  startupConfig: AppStartupConfig;
  onExit?: () => void;
  terminalSessions: readonly TerminalSessionSnapshot[];
  /** Returns false when nothing was started (no bot token). */
  startTelegramBridge: () => boolean;
  openRecapPicker: () => void;
}) {
  const modal = useModalVisibility();
  const conv = useConversationState();
  const composer = useComposer();
  const agents = useRunningAgents();
  const telegram = useTelegram();
  const toast = useToast();
  const { openPicker: openServerPicker } = useServerMode();

  const {
    setSchedules,
    setScheduleModalIndex,
    setScheduleSearchQuery,
    setShowScheduleModal,
    setShowSessionsModal,
    setSessionsList,
    setSessionsSearchQuery,
    setSessionsModalIndex,
    setShowExtensionsModal,
    setExtensionsSearchQuery,
    setExtensionsModalIndex,
    setExpandedExtensionGroups,
    setShowFlagsModal,
    setFlagsSearchQuery,
    setFlagsModalIndex,
    setShowTelegramTokenModal,
    setTelegramTokenError,
    setShowTelegramPairModal,
    setTelegramPairError,
    setShowConnectModal,
    setShowSlashMenu,
    setShowTerminalModal,
    setTerminalModalIndex,
    setExtensionsList,
    setDynamicScreens,
    setShowUpdateModal,
    setIsUpdating,
    setUpdateOutput,
  } = modal;
  const { setMessages, scrollRef, transcriptAutoFollowRef } = conv;
  const { commitComposer } = composer;
  const {
    setShowAgentsPopup,
    setAgentsPopupIndex,
    setAgentModalId,
    setAgentModalSnapshot,
    setAgentModalOutput,
    runningAgentRowsRef,
  } = agents;
  const { bridgeRef, telegramTokenInputRef } = telegram;
  const { pushToast } = toast;

  // ── Telegram callbacks ─────────────────────────────────────────────────

  const submitTelegramToken = useCallback(() => {
    const token = (telegramTokenInputRef.current?.plainText || "").trim();
    if (!token) {
      setTelegramTokenError("Paste your bot token from @BotFather.");
      return;
    }
    const previousBridge = bridgeRef.current;
    bridgeRef.current = null;
    void previousBridge?.stop();

    const u = loadUserSettings();
    saveUserSettings({ telegram: { ...u.telegram, botToken: token } });
    telegramTokenInputRef.current?.clear();
    setShowTelegramTokenModal(false);
    setTelegramTokenError(null);
    if (!startTelegramBridge()) {
      setMessages((p) => [
        ...p,
        {
          type: "assistant",
          content: "Telegram: no bot token available, so polling was not started.",
          timestamp: new Date(),
        },
      ]);
      return;
    }
    setShowTelegramPairModal(true);
    setTelegramPairError(null);
    setMessages((p) => [
      ...p,
      {
        type: "assistant",
        content:
          "Telegram polling started. In Telegram, DM your bot and send /pair. Copy the code, then enter it below.",
        timestamp: new Date(),
      },
    ]);
  }, [
    startTelegramBridge,
    setTelegramTokenError,
    setShowTelegramTokenModal,
    setTelegramPairError,
    setShowTelegramPairModal,
    setMessages,
    bridgeRef,
    telegramTokenInputRef,
  ]);

  const beginTelegramFromConnect = useCallback(() => {
    setShowConnectModal(false);
    if (!getTelegramBotToken()) {
      setShowTelegramTokenModal(true);
      setTelegramTokenError(null);
      return;
    }
    if (!startTelegramBridge()) {
      setShowTelegramTokenModal(true);
      setTelegramTokenError(null);
      return;
    }
    const alreadyPaired = (loadUserSettings().telegram?.approvedUserIds?.length ?? 0) > 0;
    if (!alreadyPaired) {
      setShowTelegramPairModal(true);
      setTelegramPairError(null);
      setMessages((p) => [
        ...p,
        {
          type: "assistant",
          content:
            "Telegram polling started. In Telegram, DM your bot and send /pair. Copy the code, then enter it below.",
          timestamp: new Date(),
        },
      ]);
    } else {
      setMessages((p) => [
        ...p,
        {
          type: "assistant",
          content: "Telegram polling is running. Your chat is already paired.",
          timestamp: new Date(),
        },
      ]);
    }
  }, [
    startTelegramBridge,
    setTelegramPairError,
    setTelegramTokenError,
    setShowTelegramTokenModal,
    setShowTelegramPairModal,
    setShowConnectModal,
    setMessages,
  ]);

  // ── Running agents popup callbacks ─────────────────────────────────────

  const closeAgentsPopup = useCallback(() => {
    setShowAgentsPopup(false);
  }, [setShowAgentsPopup]);

  const closeAgentModal = useCallback(() => {
    setAgentModalId(null);
    setAgentModalSnapshot(null);
    setAgentModalOutput(null);
  }, [setAgentModalOutput, setAgentModalId, setAgentModalSnapshot]);

  const openAgentsPopup = useCallback(() => {
    if (runningAgentRowsRef.current.length === 0) return;
    agents.setAgentsFooterFocused(false);
    setAgentsPopupIndex(0);
    setShowAgentsPopup(true);
  }, [setShowAgentsPopup, setAgentsPopupIndex, runningAgentRowsRef, agents.setAgentsFooterFocused]);

  const openAgentModalAtIndex = useCallback(
    (index: number) => {
      const row = runningAgentRowsRef.current[index];
      if (!row) return;
      setShowAgentsPopup(false);
      setAgentModalOutput(null);
      setAgentModalSnapshot(row);
      setAgentModalId(row.id);
    },
    [setAgentModalSnapshot, setShowAgentsPopup, setAgentModalOutput, setAgentModalId, runningAgentRowsRef],
  );

  // ── File link callback ─────────────────────────────────────────────────

  const openFileLinkInNavigator = useCallback(
    (target: LocalFileLinkTarget) => {
      try {
        const file = buildFileNavigatorData(target.path, agent.getCwd(), {
          initialLine: target.line,
        });
        setDynamicScreens((prev) => {
          const next = new Map(prev);
          next.set(FILES_SCREEN_ID, { file });
          return next;
        });
      } catch (err) {
        pushToast({
          style: "failure",
          title: "Couldn't open file",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [agent, pushToast, setDynamicScreens],
  );

  // ── Extension command callbacks ────────────────────────────────────────

  const tryDispatchExtensionInput = useCallback((input: string): boolean => {
    const services = kernelGetHostServices();
    const resolution = services.commands.resolveInput(input);
    if (!resolution) return false;
    const { command, args } = resolution;
    void Promise.resolve(command.handler({ args, services })).catch((err) => {
      console.error(`[extensions] command handler for ${command.name} threw:`, err);
    });
    return true;
  }, []);

  const dispatchExtensionCommand = useCallback(
    (commandName: string) => {
      if (!tryDispatchExtensionInput(commandName)) {
        setMessages((prev) => [
          ...prev,
          buildAssistantEntry(
            `${commandName} is not available — its extension may be disabled. Open /extensions to re-enable it.`,
          ),
        ]);
      }
    },
    [tryDispatchExtensionInput, setMessages],
  );

  const handleCommand = useCallback(
    (cmd: string): boolean => {
      if (tryDispatchExtensionInput(cmd)) {
        return true;
      }
      return false;
    },
    [tryDispatchExtensionInput],
  );

  const handleSlashMenuSelect = useCallback(
    (item: SlashMenuItem) => {
      setShowSlashMenu(false);
      commitComposer();
      switch (item.id) {
        case "new":
          dispatchExtensionCommand("/clear");
          break;
        case "models":
          dispatchExtensionCommand("/model");
          break;
        case "server":
          openServerPicker();
          break;
        case "recaps":
          openRecapPicker();
          break;
        case "wallet":
          dispatchExtensionCommand("/wallet");
          break;
        case "remote-control":
          dispatchExtensionCommand("/remote-control");
          break;
        case "exit":
          dispatchExtensionCommand("/quit");
          break;
        case "help":
          dispatchExtensionCommand("/help");
          break;
        case "skills":
          dispatchExtensionCommand("/skills");
          break;
        case "mcp":
          dispatchExtensionCommand("/mcp");
          break;
        case "agents":
          dispatchExtensionCommand("/agents");
          break;
        case "extensions":
          dispatchExtensionCommand("/plugins");
          break;
        case "sessions":
          dispatchExtensionCommand("/sessions");
          break;
        case "theme":
          dispatchExtensionCommand("/theme");
          break;
        case "flags":
          dispatchExtensionCommand("/flags");
          break;
        case "schedule":
          dispatchExtensionCommand("/schedule");
          break;
        case "review":
          dispatchExtensionCommand("/review");
          break;
        case "verify":
          dispatchExtensionCommand("/verify");
          break;
        case "commit-push":
          dispatchExtensionCommand("/commit-push");
          break;
        case "commit-pr":
          dispatchExtensionCommand("/commit-pr");
          break;
        case "dream":
          dispatchExtensionCommand("/dream");
          break;
        case "btw":
          commitComposer({ text: "/btw " });
          break;
        case "index":
          commitComposer({ text: "/index " });
          break;
        case "rag":
          commitComposer({ text: "/rag " });
          break;
        case "learn":
          commitComposer({ text: "/learn " });
          break;
        case "self-correct":
          commitComposer({ text: "/self-correct " });
          break;
        case "thinking":
          dispatchExtensionCommand("/thinking");
          break;
        case "effort":
          dispatchExtensionCommand("/effort");
          break;
        case "permission":
          dispatchExtensionCommand("/permission");
          break;
        case "term":
          commitComposer({ text: "/term " });
          break;
        case "terms":
          dispatchExtensionCommand("/terms");
          break;
        case "term-modal":
          commitComposer({ text: "/term-modal " });
          break;
        case "showcase":
          dispatchExtensionCommand("/showcase");
          break;
        case "ui":
          dispatchExtensionCommand("/ui");
          break;
        case "update":
          dispatchExtensionCommand("/update");
          break;
        default:
          dispatchExtensionCommand(`/${item.id}`);
          break;
      }
    },
    [dispatchExtensionCommand, openRecapPicker, openServerPicker, commitComposer, setShowSlashMenu],
  );

  // ── Other callbacks ────────────────────────────────────────────────────

  const handleTranscriptAutoFollowChange = useCallback(
    (enabled: boolean) => {
      transcriptAutoFollowRef.current = enabled;
    },
    [transcriptAutoFollowRef],
  );

  const handleExit = useCallback(() => {
    void bridgeRef.current?.stop();
    bridgeRef.current = null;
    onExit?.();
  }, [onExit, bridgeRef]);

  const handleRunUpdate = useCallback(() => {
    setIsUpdating(true);
    setShowUpdateModal(false);
    runUpdate(startupConfig.version).then((result) => {
      setIsUpdating(false);
      setUpdateOutput(result.output);
    });
  }, [startupConfig.version, setIsUpdating, setShowUpdateModal, setUpdateOutput]);

  // ── Schedule callbacks ─────────────────────────────────────────────────

  const openScheduleModal = useCallback(() => {
    void agent
      .listSchedules()
      .then((latest) => {
        setSchedules(latest);
        setScheduleSearchQuery("");
        setScheduleModalIndex(0);
        setShowScheduleModal(true);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [...prev, buildAssistantEntry(`Failed to load schedules: ${message}`)]);
      });
  }, [agent, setSchedules, setScheduleModalIndex, setScheduleSearchQuery, setShowScheduleModal, setMessages]);

  const showScheduleDetails = useCallback(
    (schedule: StoredSchedule) => {
      void agent
        .getScheduleDaemonStatus()
        .then((status) => {
          setMessages((prev) => [...prev, buildAssistantEntry(formatScheduleDetails(schedule, status))]);
          setShowScheduleModal(false);
          setScheduleSearchQuery("");
          setTimeout(() => {
            try {
              scrollRef.current?.scrollTo(scrollRef.current?.scrollHeight ?? 99999);
            } catch {
              /* */
            }
          }, 10);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setMessages((prev) => [...prev, buildAssistantEntry(`Failed to load schedule details: ${message}`)]);
        });
    },
    [
      agent,
      setShowScheduleModal,
      setScheduleSearchQuery,
      scrollRef.current?.scrollTo,
      setMessages,
      scrollRef.current?.scrollHeight,
    ],
  );

  const removeSchedule = useCallback(
    (schedule: StoredSchedule) => {
      void agent
        .removeSchedule(schedule.id)
        .then(async (message) => {
          const latest = await agent.listSchedules();
          setSchedules(latest);
          setScheduleModalIndex((index) => Math.max(0, Math.min(index, Math.max(0, latest.length - 1))));
          setMessages((prev) => [...prev, buildAssistantEntry(message)]);
          setTimeout(() => {
            try {
              scrollRef.current?.scrollTo(scrollRef.current?.scrollHeight ?? 99999);
            } catch {
              /* */
            }
          }, 10);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setMessages((prev) => [...prev, buildAssistantEntry(`Failed to remove schedule: ${message}`)]);
        });
    },
    [
      agent,
      setSchedules,
      setScheduleModalIndex,
      scrollRef.current?.scrollHeight,
      scrollRef.current?.scrollTo,
      setMessages,
    ],
  );

  // ── Extensions / flags / sessions callbacks ────────────────────────────

  const openExtensionsModal = useCallback(() => {
    setExtensionsList(kernelListExtensions());
    setExtensionsSearchQuery("");
    setExtensionsModalIndex(0);
    setExpandedExtensionGroups(new Set());
    setShowExtensionsModal(true);
  }, [
    setExtensionsModalIndex,
    setExtensionsList,
    setExtensionsSearchQuery,
    setExpandedExtensionGroups,
    setShowExtensionsModal,
  ]);

  const openFlagsModal = useCallback(() => {
    setFlagsSearchQuery("");
    setFlagsModalIndex(0);
    setShowFlagsModal(true);
  }, [setShowFlagsModal, setFlagsSearchQuery, setFlagsModalIndex]);

  const openSessionsModal = useCallback(() => {
    const scope = getFeatureFlag("sessions.scope.global") ? "global" : "local";
    setSessionsList(agent.listSessions({ limit: 200, scope }));
    setSessionsSearchQuery("");
    setSessionsModalIndex(0);
    setShowSessionsModal(true);
  }, [agent, setShowSessionsModal, setSessionsModalIndex, setSessionsList, setSessionsSearchQuery]);

  // ── Terminal callbacks ─────────────────────────────────────────────────

  const openTerminalManager = useCallback(
    (sessionId?: string) => {
      const idx = sessionId
        ? Math.max(
            0,
            terminalSessions.findIndex((s) => s.id === sessionId),
          )
        : 0;
      setTerminalModalIndex(idx);
      setShowTerminalModal(true);
    },
    [terminalSessions, setTerminalModalIndex, setShowTerminalModal],
  );

  const spawnInlineTerminal = useCallback(
    (command: string) => {
      const trimmed = command.trim();
      if (!trimmed) return;
      const sessionId = spawnTerminalSession({ command: trimmed });
      setMessages((prev) => [
        ...prev,
        {
          type: "assistant",
          content: "",
          timestamp: new Date(),
          terminalSessionId: sessionId,
        } as ChatEntry,
      ]);
    },
    [setMessages],
  );

  return {
    submitTelegramToken,
    beginTelegramFromConnect,
    closeAgentsPopup,
    closeAgentModal,
    openAgentsPopup,
    openAgentModalAtIndex,
    openFileLinkInNavigator,
    tryDispatchExtensionInput,
    dispatchExtensionCommand,
    handleCommand,
    handleSlashMenuSelect,
    handleTranscriptAutoFollowChange,
    handleExit,
    handleRunUpdate,
    openScheduleModal,
    showScheduleDetails,
    removeSchedule,
    openExtensionsModal,
    openFlagsModal,
    openSessionsModal,
    openTerminalManager,
    spawnInlineTerminal,
  };
}
