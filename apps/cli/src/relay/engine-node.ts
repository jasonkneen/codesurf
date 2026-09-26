// Runnable engine node (Phase 3 -> the "node" that owns work over the wire).
// An EngineNode composes a Hub (registry/discover/route), a NodeSessionHost
// (sessions that outlive any front), and a local relay node that serves session
// ops as remote tools, all reachable by remote fronts over WebSockets. A front
// connects, creates/messages sessions, can disconnect and the node keeps the
// turn running; reconnecting fronts read the result. The turn runner is the seam
// bound to a real engine Agent in production (injected here).

import { recordIssue } from "../storage/issues";
import { type HostedTurnRunner, NodeSessionHost, type SessionWorkspace, type SessionWorkspaceOptions } from "./host";
import { Hub } from "./hub";
import { JobHost, type JobRunner, registerJobTools } from "./jobs";
import { RelayNode } from "./node";
import { SessionStreamServer } from "./session-stream";
import { type NodeScope, resolveSessionWorkspace } from "./session-workspace";
import { Steward } from "./steward";
import { renderTraceTrajectory } from "./trace";
import { connectPeerPair } from "./transport";
import { WIRE_PRINCIPAL, WsRelayServer } from "./ws-transport";

export interface EngineNodeOptions {
  nodeId?: string;
  port?: number;
  /** Bind address for the WS server. Default 127.0.0.1. */
  host?: string;
  /** Bearer token remote fronts must present (see WsRelayServer). Unset = no auth (in-process/tests only). */
  authToken?: string;
  /** Browser origins allowed to connect (e.g. the live web front). */
  allowedOrigins?: readonly string[];
  /** Directories GET /files may read. Default: cwd + tmpdir. */
  fileRoots?: readonly string[];
  turnRunner: HostedTurnRunner;
  /** Optional compute runner — mounts job_submit/status/cancel on this node. */
  jobRunner?: JobRunner;
  /** Principals allowed to drive this node's sessions. Default: the token-authenticated wire principal. */
  allowPrincipals?: string[];
  /** Evict sessions idle past this (ms). */
  sessionIdleTtlMs?: number;
  /** Evict sessions alive past this (ms), even if active. */
  sessionMaxTtlMs?: number;
  /** Called when a session is evicted (owner disposes its Agent). */
  onSessionEvict?: (sessionId: string) => void;
  /** Which folders this node serves, and its name; reported to fronts via the info frame. Default: any folder. */
  scope?: NodeScope;
  /** Validate a session's requested folder/sandbox. Default: `resolveSessionWorkspace` under `scope`. */
  resolveWorkspace?: (options: SessionWorkspaceOptions) => SessionWorkspace;
  /** Auto-reap sessions/jobs/traces on this interval (ms). */
  reapIntervalMs?: number;
}

export class EngineNode {
  readonly hub: Hub;
  readonly sessions: NodeSessionHost;
  readonly node: RelayNode;
  readonly jobHost?: JobHost;
  readonly server: WsRelayServer;
  readonly nodeId: string;
  readonly streamServer: SessionStreamServer;
  readonly scope: NodeScope;
  private reapTimer?: ReturnType<typeof setInterval>;

