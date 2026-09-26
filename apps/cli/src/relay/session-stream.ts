// Session streaming channel — the mode-2 "front" plane.
//
// The relay envelope is a bounded command fabric (delegate_request/reply). Live
// turn streaming to a front rides a SEPARATE channel on the same WS socket,
// framed as `op:"session"` so the relay hub ignores it. A front (headless CLI
// or TUI-as-front) connects, creates a session on the node, sends a message,
// and receives live StreamChunks + done over the wire. Client death never
// cancels the node's turn (NodeSessionHost owns it); the host's TTL reaper
// evicts abandoned sessions.

import type { StreamChunk } from "../types/index";
import type { SandboxMode, SandboxSettings } from "../utils/settings";
import type { NodeSessionHost, SessionStatus } from "./host";

/** What a node serves (`info` frame): any folder, or one project tree. */
export interface NodeInfo {
  scope: "user" | "project";
  /** Project root (realpath) on a project server. */
  project?: string;
  /** Operator-chosen name (`codesurf node --name`). */
  name?: string;
}

const END = Symbol("remote-turn-end");

let turnCounter = 0;
function newTurnId(): string {
  turnCounter += 1;
  return `t${Date.now().toString(36)}-${turnCounter}`;
}

/**
 * A stream frame belongs to this turn when it is for this session and either
 * carries this turn's id or no id at all (a node that predates turn ids).
 * Without the id check, a previous turn's late `done` ended the next turn.
 */
function belongsToTurn(session: string, frameTurn: string | undefined, sessionId: string, turn: string): boolean {
  return session === sessionId && (frameTurn === undefined || frameTurn === turn);
}

/** A live front attachment to a node session (used by the interactive TUI). */
export interface RemoteFront {
  client: SessionStreamClient;
  sessionId: string;
  url: string;
}

export type SessionFrameOut =
  | {
      op: "session";
      event: "created" | "done" | "status" | "error" | "pong" | "list" | "approval_request" | "info";
      info?: NodeInfo;
      sessions?: import("./host").SessionStatus[];
      approvalId?: string;
      toolName?: string;
      input?: unknown;
      session?: string;
      chunk?: StreamChunk;
      status?: SessionStatus | null;
      finished?: boolean;
      message?: string;
      /** On an error frame: the request action that failed (e.g. "create"). */
      action?: SessionFrameIn["action"];
      /** Turn id the frame belongs to (echo of the message's `turn`). */
      turn?: string;
    }
  | { op: "session"; event: "chunk"; session: string; chunk: StreamChunk; turn?: string };

export interface SessionFrameIn {
  op: "session";
  action: "create" | "message" | "subscribe" | "status" | "destroy" | "ping" | "list" | "approval_decision" | "info";
  approvalId?: string;
  approve?: boolean;
  session?: string;
  text?: string;
  /**
   * message: front-chosen turn id, echoed on every chunk/done/error of that
   * turn so a front can drop a previous turn's late frames.
   */
  turn?: string;
  /** create: absolute folder the session runs in. Unset = the node's own folder. */
  cwd?: string;
  /** create: sandbox for the session's shell. Unset = the folder's settings. */
  sandboxMode?: SandboxMode;
  /** create: sandbox settings layered over the folder's settings. */
  sandboxSettings?: SandboxSettings;
}

/** Options for `SessionStreamClient.createSession`. */
export interface CreateSessionOptions {
  /** Session id to use; the node picks one when unset. */
  session?: string;
  cwd?: string;
  sandboxMode?: SandboxMode;
  sandboxSettings?: SandboxSettings;
}

/**
 * Reports a durable-log-worthy failure (e.g. "unknown session"). Injected so
 * this file stays free of node-only storage deps (the client half is bundled
 * for the browser); engine-node wires src/storage/issues.ts's recordIssue.
 */
export type IssueReporter = (source: string, message: string, sessionId?: string) => void;

