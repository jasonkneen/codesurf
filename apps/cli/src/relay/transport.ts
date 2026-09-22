// Relay transport seam (Phase 2 W1). Slice 1 ships an in-memory peer channel so
// the protocol is testable with no network; a WebSocket transport attaches behind
// this same interface in a later slice (v0 §6: outbound WS relay).

import type { RelayMessage } from "./protocol";

export type RelayHandler = (message: RelayMessage) => void;

export interface RelayTransport {
  send(message: RelayMessage): Promise<void>;
  onMessage(handler: RelayHandler): void;
  close(): Promise<void>;
}

/**
 * Connect two transport ends into a linked pair: a message sent on one is
 * delivered to the other's listeners (mirrors MCP InMemoryTransport).
 */
export function connectPeerPair(): [RelayTransport, RelayTransport] {
  const left = new InMemoryEndpoint();
  const right = new InMemoryEndpoint();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

class InMemoryEndpoint implements RelayTransport {
  peer: InMemoryEndpoint | null = null;
  private readonly listeners: RelayHandler[] = [];

  async send(message: RelayMessage): Promise<void> {
    if (!this.peer) throw new Error("transport end has no peer");
    // Deliver on a microtask so two-node flow is async but deterministic.
    queueMicrotask(() => {
      for (const handler of this.peer!.listeners) {
        try {
          handler(message);
        } catch (error) {
          // A listener error must not break delivery to the rest.
          console.error("relay handler error:", error);
        }
      }
    });
  }

  onMessage(handler: RelayHandler): void {
    this.listeners.push(handler);
  }

  async close(): Promise<void> {
    this.listeners.length = 0;
    this.peer = null;
  }
}
