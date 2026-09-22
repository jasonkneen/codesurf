// Shared helpers for the Agent's turn state machines (moved verbatim out of
// agent.ts). Message-shape conversion between the ai-sdk ModelMessage format
// and the xAI batch / provider-session wire formats, usage accounting, and
// API-error classification.

import { APICallError } from "@ai-sdk/provider";
import { convertToBase64, type FlexibleSchema, safeValidateTypes } from "@ai-sdk/provider-utils";
import { asSchema, type ModelMessage, type Tool, type ToolSet } from "ai";
import type {
  BatchChatCompletionRequest,
  BatchChatCompletionResponse,
  BatchChatMessage,
  BatchFunctionTool,
  BatchToolCall,
} from "../../grok/batch";
import type { Plan, ToolCall, ToolResult } from "../../types/index";
import type { ExecutedBatchTool, ProcessMessageFinishReason, ProcessMessageUsage } from "./types";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function buildBatchName(prefix: string, label: string): string {
  const compact =
    label
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9._-]+/g, "")
      .slice(0, 48) || "run";
  return `codesurf-${prefix}-${compact}`;
}

export function buildBatchChatCompletionRequest(args: {
  modelId: string;
  system: string;
  messages: ModelMessage[];
  temperature: number;
  maxOutputTokens?: number;
  reasoningEffort?: BatchChatCompletionRequest["reasoning_effort"];
  tools: BatchFunctionTool[];
}): BatchChatCompletionRequest {
  return {
    model: args.modelId,
    messages: toBatchChatMessages(args.system, args.messages),
    temperature: args.temperature,
    ...(args.maxOutputTokens != null ? { max_completion_tokens: args.maxOutputTokens } : {}),
    ...(args.reasoningEffort ? { reasoning_effort: args.reasoningEffort } : {}),
    ...(args.tools.length > 0 ? { tools: args.tools } : {}),
  };
}

