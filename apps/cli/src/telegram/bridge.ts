import { Bot } from "grammy";
import type { Agent } from "../agent/agent";
import { acquireTelegramSink, releaseTelegramSink, runInTelegramTurn } from "../core/plugins/sinks";
import type { ToolCall, ToolResult } from "../types/index";
import { registerRejectionInterceptor } from "../utils/process-guards";
import { loadUserSettings, resolveTelegramStreamSettings } from "../utils/settings";
import { getTelegramAudioSource, transcribeTelegramAudioMessage } from "./audio-input";
import { splitTelegramMessage, TELEGRAM_MAX_MESSAGE } from "./limits";
import { registerPairingCode } from "./pairing";
import { acquireTelegramPollerLock } from "./poller-lock";
import { runTelegramPartialReply } from "./preview-stream";
import { sendFileToTelegram } from "./send-file";
import type { TurnCoordinator } from "./turn-coordinator";
import { startTypingRefresh } from "./typing-refresh";

export { splitTelegramMessage, TELEGRAM_MAX_MESSAGE } from "./limits";

function latestAssistantTextAfter(agent: Agent, baselineCount: number): string | undefined {
  const entries = agent.getChatEntries().slice(baselineCount);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "assistant" && entry.content.trim()) {
      return entry.content;
    }
  }
  return undefined;
}

export function isTelegramConflictError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "error_code" in err) {
    const errorCode = (err as { error_code: unknown }).error_code;
    if (errorCode === 409) return true;
  }
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
  if (!message) return false;
  return message.includes("409: Conflict") || message.includes("terminated by other getUpdates");
}

// grammy's polling loop fires getUpdates calls whose rejections can escape the
// `bot.start()` promise chain entirely (fire-and-forget internals). Without
// this interceptor each 409 becomes an unhandledRejection: the old process
// guard killed the whole TUI, and even a log-only guard spams console.error
// (popping OpenTUI's Console overlay over the app). Instead: absorb conflict
// rejections globally and shut down every live bridge once.
const liveConflictHandlers = new Set<() => void>();
let interceptorRegistered = false;

function ensureConflictInterceptor(): void {
  if (interceptorRegistered) return;
  interceptorRegistered = true;
  registerRejectionInterceptor((reason) => {
    if (!isTelegramConflictError(reason)) return false;
    for (const stop of liveConflictHandlers) stop();
    return true;
  });
}

export interface TelegramBridgeOptions {
  token: string;
  getApprovedUserIds: () => number[];
  coordinator: TurnCoordinator;
  getTelegramAgent: (userId: number) => Agent;
  onUserMessage?: (event: { turnKey: string; userId: number; content: string }) => void;
  onAssistantMessage?: (event: { turnKey: string; userId: number; content: string; done: boolean }) => void;
  onToolCalls?: (event: { turnKey: string; userId: number; toolCalls: ToolCall[] }) => void;
  onToolResult?: (event: { turnKey: string; userId: number; toolCall: ToolCall; toolResult: ToolResult }) => void;
  onError?: (message: string) => void;
  /**
   * Polling ended for good — another poller holds the bot (409 conflict) or
   * getUpdates failed fatally. Fired once per bridge; the bridge will not
   * resume on its own, so a headless host should exit and let a supervisor
   * restart it.
   */
  onPollingStopped?: (reason: "conflict" | "error", message: string) => void;
  /**
   * A turn that already reported onUserMessage was cancelled (bridge stop or
   * coordinator reset) before it finished. No `done: true` assistant message
   * follows for this turnKey; the UI should close the turn as aborted.
   */
  onTurnAborted?: (event: { turnKey: string; userId: number }) => void;
}

export interface TelegramBridgeHandle {
  start: () => void;
  stop: () => Promise<void>;
  sendDm: (userId: number, text: string) => Promise<void>;
}

/** grammy types its `signal` parameter against the `abort-controller` polyfill; runtime-identical to the global. */
type GrammySignal = Parameters<Bot["api"]["sendChatAction"]>[3];

