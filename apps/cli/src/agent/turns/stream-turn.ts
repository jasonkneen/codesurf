// streamText turn loop (moved verbatim out of agent.ts; `this.*` became
// `ctx.*`). Drives a turn through the Vercel AI SDK streamText API: a single
// streamText call that handles multiple tool-call rounds internally via
// `stopWhen: stepCountIs(...)`. Retry logic for context-limit overflow is
// handled by the outer `while (true)` loop.

import type { ModelMessage } from "ai";
import { stepCountIs, streamText, type ToolSet } from "ai";
import type { KernelModelRuntime } from "../../core/plugins";
import { getHostServices } from "../../core/plugins";
import type { getModelInfo } from "../../grok/models";
import type { StreamChunk, ToolCall } from "../../types/index";
import { relaxCompactionSettings } from "../compaction";
import { detectClaimWithoutTool, formatFabricationWarning } from "../fabrication-detector";
import { containsEncryptedReasoning, sanitizeModelMessages } from "../reasoning";
import {
  humanizeApiError,
  isAuthenticationError,
  isContextLimitError,
  notifyObserver,
  toToolResult,
  withToolSchemas,
} from "./helpers";
import type { ProcessMessageObserver, TurnContext } from "./types";

export async function* runStreamTurn(
  ctx: TurnContext,
  args: {
    userModelMessage: ModelMessage;
    observer: ProcessMessageObserver;
    system: string;
    runtime: KernelModelRuntime;
    modelInfo: ReturnType<typeof getModelInfo>;
    signal: AbortSignal;
  },
): AsyncGenerator<StreamChunk, void, unknown> {
  const { userModelMessage, observer, system, runtime, modelInfo, signal } = args;
  let attemptedOverflowRecovery = false;

  while (true) {
    let assistantText = "";
    let reasoningPreview = "";
    let encryptedReasoningHidden = false;
    let streamOk = false;
    let streamErrorYielded = false;
    let streamErrorMessage: string | null = null;
    // The error the SDK surfaced as a stream part. When a stream fails before
    // any step completes, `result.response` rejects with a generic
    // NoOutputGeneratedError; this is the real cause behind it.
    let streamError: unknown;
    // An overflow held back from the user because the turn can still retry.
    let deferredOverflow: unknown;
    let cancelled = false;
    let closeMcp: (() => Promise<void>) | undefined;
    let stepNumber = -1;
    let toolRounds = 0;
    let lastPartWasToolCall = false;
    const activeToolCalls: ToolCall[] = [];

    // Overflow recovery replays the ENTIRE turn, so it is only safe while the
    // turn has produced nothing worth keeping and, critically, has caused no
    // side effects. A step that emitted only tool calls has already run them —
    // retrying would write the file or run the command a second time — and it
    // leaves `assistantText` empty, which is exactly what the text-only guard
    // mistook for "nothing has happened yet".
    const canRetryOverflow = (error: unknown): boolean =>
      !attemptedOverflowRecovery &&
      !assistantText.trim() &&
      activeToolCalls.length === 0 &&
      Boolean(modelInfo) &&
      isContextLimitError(error);

    const surfaceStreamError = (error: unknown): StreamChunk => {
      const friendly = humanizeApiError(error);
      streamErrorYielded = true;
      streamErrorMessage = friendly;
      streamError = error;
      notifyObserver(observer?.onError, {
        message: friendly,
        timestamp: Date.now(),
      });
      return { type: "error", content: friendly, isAuthError: isAuthenticationError(error) };
    };

    try {
      // Built before compaction: the tool schemas and the PTC SDK section go
      // out with every request, so the context estimate has to count them.
      let mcpUnavailableMessage: string | null = null;
      const turnToolset = await ctx.buildSharedTurnToolset({
        runtime,
        mode: ctx.mode,
        onMcpUnavailable: (message) => {
          mcpUnavailableMessage = `${message}\n\n`;
        },
      });
      const tools: ToolSet = turnToolset.tools;
      closeMcp = turnToolset.closeMcp;
      // PTC SDK section joins the system prompt for this request only. The
      // native wire set drives it; byte-stable per unchanged tool set.
      const requestSystem = turnToolset.sdkSection
        ? `${system}

${turnToolset.sdkSection}`
        : system;

      const settings = attemptedOverflowRecovery
        ? relaxCompactionSettings(ctx.getCompactionSettings())
        : ctx.getCompactionSettings();
      if (modelInfo) {
        const compacted = await ctx.compactForContext(
          runtime,
          // Only sized, never sent: compaction reads it for its estimate.
          withToolSchemas(requestSystem, tools),
          modelInfo.contextWindow,
          signal,
          settings,
          attemptedOverflowRecovery,
        );
        // Compaction rewrites history. Silently, the user only saw an
        // unexplained pause and a model that had forgotten things.
        if (compacted) {
          yield {
            type: "status",
            status: "compacted",
            content: "Context compacted to fit the model window",
          } satisfies StreamChunk;
        }
      }

      if (mcpUnavailableMessage) {
        yield { type: "content", content: mcpUnavailableMessage };
      }

      const result = streamText({
        model: runtime.model,
        system: requestSystem,
        // Read AFTER compactForContext above: compaction swaps the Agent's
        // message array, and a captured reference would send the old history.
        messages: ctx.getMessages(),
        tools,
        stopWhen: stepCountIs(ctx.maxToolRounds),
        maxRetries: 0,
        abortSignal: signal,
        temperature: 0.7,
        ...(runtime.modelInfo?.supportsMaxOutputTokens === false ? {} : { maxOutputTokens: ctx.maxTokens }),
        ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
        experimental_onStepStart: (event: unknown) => {
          stepNumber = getStepNumber(event, stepNumber + 1);
          notifyObserver(observer?.onStepStart, {
            stepNumber,
            timestamp: Date.now(),
          });
        },
        onStepFinish: (event: unknown) => {
          const currentStep = getStepNumber(event, Math.max(stepNumber, 0));
          stepNumber = Math.max(stepNumber, currentStep);
          notifyObserver(observer?.onStepFinish, {
            stepNumber: currentStep,
            timestamp: Date.now(),
            finishReason: getFinishReason(event),
            usage: getUsage(event),
            rounds: toolRounds,
          });
        },
        // Raw SDK usage: `recordUsage` recognises the v6 shape (inputTokens
        // includes cache reads and writes) and bills the cached prefix once.
        onFinish: ({ totalUsage }) => {
          ctx.recordUsage(totalUsage, "message", runtime.modelId);
        },
      });

      for await (const part of result.fullStream) {
        if (signal.aborted) {
          cancelled = true;
          break;
        }

        switch (part.type) {
          case "text-delta":
            assistantText += part.text;
            yield { type: "content", content: part.text };
            break;

          case "reasoning-delta":
            reasoningPreview = `${reasoningPreview}${part.text}`.slice(-256);
            if (containsEncryptedReasoning(reasoningPreview)) {
              if (!encryptedReasoningHidden) {
                encryptedReasoningHidden = true;
                yield { type: "reasoning", content: "[Encrypted reasoning hidden]" };
              }
              break;
            }
            yield { type: "reasoning", content: part.text };
            break;

          case "tool-call": {
            if (!lastPartWasToolCall) toolRounds += 1;
            lastPartWasToolCall = true;
            const tc = toToolCall(part);
            activeToolCalls.push(tc);
            notifyObserver(observer?.onToolStart, {
              toolCall: tc,
              timestamp: Date.now(),
            });
            yield { type: "tool_calls", toolCalls: [tc] };
            break;
          }

          case "tool-result": {
            lastPartWasToolCall = false;
            const tc: ToolCall = {
              id: part.toolCallId,
              type: "function",
              function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) },
            };
            const tr = toToolResult(part.output);
            notifyObserver(observer?.onToolFinish, {
              toolCall: tc,
              toolResult: tr,
              timestamp: Date.now(),
            });
            yield { type: "tool_result", toolCall: tc, toolResult: tr };
            break;
          }

          case "tool-error": {
            // A tool that threw, or a call the SDK could not parse or route.
            // The SDK answers the call itself (the model sees the error), but
            // without this the UI row and the trace span stayed open forever.
            lastPartWasToolCall = false;
            const tc: ToolCall = {
              id: part.toolCallId,
              type: "function",
              function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) },
            };
            const tr = toToolResult({
              success: false,
              error: part.error instanceof Error ? part.error.message : String(part.error),
            });
            notifyObserver(observer?.onToolFinish, {
              toolCall: tc,
              toolResult: tr,
              timestamp: Date.now(),
            });
            yield { type: "tool_result", toolCall: tc, toolResult: tr };
            break;
          }

          case "tool-approval-request": {
            const approvalPart = part as unknown as {
              approvalId: string;
              toolCall: { toolCallId: string; toolName: string; input: unknown };
            };
            const toolCallId = approvalPart.toolCall?.toolCallId ?? "";
            const pendingTc = activeToolCalls.find((tc) => tc.id === toolCallId);
            const tcForChunk = pendingTc ?? {
              id: toolCallId,
              type: "function" as const,
              function: {
                name: approvalPart.toolCall?.toolName ?? "paid_request",
                arguments: JSON.stringify(approvalPart.toolCall?.input ?? {}),
              },
            };

            let paymentPrecheck: import("../../types/index").PaymentPrecheck | undefined;
            if (approvalPart.toolCall?.toolName === "paid_request") {
              const input = approvalPart.toolCall.input as { url?: string; method?: string } | null;
              try {
                const url = input?.url;
                if (url) {
                  const { scanUrl } = await import("../../payments/brin");
                  const brin = await scanUrl(url);
                  if (brin) {
                    const securityRaw = `${brin.score}/100 (${brin.verdict}, ${brin.confidence} confidence)`;
                    paymentPrecheck = {
                      security: securityRaw,
                      securityLabel: securityRaw,
                      securityUrl: brin.url ?? "",
                    };
                  }
                }
              } catch {
                // security scan is best-effort
              }
              // The terms come from the quote `needsApproval` stored for THIS
              // call's input — the option `execute` will actually pay. A probe
              // of our own showed the server's first option, which need not be
              // it. `needsApproval` has already run: the SDK emits this part
              // only after it returned true.
              try {
                const { getPaidRequestApprovalQuote, formatPaidRequestQuote } = await import(
                  "../../core/plugins/native/payments-tools"
                );
                const quote = input?.url
                  ? getPaidRequestApprovalQuote(input as Parameters<typeof getPaidRequestApprovalQuote>[0])
                  : undefined;
                paymentPrecheck = {
                  ...paymentPrecheck,
                  ...(quote?.kind === "payment"
                    ? {
                        amount: quote.option.amount ?? quote.option.maxAmountRequired ?? quote.option.price ?? "",
                        network: quote.option.network,
                        asset: quote.option.asset,
                        payTo: quote.option.payTo,
                        description: quote.description ?? "",
                      }
                    : {
                        description: quote
                          ? formatPaidRequestQuote(quote)
                          : "No payment terms were fetched for this request.",
                      }),
                };
              } catch {
                paymentPrecheck = {
                  ...paymentPrecheck,
                  description: "No payment terms were fetched for this request.",
                };
              }
            }

            let editPrecheck: import("../../types/index").EditPrecheck | undefined;
            if (approvalPart.toolCall?.toolName === "write_file" || approvalPart.toolCall?.toolName === "edit_file") {
              try {
                const { computeEditPreview } = await import("../../tools/file");
                const cwd = getHostServices().bash.cwd();
                const preview = computeEditPreview(
                  approvalPart.toolCall.toolName,
                  approvalPart.toolCall.input as Parameters<typeof computeEditPreview>[1],
                  cwd,
                );
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

            yield {
              type: "tool_approval_request",
              approvalId: approvalPart.approvalId,
              toolCall: tcForChunk,
              paymentPrecheck,
              editPrecheck,
            };
            break;
          }

          case "error": {
            // The real SDK reports a context overflow HERE, then rejects
            // `result.response` with a generic NoOutputGeneratedError — so the
            // retry has to key off this part. Hold it back while a retry is
            // still possible: the user should not see an error the turn
            // recovers from.
            if (deferredOverflow === undefined && canRetryOverflow(part.error)) {
              deferredOverflow = part.error;
              break;
            }
            yield surfaceStreamError(part.error);
            break;
          }

          case "abort":
            cancelled = true;
            break;
        }

        if (cancelled) break;
      }

      if (cancelled || signal.aborted) {
        await ctx.terminalizeCancelledTurn(userModelMessage);
        yield { type: "content", content: "\n\n[Cancelled]" };
        yield { type: "done" };
        return;
      }

      if (deferredOverflow !== undefined) {
        // `result.response` is left untouched: the SDK creates that promise
        // lazily, so its NoOutputGeneratedError rejection never materializes.
        if (canRetryOverflow(deferredOverflow)) {
          attemptedOverflowRecovery = true;
          continue;
        }
        // Output arrived after the overflow was held back — it is a failure.
        yield surfaceStreamError(deferredOverflow);
      }

      let finalizationFailed = false;
      let finalizationError: unknown;
      try {
        const response = await result.response;
        if (!signal.aborted) {
          ctx.appendCompletedTurn(userModelMessage, sanitizeModelMessages(response.messages));
          await ctx.refreshSessionRecap(signal);
          streamOk = true;
        }
      } catch (responseError: unknown) {
        if (canRetryOverflow(streamError ?? responseError)) {
          attemptedOverflowRecovery = true;
          continue;
        }
        finalizationFailed = true;
        finalizationError = responseError;
      }

      if (signal.aborted) {
        await ctx.terminalizeCancelledTurn(userModelMessage);
        yield { type: "content", content: "\n\n[Cancelled]" };
        yield { type: "done" };
        return;
      }

      // Explicit failed terminal state. A stream that surfaced an SDK `error`
      // part, or whose `result.response` rejected, can never settle as Stop
      // — a visibly failed stream must not train as a success. Partial text
      // is retained in the transcript (no recap, matching the throw path).
      if (finalizationFailed || streamErrorYielded) {
        // Prefer the error the stream reported: after a stream error the
        // finalization error is only the SDK's generic "No output generated".
        const friendly =
          streamErrorMessage ??
          (finalizationFailed ? humanizeApiError(finalizationError) : "The response stream failed.");
        if (finalizationFailed && !streamErrorYielded) {
          console.error("[agent] response finalization failed:", finalizationError);
        }
        if (!streamOk && assistantText.trim()) {
          ctx.appendCompletedTurn(userModelMessage, [{ role: "assistant", content: assistantText }]);
        }
        if (!streamErrorYielded) {
          notifyObserver(observer?.onError, { message: friendly, timestamp: Date.now() });
          yield { type: "error", content: friendly, isAuthError: isAuthenticationError(finalizationError) };
        }
        await ctx.emitTurnStopFailure(friendly, signal);
        yield { type: "done" };
        return;
      }

      await ctx.emitTurnStop(signal);

      const finding = detectClaimWithoutTool(assistantText, activeToolCalls.length);
      if (finding) {
        yield { type: "warning", content: formatFabricationWarning(finding) };
      }

      // Truncation notice: if generation stopped because it hit the output
      // token limit (not a natural stop / tool-call), tell the user so they
      // can resume. We surface a visible hint rather than silently
      // auto-continuing — auto-resume would inject a re-stream loop into
      // this hot path and could rack up tokens without the user expecting
      // it. A "continue" reply resumes naturally via the normal turn flow.
      if (streamOk) {
        try {
          if ((await result.finishReason) === "length") {
            yield {
              type: "warning",
              content:
                '\n\n_(Output stopped at the token limit — the reply may be truncated. Send "continue" to resume.)_',
            };
          }
        } catch {
          // finishReason unavailable — skip the notice.
        }
      }

      yield { type: "done" };
      return;
    } catch (err: unknown) {
      if (signal.aborted) {
        await ctx.terminalizeCancelledTurn(userModelMessage);
        yield { type: "content", content: "\n\n[Cancelled]" };
        yield { type: "done" };
        return;
      }

      if (canRetryOverflow(err)) {
        attemptedOverflowRecovery = true;
        continue;
      }

      const authError = isAuthenticationError(err);
      const friendly = humanizeApiError(err);
      notifyObserver(observer?.onError, {
        message: friendly,
        timestamp: Date.now(),
      });
      yield {
        type: "error",
        content: friendly,
        isAuthError: authError,
      };
      if (assistantText.trim()) {
        ctx.appendCompletedTurn(userModelMessage, [{ role: "assistant", content: assistantText }]);
      }

      await ctx.emitTurnStopFailure(friendly, signal);

      yield { type: "done" };
      return;
    } finally {
      await closeMcp?.().catch(() => {});
    }
  }
}

