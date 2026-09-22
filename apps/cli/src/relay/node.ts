// Relay node (Phase 2 W3). One engine node on the relay: announces its
// steward-scoped tools, delegates bounded calls to peers, and services incoming
// delegate_requests through the steward gate — returning bounded replies with a
// statement + anchors + an opaque handle. expand(handle) re-enters the same gate.

import { BoundedEnvelope, type BoundedPayload } from "./envelope";
import {
  type DelegateReplyPayload,
  type DelegateRequestPayload,
  type DiscoverPayload,
  type RelayMessage,
  relayMessage,
} from "./protocol";
import type { Steward } from "./steward";
import { nextSpanId } from "./trace";
import type { RelayTransport } from "./transport";

export interface RemoteTool {
  /** Steward-scoped tool name, e.g. "nodeB_ping". */
  name: string;
  description: string;
  budgetBytes?: number;
  run(args: unknown): BoundedPayload;
}

export class RelayNode {
  private readonly tools = new Map<string, RemoteTool>();
  private readonly pending = new Map<number, (payload: unknown) => void>();
  private seq = 0;

  constructor(
    readonly nodeId: string,
    private readonly transport: RelayTransport,
    private readonly steward: Steward,
  ) {
    this.transport.onMessage((message) => {
      this.handleMessage(message).catch((error: unknown) => {
        // A failed reply send (peer gone) must not become an unhandled rejection.
        console.error("relay node: dropped message", message?.op, error);
      });
    });
  }

  registerTool(tool: RemoteTool): void {
    this.tools.set(tool.name, tool);
  }

  /** Announce capabilities (and optional owned repo), then serve/route. */
  async start(options: { repo?: string; load?: number } = {}): Promise<void> {
    await this.transport.send(
      relayMessage({
        op: "announce",
        from: this.nodeId,
        to: "*",
        seq: this.nextSeq(),
        ttlMs: 30_000,
        payload: {
          nodeId: this.nodeId,
          capabilities: [...this.tools.keys()],
          ...(options.repo ? { repo: options.repo } : {}),
          ...(options.load !== undefined ? { load: options.load } : {}),
        },
      }),
    );
  }

  /**
   * Delegate a bounded call to tool on a peer node. Resolves with the peer's
   * bounded reply (statement + anchors + handle).
   */
  async delegate(
    to: string,
    tool: string,
    args: unknown,
    principal: string,
    scope: string,
    options?: { target?: string; repo?: string; budgetBytes?: number; traceId?: string; parentSpanId?: string },
  ): Promise<DelegateReplyPayload> {
    const seq = this.nextSeq();
    const reply = new Promise<DelegateReplyPayload>((resolve) =>
      this.pending.set(seq, resolve as (payload: unknown) => void),
    );
    await this.transport.send(
      relayMessage({
        op: "delegate_request",
        from: this.nodeId,
        to,
        seq,
        ttlMs: 30_000,
        payload: {
          tool,
          args,
          principal,
          scope,
          ...(options?.target ? { target: options.target } : {}),
          ...(options?.repo ? { repo: options.repo } : {}),
          ...(options?.budgetBytes !== undefined ? { budgetBytes: options.budgetBytes } : {}),
          ...(options?.traceId
            ? {
                trace: {
                  traceId: options.traceId,
                  ...(options.parentSpanId ? { parentSpanId: options.parentSpanId } : {}),
                },
              }
            : {}),
        } as DelegateRequestPayload,
      }),
    );
    return reply;
  }

  /**
   * Resolve which node serves a capability (via the hub). Returns node ids.
   */
  async discover(query: DiscoverPayload): Promise<string[]> {
    const seq = this.nextSeq();
    const reply = new Promise<unknown>((resolve) => this.pending.set(seq, resolve as (payload: unknown) => void));
    await this.transport.send(
      relayMessage({ op: "discover", from: this.nodeId, to: "hub", seq, ttlMs: 30_000, payload: query }),
    );
    const value = (await reply) as { nodes: string[] };
    return value.nodes ?? [];
  }

  /**
   * Resolve which node owns a repo (via the hub). Returns a node id or null.
   */
  async locate(repo: string): Promise<string | null> {
    const seq = this.nextSeq();
    const reply = new Promise<unknown>((resolve) => this.pending.set(seq, resolve as (payload: unknown) => void));
    await this.transport.send(
      relayMessage({ op: "route", from: this.nodeId, to: "hub", seq, ttlMs: 30_000, payload: { repo } }),
    );
    const value = (await reply) as { node: string | null };
    return value.node ?? null;
  }