export function createTelegramBridge(opts: TelegramBridgeOptions): TelegramBridgeHandle {
  ensureConflictInterceptor();
  const bot = new Bot(opts.token);
  // `polling` is true from start() until the poller has exited — normally,
  // by error, or by conflict. `stopping` holds the in-flight stop() so a
  // second stop joins it and start() cannot slip in before cleanup ran.
  let polling = false;
  let stopping: Promise<void> | null = null;
  let pollingSession = 0;
  let conflictReported = false;
  let pollingStoppedReported = false;
  const reportPollingStopped = (reason: "conflict" | "error", message: string) => {
    if (pollingStoppedReported) return;
    pollingStoppedReported = true;
    opts.onPollingStopped?.(reason, message);
  };
  let releasePollerLock: (() => void) | null = null;
  // Bridge-owned cancellation for everything ingress-side: transcription,
  // typing, preview sends/edits, uploads and the agent turn itself. stop()
  // aborts it, so stopping cancels in-flight work and not only polling.
  let ingress = new AbortController();

  const freePollerLock = () => {
    releasePollerLock?.();
    releasePollerLock = null;
  };

  // The one idempotent owner of every polling-side resource. Invoked by
  // stop() (in `finally`, even when bot.stop() rejects), by every polling
  // exit and by a conflict — no path may leave the conflict handler
  // registered or the machine-wide poller lock held.
  const releasePolling = () => {
    polling = false;
    liveConflictHandlers.delete(reportConflict);
    freePollerLock();
  };

  const reportConflict = () => {
    // Still got a 409 while holding the local lock — the competitor is
    // external (another machine or checkout), so free the lock for others.
    releasePolling();
    void bot.stop().catch(() => {});
    if (conflictReported) return;
    conflictReported = true;
    const message = "Another CodeSurf instance is polling this Telegram bot — Telegram is disabled in this session.";
    opts.onError?.(message);
    reportPollingStopped("conflict", message);
  };

  const buildTurnKey = (ctx: { chat: { id: number }; message: { message_id: number } }) =>
    `telegram:${ctx.chat.id}:${ctx.message.message_id}`;

  // Private chats are the only supported ingress. A paired user's agent holds
  // their private conversation; routing a group/supergroup/channel message
  // (approved sender, different chat) to that agent would process it with
  // that private context and reply — text, files — into the group. Group
  // support needs explicit chat authorization and chat-scoped sessions first.
  const isPrivateChat = (ctx: { chat?: { type?: string } }) => ctx.chat?.type === "private";

  const ensureApprovedUser = async (ctx: {
    chat?: { type?: string };
    from?: { id?: number };
    reply: (text: string) => Promise<unknown>;
  }) => {
    if (!isPrivateChat(ctx)) return null;
    const userId = ctx.from?.id;
    if (userId === undefined) return null;

    const approved = opts.getApprovedUserIds();
    if (!approved.includes(userId)) {
      await ctx.reply("Not paired yet. Send /pair to get a code, then approve in Codesurf.");
      return null;
    }

    return userId;
  };

  const replyTurnError = async (
    ctx: { reply: (text: string) => Promise<unknown>; chat: { id: number }; message: { message_id: number } },
    userId: number,
    message: string,
  ) => {
    const clipped = message.slice(0, TELEGRAM_MAX_MESSAGE);
    opts.onAssistantMessage?.({
      turnKey: buildTurnKey(ctx),
      userId,
      content: `Error: ${clipped}`,
      done: true,
    });
    try {
      await ctx.reply(`Error: ${clipped}`);
    } catch {
      /* user blocked bot or chat forbids messages */
    }
  };

  const runAgentTurn = async (
    ctx: {
      chat: { id: number };
      from?: { id?: number };
      message: { message_id: number; message_thread_id?: number };
      reply: (text: string) => Promise<unknown>;
    },
    userId: number,
    userContent: string,
    promptText: string,
  ) => {
    const agent = opts.getTelegramAgent(userId);
    await opts.coordinator.run(async (turn) => {
      // Turn-owned cancellation: a bridge stop or a coordinator reset (the
      // TUI's abort) fences this turn out. Every Telegram request below
      // carries this signal, and the agent is told to abort so a fenced turn
      // cannot keep sending into a destination a newer turn now owns.
      const turnSignal = AbortSignal.any([ingress.signal, turn.signal]);
      if (turnSignal.aborted) return;
      const onTurnAbort = () => agent.abort();
      turnSignal.addEventListener("abort", onTurnAbort, { once: true });
      const turnKey = buildTurnKey(ctx);
      let turnStarted = false;
      let abortReported = false;
      // Every aborted exit below goes through here so the UI learns the turn ended.
      const reportAborted = () => {
        if (!turnStarted || abortReported) return;
        abortReported = true;
        opts.onTurnAborted?.({ turnKey, userId });
      };
      const sinkToken = acquireTelegramSink((filePath, abortSignal) =>
        sendFileToTelegram(
          { api: bot.api, chatId: ctx.chat.id, messageThreadId: ctx.message.message_thread_id },
          filePath,
          abortSignal ? AbortSignal.any([turnSignal, abortSignal]) : turnSignal,
        ),
      );
      // The turn body runs inside its own sink-ownership scope, so a tool call
      // still in flight after a newer turn takes over is refused by the loader
      // instead of delivering into that newer turn's chat (NET-6).
      try {
        await runInTelegramTurn(sinkToken, async () => {
          opts.onUserMessage?.({ turnKey, userId, content: userContent });
          turnStarted = true;
          const stream = resolveTelegramStreamSettings(loadUserSettings().telegram);

          const entryBaseline = agent.getChatEntries().length;

          if (stream.streaming === "off") {
            const stopTyping = startTypingRefresh(
              bot.api,
              ctx.chat.id,
              ctx.message.message_thread_id,
              stream.typingIndicator,
              turnSignal,
            );
            let acc = "";
            try {
              for await (const chunk of agent.processMessage(promptText)) {
                switch (chunk.type) {
                  case "content":
                    if (chunk.content) {
                      acc += chunk.content;
                      opts.onAssistantMessage?.({ turnKey, userId, content: acc, done: false });
                    }
                    break;
                  case "tool_calls":
                    if (chunk.toolCalls) {
                      opts.onToolCalls?.({ turnKey, userId, toolCalls: chunk.toolCalls });
                    }
                    break;
                  case "tool_result":
                    if (chunk.toolCall && chunk.toolResult) {
                      opts.onToolResult?.({
                        turnKey,
                        userId,
                        toolCall: chunk.toolCall,
                        toolResult: chunk.toolResult,
                      });
                    }
                    break;
                }
              }
            } catch (err: unknown) {
              if (turnSignal.aborted) return reportAborted();
              const msg = err instanceof Error ? err.message : String(err);
              await replyTurnError(ctx, userId, msg);
              return;
            } finally {
              stopTyping();
            }
            if (turnSignal.aborted) return reportAborted();
            const fallback = latestAssistantTextAfter(agent, entryBaseline)?.trim();
            const trimmed =
              acc.trim() ||
              fallback ||
              "Codesurf completed the Telegram turn but returned no assistant text. Check the selected model/provider credentials and try again.";
            opts.onAssistantMessage?.({ turnKey, userId, content: trimmed, done: true });
            const parts = splitTelegramMessage(trimmed);
            for (const part of parts) {
              await ctx.reply(part);
            }
            return;
          }

          await runTelegramPartialReply(bot.api, {
            chatId: ctx.chat.id,
            messageThreadId: ctx.message.message_thread_id,
            typingIndicator: stream.typingIndicator,
            stream: agent.processMessage(promptText),
            onAssistantMessage: (event) => {
              opts.onAssistantMessage?.({
                turnKey,
                userId,
                content: event.content,
                done: event.done,
              });
            },
            onToolCalls: (toolCalls) => {
              opts.onToolCalls?.({ turnKey, userId, toolCalls });
            },
            onToolResult: (event) => {
              opts.onToolResult?.({
                turnKey,
                userId,
                toolCall: event.toolCall,
                toolResult: event.toolResult,
              });
            },
            finalTextFallback: () => latestAssistantTextAfter(agent, entryBaseline),
            signal: turnSignal,
          });
          if (turnSignal.aborted) reportAborted();
        });
      } catch (err: unknown) {
        if (turnSignal.aborted) return reportAborted();
        const msg = err instanceof Error ? err.message : String(err);
        await replyTurnError(ctx, userId, msg);
      } finally {
        turnSignal.removeEventListener("abort", onTurnAbort);
        // Compare-and-release: a newer turn (after reset) may already own the
        // sink; this turn's late finalizer must not unbind it.
        releaseTelegramSink(sinkToken);
      }
    });
  };

  const handleAudioMessage = async (ctx: {
    chat: { id: number; type?: string };
    from?: { id?: number };
    message: {
      message_id: number;
      message_thread_id?: number;
      voice?: { file_id: string; mime_type?: string };
      audio?: { file_id: string; file_name?: string; mime_type?: string };
    };
    reply: (text: string) => Promise<unknown>;
  }) => {
    const userId = await ensureApprovedUser(ctx);
    if (userId === null) return;

    const source = getTelegramAudioSource(ctx.message);
    if (!source) return;

    // Transcription runs before the turn is queued, so it is fenced by the
    // bridge-level signal: stop() abandons the download/transcription too.
    const signal = ingress.signal;
    if (signal.aborted) return;
    try {
      await bot.api.sendChatAction(ctx.chat.id, "typing", undefined, signal as GrammySignal);
      const transcription = await transcribeTelegramAudioMessage({
        api: { getFile: (fileId, fileSignal) => bot.api.getFile(fileId, fileSignal as GrammySignal) },
        token: opts.token,
        source,
        telegramSettings: loadUserSettings().telegram,
        signal,
      });
      await runAgentTurn(ctx, userId, transcription.userContent, transcription.promptText);
    } catch (err: unknown) {
      if (signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      await replyTurnError(ctx, userId, `Audio transcription failed: ${msg}`);
    }
  };

  bot.command("start", async (ctx) => {
    if (!isPrivateChat(ctx)) return;
    await ctx.reply("Send /pair to link this chat to Codesurf, then approve the code in the terminal.");
  });

  bot.command("pair", async (ctx) => {
    if (!isPrivateChat(ctx)) return;
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const code = registerPairingCode(userId);
    await ctx.reply(`Your pairing code: ${code}\nEnter this code in Codesurf (/remote-control → Telegram) to approve.`);
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const userId = await ensureApprovedUser(ctx);
    if (userId === null) return;

    await runAgentTurn(ctx, userId, text, text);
  });

  bot.on("message:voice", async (ctx) => {
    await handleAudioMessage(ctx);
  });

  bot.on("message:audio", async (ctx) => {
    await handleAudioMessage(ctx);
  });

  bot.catch((err) => {
    if (isTelegramConflictError(err)) {
      reportConflict();
      return;
    }
    opts.onError?.(err instanceof Error ? err.message : String(err));
  });

  return {
    start() {
      if (polling || stopping) return;
      // Machine-wide single-poller guard: skip polling entirely (no 409
      // noise against the Telegram API) when another CodeSurf process
      // already holds the lock. sendDm still works without polling.
      const lock = acquireTelegramPollerLock();
      if (!lock.acquired) {
        reportConflict();
        return;
      }
      releasePollerLock = lock.release;
      polling = true;
      if (ingress.signal.aborted) ingress = new AbortController();
      liveConflictHandlers.add(reportConflict);
      // A late settlement of an earlier bot.start() promise must not release
      // the lock a newer start() acquired.
      const session = ++pollingSession;
      const exitPolling = () => {
        if (session === pollingSession) releasePolling();
      };
      void bot
        .start({
          allowed_updates: ["message"],
          drop_pending_updates: true,
        })
        .then(
          // grammy resolves start() once polling has stopped.
          () => exitPolling(),
          (err: unknown) => {
            if (isTelegramConflictError(err)) {
              reportConflict();
              return;
            }
            exitPolling();
            const message = err instanceof Error ? err.message : String(err);
            opts.onError?.(message);
            if (session === pollingSession) reportPollingStopped("error", message);
          },
        );
    },

    stop() {
      if (stopping) return stopping;
      const run = (async () => {
        // Cancel in-flight ingress first so turns stop sending while the
        // poller winds down; then release polling even when bot.stop() rejects.
        ingress.abort(new Error("Telegram bridge stopped"));
        try {
          if (polling) await bot.stop();
        } finally {
          releasePolling();
        }
      })();
      // The tracker is cleared from a continuation, never from inside the
      // IIFE: when nothing awaits (stop() while not polling) the IIFE's
      // `finally` runs synchronously, and a `stopping = null` there would be
      // overwritten by the assignment below — refusing start() forever.
      stopping = run.finally(() => {
        stopping = null;
      });
      return stopping;
    },

    async sendDm(userId: number, text: string) {
      for (const part of splitTelegramMessage(text)) {
        await bot.api.sendMessage(userId, part);
      }
    },
  };
}