/** Node side: bridges WS session frames to a NodeSessionHost's observers. */
export class SessionStreamServer {
  private readonly pendingApprovals = new Map<string, (approve: boolean) => void>();

  constructor(
    private readonly host: NodeSessionHost,
    private readonly nodeInfo: NodeInfo = { scope: "user" },
    private readonly onIssue?: IssueReporter,
  ) {}

  /**
   * Engine-side approval round-trip: register a pending approval and push a
   * request frame to the given front (sendBack). Resolves {approve: boolean}
   * when the front sends guidance_decision, or false on timeout.
   */
  requestApproval(
    sessionId: string,
    approvalId: string,
    toolName: string,
    input: unknown,
    sendBack: (out: SessionFrameOut) => void,
    timeoutMs = 30_000,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(approvalId);
        resolve(false);
      }, timeoutMs);
      this.pendingApprovals.set(approvalId, (approve) => {
        clearTimeout(timer);
        this.pendingApprovals.delete(approvalId);
        resolve(approve);
      });
      sendBack({ op: "session", event: "approval_request", session: sessionId, approvalId, toolName, input });
    });
  }

  handle(frame: SessionFrameIn, sendBack: (out: SessionFrameOut) => void): void {
    const action = (frame as SessionFrameIn | undefined)?.action;
    if (!action) return;
    const safe = (fn: () => void) => {
      try {
        fn();
      } catch {
        /* front gone (closed socket) — swallow; next reaper pass evicts the session */
      }
    };
    const turnOf = (session: string) => this.host.turnIdOf(session);
    const observer = (session: string) => ({
      onChunk: (c: StreamChunk) =>
        safe(() => sendBack({ op: "session", event: "chunk", session, chunk: c, turn: turnOf(session) })),
      onEnd: () => safe(() => sendBack({ op: "session", event: "done", session, finished: true, turn: turnOf(session) })),
    });
    switch (action) {
      case "create":
        try {
          const session = this.host.createSession(frame.session, {
            cwd: frame.cwd,
            sandboxMode: frame.sandboxMode,
            sandboxSettings: frame.sandboxSettings,
          });
          sendBack({ op: "session", event: "created", session });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.onIssue?.("relay.session-stream.create", message, frame.session);
          sendBack({ op: "session", event: "error", action: "create", session: frame.session, message });
        }
        break;
      case "message": {
        const session = frame.session ?? "";
        const status = this.host.status(session);
        if (!status) {
          // Unknown or reaped session: tell the front instead of leaving it waiting for `done`.
          this.onIssue?.("relay.session-stream.message", `unknown session ${session}`, session);
          sendBack({ op: "session", event: "error", session, turn: frame.turn, message: `unknown session ${session}` });
          break;
        }
        if (status.turning) {
          this.onIssue?.("relay.session-stream.busy", `session ${session} is busy with a running turn`, session);
          sendBack({
            op: "session",
            event: "error",
            session,
            turn: frame.turn,
            message: `session ${session} is busy with a running turn`,
          });
          break;
        }
        const detach = this.host.attach(session, observer(session));
        void this.host
          .message(session, frame.text ?? "", frame.turn)
          .catch((e) => this.onIssue?.("relay.turn", e instanceof Error ? e.message : String(e), session))
          .finally(() => safe(() => detach()));
        break;
      }
      case "subscribe":
        try {
          this.host.attach(frame.session ?? "", observer(frame.session ?? ""));
        } catch (e) {
          this.onIssue?.("relay.session-stream.subscribe", String(e), frame.session);
          sendBack({ op: "session", event: "error", message: String(e) });
        }
        break;
      case "status":
        sendBack({
          op: "session",
          event: "status",
          session: frame.session,
          status: this.host.status(frame.session ?? ""),
        });
        break;
      case "list":
        sendBack({ op: "session", event: "list", sessions: this.host.list() });
        break;
      case "approval_decision": {
        const resolver = this.pendingApprovals.get(frame.approvalId ?? "");
        if (resolver) resolver(Boolean(frame.approve));
        break;
      }
      case "ping":
        sendBack({ op: "session", event: "pong" });
        break;
      case "info":
        sendBack({ op: "session", event: "info", info: this.nodeInfo });
        break;
      case "destroy":
        this.host.destroy(frame.session ?? "");
        break;
    }
  }
}

