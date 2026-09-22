import type { TextareaRenderable } from "@opentui/core";
import { createContext, type ReactNode, type RefObject, useCallback, useContext, useMemo, useRef } from "react";
import type { Agent } from "../../agent/agent";
import type { TelegramBridgeHandle } from "../../telegram/bridge";
import { approvePairingCode } from "../../telegram/pairing";
import { createTurnCoordinator, type TurnCoordinator } from "../../telegram/turn-coordinator";
import { saveApprovedTelegramUserId } from "../../utils/settings";
import { useConversationState } from "./conversation-state-context.js";
import { useModalVisibility } from "./modal-context.js";

interface TelegramCtx {
  coordinatorRef: RefObject<TurnCoordinator>;
  bridgeRef: RefObject<TelegramBridgeHandle | null>;
  telegramAgentsRef: RefObject<Map<number, Agent>>;
  telegramEntryCountsRef: RefObject<Map<number, number>>;
  telegramSubagentUnsubsRef: RefObject<Map<number, () => void>>;
  /** Turn keys of Telegram turns the user stopped (Ctrl+X, send-now, session
   *  swap). Late bridge events for them are dropped instead of re-opening a
   *  live turn that nothing will ever finalize. */
  stoppedTelegramTurnKeysRef: RefObject<Set<string>>;
  telegramTokenInputRef: RefObject<TextareaRenderable | null>;
  telegramPairInputRef: RefObject<TextareaRenderable | null>;
  submitTelegramPair: () => Promise<void>;
}

const Ctx = createContext<TelegramCtx | null>(null);

export function useTelegram(): TelegramCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTelegram must be used inside <TelegramProvider>");
  return ctx;
}

export function TelegramProvider({ children }: { children: ReactNode }) {
  const coordinatorRef = useRef<TurnCoordinator>(createTurnCoordinator());
  const bridgeRef = useRef<TelegramBridgeHandle | null>(null);
  const telegramAgentsRef = useRef<Map<number, Agent>>(new Map());
  const telegramEntryCountsRef = useRef<Map<number, number>>(new Map());
  const telegramSubagentUnsubsRef = useRef<Map<number, () => void>>(new Map());
  const stoppedTelegramTurnKeysRef = useRef<Set<string>>(new Set());
  const telegramTokenInputRef = useRef<TextareaRenderable | null>(null);
  const telegramPairInputRef = useRef<TextareaRenderable | null>(null);

  const { setMessages } = useConversationState();
  const { setTelegramPairError, setShowTelegramPairModal } = useModalVisibility();

  const submitTelegramPair = useCallback(async () => {
    const code = (telegramPairInputRef.current?.plainText || "").trim();
    if (!code) {
      setTelegramPairError("Enter the pairing code.");
      return;
    }
    const result = approvePairingCode(code);
    if (!result.ok) {
      setTelegramPairError(result.error);
      return;
    }
    saveApprovedTelegramUserId(result.userId);
    telegramPairInputRef.current?.clear();
    setShowTelegramPairModal(false);
    setTelegramPairError(null);
    setMessages((p) => [
      ...p,
      {
        type: "assistant",
        content: `Telegram user ${result.userId} paired. Keep this CLI open while you use the bot.`,
        timestamp: new Date(),
      },
    ]);
    try {
      await bridgeRef.current?.sendDm(result.userId, "Pairing approved. You can message Codesurf here.");
    } catch {
      /* optional DM */
    }
  }, [setTelegramPairError, setShowTelegramPairModal, setMessages]);

  const value = useMemo<TelegramCtx>(
    () => ({
      coordinatorRef,
      bridgeRef,
      telegramAgentsRef,
      telegramEntryCountsRef,
      telegramSubagentUnsubsRef,
      stoppedTelegramTurnKeysRef,
      telegramTokenInputRef,
      telegramPairInputRef,
      submitTelegramPair,
    }),
    [submitTelegramPair],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
