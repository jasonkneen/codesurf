import type { ModelMessage, ToolSet } from "ai";
import {
  getHostServices,
  type KernelModelRuntime,
  resolveModelRuntimeViaKernel,
  runtimeUsesSendTurn,
} from "../../core/plugins";
import type { BatchClientOptions } from "../../grok/batch";
import type { getModelInfo } from "../../grok/models";
import type { AggregatedHookResult, HookInput } from "../../hooks/index";
import type {
  SessionStartHookInput,
  StopFailureHookInput,
  StopHookInput,
  UserPromptSubmitHookInput,
} from "../../hooks/types";
import type { SessionStore } from "../../storage/index";
import { appendMessages } from "../../storage/index";
import type {
  AgentMode,
  SessionInfo,
  StreamChunk,
  SubagentStatus,
  ToolCall,
  ToolResult,
  UsageSource,
} from "../../types/index";
import type { CompactionSettings } from "./../compaction";
import { applyModelConstraints } from "./../model-constraints";
import type { SessionPromptContext } from "./../prompt-context";
import { buildSystemPrompt } from "./../prompts";
import type { SessionToolsets } from "./../session-toolsets";
import { resolvePresentation as resolveToolPresentation, type ToolPresentation } from "./../tool-presentation";
import { TraceCollector } from "./../trace-collector";
import { closingToolMessage, deniedToolMessage } from "./../turns/helpers";
import { runStreamTurn } from "./../turns/stream-turn";
import type { ProcessMessageObserver, TurnContext } from "./../turns/types";
import type { TurnTerminalState } from "./../types";
import { buildVisionUserMessages } from "./../vision-input";

interface TurnState {
  abortController: AbortController | null;
  activeTrace: TraceCollector | null;
  batchApi: boolean;
  currentProviderSession: unknown;
  isProcessingTurn: boolean;
  maxTokens: number;
  maxToolRounds: number;
  messageSeqs: Array<number | null>;
  messages: ModelMessage[];
  mode: AgentMode;
  modelAdapterId: string | undefined;
  modelId: string;
  pendingApprovalId: string | null;
  planContext: string | null;
  presentationOption: ToolPresentation | undefined;
  promptContext: SessionPromptContext;
  session: SessionInfo | null;
  sessionStartHookFired: boolean;
  sessionStore: SessionStore | null;
  toolsets: SessionToolsets;
  turnUserMessage: ModelMessage | null;
  partialTurnSnapshot: (() => ModelMessage[]) | null;
  compactForContext(
    runtime: Pick<KernelModelRuntime, "model" | "modelInfo" | "providerOptions">,
    system: string,
    contextWindow: number,
    signal: AbortSignal,
    settings?: CompactionSettings,
    force?: boolean,
  ): Promise<boolean>;
  drainBackgroundNotifications(): Promise<void>;
  emitSubagentStatus(status: SubagentStatus | null, runKey?: string): void;
  executeBatchToolCall(
    tools: ToolSet,
    toolCall: ToolCall,
    messages: ModelMessage[],
    signal?: AbortSignal,
  ): Promise<{ input: unknown; result: ToolResult }>;
  fireHook(input: HookInput, signal?: AbortSignal): Promise<AggregatedHookResult>;
  getBatchClientOptions(signal?: AbortSignal): BatchClientOptions;
  getCompactionSettings(): CompactionSettings;
  getCwd(): string;
  getSessionId(): string | null;
  processMessageBatchTurn(args: {
    userModelMessage: ModelMessage;
    observer?: ProcessMessageObserver;
    system: string;
    runtime: KernelModelRuntime;
    modelInfo: ReturnType<typeof getModelInfo>;
    signal: AbortSignal;
  }): AsyncGenerator<StreamChunk, void, unknown>;
  processMessageViaSession(args: {
    userMessage: string;
    userModelMessage: ModelMessage;
    observer?: ProcessMessageObserver;
    runtime: KernelModelRuntime;
    signal: AbortSignal;
  }): AsyncGenerator<StreamChunk, void, unknown>;
  recordUsage(
    usage?: {
      totalTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    },
    source?: UsageSource,
    model?: string,
  ): void;
  refreshSessionRecap(signal?: AbortSignal): Promise<void>;
  resolveAdaptiveModel(userMessage: string): { modelId: string; note?: string };
}

