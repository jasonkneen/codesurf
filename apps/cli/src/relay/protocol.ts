// Versioned node-to-node protocol schema (Phase 2 W1). Messages are the
// contract (v0 §6): versioned, with a compat policy mirroring DSH session-log
// versioning. Slice 1 implements announce / delegate / presence; discover and
// route are declared for the schema and stubbed.

export const RELAY_PROTOCOL_VERSION = 1;

export type RelayOp =
  | "announce"
  | "presence"
  | "delegate_request"
  | "delegate_reply"
  | "discover_reply"
  | "route_reply"
  | "discover"
  | "route";

export interface RelayMessage<P = unknown> {
  protocolVersion: typeof RELAY_PROTOCOL_VERSION;
  op: RelayOp;
  from: string;
  to: string;
  seq: number;
  ttlMs: number;
  payload: P;
}

export function relayMessage<P>(msg: Omit<RelayMessage<P>, "protocolVersion">): RelayMessage<P> {
  return { protocolVersion: RELAY_PROTOCOL_VERSION, ...msg };
}

// --- Payload shapes (slice 1) ------------------------------------------

export interface AnnouncePayload {
  nodeId: string;
  capabilities: string[]; // steward-scoped tool names this node serves
  relayEndpoint?: string;
  repo?: string;
  load?: number; // current job load (active jobs) for load-aware placement
}

export interface PresencePayload {
  status: "join" | "leave" | "heartbeat";
  at: string;
  load?: number; // live load for load-aware placement on heartbeat
  telemetry?: PresenceTelemetry; // fleet-status snapshot (sessions, jobs, version, uptime)
}

export interface PresenceTelemetry {
  sessions?: number;
  jobs?: number;
  version?: string;
  uptimeMs?: number;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  node: string; // component/hub/node that recorded the hop
  event: string; // forward | run | reply | submit | ...
  at: string; // ISO timestamp when the span started
  durMs?: number;
  status?: "ok" | "failed";
  detail?: string; // bounded detail: route, tool, target
}

export interface DelegateRequestPayload {
  tool: string; // steward-scoped tool name, e.g. "nodeB_ping"
  args: unknown;
  principal: string; // originating node/identity for the steward gate
  scope: string;
  /** Optional explicit target node; else the hub routes by capability. */
  target?: string;
  /** Locality hint: route a job to the node owning this repo when it offers the tool. */
  repo?: string;
  /** Optional budget hint for the bounded envelope. */
  budgetBytes?: number;
  /** Optional trace context for the full-route (traceroute) spans. */
  trace?: { traceId: string; parentSpanId?: string };
}

export interface DelegateReplyPayload {
  ok: boolean;
  reason?: string;
  /** Bounded payload when ok — statement + anchors + optional handle. */
  statement?: string;
  anchors?: import("./envelope").Anchor[];
  handle?: string;
  /** Present on every gated call so the caller can satisfy audit. */
  auditId: string;
  /** Worker-recorded spans to merge into the hub's trace (traceroute). */
  traceSpans?: import("./protocol").Span[];
}

export interface DiscoverPayload {
  query?: string;
  capabilities?: string[];
}

export interface RoutePayload {
  repo?: string;
  sessionId?: string;
}

export function isRelayMessage(value: unknown): value is RelayMessage {
  return (
    typeof value === "object" && value !== null && (value as RelayMessage).protocolVersion === RELAY_PROTOCOL_VERSION
  );
}

const RELAY_OPS: ReadonlySet<string> = new Set<RelayOp>([
  "announce",
  "presence",
  "delegate_request",
  "delegate_reply",
  "discover_reply",
  "route_reply",
  "discover",
  "route",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Structural check for a message arriving from an untrusted wire peer: the
 * envelope fields must be well-typed and the payload must match the shape the
 * hub reads for that op, so a malformed frame is dropped instead of throwing
 * inside the handler.
 */
export function isValidRelayMessage(value: unknown): value is RelayMessage {
  if (!isRelayMessage(value)) return false;
  const message = value as unknown as Record<string, unknown>;
  if (typeof message.op !== "string" || !RELAY_OPS.has(message.op)) return false;
  if (typeof message.from !== "string" || message.from.length === 0) return false;
  if (typeof message.to !== "string") return false;
  if (typeof message.seq !== "number" || !Number.isFinite(message.seq)) return false;
  if (typeof message.ttlMs !== "number" || !Number.isFinite(message.ttlMs)) return false;
  const payload = message.payload;
  if (!isObject(payload)) return false;
  switch (message.op) {
    case "announce":
      return (
        isStringArray(payload.capabilities ?? []) &&
        (payload.repo === undefined || typeof payload.repo === "string") &&
        (payload.load === undefined || typeof payload.load === "number")
      );
    case "discover":
      return (
        (payload.query === undefined || typeof payload.query === "string") &&
        (payload.capabilities === undefined || isStringArray(payload.capabilities))
      );
    case "route":
      return payload.repo === undefined || typeof payload.repo === "string";
    case "delegate_request":
      return (
        typeof payload.tool === "string" &&
        typeof payload.scope === "string" &&
        (payload.target === undefined || typeof payload.target === "string") &&
        (payload.repo === undefined || typeof payload.repo === "string") &&
        (payload.trace === undefined || (isObject(payload.trace) && typeof payload.trace.traceId === "string"))
      );
    case "delegate_reply":
      return typeof payload.ok === "boolean" && (payload.traceSpans === undefined || Array.isArray(payload.traceSpans));
    case "presence":
      return (
        (payload.status === "join" || payload.status === "leave" || payload.status === "heartbeat") &&
        (payload.load === undefined || typeof payload.load === "number") &&
        (payload.telemetry === undefined || isObject(payload.telemetry))
      );
    default:
      return true;
  }
}
