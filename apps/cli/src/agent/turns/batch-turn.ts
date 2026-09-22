// xAI batch-mode turn loop (moved verbatim out of agent.ts; `this.*` became
// `ctx.*`). Drives a turn through the xAI Batch API: one batch request per
// tool round, polling for each response, executing tool calls locally.

import type { ModelMessage, ToolSet } from "ai";
import type { KernelModelRuntime } from "../../core/plugins";
import {
  addBatchRequests,
  cancelBatch,
  createBatch,
  getBatchChatCompletion,
  pollBatchRequestResult,
} from "../../grok/batch";
import type { getModelInfo } from "../../grok/models";
import { toolSetToBatchTools } from "../../grok/tool-schemas";
import type { StreamChunk } from "../../types/index";
import { relaxCompactionSettings } from "../compaction";
import { detectClaimWithoutTool, formatFabricationWarning } from "../fabrication-detector";
import {
  accumulateUsage,
  buildAssistantBatchMessage,
  buildBatchChatCompletionRequest,
  buildBatchName,
  buildToolBatchMessage,
  closeDanglingToolCalls,
  getBatchFinishReason,
  getBatchUsage,
  hasUsage,
  humanizeApiError,
  isAuthenticationError,
  isContextLimitError,
  notifyObserver,
  toLocalToolCall,
  withToolSchemas,
} from "./helpers";
import type { ExecutedBatchTool, ProcessMessageObserver, ProcessMessageUsage, TurnContext } from "./types";

const BATCH_CANCEL_TIMEOUT_MS = 5_000;

