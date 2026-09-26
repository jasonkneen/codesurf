// Provider-session turn loop (moved verbatim out of agent.ts; `this.*`
// became `ctx.*`).
//
// Processes one turn through a ProviderSession that owns its own turn loop
// (Claude Agent SDK, Codex CLI). The session's `sendTurn` streams its own
// events; we translate them into the Agent's StreamChunk envelope so the UI
// treats them the same as an xAI / Anthropic streamText response.
//
// This path does NOT pass grok's tool set to the upstream — the adapter has
// its own tool runtime (e.g. Claude CLI's Read/Bash/Edit).

import type { ModelMessage } from "ai";
import {
  getHostServices,
  type KernelModelRuntime,
  type ProviderStreamEvent,
  type ProviderUsageSnapshot,
} from "../../core/plugins";
import { totalBilledTokens } from "../../core/plugins/builtin/provider-usage";
import type { EditPrecheck, StreamChunk, ToolCall, ToolResult } from "../../types/index";
import { detectClaimWithoutTool, formatFabricationWarning } from "../fabrication-detector";
import { containsEncryptedReasoning } from "../reasoning";
import {
  buildProviderTurnMessages,
  capToolOutput,
  closeDanglingToolCalls,
  notifyObserver,
  parseToolArgumentsOrRaw,
} from "./helpers";
import type { ExecutedBatchTool, ProcessMessageObserver, TurnContext } from "./types";

/** The input `computeEditPreview` accepts — kept structurally linked so a
 *  renamed preview field is a compile error here, not a silent lost diff. */
type EditPreviewInput = Parameters<typeof import("../../tools/file").computeEditPreview>[1];

export type ProviderEditApproval =
  /** A faithful single-file preview can be computed from `input`. */
  | { kind: "preview"; outboundName: "write_file" | "edit_file"; input: EditPreviewInput }
  /** A file tool whose change cannot be previewed faithfully; the UI still
   *  routes to the edit panel (via `outboundName`) but gets no diff. */
  | { kind: "unsupported"; outboundName: "write_file" | "edit_file"; reason: string }
  /** Not a file tool — forwarded as-is. */
  | { kind: "passthrough" };

/**
 * How a provider's terminator is read.
 *
 * Adapters forward their upstream's own vocabulary (Anthropic stop reasons,
 * OpenAI finish reasons, opencode's and lazar's own strings), so an unlisted
 * reason means "finished" rather than "failed" — classifying the unknown as a
 * failure would invent errors on providers whose vocabulary is not enumerable
 * from here. Only reasons that definitely are not a completed turn are listed.
 */
const CANCELLED_STOP_REASONS = new Set(["aborted", "cancelled", "canceled"]);
const FAILED_STOP_REASONS = new Set(["error", "refusal", "max_iterations", "max_turns", "error_max_turns"]);
/** Ran out of room mid-answer: a real reply, just cut short. Matches the
 *  streamText path, which warns on `finishReason === "length"` and still
 *  settles the turn as a success. `incomplete` is the OpenAI Responses
 *  vocabulary for the same thing (max_output_tokens or a content filter). */
const TRUNCATED_STOP_REASONS = new Set(["length", "max_tokens", "incomplete"]);
const TRUNCATION_NOTICE =
  '\n\n_(Output stopped at the token limit — the reply may be truncated. Send "continue" to resume.)_';

/**
 * Backstop for a provider that goes silent. Adapter and transport watchdogs
 * are tighter and fire first; this one exists so that coverage does not depend
 * on every adapter remembering to guard itself — without it a wedged
 * subprocess leaves the turn with no terminal state at all, which no restart
 * clears because nothing was ever written.
 *
 * Deliberately generous: the gap between dispatching a tool call and its
 * result is dead air on some adapters, and a long build or test run inside
 * that gap is not a stall. `CODESURF_TURN_STALL_MS=0` disables it.
 */
const DEFAULT_TURN_STALL_MS = 900_000;