/**
 * Add a node token to a ws:// URL as `?token=` (browsers and the global
 * WebSocket cannot set an Authorization header on the upgrade). A URL that
 * already carries a token is left alone.
 */
export function withToken(url: string, token: string | null | undefined): string {
  if (!token) return url;
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("token")) return url;
    parsed.searchParams.set("token", token);
    return parsed.toString();
  } catch {
    return url;
  }
}

type WebSocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(ev: "open" | "message" | "close" | "error", fn: (e: unknown) => void): void;
};

interface StreamClientHandlers {
  onChunk?: (session: string, chunk: StreamChunk, turn?: string) => void;
  onDone?: (session: string, finished: boolean, turn?: string) => void;
  onCreated?: (session: string) => void;
  onError?: (message: string, session?: string, turn?: string) => void;
  /** The socket closed (node gone, auth refused, network drop). */
  onClose?: () => void;
}

/** Front side: a thin session front against a codesurf node's WS server. */
export class SessionStreamClient {
  /**
   * Supplies the node token for a URL that carries none. Node-side entrypoints
   * install one that reads the machine-local node token; the browser front
   * never does (it passes `?token=` in its URL). Kept as a hook so this module
   * stays free of node:fs for the web bundle.
   */
  static tokenResolver: ((url: string) => string | null) | undefined;

  private ws?: WebSocketLike;
  private readonly pending = new Map<string, (v: unknown) => void>();
  private readonly handlers: StreamClientHandlers = {};

  constructor(
    private readonly url: string,
    private readonly onClose?: () => void,
  ) {}

