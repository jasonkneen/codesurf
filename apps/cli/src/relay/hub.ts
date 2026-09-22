// Hub protocol node (Phase 3 W1/W2). A hub is a RelayNode plus a registry and
// a forwarder, on the same versioned mesh protocol. Each client holds ONE spoke
// to the hub: it discovers nodes by capability/repo and delegates jobs; the hub
// routes to the owning node, forwards, and relays the bounded reply back. The
// steward gate stays on the worker node. The hub never reasons — it registers,
// discovers, routes, and forwards. Fleet-scale: thousands of clients and nodes
// hang off hubs while the logical mesh stays any-to-any.

import {
  type DelegateReplyPayload,
  type DelegateRequestPayload,
  type DiscoverPayload,
  isValidRelayMessage,
  type PresencePayload,
  type PresenceTelemetry,
  type RelayMessage,
  type RoutePayload,
  relayMessage,
  type Span,
} from "./protocol";
import { nextSpanId, TraceStore } from "./trace";
import type { RelayTransport } from "./transport";

export interface HubRegistration {
  capabilities: string[];
  repo?: string;
  load: number; // current job load for load-aware placement
  lastSeen: number;
  telemetry?: PresenceTelemetry;
}

export interface DiscoverReply {
  nodes: string[];
}

export interface RouteReply {
  node: string | null;
}

/** Identity the transport layer authenticated for a spoke (e.g. a node-token holder). */
export interface SpokeIdentity {
  /** Steward principal stamped on every delegate_request from this spoke; payload claims are ignored. */
  principal?: string;
}

interface SpokeBinding {
  /** Node ids this transport owns (first `from` it used, or the attach() id). */
  ids: Set<string>;
  principal?: string;
}

const FORWARD_TTL_FLOOR_MS = 30_000;

export class Hub {
  private readonly spokes = new Map<string, RelayTransport>();
  private readonly registry = new Map<string, HubRegistration>();
  private readonly bindings = new Map<RelayTransport, SpokeBinding>();
  /** delegate_requests forwarded to a worker, keyed worker|client|seq -> expiry; only these replies relay. */
  private readonly forwards = new Map<string, number>();

  constructor(readonly hubId = "hub") {}

  /** Observed hops per trace (full-route traceroute spans). */
  readonly traces = new TraceStore();

  trace(traceId: string): Span[] {
    return this.traces.trace(traceId);
  }

  /** Attach a node's spoke; the hub then handles its messages (announce, discover, route, delegate). */
  attach(nodeId: string, transport: RelayTransport): void {
    this.spokes.set(nodeId, transport);
    this.bindings.set(transport, { ids: new Set([nodeId]) });
    transport.onMessage((message) => this.ingest(message, transport));
  }

  /**
   * Auto-attach any transport (WS/remote). A transport claims the node id of the
   * first message it sends; it can never speak as an id another transport owns,
   * and its delegate_requests carry the transport's authenticated principal.
   */
  attachAny(transport: RelayTransport, identity: SpokeIdentity = {}): void {
    this.bindings.set(transport, { ids: new Set(), principal: identity.principal });
    transport.onMessage((message) => {
      if ((message as { op?: string }).op === "session") return; // live-stream channel, not relay command
      if (!isValidRelayMessage(message)) return;
      const binding = this.bindings.get(transport);
      if (!binding) return;
      const owner = this.spokes.get(message.from);
      if (owner && owner !== transport) return; // id owned by another spoke: spoofed `from`
      if (!owner) {
        this.spokes.set(message.from, transport);
        binding.ids.add(message.from);
      }
      this.ingest(message, transport);
    });
  }

  /** Drop all spokes/registrations bound to a transport (socket close). */
  detachTransport(transport: RelayTransport): void {
    for (const [nodeId, spoke] of [...this.spokes]) {
      if (spoke === transport) {
        this.spokes.delete(nodeId);
        this.registry.delete(nodeId);
      }
    }
    this.bindings.delete(transport);
  }