function toBatchChatMessages(system: string, messages: ModelMessage[]): BatchChatMessage[] {
  const batchMessages: BatchChatMessage[] = [{ role: "system", content: system }];

  for (const message of messages) {
    const { role, content } = message;

    switch (role) {
      case "system":
        batchMessages.push({ role: "system", content });
        break;

      case "user": {
        if (typeof content === "string") {
          batchMessages.push({ role: "user", content });
          break;
        }

        if (!Array.isArray(content)) {
          break;
        }

        if (content.length === 1 && content[0]?.type === "text") {
          batchMessages.push({ role: "user", content: content[0].text });
          break;
        }

        const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> =
          [];
        for (const part of content) {
          switch (part.type) {
            case "text":
              userContent.push({ type: "text", text: part.text });
              break;

            case "image": {
              const mediaType = part.mediaType === "image/*" || !part.mediaType ? "image/jpeg" : part.mediaType;
              const data =
                part.image instanceof URL
                  ? part.image.toString()
                  : `data:${mediaType};base64,${toBase64DataContent(part.image)}`;
              userContent.push({ type: "image_url", image_url: { url: data } });
              break;
            }

            case "file": {
              if (!part.mediaType.startsWith("image/")) {
                break;
              }
              const mediaType = part.mediaType === "image/*" ? "image/jpeg" : part.mediaType;
              const data =
                part.data instanceof URL
                  ? part.data.toString()
                  : `data:${mediaType};base64,${toBase64DataContent(part.data)}`;
              userContent.push({ type: "image_url", image_url: { url: data } });
              break;
            }
          }
        }
        batchMessages.push({
          role: "user",
          content: userContent,
        });
        break;
      }

      case "assistant": {
        if (typeof content === "string") {
          batchMessages.push({ role: "assistant", content });
          break;
        }

        if (!Array.isArray(content)) {
          break;
        }

        let assistantText = "";
        const toolCalls: BatchToolCall[] = [];
        for (const part of content) {
          if (part.type === "text") {
            assistantText += part.text;
          } else if (part.type === "tool-call") {
            toolCalls.push({
              id: part.toolCallId,
              type: "function",
              function: {
                name: part.toolName,
                arguments: JSON.stringify(part.input),
              },
            });
          }
        }

        if (assistantText || toolCalls.length > 0) {
          batchMessages.push({
            role: "assistant",
            content: assistantText,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
        }
        break;
      }

      case "tool":
        for (const part of content) {
          if (part.type === "tool-approval-response") {
            continue;
          }
          batchMessages.push({
            role: "tool",
            tool_call_id: part.toolCallId,
            content: toolOutputToText(part.output),
          });
        }
        break;
    }
  }

  return batchMessages;
}

function toBase64DataContent(value: string | Uint8Array | ArrayBuffer): string {
  return convertToBase64(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
}

function toolOutputToText(output: {
  type: "text" | "json" | "execution-denied" | "error-text" | "error-json" | "content";
  value?: unknown;
  reason?: string;
}): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return String(output.value ?? "");
    case "execution-denied":
      return output.reason ?? "Tool execution denied.";
    case "json":
    case "error-json":
    case "content":
      return JSON.stringify(output.value ?? null);
  }
}

export function getBatchUsage(response: BatchChatCompletionResponse): ProcessMessageUsage {
  const usage = response.usage ?? {};
  const inputTokens = asNumber(usage.input_tokens) ?? asNumber(usage.prompt_tokens);
  const outputTokens = asNumber(usage.output_tokens) ?? asNumber(usage.completion_tokens);
  const totalTokens = asNumber(usage.total_tokens) ?? sumDefined(inputTokens, outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsdTicks: asNumber(usage.cost_in_usd_ticks),
  };
}

export function accumulateUsage(target: ProcessMessageUsage, usage: ProcessMessageUsage): void {
  target.inputTokens = (target.inputTokens ?? 0) + (usage.inputTokens ?? 0);
  target.outputTokens = (target.outputTokens ?? 0) + (usage.outputTokens ?? 0);
  target.totalTokens = (target.totalTokens ?? 0) + (usage.totalTokens ?? 0);
  target.costUsdTicks = (target.costUsdTicks ?? 0) + (usage.costUsdTicks ?? 0);
}

export function hasUsage(usage: ProcessMessageUsage): boolean {
  return Boolean(
    (usage.inputTokens ?? 0) || (usage.outputTokens ?? 0) || (usage.totalTokens ?? 0) || (usage.costUsdTicks ?? 0),
  );
}

export function getBatchFinishReason(finishReason: string | null | undefined): ProcessMessageFinishReason {
  switch (finishReason) {
    case "stop":
    case "length":
    case "content-filter":
    case "tool-calls":
    case "error":
    case "other":
      return finishReason;
    case "tool_calls":
      return "tool-calls";
    default:
      return "other";
  }
}

export function toLocalToolCall(toolCall: BatchToolCall): ToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    },
  };
}

export function buildAssistantBatchMessage(content: string, toolCalls: ToolCall[]): ModelMessage | null {
  if (toolCalls.length === 0) {
    return content ? { role: "assistant", content } : null;
  }

  const parts: Array<
    { type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  > = [];
  if (content) {
    parts.push({ type: "text", text: content });
  }
  for (const toolCall of toolCalls) {
    parts.push({
      type: "tool-call",
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      input: parseToolArgumentsOrRaw(toolCall.function.arguments),
    });
  }
  return { role: "assistant", content: parts };
}

export function buildToolBatchMessage(toolParts: ExecutedBatchTool[]): ModelMessage | null {
  if (toolParts.length === 0) {
    return null;
  }

  return {
    role: "tool",
    content: toolParts.map((part) => ({
      type: "tool-result" as const,
      toolCallId: part.toolCall.id,
      toolName: part.toolCall.function.name,
      output: part.toolResult.success
        ? ({ type: "json", value: toSerializableValue(part.toolResult) } as const)
        : ({ type: "error-json", value: toSerializableValue(part.toolResult) } as const),
    })),
  };
}

export function buildProviderTurnMessages(
  content: string,
  toolCalls: ToolCall[],
  toolParts: ExecutedBatchTool[],
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const assistantMessage = buildAssistantBatchMessage(content, toolCalls);
  if (assistantMessage) {
    messages.push(assistantMessage);
  }
  const toolMessage = buildToolBatchMessage(toolParts);
  if (toolMessage) {
    messages.push(toolMessage);
  }
  return messages;
}

export const INTERRUPTED_TOOL_RESULT_MESSAGE =
  "Tool call did not complete: the turn ended before a result arrived. The side effect may or may not have happened — check the current state before retrying.";

function toolCallPartsOf(message: ModelMessage): Array<{ toolCallId: string; toolName: string }> {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part) =>
    typeof part === "object" && part && part.type === "tool-call"
      ? [{ toolCallId: part.toolCallId, toolName: part.toolName }]
      : [],
  );
}

