// ACP surface for the codesurf gateway (Phase 1 W3). ACP ("Agent Client
// Protocol") here is CodeSurf's client-to-agent wire: an external agent client
// or IDE (agensis, an IDE agent host, another engine front) drives engine
// sessions over an explicit session/prompt/stream envelope, complementing:
//   - session API   — the raw gateway HTTP/SSE wire (W2)
//   - MCP server    — tools for MCP clients (W2)
//   - ACP server    — this file: agent-client envelope (W3)
//   - OpenAI-style  — LLM gateway role (W3, not yet built)
//
// The envelope is deliberately thin and versioned. Engine StreamChunk events
// are carried whole (event + data separated) so no fidelity is lost, matching
// the SSE mapper in sse.ts. v1 speaks the session/prompt/stream subset; full
// ACP control (approvals, multimodal, tool policy) lands behind the same
// envelope shape as the engine matures.

import type { StreamChunk } from "../types/index";
import type { GatewayPresentation } from "./types";

export const ACP_VERSION = 1;

// --- Envelope types -----------------------------------------------------

export type AcpEvent =
  | { type: "session/init/success"; sessionId: string; presentation: GatewayPresentation; createdAt: string }
  | { type: "session/status"; sessionId: string; presentation: GatewayPresentation; createdAt: string }
  | { type: "session/end"; sessionId: string; removed: boolean }
  | { type: "message/stream/start"; sessionId: string }
  | { type: "message/stream/update"; sessionId: string; event: StreamChunk["type"]; chunk: StreamChunk }
  | { type: "message/stream/end"; sessionId: string }
  | { type: "agent/error"; sessionId?: string; error: string };

export interface AcpMessage {
  version: typeof ACP_VERSION;
  message: AcpEvent;
}

/** Wrap an ACP event in the versioned envelope. */
export function acpEnvelope(event: AcpEvent): AcpMessage {
  return { version: ACP_VERSION, message: event };
}

/** Map one engine StreamChunk to an ACP message/stream/update envelope. */
export function chunkToAcp(chunk: StreamChunk, sessionId: string): AcpMessage {
  return acpEnvelope({ type: "message/stream/update", sessionId, event: chunk.type, chunk });
}

/** Serialize an ACP message as an SSE data frame (one message per frame). */
export function acpToSse(message: AcpMessage): string {
  return `data: ${JSON.stringify(message)}\n\n`;
}

/** Serialize an ACP error as an SSE frame. */
export function acpError(message: string): string {
  return acpToSse(acpEnvelope({ type: "agent/error", error: message }));
}

/** Parse a streamed ACP message body back into its envelope. */
export function parseAcpFrame(frame: string): AcpMessage | null {
  const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine.slice(5).trim()) as AcpMessage;
  } catch {
    return null;
  }
}