  private ingest(message: RelayMessage, transport: RelayTransport): void {
    if (!isValidRelayMessage(message)) return;
    const binding = this.bindings.get(transport);
    if (!binding?.ids.has(message.from)) return;
    this.handle(message, transport, binding).catch((error: unknown) => {
      // A peer that vanished mid-reply (or any handler fault) must not surface
      // as an unhandled rejection — that exits the whole process.
      console.error("relay hub: dropped message", message.op, "from", message.from, error);
    });
  }

  /** Resolve nodes whose capabilities (and/or id/capability text) match a query. */
  discover(query: DiscoverPayload): string[] {
    const wanted = query.capabilities ?? [];
    const term = (query.query ?? "").toLowerCase().trim();
    const matches: string[] = [];
    for (const [id, registration] of this.registry) {
      if (wanted.length > 0 && !wanted.some((c) => registration.capabilities.includes(c))) continue;
      if (
        term.length > 0 &&
        !(id.toLowerCase().includes(term) || registration.capabilities.some((c) => c.toLowerCase().includes(term)))
      )
        continue;
      matches.push(id);
    }
    return matches;
  }

  /** Route to the node owning a repo (when known). */
  routeNode(route: RoutePayload): string | null {
    if (route.repo) {
      for (const [id, registration] of this.registry) {
        if (registration.repo === route.repo) return id;
      }
    }
    return null;
  }

  private rememberForward(worker: string, client: string, seq: number, ttlMs: number): void {
    const now = Date.now();
    if (this.forwards.size > 1000) {
      for (const [key, expiry] of this.forwards) if (expiry < now) this.forwards.delete(key);
    }
    this.forwards.set(worker + "|" + client + "|" + seq, now + 2 * Math.max(ttlMs, FORWARD_TTL_FLOOR_MS));
  }

  private consumeForward(worker: string, client: string, seq: number): boolean {
    const key = worker + "|" + client + "|" + seq;
    const expiry = this.forwards.get(key);
    if (expiry === undefined) return false;
    this.forwards.delete(key);
    return expiry >= Date.now();
  }

  /** Drop a node from the registry and detach its spoke (leave). */
  unregister(nodeId: string): void {
    this.registry.delete(nodeId);
    this.spokes.delete(nodeId);
  }

  /** Snapshot of registered peers (for introspection/tests). */
  peers(): { nodeId: string; capabilities: string[]; repo?: string; load: number; lastSeen: number }[] {
    const out: { nodeId: string; capabilities: string[]; repo?: string; load: number; lastSeen: number }[] = [];
    for (const [nodeId, registration] of this.registry) {
      out.push({
        nodeId,
        capabilities: registration.capabilities,
        repo: registration.repo,
        load: registration.load,
        lastSeen: registration.lastSeen,
      });
    }
    return out;
  }

  /** Aggregated bounded fleet snapshot (for fleet_status tool / ops view). */
  fleetStatus(): {
    node: string;
    load: number;
    sessions?: number;
    jobs?: number;
    version?: string;
    uptimeMs?: number;
    lastSeen: number;
  }[] {
    const out: {
      node: string;
      load: number;
      sessions?: number;
      jobs?: number;
      version?: string;
      uptimeMs?: number;
      lastSeen: number;
    }[] = [];
    for (const [nodeId, registration] of this.registry) {
      out.push({
        node: nodeId,
        load: registration.load,
        sessions: registration.telemetry?.sessions,
        jobs: registration.telemetry?.jobs,
        version: registration.telemetry?.version,
        uptimeMs: registration.telemetry?.uptimeMs,
        lastSeen: registration.lastSeen,
      });
    }
    return out;
  }

  /**
   * Placement: where a delegated job should run. Explicit target wins; else
   * locality (prefer the repo-owning capable node), else least-loaded capable.
   */
  placement(request: { tool: string; repo?: string; target?: string }): string | null {
    if (request.target) return request.target;
    const candidates = this.discover({ capabilities: [request.tool] });
    if (candidates.length === 0) return null;
    if (request.repo) {
      const local = candidates.find((id) => this.registry.get(id)?.repo === request.repo);
      if (local) return local;
    }
    let best = candidates[0];
    let bestLoad = this.registry.get(best)?.load ?? 0;
    for (const id of candidates) {
      const load = this.registry.get(id)?.load ?? 0;
      if (load < bestLoad) {
        best = id;
        bestLoad = load;
      }
    }
    return best;
  }