function answeredToolCallIds(messages: ModelMessage[]): Set<string> {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (typeof part === "object" && part && part.type === "tool-result") {
        answered.add(part.toolCallId);
      }
    }
  }
  return answered;
}

/** Whether any `tool-call` in `messages` is still waiting for a result. */
export function hasUnansweredToolCall(messages: ModelMessage[]): boolean {
  const answered = answeredToolCallIds(messages);
  return messages.some((message) => toolCallPartsOf(message).some((call) => !answered.has(call.toolCallId)));
}

function interruptedResultFor(call: { toolCallId: string; toolName: string }) {
  return {
    type: "tool-result" as const,
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: {
      type: "error-json" as const,
      value: { success: false, error: INTERRUPTED_TOOL_RESULT_MESSAGE },
    },
  };
}

/**
 * One `tool` message answering every call `messages` left open, or null.
 *
 * For closing out a turn that is ending where it stands — an interrupt, say —
 * rather than repairing an arbitrary history. An approval the user granted
 * counts as unanswered until the tool actually runs: the SDK executes an
 * approved call on the next request and synthesizes nothing if that request
 * never comes.
 */
export function closingToolMessage(messages: ModelMessage[]): ModelMessage | null {
  const answered = answeredToolCallIds(messages);
  const open = messages.flatMap((message) => toolCallPartsOf(message).filter((call) => !answered.has(call.toolCallId)));
  if (open.length === 0) return null;
  return { role: "tool", content: open.map(interruptedResultFor) };
}

/**
 * One `tool` message denying every call `messages` left open, or null.
 *
 * For an approval the user never answered. It has to be a real `tool-result`:
 * the SDK only honours a `tool-approval-response` while it is the LAST
 * message, and strips it from the wire otherwise, so a denial written that way
 * leaves the call open the moment anything follows it.
 */
export function deniedToolMessage(messages: ModelMessage[], reason: string): ModelMessage | null {
  const answered = answeredToolCallIds(messages);
  const open = messages.flatMap((message) => toolCallPartsOf(message).filter((call) => !answered.has(call.toolCallId)));
  if (open.length === 0) return null;
  return {
    role: "tool",
    content: open.map((call) => ({
      type: "tool-result" as const,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: { type: "execution-denied" as const, reason },
    })),
  };
}

/**
 * Give every `tool-call` a `tool-result`, synthesizing a failed one for any
 * call the turn left open.
 *
 * Run this over a WHOLE turn, never one round at a time. A round is closed as
 * soon as it holds any result, so a second call's real result can land in the
 * next round — closing per round would answer it twice, and two results for
 * one id is itself rejected.
 *
 * An assistant `tool-call` with no matching `tool-result` is rejected by every
 * provider, and nothing repairs the transcript on load — so once one reaches
 * the durable store the session is poisoned for good. Providers cut streams,
 * error out mid-round and settle with calls still open, so the closing has to
 * happen before the turn is persisted.
 *
 * The synthesized result says the side effect is of unknown status rather than
 * claiming failure: the tool may well have run. It is never re-executed.
 *
 * Only for turns that have reached a terminal state. A call parked on a pending
 * user approval is legitimately open and must not be closed here — the AI SDK
 * resolves it on the next request via its `tool-approval-response`.
 */
export function closeDanglingToolCalls(messages: ModelMessage[]): ModelMessage[] {
  const answered = answeredToolCallIds(messages);
  if (messages.every((message) => toolCallPartsOf(message).every((call) => answered.has(call.toolCallId)))) {
    return messages;
  }

  const closed: ModelMessage[] = [];
  for (const message of messages) {
    closed.push(message);
    // Insert beside the assistant message that opened the calls, not at the
    // end: a later round's messages must not sit between a call and its result.
    const open = toolCallPartsOf(message).filter((call) => !answered.has(call.toolCallId));
    if (open.length === 0) continue;
    closed.push({ role: "tool", content: open.map(interruptedResultFor) });
  }
  return closed;
}