  on(handlers: StreamClientHandlers): void {
    Object.assign(this.handlers, handlers);
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(withToken(this.url, SessionStreamClient.tokenResolver?.(this.url)));
      this.ws = ws as unknown as WebSocketLike;
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error(`session stream connect failed: ${this.url}`)));
      ws.addEventListener("close", () => {
        this.onClose?.();
        this.handlers.onClose?.();
      });
      ws.addEventListener("message", (event) => this.ingest(String((event as { data: unknown }).data)));
    });
  }

  private send(frame: SessionFrameIn): void {
    this.require().send(JSON.stringify(frame));
  }

  private ingest(raw: string): void {
    let frame: SessionFrameOut;
    try {
      frame = JSON.parse(raw) as SessionFrameOut;
    } catch {
      return;
    }
    if ((frame as { op?: string }).op !== "session") return;
    switch (frame.event) {
      case "created":
        this.pending.get("create")?.(frame.session);
        this.pending.delete("create");
        this.handlers.onCreated?.(frame.session as string);
        break;
      case "status":
        this.pending.get("status")?.(frame.status);
        this.pending.delete("status");
        break;
      case "pong":
        this.pending.get("ping")?.(true);
        this.pending.delete("ping");
        break;
      case "list":
        this.pending.get("list")?.(frame.sessions);
        this.pending.delete("list");
        break;
      case "info":
        this.pending.get("info")?.(frame.info);
        this.pending.delete("info");
        break;
      case "approval_request":
        this.onApprovalRequest?.(frame.session ?? "", frame.approvalId ?? "", frame.toolName ?? "", frame.input);
        break;
      case "chunk":
        this.handlers.onChunk?.(frame.session as string, frame.chunk as StreamChunk, frame.turn);
        break;
      case "done":
        this.handlers.onDone?.(frame.session as string, Boolean(frame.finished), frame.turn);
        break;
      case "error":
        if (frame.action === "create") {
          this.pending.get("create-error")?.(frame.message);
          this.pending.delete("create");
          this.pending.delete("create-error");
        }
        this.handlers.onError?.(frame.message as string, frame.session, frame.turn);
        break;
    }
  }

  /**
   * Create a session on the node. A string is the session id (the old form);
   * an options object can also set the folder the session runs in (`cwd`,
   * absolute) and its sandbox. Rejects with the node's message when it refuses
   * the create (e.g. a cwd that is not an existing directory).
   */
  createSession(options?: string | CreateSessionOptions): Promise<string> {
    const request: CreateSessionOptions = typeof options === "string" ? { session: options } : (options ?? {});
    return new Promise<string>((resolve, reject) => {
      this.pending.set("create", (v) => {
        this.pending.delete("create-error");
        resolve(v as string);
      });
      this.pending.set("create-error", (message) => reject(new Error(String(message))));
      this.send({
        op: "session",
        action: "create",
        session: request.session,
        cwd: request.cwd,
        sandboxMode: request.sandboxMode,
        sandboxSettings: request.sandboxSettings,
      });
      setTimeout(() => {
        if (this.pending.has("create")) {
          this.pending.delete("create");
          this.pending.delete("create-error");
          reject(new Error("create session timed out"));
        }
      }, 5000);
    });
  }

  /**
   * Make sure the node has a live session with this exact id, creating it if
   * missing (never attached, or reaped after idling). Fronts pass their saved
   * session id so the node continues that conversation.
   */
  async ensureSession(
    session: string,
    options: Omit<CreateSessionOptions, "session"> = {},
    timeoutMs = 5000,
  ): Promise<string> {
    const existing = await Promise.race([
      this.status(session),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (existing) return session;
    return await this.createSession({ ...options, session });
  }

  sendMessage(session: string, text: string, turn?: string): void {
    this.send({ op: "session", action: "message", session, text, turn });
  }

  subscribe(session: string): void {
    this.send({ op: "session", action: "subscribe", session });
  }

  destroy(session: string): void {
    this.send({ op: "session", action: "destroy", session });
  }

  status(session: string): Promise<SessionStatus | null> {
    return new Promise((resolve) => {
      this.pending.set("status", (v) => resolve(v as SessionStatus | null));
      this.send({ op: "session", action: "status", session });
    });
  }

  /** Lightweight reachability probe: returns true if the node answers pong. */
  /** List sessions on the node. */
  listSessions(timeoutMs = 2000): Promise<import("./host").SessionStatus[]> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve([]), timeoutMs);
      this.pending.set("list", (sessions: unknown) => {
        clearTimeout(timer);
        resolve((sessions as import("./host").SessionStatus[] | undefined) ?? []);
      });
      this.send({ op: "session", action: "list" });
    });
  }

  /** Front-side approval callback: called when the node asks the user. */
  onApprovalRequest?: (sessionId: string, approvalId: string, toolName: string, input: unknown) => void;

  /** Send a tool-approval decision to the node. */
  approve(sessionId: string, approvalId: string, approve: boolean): void {
    this.send({ op: "session", action: "approval_decision", session: sessionId, approvalId, approve });
  }

  /**
   * What the node serves: `{ scope: "user" }` (any folder) or
   * `{ scope: "project", project }`, plus its `name` if it has one. Resolves
   * null when the node does not answer in time (e.g. a node predating this frame).
   */
  info(timeoutMs = 1500): Promise<NodeInfo | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete("info");
        resolve(null);
      }, timeoutMs);
      this.pending.set("info", (info) => {
        clearTimeout(timer);
        resolve((info as NodeInfo | undefined) ?? null);
      });
      this.send({ op: "session", action: "info" });
    });
  }

  ping(timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.pending.set("ping", () => {
        clearTimeout(timer);
        resolve(true);
      });
      this.send({ op: "session", action: "ping" });
    });
  }

  close(): void {
    this.ws?.close();
  }

  private require(): WebSocketLike {
    if (!this.ws) throw new Error("client not connected");
    return this.ws;
  }
}
/**
 * Bridge a remote session stream into an AsyncGenerator<StreamChunk> — the
 * shape the interactive TUI's turn engine consumes. Sends `text` to the
 * session and yields chunks as they arrive over the wire, finishing on done.
 */
