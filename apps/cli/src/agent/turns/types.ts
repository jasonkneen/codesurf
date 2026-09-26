// Shared types for the Agent's turn state machines.
//
// agent.ts hosts three nearly-independent turn loops (streamText, provider
// session, xAI batch). The batch and session loops live in this directory as
// free generator functions; `TurnContext` is the narrow, explicit surface of
// Agent internals they're allowed to touch. The Agent builds one adapter per
// call (see Agent.turnContext()) so its members stay private.

import type { ModelMessage, ToolSet } from "ai";
import type { KernelModelRuntime, ProviderSession } from "../../core/plugins";
import type { BatchClientOptions } from "../../grok/batch";
import type { AgentMode, ToolCall, ToolResult, UsageSource } from "../../types/index";
import type { CompactionSettings } from "../compaction";

export type ProcessMessageFinishReason = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";

export interface ProcessMessageUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsdTicks?: number;
  /** Prefix-cache counters. Providers on the session path report these; they
   *  must survive to `recordUsage` or the title bar shows `cache: 0 read` for
   *  adapters that demonstrably cache. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ProcessMessageStepStart {
  stepNumber: number;
  timestamp: number;
}

export interface ProcessMessageStepFinish {
  stepNumber: number;
  timestamp: number;
  finishReason: ProcessMessageFinishReason;
  usage: ProcessMessageUsage;
  /**
   * Tool-call round-trips for this turn: the number of times the model emitted
   * a batch of tool calls (one per distinct LLM tool-calling response). This is
   * the metric PTC exists to cut — under "code" the model calls run_code once,
   * so rounds = 1, whereas native re-enters once per batch).
   */
  rounds?: number;
}

export interface ProcessMessageToolStart {
  toolCall: ToolCall;
  timestamp: number;
}

export interface ProcessMessageToolFinish {
  toolCall: ToolCall;
  toolResult: ToolResult;
  timestamp: number;
}

export interface ProcessMessageError {
  message: string;
  timestamp: number;
}

export interface ProcessMessageObserver {
  onStepStart?(info: ProcessMessageStepStart): void;
  onStepFinish?(info: ProcessMessageStepFinish): void;
  onToolStart?(info: ProcessMessageToolStart): void;
  onToolFinish?(info: ProcessMessageToolFinish): void;
  onError?(info: ProcessMessageError): void;
}

export interface ExecutedBatchTool {
  toolCall: ToolCall;
  input: unknown;
  toolResult: ToolResult;
}

/**
 * Sub-agent ancestry for one execution.
 *
 * Lives here rather than in agent.ts so the extracted toolset builder can name
 * it without importing the Agent: a child's nested `task` tool is bound to
 * `{ depth: parent.depth + 1 }`, so depth follows the actual chain instead of a
 * counter shared by concurrent siblings on the same Agent.
 */
export interface SubagentExecutionContext {
  /** Number of sub-agent ancestors above the caller. The root session is 0. */
  readonly depth: number;
}

export interface TurnToolset {
  tools: ToolSet;
  closeMcp: () => Promise<void>;
  mcpUnavailableMessage: string | null;
  /** PTC SDK system-prompt section (present only under code/both presentation). */
  sdkSection?: string;
}

/**
 * The Agent surface a turn state machine may use. Everything here is a thin
 * delegate to a private Agent member — see Agent.turnContext(). Keep this
 * narrow: a new entry means a new coupling between the turn loops and the
 * Agent's internals.
 */
export interface TurnContext {
  /**
   * The Agent's CURRENT conversation history. A getter, not a captured array:
   * `compactForContext` replaces the Agent's array wholesale, so a turn that
   * captured `messages` at construction would keep sending the pre-compaction
   * history (and re-send it on overflow retry) after compaction succeeded.
   * Read it after every compaction point, immediately before building a
   * request.
   */
  getMessages(): ModelMessage[];
  readonly mode: AgentMode;
  readonly maxToolRounds: number;
  readonly maxTokens: number;
  getSessionId(): string | null;
  getCompactionSettings(): CompactionSettings;
  getBatchClientOptions(signal?: AbortSignal): BatchClientOptions;
  recordUsage(usage: ProcessMessageUsage, source?: UsageSource, model?: string): void;
  appendCompletedTurn(userMessage: ModelMessage, newMessages: ModelMessage[]): void;
  /**
   * End a user-aborted turn without firing Stop or StopFailure. This discards
   * its uncommitted user message and finalizes the active learning trace as a
   * neutral cancellation. `partialMessages` is whatever the turn had already
   * produced (text, closed tool rounds) — persisted ahead of the note so an
   * interrupt keeps the work the user watched happen.
   */
  terminalizeCancelledTurn(userMessage: ModelMessage, partialMessages?: ModelMessage[]): Promise<void>;
  /**
   * Register a snapshot of the turn's uncommitted output, or clear it with
   * null. Read when the app exits mid-turn so the in-flight turn is persisted
   * instead of vanishing from the resumed session.
   */
  setPartialTurnSnapshot?(snapshot: (() => ModelMessage[]) | null): void;
  emitTurnStop(signal: AbortSignal): Promise<void>;
  emitTurnStopFailure(error: string, signal: AbortSignal): Promise<void>;
  refreshSessionRecap(signal?: AbortSignal): Promise<void>;
  compactForContext(
    runtime: Pick<KernelModelRuntime, "model" | "modelInfo" | "providerOptions">,
    system: string,
    contextWindow: number,
    signal: AbortSignal,
    settings?: CompactionSettings,
    force?: boolean,
  ): Promise<boolean>;
  buildSharedTurnToolset(args: {
    runtime: KernelModelRuntime;
    mode: AgentMode;
    onMcpUnavailable?: (message: string) => void;
  }): Promise<TurnToolset>;
  executeBatchToolCall(
    tools: ToolSet,
    toolCall: ToolCall,
    messages: ModelMessage[],
    signal?: AbortSignal,
  ): Promise<{ input: unknown; result: ToolResult }>;
  /** Track the active owning-adapter session for approval forwarding. */
  setCurrentProviderSession(session: ProviderSession | null): void;
}