export async function* runBatchTurn(
  ctx: TurnContext,
  args: {
    userModelMessage: ModelMessage;
    observer?: ProcessMessageObserver;
    system: string;
    runtime: KernelModelRuntime;
    modelInfo: ReturnType<typeof getModelInfo>;
    signal: AbortSignal;
  },
): AsyncGenerator<StreamChunk, void, unknown> {
  const { userModelMessage, observer, system, runtime, modelInfo, signal } = args;
  let attemptedOverflowRecovery = false;

  while (true) {
    let closeMcp: (() => Promise<void>) | undefined;
    let batchId: string | null = null;
    const turnMessages: ModelMessage[] = [];
    const totalUsage: ProcessMessageUsage = {};

    try {
      // Built before compaction: the tool definitions go out with every batch
      // request, so the context estimate has to count them (as stream-turn does).
      const turnToolset = await ctx.buildSharedTurnToolset({
        runtime,
        mode: ctx.mode,
      });
      const tools: ToolSet = turnToolset.tools;
      closeMcp = turnToolset.closeMcp;
      const sendsTools = runtime.modelInfo?.supportsClientTools !== false;

      const settings = attemptedOverflowRecovery
        ? relaxCompactionSettings(ctx.getCompactionSettings())
        : ctx.getCompactionSettings();
      if (modelInfo) {
        const compacted = await ctx.compactForContext(
          runtime,
          // Only sized, never sent: compaction reads it for its estimate.
          withToolSchemas(system, sendsTools ? tools : {}),
          modelInfo.contextWindow,
          signal,
          settings,
          attemptedOverflowRecovery,
        );
        if (compacted) {
          yield {
            type: "status",
            status: "compacted",
            content: "Context compacted to fit the model window",
          } satisfies StreamChunk;
        }
      }
      if (signal.aborted) {
        throw new Error("Batch turn cancelled.");
      }

      if (runtime.modelInfo?.responsesOnly) {
        throw new Error("Batch mode currently supports chat-completions models only.");
      }

      // Batch API is xAI-specific. Non-xAI providers (Anthropic, OpenAI,
      // etc.) don't have a comparable endpoint.
      if (!runtime.modelInfo) {
        throw new Error(
          "Batch mode is only supported with xAI / Grok models. Disable --batch-api to use other providers.",
        );
      }

      if (signal.aborted) {
        throw new Error("Batch turn cancelled.");
      }

      if (turnToolset.mcpUnavailableMessage) {
        yield { type: "content", content: `${turnToolset.mcpUnavailableMessage}\n\n` };
      }

      const batchTools = sendsTools ? await toolSetToBatchTools(tools) : [];
      const batch = await createBatch({
        ...ctx.getBatchClientOptions(signal),
        name: buildBatchName("session", ctx.getSessionId() || runtime.modelId),
      });
      batchId = batch.batch_id;

      // Accumulate across all rounds of this turn so the fabrication detector
      // sees the full assistant message + total tool calls, not just the last round.
      let turnAssistantText = "";
      let turnToolCallCount = 0;

      for (let round = 0; round < ctx.maxToolRounds; round++) {
        if (signal.aborted) {
          throw new Error("Batch turn cancelled.");
        }
        const stepNumber = round + 1;
        notifyObserver(observer?.onStepStart, {
          stepNumber,
          timestamp: Date.now(),
        });

        const batchRequestId = `turn-${Date.now()}-${stepNumber}`;
        await addBatchRequests({
          ...ctx.getBatchClientOptions(signal),
          batchId: batch.batch_id,
          batchRequests: [
            {
              batch_request_id: batchRequestId,
              batch_request: {
                chat_get_completion: buildBatchChatCompletionRequest({
                  modelId: runtime.modelId,
                  system,
                  // Live read: compaction (above) replaces the Agent's array.
                  messages: [...ctx.getMessages(), ...turnMessages],
                  temperature: 0.7,
                  maxOutputTokens: runtime.modelInfo?.supportsMaxOutputTokens === false ? undefined : ctx.maxTokens,
                  reasoningEffort: runtime.providerOptions?.xai.reasoningEffort,
                  tools: batchTools,
                }),
              },
            },
          ],
        });

        const result = await pollBatchRequestResult({
          ...ctx.getBatchClientOptions(signal),
          batchId: batch.batch_id,
          batchRequestId,
        });
        if (signal.aborted) {
          throw new Error("Batch turn cancelled.");
        }
        const response = getBatchChatCompletion(result);
        const choice = response.choices[0];
        if (!choice) {
          throw new Error("Batch response did not contain any choices.");
        }

        const usage = getBatchUsage(response);
        accumulateUsage(totalUsage, usage);
        const finishReason = getBatchFinishReason(choice.finish_reason);

        const content = choice.message.content ?? "";
        if (content) {
          turnAssistantText += content;
          yield { type: "content", content };
          // The yield above hands control to the consumer; an Esc pressed
          // while it holds this final content must win over the commit
          // below (mirrors the provider-session runner's post-flush guard).
          if (signal.aborted) {
            throw new Error("Batch turn cancelled.");
          }
        }

        const requestMessages = [...ctx.getMessages(), ...turnMessages];
        const toolCalls = (choice.message.tool_calls ?? []).map(toLocalToolCall);
        turnToolCallCount += toolCalls.length;
        const assistantMessage = buildAssistantBatchMessage(content, toolCalls);
        if (assistantMessage) {
          turnMessages.push(assistantMessage);
        }

        if (toolCalls.length === 0) {
          notifyObserver(observer?.onStepFinish, {
            stepNumber,
            timestamp: Date.now(),
            finishReason,
            usage,
          });
          if (hasUsage(totalUsage)) {
            ctx.recordUsage(totalUsage, "message", runtime.modelId);
          }
          ctx.appendCompletedTurn(userModelMessage, turnMessages);
          const finding = detectClaimWithoutTool(turnAssistantText, turnToolCallCount);
          if (finding) {
            yield { type: "warning", content: formatFabricationWarning(finding) };
          }
          await ctx.refreshSessionRecap(signal);
          await ctx.emitTurnStop(signal);
          yield { type: "done" };
          return;
        }

        yield { type: "tool_calls", toolCalls };

        const toolParts: ExecutedBatchTool[] = [];
        for (const toolCall of toolCalls) {
          notifyObserver(observer?.onToolStart, {
            toolCall,
            timestamp: Date.now(),
          });

          const executed = await ctx.executeBatchToolCall(tools, toolCall, requestMessages, signal);
          notifyObserver(observer?.onToolFinish, {
            toolCall,
            toolResult: executed.result,
            timestamp: Date.now(),
          });
          yield { type: "tool_result", toolCall, toolResult: executed.result };
          if (signal.aborted) {
            throw new Error("Batch turn cancelled.");
          }
          toolParts.push({
            toolCall,
            input: executed.input,
            toolResult: executed.result,
          });
        }

        const toolMessage = buildToolBatchMessage(toolParts);
        if (toolMessage) {
          turnMessages.push(toolMessage);
        }
        notifyObserver(observer?.onStepFinish, {
          stepNumber,
          timestamp: Date.now(),
          finishReason,
          usage,
        });
      }

      // The last tool result was yielded before the loop ended; recheck before
      // committing the limit failure so a cancelled turn stays cancelled.
      if (signal.aborted) {
        throw new Error("Batch turn cancelled.");
      }

      const message = `Error: Reached max tool rounds (${ctx.maxToolRounds}) in batch mode.`;
      notifyObserver(observer?.onError, {
        message,
        timestamp: Date.now(),
      });
      if (hasUsage(totalUsage)) {
        ctx.recordUsage(totalUsage, "message", runtime.modelId);
      }
      ctx.appendCompletedTurn(userModelMessage, closeDanglingToolCalls(turnMessages));
      await ctx.emitTurnStopFailure(`Error: Reached max tool rounds (${ctx.maxToolRounds}) in batch mode.`, signal);
      yield { type: "error", content: message };
      yield { type: "done" };
      return;
    } catch (err: unknown) {
      if (signal.aborted) {
        // A request already queued keeps running (and billing) server-side
        // unless the batch is cancelled. Best-effort and not awaited: the turn
        // signal is already aborted, so this call gets its own short deadline.
        if (batchId) {
          cancelBatch({
            ...ctx.getBatchClientOptions(),
            batchId,
            signal: AbortSignal.timeout(BATCH_CANCEL_TIMEOUT_MS),
          }).catch(() => {});
        }
        await ctx.terminalizeCancelledTurn(userModelMessage);
        yield { type: "content", content: "\n\n[Cancelled]" };
        yield { type: "done" };
        return;
      }

      if (!attemptedOverflowRecovery && turnMessages.length === 0 && modelInfo && isContextLimitError(err)) {
        attemptedOverflowRecovery = true;
        continue;
      }

      const authError = isAuthenticationError(err);
      const friendly = humanizeApiError(err);
      notifyObserver(observer?.onError, {
        message: friendly,
        timestamp: Date.now(),
      });
      if (hasUsage(totalUsage)) {
        ctx.recordUsage(totalUsage, "message", runtime.modelId);
      }
      // A throw between issuing the round's tool calls and recording their
      // results leaves the assistant message holding calls nothing answers.
      ctx.appendCompletedTurn(userModelMessage, closeDanglingToolCalls(turnMessages));
      await ctx.emitTurnStopFailure(friendly, signal);
      yield {
        type: "error",
        content: friendly,
        isAuthError: authError,
      };
      yield { type: "done" };
      return;
    } finally {
      await closeMcp?.().catch(() => {});
    }
  }
}