  constructor(options: EngineNodeOptions) {
    this.nodeId = options.nodeId ?? "node0";
    const scope: NodeScope = options.scope ?? { scope: "user" };
    this.scope = scope;
    this.hub = new Hub("hub");
    this.sessions = new NodeSessionHost(options.turnRunner, {
      idleTtlMs: options.sessionIdleTtlMs,
      maxTtlMs: options.sessionMaxTtlMs,
      onEvict: options.onSessionEvict,
      resolveWorkspace: options.resolveWorkspace ?? ((requested) => resolveSessionWorkspace(requested, scope)),
    });
    const allow = options.allowPrincipals ?? (options.authToken !== undefined ? [WIRE_PRINCIPAL] : ["any"]);

    const [localTx, hubTx] = connectPeerPair();
    const policy: Record<string, string[]> = {};
    for (const tool of [
      "session_create",
      "session_message",
      "session_status",
      "session_destroy",
      "job_submit",
      "job_status",
      "job_cancel",
      "fleet_status",
      "trace_path",
    ]) {
      policy[tool] = allow;
    }
    this.node = new RelayNode(this.nodeId, localTx, new Steward({ allow: policy }));

    this.node.registerTool({
      name: "session_create",
      description: "Create a session owned by this node, optionally in a given absolute folder (cwd).",
      run: (args) => {
        const cwd = (args as { cwd?: unknown } | undefined)?.cwd;
        const id = this.sessions.createSession(undefined, typeof cwd === "string" ? { cwd } : {});
        return { statement: `created:${id}`, anchors: [], handle: id };
      },
    });
    this.node.registerTool({
      name: "session_message",
      description: "Send a message to a session; the node runs it background.",
      run: (args) => {
        const sessionId = String((args as { sessionId?: string }).sessionId ?? "");
        const text = String((args as { text?: string }).text ?? "");
        const status = this.sessions.status(sessionId);
        if (!status) return { statement: `unknown:${sessionId}`, anchors: [] };
        if (status.turning) return { statement: `busy:${sessionId}`, anchors: [], handle: sessionId };
        this.sessions.enqueue(sessionId, text);
        return { statement: `accepted:${sessionId}`, anchors: [], handle: sessionId };
      },
    });
    this.node.registerTool({
      name: "session_status",
      description: "Read a session's bounded status (turning, finished, text).",
      run: (args) => {
        const sessionId = String((args as { sessionId?: string }).sessionId ?? "");
        const status = this.sessions.status(sessionId);
        if (!status) return { statement: `unknown:${sessionId}`, anchors: [] };
        return {
          statement: JSON.stringify({ turning: status.turning, finished: status.finished, text: status.text }),
          anchors: [],
          handle: sessionId,
        };
      },
    });
    this.node.registerTool({
      name: "session_destroy",
      description: "Destroy a session.",
      run: (args) => {
        const sessionId = String((args as { sessionId?: string }).sessionId ?? "");
        const removed = this.sessions.destroy(sessionId);
        return { statement: removed ? `removed:${sessionId}` : `absent:${sessionId}`, anchors: [] };
      },
    });

    this.node.registerTool({
      name: "trace_path",
      description: "Render the full traceroute (trajectory) for a trace id",
      run: (args) => {
        const traceId = String((args as { traceId?: string }).traceId ?? "");
        const rendered = renderTraceTrajectory(this.hub.trace(traceId));
        return { statement: rendered, anchors: [], handle: traceId };
      },
    });

    this.node.registerTool({
      name: "fleet_status",
      description: "Read the aggregated fleet snapshot served by this node's hub",
      run: () => {
        const fleet = this.hub.fleetStatus();
        return { statement: JSON.stringify(fleet), anchors: [], handle: "fleet" };
      },
    });

    if (options.jobRunner) {
      const jobHost = new JobHost(options.jobRunner);
      this.jobHost = jobHost;
      registerJobTools(this.node, jobHost, () => void this.node.reportLoad(jobHost.load()));
    }

    this.hub.attach(this.nodeId, hubTx);

    if (options.reapIntervalMs) {
      this.reapTimer = setInterval(() => this.reapAll(), options.reapIntervalMs);
      this.reapTimer.unref?.();
    }
    this.streamServer = new SessionStreamServer(this.sessions, scope, (source, message, sessionId) =>
      recordIssue({ source, message, sessionId }),
    );
    this.server = new WsRelayServer({
      hub: this.hub,
      port: options.port,
      host: options.host,
      authToken: options.authToken,
      allowedOrigins: options.allowedOrigins,
      fileRoots: options.fileRoots,
      onSessionFrame: (frame, sendBack) => this.streamServer.handle(frame, sendBack),
    });
  }

  /** Evict expired sessions/jobs/traces; returns the number of sessions evicted. */
  reapAll(): number {
    const evicted = this.sessions.reap();
    this.jobHost?.reapFinished();
    this.hub.traces.reap();
    return evicted;
  }

  async start(): Promise<void> {
    await this.server.ready;
    await this.node.start({});
  }

  /** Bound port remote fronts connect to. */
  port(): number {
    return this.server.port();
  }

  async close(): Promise<void> {
    if (this.reapTimer) clearInterval(this.reapTimer);
    this.reapTimer = undefined;
    await this.server.close();
  }
}