function st(self: object): TurnState {
  return self as unknown as TurnState;
}

const PENDING_APPROVAL_DENIED_REASON = "User declined: sent a new message instead of approving";

const failedTurnNote = (error: string): string =>
  `[Turn failed before the assistant replied: ${error}. Any tools that had already started may have completed — check the current state before retrying.]`;

const EXITED_TURN_NOTE =
  "[Turn interrupted because the app exited. Any tools that had already started may have completed — check the current state before assuming this turn had no effect.]";

const exitPersistedTurns = new WeakSet<ModelMessage>();

/**
 * Append the note to a trailing assistant message rather than after it, so a
 * cancelled turn with partial output keeps user/assistant alternation.
 */
function withTrailingNote(partial: ModelMessage[], note: string): ModelMessage[] {
  const last = partial[partial.length - 1];
  if (last?.role !== "assistant") return [...partial, { role: "assistant", content: note }];
  const merged: ModelMessage =
    typeof last.content === "string"
      ? { ...last, content: last.content ? `${last.content}\n\n${note}` : note }
      : { ...last, content: [...last.content, { type: "text", text: note }] };
  return [...partial.slice(0, -1), merged];
}

const CANCELLED_TURN_NOTE =
  "[Turn cancelled by the user. Any tools that had already started may have completed — check the current state before assuming this turn had no effect.]";

// biome-ignore lint/suspicious/noExplicitAny: TS mixin base constraint must accept any[] (TS2545).
type MixinConstructor = new (...args: any[]) => object;