export type BatchToolInvocation = { ok: true; input: unknown } | { ok: false; input: unknown; result: ToolResult };

/**
 * The batch/provider tool-execution boundary that the direct streamText path
 * gets from the AI SDK for free: parse, validate against the tool's declared
 * input schema, and honor `needsApproval`.
 *
 * Batch turns cannot pause for an approval prompt, so an approval-required
 * call is refused with an explicit result instead of being executed silently
 * — file edits under "ask-always" and paid requests declare approval exactly
 * so the user gets to decide, and switching to batch mode must not bypass
 * that decision. Schema validation runs first so `execute` never sees input
 * the tool did not declare it accepts.
 */
export async function prepareBatchToolInvocation(
  tool: { inputSchema?: Tool["inputSchema"]; needsApproval?: Tool["needsApproval"] },
  toolName: string,
  rawArguments: string,
  options: { toolCallId: string; messages: ModelMessage[]; abortSignal?: AbortSignal },
): Promise<BatchToolInvocation> {
  let parsedInput: unknown;
  try {
    parsedInput = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      input: rawArguments,
      result: {
        success: false,
        output: `Tool "${toolName}" received invalid JSON arguments: ${message}`,
      },
    };
  }

  if (tool.inputSchema) {
    const validation = await safeValidateTypes({
      value: parsedInput,
      schema: tool.inputSchema as FlexibleSchema<unknown>,
    });
    if (!validation.success) {
      return {
        ok: false,
        input: parsedInput,
        result: {
          success: false,
          output: `Tool "${toolName}" received invalid arguments: ${validation.error.message}`,
        },
      };
    }
    parsedInput = validation.value;
  }

  const needsApproval =
    typeof tool.needsApproval === "function"
      ? await tool.needsApproval(parsedInput as never, options)
      : tool.needsApproval === true;
  if (needsApproval) {
    return {
      ok: false,
      input: parsedInput,
      result: {
        success: false,
        output: `Tool "${toolName}" requires user approval, which batch mode cannot request. Run this step outside batch mode, or change the approval setting so it does not need a prompt.`,
      },
    };
  }

  return { ok: true, input: parsedInput };
}

export function parseToolArgumentsOrRaw(raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return raw;
  }
}

function toSerializableValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  } catch {
    return String(value);
  }
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function sumDefined(left?: number, right?: number): number | undefined {
  if (left == null && right == null) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
}

export function notifyObserver<T>(listener: ((payload: T) => void) | undefined, payload: T): void {
  if (!listener) {
    return;
  }

  try {
    listener(payload);
  } catch {
    // Observer failures should never break generation.
  }
}

export function isContextLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(context|token|prompt).*(limit|length|large|window|overflow)|too many tokens|maximum context/i.test(message);
}

export function isAuthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(401|403)\b|unauthori[sz]ed|invalid.*(api[_ ]?key|token|credential)|authentication failed|forbidden|access denied/i.test(
    message,
  );
}

const STATUS_MESSAGES: Record<number, string> = {
  400: "The request was invalid. This may be caused by an unsupported parameter or model.",
  401: "Authentication failed. Your API key may be invalid or expired.",
  403: "Access denied. Your API key does not have permission for this request.",
  404: "The requested model or endpoint was not found. Check your model name and base URL.",
  408: "The request timed out. Please try again.",
  422: "The request could not be processed. Check your message format or parameters.",
  429: "Rate limit exceeded. Please wait a moment and try again.",
  500: "The API server encountered an internal error. Please try again later.",
  502: "The API server is temporarily unavailable. Please try again later.",
  503: "The API service is temporarily overloaded. Please try again later.",
  529: "The API service is overloaded. Please try again later.",
};

export function humanizeApiError(error: unknown): string {
  const raw = cleanErrorMessage(error);
  if (APICallError.isInstance(error)) {
    const detail = extractResponseDetail(error.responseBody);
    if (detail) return detail;
    const status = error.statusCode ? STATUS_MESSAGES[error.statusCode] : undefined;
    // The generic status text alone ("…unsupported parameter or model") names
    // neither the parameter nor the model. Keep the provider's own words when
    // they add anything, or the user has nothing to act on.
    if (status) return appendRawDetail(status, raw);
  }

  return raw;
}

function cleanErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^AI_\w+Error:\s*/i, "").trim() || raw;
}

/** Append the provider's message to a canned status line when it adds detail. */
export function appendRawDetail(status: string, raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return status;
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  if (normalize(status).includes(normalize(trimmed))) return status;
  return `${status} (${trimmed})`;
}

function extractResponseDetail(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message ?? parsed?.message ?? parsed?.detail;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * Ceiling for a single tool result entering the transcript.
 *
 * Set at the largest a native tool can already produce (`read_file`'s 512KB),
 * so nothing in-tree changes shape and the cap only bites on output no one
 * bounded: an MCP server's response, or a tool owned by a provider adapter.
 * Those are persisted and re-sent on every later turn, so one unbounded result
 * is charged over and over. `CODESURF_TOOL_RESULT_MAX_BYTES` overrides it.
 */
const DEFAULT_TOOL_RESULT_MAX_BYTES = 512 * 1024;

function toolResultMaxBytes(): number {
  const raw = process.env.CODESURF_TOOL_RESULT_MAX_BYTES;
  if (raw === undefined) return DEFAULT_TOOL_RESULT_MAX_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOOL_RESULT_MAX_BYTES;
}

/**
 * Bound one tool result at capture, replacing the overflow with a marker that
 * names the real size and how to get the rest. Without the marker the model
 * reads the truncated output as the whole answer.
 */
export function capToolOutput(text: string): string {
  const max = toolResultMaxBytes();
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes <= max) return text;
  // Cut on the byte budget, then drop a replacement char left by splitting a
  // multi-byte sequence so the kept head is always valid UTF-8.
  const head = Buffer.from(text, "utf-8").subarray(0, max).toString("utf-8").replace(/�+$/, "");
  const elided = bytes - Buffer.byteLength(head, "utf-8");
  return `${head}\n\n[... truncated: ${bytes.toLocaleString("en-US")} bytes total, ${elided.toLocaleString("en-US")} elided. Re-run the tool against a narrower range or filter to see the rest.]`;
}

export function toToolResult(output: unknown): ToolResult {
  if (output && typeof output === "object" && "success" in output) {
    const r = output as {
      success: boolean;
      output?: string;
      error?: string;
      diff?: ToolResult["diff"];
      plan?: Plan;
      task?: ToolResult["task"];
      delegation?: ToolResult["delegation"];
      backgroundProcess?: ToolResult["backgroundProcess"];
      media?: ToolResult["media"];
      computer?: ToolResult["computer"];
      lspDiagnostics?: ToolResult["lspDiagnostics"];
    };
    const error = r.error ?? (r.success ? undefined : r.output);
    return {
      success: r.success,
      output: r.output === undefined ? undefined : capToolOutput(r.output),
      error: error === undefined ? undefined : capToolOutput(error),
      diff: r.diff,
      plan: r.plan,
      task: r.task,
      delegation: r.delegation,
      backgroundProcess: r.backgroundProcess,
      media: r.media,
      computer: r.computer,
      lspDiagnostics: r.lspDiagnostics,
    };
  }
  return { success: true, output: capToolOutput(String(output)) };
}

/**
 * The system prompt plus the tool definitions the request carries, as text for
 * the compaction estimate. Tool schemas can run to tens of thousands of tokens
 * (MCP servers especially) and are sent on every request, yet the estimate saw
 * only the prompt — so it said "fits" for requests the provider rejected.
 */
export function withToolSchemas(system: string, tools: ToolSet): string {
  const definitions = Object.entries(tools).map(([name, tool]) => {
    let schema = "";
    try {
      schema = tool.inputSchema ? JSON.stringify(asSchema(tool.inputSchema).jsonSchema) : "";
    } catch {
      // An unserializable schema still costs its name and description.
    }
    return `${name}\n${tool.description ?? ""}\n${schema}`;
  });
  return definitions.length > 0 ? `${system}\n\n${definitions.join("\n\n")}` : system;
}