export function createRemoteSessionTurn(
  client: SessionStreamClient,
  sessionId: string,
  text: string,
): AsyncGenerator<StreamChunk, void, unknown> {
  return (async function* () {
    const queue: Array<StreamChunk | typeof END> = [];
    let notify: (() => void) | null = null;
    let settled = false;
    const wake = () => {
      const n = notify;
      notify = null;
      n?.();
    };
    const turn = newTurnId();
    client.on({
      onChunk: (s, c, frameTurn) => {
        if (settled || !belongsToTurn(s, frameTurn, sessionId, turn)) return;
        queue.push(c);
        wake();
      },
      onDone: (s, _finished, frameTurn) => {
        if (settled || !belongsToTurn(s, frameTurn, sessionId, turn)) return;
        settled = true;
        queue.push(END);
        wake();
      },
      // Unknown/reaped/busy session or a dropped socket: end the turn with an
      // error chunk instead of waiting forever for a `done` that never comes.
      onError: (message, session, frameTurn) => {
        if (settled || (session !== undefined && session !== sessionId)) return;
        if (frameTurn !== undefined && frameTurn !== turn) return;
        settled = true;
        queue.push({ type: "error", content: message }, END);
        wake();
      },
      onClose: () => {
        if (settled) return;
        settled = true;
        queue.push({ type: "error", content: "connection to the node closed" }, END);
        wake();
      },
    });
    client.sendMessage(sessionId, text, turn);
    while (true) {
      if (queue.length) {
        const v = queue.shift() as StreamChunk | typeof END;
        if (v === END) return;
        yield v as StreamChunk;
        continue;
      }
      if (settled) return;
      await new Promise<void>((res) => {
        notify = res;
      });
    }
  })();
}

/** Idle limit for a remote turn: no chunk for this long means the node is gone or stuck. */
export const REMOTE_TURN_IDLE_TIMEOUT_MS = 10 * 60_000;

/**
 * Run one turn on a node session and settle: resolves on `done`, rejects on a
 * node error frame (unknown/reaped/busy session), a closed socket, or when no
 * frame arrives for `idleTimeoutMs` — so a headless front never hangs forever.
 */
export function runRemoteTurn(
  client: SessionStreamClient,
  sessionId: string,
  text: string,
  options: { onChunk?: (chunk: StreamChunk) => void; idleTimeoutMs?: number } = {},
): Promise<void> {
  const idleTimeoutMs = options.idleTimeoutMs ?? REMOTE_TURN_IDLE_TIMEOUT_MS;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => settle(new Error(`remote turn timed out: no frame from the node for ${idleTimeoutMs}ms`)),
        idleTimeoutMs,
      );
    };
    const turn = newTurnId();
    client.on({
      onChunk: (session, chunk, frameTurn) => {
        if (!belongsToTurn(session, frameTurn, sessionId, turn)) return;
        arm();
        options.onChunk?.(chunk);
      },
      onDone: (session, _finished, frameTurn) => {
        if (belongsToTurn(session, frameTurn, sessionId, turn)) settle();
      },
      onError: (message, session, frameTurn) => {
        if (frameTurn !== undefined && frameTurn !== turn) return;
        if (session === undefined || session === sessionId) settle(new Error(message));
      },
      onClose: () => settle(new Error("connection to the node closed before the turn finished")),
    });
    arm();
    try {
      client.sendMessage(sessionId, text, turn);
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
