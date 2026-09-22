import type { ModelMessage, ToolSet } from "ai";
import type { KernelModelRuntime } from "../../core/plugins";
import type { BatchClientOptions } from "../../grok/batch";
import type { getModelInfo } from "../../grok/models";
import type { StreamChunk, ToolCall, ToolResult } from "../../types/index";
import { runBatchTurn } from "./../turns/batch-turn";
import { parseToolArgumentsOrRaw, prepareBatchToolInvocation, toToolResult } from "./../turns/helpers";
import type { ProcessMessageObserver, TurnContext } from "./../turns/types";

interface BatchState {
  apiKey: string | null;
  baseURL: string | null;
  turnContext(): TurnContext;
}

function st(self: object): BatchState {
  return self as unknown as BatchState;
}

// biome-ignore lint/suspicious/noExplicitAny: TS mixin base constraint must accept any[] (TS2545).
type MixinConstructor = new (...args: any[]) => object;

export function BatchMixin<TBase extends MixinConstructor>(Base: TBase) {
  return class Batch extends Base {
    getBatchClientOptions(signal?: AbortSignal): BatchClientOptions {
      if (!st(this).apiKey) {
        throw new Error("API key required. Add an API key to continue.");
      }

      return {
        apiKey: st(this).apiKey!,
        baseURL: st(this).baseURL ?? undefined,
        signal,
      };
    }

    async executeBatchToolCall(
      tools: ToolSet,
      toolCall: ToolCall,
      messages: ModelMessage[],
      signal?: AbortSignal,
    ): Promise<{ input: unknown; result: ToolResult }> {
      const tool = tools[toolCall.function.name];
      if (!tool || tool.type === "provider" || typeof tool.execute !== "function") {
        return {
          input: parseToolArgumentsOrRaw(toolCall.function.arguments),
          result: {
            success: false,
            output: `Tool "${toolCall.function.name}" is unavailable in batch mode.`,
          },
        };
      }

      // Same boundary the direct streamText path gets from the AI SDK: schema
      // validation and the tool's own `needsApproval` gate run BEFORE execute.
      // Batch turns cannot pause for approval, so an approval-required call is
      // refused explicitly rather than executed without the user's decision.
      const invocation = await prepareBatchToolInvocation(tool, toolCall.function.name, toolCall.function.arguments, {
        toolCallId: toolCall.id,
        messages,
        abortSignal: signal,
      });
      if (!invocation.ok) {
        return { input: invocation.input, result: invocation.result };
      }
      const parsedInput = invocation.input;

      try {
        const output = await tool.execute(parsedInput as never, {
          toolCallId: toolCall.id,
          messages,
          abortSignal: signal,
        });
        return {
          input: parsedInput,
          result: toToolResult(output),
        };
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          input: parsedInput,
          result: {
            success: false,
            output: `Tool "${toolCall.function.name}" failed: ${message}`,
          },
        };
      }
    }

    async *processMessageBatchTurn(args: {
      userModelMessage: ModelMessage;
      observer?: ProcessMessageObserver;
      system: string;
      runtime: KernelModelRuntime;
      modelInfo: ReturnType<typeof getModelInfo>;
      signal: AbortSignal;
    }): AsyncGenerator<StreamChunk, void, unknown> {
      yield* runBatchTurn(st(this).turnContext(), args);
    }
  };
}
