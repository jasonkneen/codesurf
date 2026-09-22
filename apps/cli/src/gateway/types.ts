// Gateway wire types (Phase 1 W2). The gateway serves engine sessions over
// HTTP/SSE (JSON-lines-compatible events) reusing the exact StreamChunk stream
// the TUI consumes, so any client sees the same events a local turn does.

import type { StreamChunk } from "../types/index";

export type GatewayPresentation = "native" | "code" | "both";

export interface GatewaySessionRecord {
  id: string;
  createdAt: string;
  cwd?: string;
  model?: string;
  presentation: GatewayPresentation;
}

export interface GatewaySessionInput {
  cwd?: string;
  model?: string;
  presentation?: GatewayPresentation;
}

/** Real seam to an engine Agent turn. Bound by the host (CLI serve command). */
export type GatewayTurnRunner = (
  session: GatewaySessionRecord,
  message: string,
  signal: AbortSignal,
) => AsyncIterable<StreamChunk>;