function resolveTurnStallMs(): number {
  const raw = process.env.CODESURF_TURN_STALL_MS;
  if (raw === undefined) return DEFAULT_TURN_STALL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TURN_STALL_MS;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function adaptSingleEdit(path: string, edit: Record<string, unknown>): ProviderEditApproval {
  if (edit.replace_all === true) {
    // `computeEditPreview` renders a single occurrence; a replace_all edit
    // would be shown as a "matched N times" warning, which misdescribes it.
    return {
      kind: "unsupported",
      outboundName: "edit_file",
      reason: `replace_all edits cannot be previewed (${path || "unknown path"})`,
    };
  }
  return {
    kind: "preview",
    outboundName: "edit_file",
    input: { path, old_string: stringField(edit, "old_string"), new_string: stringField(edit, "new_string") },
  };
}

/**
 * Typed adapter from an owning provider's file-tool approval input to the
 * native preview input. The Claude Agent SDK names its tools `Write` / `Edit`
 * / `MultiEdit` with a `file_path` param; codesurf's own tools (which an
 * adapter may re-expose) use `write_file` / `edit_file` with `path`. Both
 * already share `content` / `old_string` / `new_string`. The original input
 * is never altered — it still travels with the ToolCall for execution.
 */
export function adaptProviderEditApproval(toolName: string, input: unknown): ProviderEditApproval {
  const lowerName = toolName.toLowerCase();
  const record = asRecord(input);
  const path = stringField(record, "path", "file_path") ?? "";
  if (lowerName === "write" || lowerName === "write_file") {
    return { kind: "preview", outboundName: "write_file", input: { path, content: stringField(record, "content") } };
  }
  if (lowerName === "edit" || lowerName === "edit_file") {
    return adaptSingleEdit(path, record);
  }
  if (lowerName === "multiedit") {
    const edits = Array.isArray(record.edits) ? record.edits : [];
    if (edits.length === 1) {
      return adaptSingleEdit(path, asRecord(edits[0]));
    }
    return {
      kind: "unsupported",
      outboundName: "edit_file",
      reason: `MultiEdit preview is not supported (${edits.length} edits to ${path || "unknown path"})`,
    };
  }
  return { kind: "passthrough" };
}

export async function* runSessionTurn(
  ctx: TurnContext,
  args: {
    userMessage: string;
    userModelMessage: ModelMessage;
    observer?: ProcessMessageObserver;
    runtime: KernelModelRuntime;
    signal: AbortSignal;
  },
): AsyncGenerator<StreamChunk, void, unknown> {
  const { runtime } = args;
  const session = runtime.session;
  if (!session?.sendTurn) {
    yield {
      type: "error",
      content: `Provider adapter "${runtime.adapterId ?? "unknown"}" is installed but cannot execute turns (no sendTurn). Check extension configuration.`,
    } satisfies StreamChunk;
    return;
  }
  // Track the active owning-adapter session so `respondToToolApproval` and
  // `Agent.abort()` can forward into the running turn. Cleared in the finally
  // below regardless of how the turn settles — including when the consumer
  // abandons this generator mid-stream (e.g. on an Esc interrupt), which the
  // two terminal returns alone would miss and leave a stale session pointer.
  ctx.setCurrentProviderSession(session);

  try {
    // `session.sendTurn` is non-null here (guarded above); the cast carries that
    // through to the inner generator's narrowed parameter type.
    yield* runSessionTurnInner(ctx, args, session as Parameters<typeof runSessionTurnInner>[2]);
  } finally {
    ctx.setCurrentProviderSession(null);
  }
}

async function* runSessionTurnInner(
  ctx: TurnContext,
  args: {
    userMessage: string;
    userModelMessage: ModelMessage;
    observer?: ProcessMessageObserver;
    runtime: KernelModelRuntime;
    signal: AbortSignal;
  },
  // `sendTurn` is guaranteed present — the caller returns early when absent.
  session: NonNullable<KernelModelRuntime["session"]> & {
    sendTurn: NonNullable<NonNullable<KernelModelRuntime["session"]>["sendTurn"]>;
  },
): AsyncGenerator<StreamChunk, void, unknown> {
  const { userMessage, userModelMessage, observer, runtime, signal } = args;

  notifyObserver(observer?.onStepStart, {
    stepNumber: 1,
    timestamp: Date.now(),
  });

  // `buffer` is the un-flushed delta bucket; `fullText` accumulates every
  // text delta across the whole turn so we can persist the completed
  // assistant message after the loop even once buffer has been flushed.
  let buffer = "";
  let fullText = "";
  const flush = function* (): Generator<StreamChunk> {
    if (buffer.length === 0) return;
    const text = buffer;
    buffer = "";
    yield { type: "content", content: text } satisfies StreamChunk;
  };

  // Buffered stream events from the session; we translate and yield in the
  // main generator below.
  const queue: Array<
    | { kind: "text"; delta: string }
    | { kind: "status"; status: string; message?: string }
    | { kind: "reasoning"; delta: string }
    | { kind: "tool_call"; id: string; toolName: string; args: unknown }
    | { kind: "tool_result"; id: string; result: unknown; isError?: boolean }
    | { kind: "tool_approval_request"; approvalId: string; toolName: string; input: unknown }
    | { kind: "questionnaire_request"; title?: string; questions: unknown }
    | { kind: "error"; message: string }
    | { kind: "usage"; usage: ProviderUsageSnapshot }
    | { kind: "cancelled" }
    | { kind: "done"; stopReason?: string }
    // `sendTurn` settled without the provider ever emitting a terminator.
    // Kept distinct from `done` so "the turn finished" and "the stream just
    // stopped" cannot be confused for one another.
    | { kind: "settled" }
  > = [];
  // Mirrors the xAI direct-stream path: if the upstream emits PGP-style
  // encrypted reasoning, hide it once and stop forwarding deltas for the
  // rest of the turn. Claude thinking is plaintext, but the guard costs
  // nothing and keeps both paths shaped the same.
  let reasoningPreview = "";
  let encryptedReasoningHidden = false;
  // Track tool calls as they arrive so tool_result events can be paired
  // with the original name/arguments (the SDK's tool_result block only
  // carries the tool_use_id).
  const pendingToolCalls = new Map<string, ToolCall>();
  const completedToolCalls: ToolCall[] = [];
  // One round per model step: the text the model wrote, the tool calls it
  // issued, and their results. Persisting `[assistant, tool]` per round (the
  // shape the ai-sdk path already stores) keeps the transcript in the order
  // the user watched it happen — text → tool → text — instead of one merged
  // assistant message followed by every tool row.
  type TurnRound = { text: string; toolCalls: ToolCall[]; toolParts: ExecutedBatchTool[] };
  const rounds: TurnRound[] = [{ text: "", toolCalls: [], toolParts: [] }];
  const currentRound = (): TurnRound => rounds[rounds.length - 1]!;
  const openRoundIfSettled = (): void => {
    if (currentRound().toolParts.length > 0) rounds.push({ text: "", toolCalls: [], toolParts: [] });
  };
  // Closed across the flattened turn, not per round: a call issued in one
  // round can be answered in the next, and closing round by round would
  // synthesize a second result for it.
  const buildTurnMessages = () =>
    closeDanglingToolCalls(rounds.flatMap((r) => buildProviderTurnMessages(r.text, r.toolCalls, r.toolParts)));
  // Lets an app exit mid-turn persist what has streamed so far.
  ctx.setPartialTurnSnapshot?.(buildTurnMessages);
  let resolveWaiter: (() => void) | null = null;
  const waitForEvent = () =>
    new Promise<void>((resolve) => {
      resolveWaiter = resolve;
    });
  const tick = () => {
    const r = resolveWaiter;
    resolveWaiter = null;
    r?.();
  };

  // Unlike direct AI-SDK streams, a provider-owned session can wait on its
  // own subprocess indefinitely. Wake the queue immediately on host abort so
  // the Agent can terminalize even if that provider is slow to acknowledge.
  //
  // The queue, the abort listener and the provider's `emit` callback form
  // one turn-scoped effect: `disposed` flips as soon as the consuming loop
  // ends (or the consumer abandons this generator at a yield), after which
  // every late provider event is dropped instead of accumulating in a queue
  // nobody drains. The `finally` below removes the listener unconditionally.
  let cancelled = false;
  let disposed = false;
  const queueCancellation = () => {
    if (cancelled || disposed) return;
    cancelled = true;
    queue.push({ kind: "cancelled" });
    tick();
  };

  const stallMs = resolveTurnStallMs();
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStallWatchdog = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
  };
  const armStallWatchdog = () => {
    if (stallMs <= 0 || disposed || cancelled) return;
    clearStallWatchdog();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (disposed || cancelled) return;
      // Terminalizing our side leaves the adapter mid-turn, and a persistent
      // session refuses the next sendTurn while one is active. Best-effort,
      // matching Agent.abort(): a stall guard must never throw.
      try {
        void Promise.resolve(session.abortTurn?.()).catch(() => {});
      } catch {
        // abortTurn threw synchronously — the turn still terminalizes.
      }
      queue.push({
        kind: "error",
        message: `${runtime.adapterId ?? "The provider"} sent nothing for ${Math.round(stallMs / 1000)}s — giving up on this turn.`,
      });
      tick();
    }, stallMs);
    stallTimer.unref?.();
  };
  if (signal.aborted) {
    queueCancellation();
  } else {
    signal.addEventListener("abort", queueCancellation, { once: true });
  }
  const removeAbortListener = () => signal.removeEventListener("abort", queueCancellation);

  try {
    if (cancelled) {
      await ctx.terminalizeCancelledTurn(userModelMessage, buildTurnMessages());
      yield { type: "content", content: "\n\n[Cancelled]" } satisfies StreamChunk;
      yield { type: "done" };
      return;
    }

    const turnInput = {
      conversationId: ctx.getSessionId() ?? "ephemeral",
      providerId: runtime.providerId ?? "unknown",
      adapterId: runtime.adapterId ?? "unknown",
      modelId: runtime.modelId,
      prompt: userMessage,
      messages: ctx.getMessages(),
      abortSignal: signal,
    };
    const turnController = {
      emit: (event: ProviderStreamEvent) => {
        if (disposed) return;
        // Lifecycle pings prove the transport is alive, not that the turn is
        // progressing — a provider looping on `status` must still time out.
        if (event.type !== "status") armStallWatchdog();
        switch (event.type) {
          case "text-delta":
            queue.push({ kind: "text", delta: event.delta });
            tick();
            break;
          case "reasoning-delta": {
            reasoningPreview = `${reasoningPreview}${event.delta}`.slice(-256);
            if (containsEncryptedReasoning(reasoningPreview)) {
              if (!encryptedReasoningHidden) {
                encryptedReasoningHidden = true;
                queue.push({ kind: "reasoning", delta: "[Encrypted reasoning hidden]" });
                tick();
              }
              break;
            }
            queue.push({ kind: "reasoning", delta: event.delta });
            tick();
            break;
          }
          case "tool-call":
            queue.push({
              kind: "tool_call",
              id: event.id,
              toolName: event.toolName,
              args: event.args,
            });
            tick();
            break;
          case "tool-result":
            queue.push({
              kind: "tool_result",
              id: event.id,
              result: event.result,
              isError: event.isError,
            });
            tick();
            break;
          case "tool-approval-request":
            queue.push({
              kind: "tool_approval_request",
              approvalId: event.approvalId,
              toolName: event.toolName,
              input: event.input,
            });
            tick();
            break;
          case "questionnaire-request":
            queue.push({
              kind: "questionnaire_request",
              title: event.title,
              questions: event.questions,
            });
            tick();
            break;
          case "usage":
            queue.push({
              kind: "usage",
              usage: event.usage,
            });
            tick();
            break;
          case "error":
            queue.push({ kind: "error", message: event.message });
            tick();
            break;
          case "done":
            queue.push({ kind: "done", stopReason: event.stopReason });
            tick();
            break;
          case "status":
            // Provider lifecycle (connecting / ready / streaming / …). The UI
            // turns `connecting` into a real phase instead of a generic wait.
            queue.push({ kind: "status", status: event.status, message: event.message });
            tick();
            break;
          default:
            break;
        }
      },
    };

    // A provider that throws synchronously from `sendTurn` (failed spawn, bad
    // config) is treated exactly like one whose promise rejects: an `error`
    // event → StopFailure. Left to propagate, the exception would escape the
    // turn machine with no terminal state and the listener still attached.
    armStallWatchdog();
    let controllerPromise: ReturnType<typeof session.sendTurn>;
    try {
      controllerPromise = session.sendTurn(turnInput, turnController);
    } catch (err) {
      controllerPromise = Promise.reject(err);
    }

    let done = false;
    let truncated = false;
    let errorMessage: string | null = null;
    let finalUsage: ProviderUsageSnapshot | undefined;

    // Consume the queue concurrently with the sendTurn promise.
    controllerPromise
      .catch((err) => {
        if (disposed) return;
        const message = err instanceof Error ? err.message : String(err);
        queue.push({ kind: "error", message });
        tick();
      })
      .finally(() => {
        if (disposed) return;
        // Only reached when no terminator arrived first — the loop exits on
        // the real `done` and drops anything queued behind it.
        queue.push({ kind: "settled" });
        tick();
      });

    // Cursor-based draining: `head` advances over the array and the array is
    // recycled only once fully consumed, so a bursty producer never pays for
    // `shift()` re-indexing the remaining events on every dequeue.
    let head = 0;
    let toolRounds = 0;
    let lastWasToolCall = false;
    while (!done) {
      if (head === queue.length) {
        queue.length = 0;
        head = 0;
        await waitForEvent();
      }
      const event = queue[head++];
      if (!event) continue;
      switch (event.kind) {
        case "text":
          lastWasToolCall = false;
          buffer += event.delta;
          fullText += event.delta;
          openRoundIfSettled();
          currentRound().text += event.delta;
          if (buffer.length >= 32 || event.delta.includes("\n")) {
            yield* flush();
          }
          break;
        case "status":
          yield { type: "status", status: event.status, content: event.message } satisfies StreamChunk;
          break;
        case "reasoning":
          lastWasToolCall = false;
          // Forward as a `reasoning` StreamChunk so the UI's <Reasoning>
          // block accumulates and renders the thinking trace, matching the
          // xAI direct-stream path.
          yield { type: "reasoning", content: event.delta } satisfies StreamChunk;
          break;
        case "tool_call": {
          if (!lastWasToolCall) toolRounds += 1;
          lastWasToolCall = true;
          // Flush any pending text before the tool-call chunk so the UI
          // renders text → tool → text in the order the SDK emitted them.
          yield* flush();
          const tc: ToolCall = {
            id: event.id,
            type: "function",
            function: {
              name: event.toolName,
              arguments: JSON.stringify(event.args ?? {}),
            },
          };
          pendingToolCalls.set(event.id, tc);
          completedToolCalls.push(tc);
          openRoundIfSettled();
          currentRound().toolCalls.push(tc);
          notifyObserver(observer?.onToolStart, {
            toolCall: tc,
            timestamp: Date.now(),
          });
          yield { type: "tool_calls", toolCalls: [tc] } satisfies StreamChunk;
          break;
        }
        case "tool_approval_request": {
          // Owning-adapter approval prompt (Claude Agent SDK's `canUseTool`).
          // Flush pending text so the prompt panel renders after the model's
          // most recent assistant text — matching the ai-sdk approval-request
          // ordering used by the file-tools / payment flows.
          yield* flush();
          // Best-effort precheck for file edits so the same EditApprovalPanel
          // the ai-sdk path uses can render a diff. The Claude Agent SDK
          // names file tools `Write` / `Edit` / `MultiEdit`; we normalise to
          // `write_file` / `edit_file` so the existing app.tsx routing in
          // `case "tool_approval_request"` lands on the edit-panel branch.
          // `adaptProviderEditApproval` is the typed shape adapter; an
          // `unsupported` result (MultiEdit with several edits, replace_all)
          // still routes to the edit panel but deliberately carries no diff.
          let editPrecheck: EditPrecheck | undefined;
          const adapted = adaptProviderEditApproval(event.toolName, event.input);
          const outboundName = adapted.kind === "passthrough" ? event.toolName : adapted.outboundName;
          if (adapted.kind === "preview") {
            try {
              const { computeEditPreview } = await import("../../tools/file");
              const cwd = getHostServices().bash.cwd();
              const preview = computeEditPreview(adapted.outboundName, adapted.input, cwd);
              if (preview) {
                editPrecheck = {
                  filePath: preview.filePath,
                  absolutePath: preview.absolutePath,
                  isNew: preview.isNew,
                  additions: preview.additions,
                  removals: preview.removals,
                  patch: preview.patch,
                  noop: preview.noop,
                };
              }
            } catch {
              // best-effort — UI falls back to a generic prompt
            }
          }
          const tc: ToolCall = {
            id: event.approvalId,
            type: "function",
            function: {
              name: outboundName,
              arguments: JSON.stringify(event.input ?? {}),
            },
          };
          yield {
            type: "tool_approval_request",
            approvalId: event.approvalId,
            toolCall: tc,
            editPrecheck,
          } satisfies StreamChunk;
          break;
        }
        case "questionnaire_request": {
          // Owning-adapter structured questionnaire (Claude Agent SDK's
          // built-in `AskUserQuestion`). Flush pending text so the
          // questionnaire renders after the model's most recent assistant
          // text, then forward the questions to the UI's QuestionnaireTabs
          // surface. There is no approvalId to resolve — the adapter has
          // already terminated the turn, and the user's selections return as
          // a follow-up message on the next turn.
          yield* flush();
          yield {
            type: "questionnaire",
            questionnaire: { title: event.title, questions: event.questions },
          } satisfies StreamChunk;
          break;
        }
        case "tool_result": {
          lastWasToolCall = false;
          yield* flush();
          const tc =
            pendingToolCalls.get(event.id) ??
            ({
              id: event.id,
              type: "function" as const,
              function: { name: "unknown", arguments: "{}" },
            } satisfies ToolCall);
          pendingToolCalls.delete(event.id);
          // The adapter owns this tool, so nothing upstream bounded its output.
          const output = capToolOutput(
            typeof event.result === "string"
              ? event.result
              : event.result === undefined
                ? ""
                : JSON.stringify(event.result),
          );
          const tr: ToolResult = {
            success: event.isError !== true,
            output: event.isError ? undefined : output,
            error: event.isError ? output : undefined,
          };
          notifyObserver(observer?.onToolFinish, {
            toolCall: tc,
            toolResult: tr,
            timestamp: Date.now(),
          });
          // File the result with the round that ISSUED the call. A result can
          // land after later text has opened a new round; filing it there
          // put assistant text between a call and its result, which
          // providers reject. A result for a call never seen (or seen twice)
          // is shown but not persisted — an orphan result is rejected too.
          const owner = rounds.find((round) => round.toolCalls.some((call) => call.id === event.id));
          if (owner && !owner.toolParts.some((part) => part.toolCall.id === event.id)) {
            owner.toolParts.push({
              toolCall: tc,
              input: parseToolArgumentsOrRaw(tc.function.arguments),
              toolResult: tr,
            });
          }
          yield { type: "tool_result", toolCall: tc, toolResult: tr } satisfies StreamChunk;
          break;
        }
        case "usage":
          finalUsage = event.usage;
          break;
        case "cancelled":
          cancelled = true;
          done = true;
          break;
        case "error":
          errorMessage = event.message;
          done = true;
          break;
        case "settled":
          errorMessage = `${runtime.adapterId ?? "The provider"} ended the stream without finishing the turn.`;
          done = true;
          break;
        case "done":
          if (CANCELLED_STOP_REASONS.has(event.stopReason ?? "")) {
            cancelled = true;
          } else if (FAILED_STOP_REASONS.has(event.stopReason ?? "")) {
            // The stdio transports report a decoder-level failure ONLY as
            // `stopReason: "error"` — there is no accompanying error event, so
            // treating this as an ordinary terminator swallowed the failure.
            errorMessage = `${runtime.adapterId ?? "The provider"} ended the turn with "${event.stopReason}".`;
          } else if (TRUNCATED_STOP_REASONS.has(event.stopReason ?? "")) {
            truncated = true;
          }
          done = true;
          break;
      }
    }

    // The loop has settled on a terminal event; anything the provider emits
    // from here on (a late `done` after an error, text after an abort) belongs
    // to no consumer and is dropped.
    disposed = true;
    clearStallWatchdog();
    queue.length = 0;

    if (cancelled || signal.aborted) {
      await ctx.terminalizeCancelledTurn(userModelMessage, buildTurnMessages());
      yield { type: "content", content: "\n\n[Cancelled]" } satisfies StreamChunk;
      yield { type: "done" };
      return;
    }

    yield* flush();

    // `flush()` yields control to the stream consumer. An Esc pressed after the
    // provider's final event but before we commit the transcript must still win
    // over success/error terminalization.
    if (cancelled || signal.aborted) {
      await ctx.terminalizeCancelledTurn(userModelMessage, buildTurnMessages());
      yield { type: "content", content: "\n\n[Cancelled]" } satisfies StreamChunk;
      yield { type: "done" };
      return;
    }

    // Before the error branch: a turn that failed still burned every token the
    // provider reported, and recording only successes understates the session.
    if (finalUsage) {
      // Pass the snapshot through whole: narrowing it to input/output here is
      // what made the cache-stats line read `0 read · 0 written` for every
      // Claude / Codex / amp / OpenCode session, and what left a turn that
      // reused a 40k prefix reporting a few hundred tokens.
      ctx.recordUsage({ ...finalUsage, totalTokens: totalBilledTokens(finalUsage) }, "message", runtime.modelId);
    }

    if (errorMessage) {
      yield { type: "error", content: errorMessage } satisfies StreamChunk;
      notifyObserver(observer?.onError, {
        message: errorMessage,
        timestamp: Date.now(),
      });
      notifyObserver(observer?.onStepFinish, {
        stepNumber: 1,
        timestamp: Date.now(),
        finishReason: "error",
        usage: {},
      });
      const completedMessages = buildTurnMessages();
      if (completedMessages.length > 0) {
        ctx.appendCompletedTurn(userModelMessage, completedMessages);
      }
      await ctx.emitTurnStopFailure(errorMessage, signal);
      yield { type: "done" };
      return;
    }

    const completedMessages = buildTurnMessages();
    if (completedMessages.length > 0) {
      ctx.appendCompletedTurn(userModelMessage, completedMessages);
      await ctx.refreshSessionRecap(signal);
    }

    notifyObserver(observer?.onStepFinish, {
      stepNumber: 1,
      timestamp: Date.now(),
      rounds: toolRounds,
      finishReason: "stop",
      usage: finalUsage
        ? {
            inputTokens: finalUsage.inputTokens,
            outputTokens: finalUsage.outputTokens,
            totalTokens: totalBilledTokens(finalUsage),
          }
        : {},
    });

    await ctx.emitTurnStop(signal);

    if (truncated) {
      yield { type: "warning", content: TRUNCATION_NOTICE };
    }

    const finding = detectClaimWithoutTool(fullText, completedToolCalls.length);
    if (finding) {
      yield { type: "warning", content: formatFabricationWarning(finding) };
    }

    yield { type: "done" };
  } finally {
    // Unconditional: reached on every terminal return above, on a throw, and
    // when the consumer abandons this generator at a yield via `return()`.
    disposed = true;
    clearStallWatchdog();
    queue.length = 0;
    removeAbortListener();
  }
}