export function TurnEngineMixin<TBase extends MixinConstructor>(Base: TBase) {
  return class TurnEngine extends Base {
    /**
     * Keep a cancelled turn in the transcript, marked as cancelled.
     *
     * Splicing the user message back out left no trace the turn happened. For
     * an owning adapter that is a lie: its subprocess keeps its own history,
     * including any tools it already ran, so the two transcripts diverge —
     * and the mirror is what feeds the resume preface, the compaction
     * summariser and any model switch. The note tells the model the gap is a
     * gap, instead of letting it conclude the work was never done.
     */
    recordCancelledTurn(
      userMessage: ModelMessage,
      partialMessages: ModelMessage[] = [],
      note = CANCELLED_TURN_NOTE,
    ): void {
      if (st(this).messages.lastIndexOf(userMessage) < 0) return;
      // The exit path already wrote this turn; a late cancel must not write it twice.
      if (exitPersistedTurns.has(userMessage)) return;
      // An interrupt can land between an approval being granted and the tool
      // running. The SDK executes an approved call on the NEXT request and
      // synthesizes nothing if that request never comes, so the call has to be
      // closed here or the transcript keeps an open one forever.
      const closing = closingToolMessage(st(this).messages);
      this.appendCompletedTurn(userMessage, [
        ...(closing ? [closing] : []),
        ...withTrailingNote(partialMessages, note),
      ]);
    }

    /**
     * Persist the turn in flight before the process exits. Ctrl+C quits
     * without the turn generator ever reaching its cancel path, so without this
     * the user's prompt and everything streamed since were never written and
     * the resumed session ended at the previous turn.
     */
    persistInFlightTurn(): void {
      const userMessage = st(this).turnUserMessage;
      if (!userMessage) return;
      let partial: ModelMessage[] = [];
      try {
        partial = st(this).partialTurnSnapshot?.() ?? [];
      } catch {
        partial = [];
      }
      st(this).partialTurnSnapshot = null;
      this.recordCancelledTurn(userMessage, partial, EXITED_TURN_NOTE);
      exitPersistedTurns.add(userMessage);
    }

    /**
     * Keep a failed turn in the transcript, marked as failed.
     *
     * A turn that failed before committing anything left its user message in
     * memory but never wrote it: the next turn persists only its own message,
     * so a resume showed a different history than the one the model had been
     * sent. Same resolution as a cancelled turn — persist it with a note.
     * Only when nothing was committed; a turn that kept partial output has
     * already written its user message.
     */
    recordFailedTurn(error: string): void {
      const userMessage = st(this).turnUserMessage;
      const messages = st(this).messages;
      if (!userMessage || messages[messages.length - 1] !== userMessage) return;
      // On an approval continuation the anchor is the granted approval, and
      // the SDK only runs the approved call on a request that succeeds. A
      // failure before step 1 leaves that call with no result, and the
      // approval stops counting the moment anything follows it — so close it
      // here, exactly as a cancelled turn does.
      const closing = closingToolMessage(messages);
      const note: ModelMessage = { role: "assistant", content: failedTurnNote(error) };
      this.appendCompletedTurn(userMessage, closing ? [closing, note] : [note]);
    }

    turnContext(): TurnContext {
      return {
        getMessages: () => st(this).messages,
        mode: st(this).mode,
        maxToolRounds: st(this).maxToolRounds,
        maxTokens: st(this).maxTokens,
        getSessionId: () => st(this).getSessionId(),
        getCompactionSettings: () => st(this).getCompactionSettings(),
        getBatchClientOptions: (signal) => st(this).getBatchClientOptions(signal),
        recordUsage: (usage, source, model) => st(this).recordUsage(usage, source, model),
        appendCompletedTurn: (userMessage, newMessages) => this.appendCompletedTurn(userMessage, newMessages),
        terminalizeCancelledTurn: (userMessage, partialMessages) =>
          this.terminalizeCancelledTurn(userMessage, partialMessages),
        setPartialTurnSnapshot: (snapshot) => {
          st(this).partialTurnSnapshot = snapshot;
        },
        emitTurnStop: (signal) => this.emitTurnStop(signal),
        emitTurnStopFailure: (error, signal) => this.emitTurnStopFailure(error, signal),
        refreshSessionRecap: (signal) => st(this).refreshSessionRecap(signal),
        compactForContext: (runtime, system, contextWindow, signal, settings, force) =>
          st(this).compactForContext(runtime, system, contextWindow, signal, settings, force),
        buildSharedTurnToolset: (args) =>
          st(this).toolsets.buildShared({
            ...args,
            presentation: resolveToolPresentation(st(this).presentationOption),
          }),
        executeBatchToolCall: (tools, toolCall, messages, signal) =>
          st(this).executeBatchToolCall(tools, toolCall, messages, signal),
        setCurrentProviderSession: (session) => {
          st(this).currentProviderSession = session;
        },
      };
    }

    /**
     * Normalize all terminal turn states. A user cancellation deliberately
     * persists a neutral trace but fires neither Stop nor StopFailure; those
     * hooks describe model completion and model failure, not a human interrupt.
     */
    async terminalizeTurn(terminal: TurnTerminalState): Promise<void> {
      if (terminal.kind === "cancelled") {
        // The turn never committed its tool call, so nothing is parked on the
        // approval any more.
        st(this).pendingApprovalId = null;
        st(this).partialTurnSnapshot = null;
        if (terminal.userModelMessage) {
          this.recordCancelledTurn(terminal.userModelMessage, terminal.partialMessages);
        }
      }

      st(this).activeTrace?.finish(terminal.kind, terminal.kind === "cancelled" ? null : this.lastAssistantText());
      st(this).activeTrace = null;

      // After the trace: the note is bookkeeping, not the turn's result.
      if (terminal.kind === "failure") this.recordFailedTurn(terminal.error);

      if (terminal.kind === "cancelled") {
        return;
      }

      const input: StopHookInput | StopFailureHookInput =
        terminal.kind === "success"
          ? {
              hook_event_name: "Stop",
              session_id: st(this).session?.id,
              cwd: getHostServices().bash.cwd(),
            }
          : {
              hook_event_name: "StopFailure",
              error: terminal.error,
              session_id: st(this).session?.id,
              cwd: getHostServices().bash.cwd(),
            };
      const label = terminal.kind === "success" ? "Stop" : "StopFailure";
      await st(this)
        .fireHook(input, terminal.signal)
        .catch((err) => {
          console.error(`[agent] ${label} hook failed:`, err);
        });
    }

    async terminalizeCancelledTurn(userModelMessage: ModelMessage, partialMessages?: ModelMessage[]): Promise<void> {
      await this.terminalizeTurn({ kind: "cancelled", userModelMessage, partialMessages });
    }

    /** Fire the Stop hook and record a successful terminal state. */
    async emitTurnStop(signal: AbortSignal): Promise<void> {
      await this.terminalizeTurn({ kind: "success", signal });
    }

    /** Fire the StopFailure hook and record a failed terminal state. */
    async emitTurnStopFailure(error: string, signal: AbortSignal): Promise<void> {
      await this.terminalizeTurn({ kind: "failure", error, signal });
    }

    /** Extract the assistant text of the latest turn (used as the trace
     *  `result`). Multi-round turns persist one assistant message per tool
     *  round, so walk back to the turn's user message and join every
     *  assistant segment in order. Returns null if none. */
    lastAssistantText(): string | null {
      const texts: string[] = [];
      for (let i = st(this).messages.length - 1; i >= 0; i--) {
        const msg = st(this).messages[i];
        if (msg.role === "user") break;
        if (msg.role !== "assistant") continue;
        const content = msg.content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .map((part) =>
                    typeof part === "object" && part && "type" in part && part.type === "text" ? part.text : "",
                  )
                  .join("")
              : "";
        texts.unshift(text);
      }
      const joined = texts.join("");
      return joined || null;
    }

    /** Compose the caller's observer with one that feeds `st(this).activeTrace`, so
     *  trace collection happens for every turn regardless of what the caller
     *  passes. Forwards all callbacks to the caller first. */
    composeTraceObserver(caller: ProcessMessageObserver | undefined): ProcessMessageObserver {
      return {
        onStepStart: (info) => caller?.onStepStart?.(info),
        onStepFinish: (info) => {
          caller?.onStepFinish?.(info);
          st(this).activeTrace?.onGenerateStep({ finishReason: info.finishReason, timestampMs: info.timestamp });
        },
        onToolStart: (info) => {
          caller?.onToolStart?.(info);
          let args: unknown;
          try {
            args = JSON.parse(info.toolCall.function.arguments);
          } catch {
            args = info.toolCall.function.arguments;
          }
          st(this).activeTrace?.onToolStart({
            toolCallId: info.toolCall.id,
            toolName: info.toolCall.function.name,
            input: args,
            timestampMs: info.timestamp,
            // Read live, not once per turn: a `cd` moves this mid-turn, and skill
            // attribution needs the directory THIS call resolved against.
            cwd: st(this).getCwd(),
          });
        },
        onToolFinish: (info) => {
          caller?.onToolFinish?.(info);
          st(this).activeTrace?.onToolFinish({
            toolCallId: info.toolCall.id,
            toolName: info.toolCall.function.name,
            output: info.toolResult.output ?? info.toolResult.error ?? null,
            success: info.toolResult.success,
            timestampMs: info.timestamp,
          });
        },
        onError: (info) => caller?.onError?.(info),
      };
    }

    /** Record an approval the turn parked on, so a turn that ends without one
     *  arriving can be closed before the next request goes out. */
    async *trackPendingApproval(
      source: AsyncGenerator<StreamChunk, void, unknown>,
    ): AsyncGenerator<StreamChunk, void, unknown> {
      for await (const chunk of source) {
        if (chunk.type === "tool_approval_request" && chunk.approvalId) {
          st(this).pendingApprovalId = chunk.approvalId;
        }
        yield chunk;
      }
    }

    /**
     * Deny an approval nothing ever answered.
     *
     * A parked call is an assistant `tool-call` with no result. That is fine
     * while the user is deciding, but if they type something else instead the
     * next request carries an unanswered call, which providers reject. The
     * denial is persisted immediately: the next `appendCompletedTurn` writes
     * only the new user message and the turn after it, so a denial left in
     * memory would vanish on resume and leave the stored history broken.
     */
    closePendingApproval(): void {
      const approvalId = st(this).pendingApprovalId;
      if (!approvalId) return;
      st(this).pendingApprovalId = null;

      // Only settle a call that actually reached the transcript. A turn that
      // was cancelled or failed to commit yielded the approval chunk but
      // persisted no tool-call, so answering it here would add an orphan
      // result for a call that exists nowhere — the same shape this whole
      // change exists to prevent.
      //
      // A `tool-approval-response` would not do: the SDK only reads one while
      // it is the last message and strips it from the wire otherwise, so the
      // user message that follows would leave the call open. A real result
      // closes every call the parked turn left open (parallel approvals too).
      const denial = deniedToolMessage(st(this).messages, PENDING_APPROVAL_DENIED_REASON);
      if (!denial) return;
      st(this).messages.push(denial);
      const seq =
        st(this).sessionStore && st(this).session ? (appendMessages(st(this).session!.id, [denial])[0] ?? null) : null;
      st(this).messageSeqs.push(seq);
    }

    appendCompletedTurn(userMessage: ModelMessage, newMessages: ModelMessage[]): void {
      if (newMessages.length === 0) return;

      const userIndex = st(this).messages.lastIndexOf(userMessage);
      if (!st(this).sessionStore || !st(this).session) {
        if (userIndex >= 0 && st(this).messageSeqs[userIndex] == null) {
          st(this).messageSeqs[userIndex] = null;
        }
        st(this).messages.push(...newMessages);
        st(this).messageSeqs.push(...newMessages.map(() => null));
        return;
      }

      const insertedSeqs = appendMessages(st(this).session!.id, [userMessage, ...newMessages]);
      if (userIndex >= 0) {
        st(this).messageSeqs[userIndex] = insertedSeqs[0] ?? st(this).messageSeqs[userIndex];
      }
      st(this).messages.push(...newMessages);
      st(this).messageSeqs.push(...insertedSeqs.slice(1));
      st(this).sessionStore!.touchSession(st(this).session!.id, getHostServices().bash.cwd());
      st(this).session = st(this).sessionStore!.getRequiredSession(st(this).session!.id);
    }

    async *continueAfterToolApproval(observer?: ProcessMessageObserver): AsyncGenerator<StreamChunk, void, unknown> {
      const anchor = st(this).messages[st(this).messages.length - 1];
      if (!anchor) {
        throw new Error("continueAfterToolApproval: message history is empty");
      }
      yield* this.processMessage("", observer, { preExistingAnchor: anchor });
    }

    async *processMessage(
      userMessage: string,
      callerObserver?: ProcessMessageObserver,
      options: { preExistingAnchor?: ModelMessage } = {},
    ): AsyncGenerator<StreamChunk, void, unknown> {
      st(this).abortController = new AbortController();
      const signal = st(this).abortController!.signal;
      st(this).emitSubagentStatus(null);
      // From here `st(this).messages` is owned by the turn; the UI poll timer must
      // queue background notifications rather than splice them into it.
      st(this).isProcessingTurn = true;

      // Single owner for the abort-controller lifecycle and StopFailure emission.
      // `enteredTurn` flips true once a turn state machine takes over — each one
      // already owns its own StopFailure on its error paths, so the catch below
      // only fires StopFailure for a setup-phase throw (hooks, vision build,
      // runtime resolution). The outer finally guarantees the controller is
      // cleared on every exit, including a setup exception, so a failed setup
      // can't leave stale in-flight state behind.
      let enteredTurn = false;
      let userModelMessage: ModelMessage | undefined;
      try {
        let effectiveUserMessage = userMessage;

        if (options.preExistingAnchor) {
          // Continuation path (post tool-approval). Skip:
          //   - UserPromptSubmit hook (no new user input)
          //   - vision message build (no new user input)
          //   - message push (the anchor — typically a tool-approval-response — is
          //     already at the end of st(this).messages, pushed by respondToToolApproval)
          //   - background-notification drain: the SDK only acts on an approval
          //     response that is the LAST message, so nothing may land after it.
          //     Notifications stay queued for the next user turn.
          // The SessionStart hook still runs on first invocation.
          if (!st(this).sessionStartHookFired) {
            st(this).sessionStartHookFired = true;
            const isResume = st(this).messages.length > 0;
            const sessionStartInput: SessionStartHookInput = {
              hook_event_name: "SessionStart",
              source: isResume ? "resume" : "startup",
              session_id: st(this).session?.id,
              cwd: getHostServices().bash.cwd(),
            };
            await st(this)
              .fireHook(sessionStartInput, signal)
              .catch(() => null);
          }
          userModelMessage = options.preExistingAnchor;
          st(this).turnUserMessage = userModelMessage;
        } else {
          const hookContexts: string[] = [];

          if (!st(this).sessionStartHookFired) {
            st(this).sessionStartHookFired = true;
            const isResume = st(this).messages.length > 0;
            const sessionStartInput: SessionStartHookInput = {
              hook_event_name: "SessionStart",
              source: isResume ? "resume" : "startup",
              session_id: st(this).session?.id,
              cwd: getHostServices().bash.cwd(),
            };
            const sessionStartResult = await st(this)
              .fireHook(sessionStartInput, signal)
              .catch(() => null);
            if (sessionStartResult?.additionalContexts.length) {
              hookContexts.push(...sessionStartResult.additionalContexts);
            }
          }

          const promptInput: UserPromptSubmitHookInput = {
            hook_event_name: "UserPromptSubmit",
            user_prompt: userMessage,
            session_id: st(this).session?.id,
            cwd: getHostServices().bash.cwd(),
          };
          const promptResult = await st(this)
            .fireHook(promptInput, signal)
            .catch(() => null);
          if (promptResult?.additionalContexts.length) {
            hookContexts.push(...promptResult.additionalContexts);
          }

          // The user answered the approval prompt with a new instruction
          // instead of a decision. Settle the parked call before their message
          // joins the history, or the next request carries an open tool call.
          // It runs before the notification drain: anything spliced in between
          // a call and its result is rejected by the provider.
          this.closePendingApproval();

          await st(this).drainBackgroundNotifications();

          // If any hook returned additionalContext, prepend it to the user message
          // as a <system-reminder> block. The model treats this as authoritative
          // out-of-band context (same convention as Claude Code's hook contracts).
          effectiveUserMessage =
            hookContexts.length > 0
              ? `<system-reminder>\n${hookContexts.join("\n\n")}\n</system-reminder>\n\n${userMessage}`
              : userMessage;
          const userModelMessages = await buildVisionUserMessages(effectiveUserMessage, st(this).getCwd(), signal);
          userModelMessage =
            userModelMessages[0] ?? ({ role: "user", content: effectiveUserMessage } satisfies ModelMessage);
          st(this).messages.push(userModelMessage);
          st(this).messageSeqs.push(null);
          st(this).turnUserMessage = userModelMessage;
        }

        // Learned adaptive routing (opt-in). Skip on continuation turns (no new
        // user input to classify). When it overrides the user's model, `note`
        // carries a visible inline announcement we yield before any output.
        const route = options.preExistingAnchor
          ? { modelId: st(this).modelId }
          : st(this).resolveAdaptiveModel(userMessage);
        const turnModelId = route.modelId;

        const subagents = st(this).promptContext.roster();
        const system = applyModelConstraints(
          buildSystemPrompt(
            getHostServices().bash.cwd(),
            st(this).mode,
            getHostServices().bash.getSandboxMode(),
            st(this).planContext,
            subagents,
            getHostServices().bash.getSandboxSettings(),
            st(this).promptContext.skillsSection(getHostServices().bash.cwd(), userMessage),
            st(this).promptContext.notes(),
            st(this).promptContext.instructions(getHostServices().bash.cwd()),
          ),
          turnModelId,
        );
        const runtime = await resolveModelRuntimeViaKernel(turnModelId, st(this).getSessionId() ?? "ephemeral", {
          adapterId: turnModelId === st(this).modelId ? st(this).modelAdapterId : undefined,
        });
        const modelInfo = runtime.modelInfo;
        if (route.note) {
          yield { type: "content", content: route.note } satisfies StreamChunk;
        }

        // Begin the learning-loop trace for this turn. Only when persisting to a
        // real session (recordTrace FKs to sessions). The composed observer feeds
        // step/tool data into activeTrace AND forwards to the caller's observer,
        // so collection happens for every turn regardless of caller (UI, headless,
        // Telegram). Finalized in emitTurnStop / emitTurnStopFailure.
        st(this).activeTrace = st(this).session
          ? new TraceCollector({
              sessionId: st(this).session!.id,
              query: userMessage,
              model: runtime.modelId,
              cwd: getHostServices().bash.cwd(),
              agentMode: st(this).mode,
            })
          : null;
        const observer = this.composeTraceObserver(callerObserver);

        st(this).planContext = null;

        // Agent-SDK / owning adapter branch: route through session.sendTurn()
        // instead of streamText(). No grok tools are passed — the adapter owns
        // its own tool runtime (e.g. Claude CLI's built-in tools).
        if (runtimeUsesSendTurn(runtime)) {
          enteredTurn = true;
          yield* this.trackPendingApproval(
            st(this).processMessageViaSession({
              userMessage: effectiveUserMessage,
              userModelMessage,
              observer,
              runtime,
              signal,
            }),
          );
          return;
        }

        if (st(this).batchApi) {
          enteredTurn = true;
          yield* this.trackPendingApproval(
            st(this).processMessageBatchTurn({
              userModelMessage,
              observer,
              system,
              runtime,
              modelInfo,
              signal,
            }),
          );
          return;
        }

        // streamText turn loop. Implementation: ./turns/stream-turn.ts.
        enteredTurn = true;
        yield* this.trackPendingApproval(
          runStreamTurn(this.turnContext(), {
            userModelMessage,
            observer,
            system,
            runtime,
            modelInfo,
            signal,
          }),
        );
      } catch (err) {
        // A throw that escapes here before a turn took over is a setup-phase
        // failure — finalize the trace and fire StopFailure so the contract holds
        // even when setup blows up. Once `enteredTurn` is set the turn machine
        // already emitted StopFailure on its own error path; don't double-emit.
        if (!enteredTurn) {
          if (signal.aborted) {
            if (userModelMessage) {
              await this.terminalizeCancelledTurn(userModelMessage);
            } else {
              await this.terminalizeTurn({ kind: "cancelled" });
            }
            yield { type: "content", content: "\n\n[Cancelled]" } satisfies StreamChunk;
            yield { type: "done" };
            return;
          }
          const friendly = err instanceof Error ? err.message : String(err);
          await this.emitTurnStopFailure(friendly, signal);
        }
        throw err;
      } finally {
        st(this).turnUserMessage = null;
        st(this).partialTurnSnapshot = null;
        st(this).isProcessingTurn = false;
        if (st(this).abortController?.signal === signal) {
          st(this).abortController = null;
        }
      }
    }
  };
}