  private async handle(message: RelayMessage, spoke: RelayTransport, binding: SpokeBinding): Promise<void> {
    const { op, from, seq, ttlMs, payload } = message;

    if (op === "announce") {
      const announce = payload as { nodeId: string; capabilities: string[]; repo?: string; load?: number };
      this.registry.set(from, {
        capabilities: announce.capabilities ?? [],
        repo: announce.repo,
        load: announce.load ?? 0,
        lastSeen: Date.now(),
      });
      return;
    }

    if (op === "discover") {
      const result: DiscoverReply = { nodes: this.discover(payload as DiscoverPayload) };
      await spoke.send(relayMessage({ op: "discover_reply", from: this.hubId, to: from, seq, ttlMs, payload: result }));
      return;
    }

    if (op === "route") {
      const result: RouteReply = { node: this.routeNode(payload as RoutePayload) };
      await spoke.send(relayMessage({ op: "route_reply", from: this.hubId, to: from, seq, ttlMs, payload: result }));
      return;
    }

    if (op === "delegate_request") {
      // The steward gates on the principal the transport authenticated, never on
      // what the payload claims (else any peer could name an allowed principal).
      const request: DelegateRequestPayload = {
        ...(payload as DelegateRequestPayload),
        principal: binding.principal ?? from,
      };
      const target = this.placement(request);
      if (!target) {
        await spoke.send(
          relayMessage({
            op: "delegate_reply",
            from: this.hubId,
            to: from,
            seq,
            ttlMs,
            payload: { ok: false, auditId: "", reason: "no node offers " + request.tool },
          }),
        );
        return;
      }
      const targetSpoke = this.spokes.get(target);
      if (!targetSpoke) {
        await spoke.send(
          relayMessage({
            op: "delegate_reply",
            from: this.hubId,
            to: from,
            seq,
            ttlMs,
            payload: { ok: false, auditId: "", reason: "node reached is not connected" },
          }),
        );
        return;
      }
      if (request.trace) {
        this.traces.record({
          traceId: request.trace.traceId,
          spanId: nextSpanId(),
          parentSpanId: request.trace.parentSpanId,
          node: this.hubId,
          event: "forward",
          at: new Date().toISOString(),
          status: "ok",
          detail: from + " -> " + target + " tool=" + request.tool,
        });
      }
      // Forward to the worker, preserving the client's identity so its steward gates the call.
      this.rememberForward(target, from, seq, ttlMs);
      await targetSpoke.send(relayMessage({ op: "delegate_request", from, to: target, seq, ttlMs, payload: request }));
      return;
    }

    if (op === "delegate_reply") {
      // Only relay a reply to a request this hub actually forwarded to this
      // worker — otherwise any peer could forge replies to another client.
      if (!this.consumeForward(from, message.to, seq)) return;
      const reply = payload as DelegateReplyPayload;
      if (reply.traceSpans && reply.traceSpans.length > 0) {
        const traceId = reply.traceSpans[0].traceId;
        for (const span of reply.traceSpans) this.traces.record(span);
        this.traces.record({
          traceId,
          spanId: nextSpanId(),
          node: this.hubId,
          event: "reply",
          at: new Date().toISOString(),
          status: reply.ok ? "ok" : "failed",
          detail: message.from + " -> " + message.to,
        });
      }
      // A worker replied through a spoke; relay to the originating client's spoke.
      const clientSpoke = this.spokes.get(message.to);
      if (clientSpoke) await clientSpoke.send(message);
      return;
    }

    if (op === "presence") {
      const presence = payload as PresencePayload;
      if (presence.status === "leave") {
        this.registry.delete(from);
      } else if (presence.status === "join") {
        const existing = this.registry.get(from);
        this.registry.set(from, existing ?? { capabilities: [], load: 0, lastSeen: Date.now() });
        if (existing) existing.lastSeen = Date.now();
      } else if (presence.status === "heartbeat") {
        const existing = this.registry.get(from);
        if (existing) {
          existing.lastSeen = Date.now();
          if (presence.load !== undefined) existing.load = presence.load;
          if (presence.telemetry) existing.telemetry = presence.telemetry;
        }
      }
      return;
    }
  }
}