  /**
   * expand(handle) re-enters the same steward gate for the deferred content —
   * the handle is passed through the identical delegate path (v0 §6 delegate/
   * expand follows the same gate).
   */
  async expand(
    to: string,
    tool: string,
    handle: string,
    principal: string,
    scope: string,
  ): Promise<DelegateReplyPayload> {
    return this.delegate(to, tool, { handle }, principal, scope);
  }

  /** Send a presence signal (join/leave/heartbeat). */
  async presence(status: "join" | "leave" | "heartbeat"): Promise<void> {
    await this.transport.send(
      relayMessage({
        op: "presence",
        from: this.nodeId,
        to: "hub",
        seq: this.nextSeq(),
        ttlMs: 15_000,
        payload: { status, at: new Date().toISOString() },
      }),
    );
  }

  /** Report fleet telemetry (sessions/jobs/version/uptime) to the hub. */
  async reportStatus(telemetry: import("./protocol").PresenceTelemetry): Promise<void> {
    await this.transport.send(
      relayMessage({
        op: "presence",
        from: this.nodeId,
        to: "hub",
        seq: this.nextSeq(),
        ttlMs: 15_000,
        payload: { status: "heartbeat", at: new Date().toISOString(), telemetry },
      }),
    );
  }

  /** Report this node's current load so hubs place jobs on the least-loaded peer. */
  async reportLoad(load: number): Promise<void> {
    await this.transport.send(
      relayMessage({
        op: "presence",
        from: this.nodeId,
        to: "hub",
        seq: this.nextSeq(),
        ttlMs: 15_000,
        payload: { status: "heartbeat", at: new Date().toISOString(), load },
      }),
    );
  }

  /** Announce leave, then close the transport. */
  async leave(): Promise<void> {
    await this.presence("leave");
    await this.transport.close();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) % 100000;
    return this.seq;
  }

  private async handleMessage(message: RelayMessage): Promise<void> {
    if (message.to !== this.nodeId && message.to !== "*") return;
    const payload = message.payload;

    if (message.op === "delegate_request") {
      const request = payload as DelegateRequestPayload;
      const gate = this.steward.authorize(request.principal, request.tool, request.scope);
      const tool = this.tools.get(request.tool);
      const spanStart = request.trace ? Date.now() : undefined;
      let reply: DelegateReplyPayload;
      if (!gate.allowed || !tool) {
        reply = { ok: false, auditId: gate.auditId, reason: gate.reason ?? `unknown tool ${request.tool}` };
      } else {
        try {
          const bounded = tool.run(request.args);
          // Budget enforced at construction; over-budget replies are refused.
          const envelope = new BoundedEnvelope(this.nodeId, bounded, tool.budgetBytes);
          reply = {
            ok: true,
            auditId: gate.auditId,
            statement: envelope.payload.statement,
            anchors: envelope.payload.anchors,
            handle: envelope.payload.handle,
          };
        } catch (error) {
          reply = { ok: false, auditId: gate.auditId, reason: String(error) };
        }
      }
      if (request.trace && spanStart !== undefined) {
        reply = {
          ...reply,
          traceSpans: [
            {
              traceId: request.trace.traceId,
              spanId: nextSpanId(),
              parentSpanId: request.trace.parentSpanId,
              node: this.nodeId,
              event: "run",
              at: new Date().toISOString(),
              durMs: Date.now() - spanStart,
              status: reply.ok ? "ok" : "failed",
              detail: `tool=${request.tool}`,
            },
          ],
        };
      }
      await this.transport.send(
        relayMessage({
          op: "delegate_reply",
          from: this.nodeId,
          to: message.from,
          seq: message.seq,
          ttlMs: message.ttlMs,
          payload: reply,
        }),
      );
      return;
    }

    if (message.op === "delegate_reply" || message.op === "discover_reply" || message.op === "route_reply") {
      const resolver = this.pending.get(message.seq);
      if (resolver) {
        this.pending.delete(message.seq);
        resolver(payload);
      }
      return;
    }

    // announce / presence / discover / route: slice 1 stubs (accepted, unused).
  }
}
