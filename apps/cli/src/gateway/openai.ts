// OpenAI-style LLM-gateway surface for the codesurf gateway (Phase 1 W3).
// Exposes engine turns as an OpenAI chat-completions-compatible endpoint so an
// OpenAI-form client (a Chat UI, an LLM gateway consumer, an IDE) can drive the
// engine via POST /v1/chat/completions — stream or non-stream. This is the third
// 'standard wire' (v0): MCP = tools, ACP = agent-client envelope, OpenAI = LLM role.
//
// Mapping is deliberately shallow: the last user message becomes the gateway
// turn prompt (the engine keeps its full tool plane server-side); engine content
// StreamChunks become OpenAI text deltas. Stateless per request: one gateway
// session per completion, removed when the turn finishes.

import type { StreamChunk } from "../types/index";

// --- OpenAI request/response shapes -----------------------------------

export interface OpenAIMessage {
  role: string;
  content: string;
}

export interface OpenAIChatCompletionRequest {
  model?: string;
  messages: OpenAIMessage[];
  stream?: boolean;
}

export interface OpenAIChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: { index: number; message: { role: "assistant"; content: string }; finish_reason: "stop" }[];
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: { index: number; delta: { role?: "assistant"; content?: string | null }; finish_reason: "stop" | null }[];
}

let seq = 0;
function completionId(): string {
  seq = (seq + 1) % 100000;
  return "chatcmpl-" + Date.now().toString(36) + "-" + seq;
}

/** Last user message text, or null when the request carries none. */
export function lastUserMessage(messages: OpenAIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = (messages[i].content ?? "").trim();
      if (content.length > 0) return content;
    }
  }
  return null;
}

function base(id: string, model: string, created: number) {
  return { id, created, model };
}

/** SSE role delta frame (start of a streamed completion). */
export function openaiRoleFrame(model: string): string {
  const { id, created } = base(completionId(), model, Math.floor(Date.now() / 1000));
  const chunk: OpenAIChatCompletionChunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
  return "data: " + JSON.stringify(chunk) + "\n\n";
}

/** SSE content delta frame for one engine content chunk. */
export function openaiContentFrame(model: string, content: string): string {
  const { id, created } = base(completionId(), model, Math.floor(Date.now() / 1000));
  const chunk: OpenAIChatCompletionChunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  return "data: " + JSON.stringify(chunk) + "\n\n";
}

/** SSE finish_reason=stop frame, then the client treats the stream as over. */
export function openaiStopFrame(model: string): string {
  const { id, created } = base(completionId(), model, Math.floor(Date.now() / 1000));
  const chunk: OpenAIChatCompletionChunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return "data: " + JSON.stringify(chunk) + "\n\n";
}

export function openaiDone(): string {
  return "data: [DONE]\n\n";
}

/** Non-stream JSON completion body. */
export function openaiCompletion(model: string, content: string): OpenAIChatCompletion {
  const { id, created } = base(completionId(), model, Math.floor(Date.now() / 1000));
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

/** Extract textual content from an engine StreamChunk, if any. */
export function chunkText(chunk: StreamChunk): string | null {
  if (chunk.type === "content" && typeof chunk.content === "string") return chunk.content;
  return null;
}
