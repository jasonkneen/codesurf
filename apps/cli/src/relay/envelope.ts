// Bounded envelope for the relay/steward tiers (Phase 2 W1). Relay-tier
// messages carry a focused statement + anchors + an opaque handle — never raw
// file/content off-node. Budget (bytes) is enforced at construction; a payload
// over budget is refused so a node can't leak unbounded content through the relay.

export const RELAY_SCHEMA_VERSION = 1;
export const DEFAULT_BUDGET_BYTES = 4096;

/**
 * A logical pointer to expandable content. `gate` names the tier to re-enter
 * when the consumer calls expand(handle): relay (bounded) or steward (gated).
 */
export interface Anchor {
  name: string;
  gate: "relay" | "steward";
  meta?: Record<string, string>;
}

/**
 * The bounded payload shape: a usable statement plus anchors/handle. The `content`
 * field is deliberately absent on the relay tier — relaySafe() rejects raw content.
 */
export interface BoundedPayload {
  statement: string;
  anchors: Anchor[];
  handle?: string;
}

export function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Throw if the payload exceeds the budget (bytes). */
export function enforceBudget(payload: unknown, budgetBytes: number): void {
  const size = byteLength(payload);
  if (size > budgetBytes) {
    throw new Error(`bounded envelope over budget: ${size}B > ${budgetBytes}B`);
  }
}

/**
 * Assert a payload is relay-safe: bounded statement + anchors only, no raw
 * `content` field leaking off-node.
 */
export function relaySafe(payload: Record<string, unknown>): void {
  if ("content" in payload && payload.content != null) {
    throw new Error("relay tier forbids raw content; use anchors + statement");
  }
}

/**
 * A versioned, budget-bounded envelope. Constructing one enforces the budget and
 * (optionally) the relay-safety rule.
 */
export class BoundedEnvelope<T extends BoundedPayload> {
  readonly schemaVersion = RELAY_SCHEMA_VERSION;
  constructor(
    readonly nodeId: string,
    readonly payload: T,
    readonly budgetBytes: number = DEFAULT_BUDGET_BYTES,
    readonly ttlMs: number = 30_000,
    readonly kind = "bounded",
    readonly relayOnly = false,
  ) {
    enforceBudget(this.payload, this.budgetBytes);
    if (this.relayOnly) relaySafe(this.payload as unknown as Record<string, unknown>);
  }
}