function toToolCall(part: { toolCallId: string; toolName: string; args?: unknown; input?: unknown }): ToolCall {
  return {
    id: part.toolCallId,
    type: "function",
    function: {
      name: part.toolName,
      arguments: JSON.stringify(part.input ?? part.args ?? {}),
    },
  };
}

function getStepNumber(event: unknown, fallback: number): number {
  if (event && typeof event === "object" && "stepNumber" in event && typeof event.stepNumber === "number") {
    return event.stepNumber;
  }

  return fallback;
}

function getFinishReason(event: unknown): "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other" {
  if (event && typeof event === "object" && "finishReason" in event) {
    switch (event.finishReason) {
      case "stop":
      case "length":
      case "content-filter":
      case "tool-calls":
      case "error":
      case "other":
        return event.finishReason;
    }
  }

  return "other";
}

function getUsage(event: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsdTicks?: number;
} {
  if (!(event && typeof event === "object" && "usage" in event)) {
    return {};
  }

  const usage = event.usage;
  if (!usage || typeof usage !== "object") {
    return {};
  }

  const u = usage as Record<string, unknown>;
  return {
    inputTokens: typeof u.inputTokens === "number" ? u.inputTokens : undefined,
    outputTokens: typeof u.outputTokens === "number" ? u.outputTokens : undefined,
    totalTokens: typeof u.totalTokens === "number" ? u.totalTokens : undefined,
  };
}
