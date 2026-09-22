// StreamChunk -> SSE mapper (Phase 1 W2). Pure: given the engine's chunk
// stream it produces well-formed text/event-stream frames a client can render.
// Each chunk is carried whole (event = chunk type, data = the full chunk) so
// no fidelity is lost for content, reasoning, tool calls/results, approval
// requests, questionnaires, warnings, errors, or the terminal done marker.

import type { StreamChunk } from "../types/index";

const EVENT = new Set([
  "content",
  "reasoning",
  "tool_calls",
  "tool_result",
  "tool_approval_request",
  "questionnaire",
  "error",
  "done",
  "warning",
]);

export function chunkToSse(chunk: StreamChunk): string {
  const event = EVENT.has(chunk.type) ? chunk.type : "message";
  return `event: ${event}\ndata: ${JSON.stringify(chunk)}\n\n`;
}

export function sseError(message: string): string {
  return `event: error\ndata: ${JSON.stringify({ type: "error", content: message })}\n\n`;
}
