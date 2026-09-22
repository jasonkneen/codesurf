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
import type { NodeSessionHost, SessionStatus } from "./host";

const END = Symbol("remote-turn-end");

/** A live front attachment to a node session (used by the interactive TUI). */
export interface RemoteFront {
  client: SessionStreamClient;
  sessionId: string;
  url: string;
}

export type SessionFrameOut =
  | {
      op: "session";
      event: "created" | "done" | "status" | "error" | "pong" | "list" | "approval_request";
      sessions?: import("./host").SessionStatus[];
      approvalId?: string;
      toolName?: string;
      input?: unknown;
      session?: string;
      chunk?: StreamChunk;
      status?: SessionStatus | null;
      finished?: boolean;
      message?: string;
    }
  | { op: "session"; event: "chunk"; session: string; chunk: StreamChunk };

export interface SessionFrameIn {
  op: "session";
  action: "create" | "message" | "subscribe" | "status" | "destroy" | "ping" | "list" | "approval_decision";
  approvalId?: string;
  approve?: boolean;
  session?: string;
  text?: string;
}

/** Node side: bridges WS session frames to a NodeSessionHost's observers. */
export class SessionStreamServer {
  private readonly pendingApprovals = new Map<string, (approve: boolean) => void>();

  constructor(private readonly host: NodeSessionHost) {}

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
    const observer = (session: string) => ({
      onChunk: (c: StreamChunk) => safe(() => sendBack({ op: "session", event: "chunk", session, chunk: c })),
      onEnd: () => safe(() => sendBack({ op: "session", event: "done", session, finished: true })),
    });
    switch (action) {
      case "create":
        try {
          const session = this.host.createSession(frame.session);
          sendBack({ op: "session", event: "created", session });
        } catch (e) {
          sendBack({ op: "session", event: "error", message: String(e) });
        }
        break;
      case "message": {
        const session = frame.session ?? "";
        const status = this.host.status(session);
        if (!status) {
          // Unknown or reaped session: tell the front instead of leaving it waiting for `done`.
          sendBack({ op: "session", event: "error", session, message: `unknown session ${session}` });
          break;
        }
        if (status.turning) {
          sendBack({
            op: "session",
            event: "error",
            session,
            message: `session ${session} is busy with a running turn`,
          });
          break;
        }
        const detach = this.host.attach(session, observer(session));
        void this.host
          .message(session, frame.text ?? "")
          .catch(() => {})
          .finally(() => safe(() => detach()));
        break;
      }
      case "subscribe":
        try {
          this.host.attach(frame.session ?? "", observer(frame.session ?? ""));
        } catch (e) {
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
  onChunk?: (session: string, chunk: StreamChunk) => void;
  onDone?: (session: string, finished: boolean) => void;
  onCreated?: (session: string) => void;
  onError?: (message: string, session?: string) => void;
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
      case "approval_request":
        this.onApprovalRequest?.(frame.session ?? "", frame.approvalId ?? "", frame.toolName ?? "", frame.input);
        break;
      case "chunk":
        this.handlers.onChunk?.(frame.session as string, frame.chunk as StreamChunk);
        break;
      case "done":
        this.handlers.onDone?.(frame.session as string, Boolean(frame.finished));
        break;
      case "error":
        this.handlers.onError?.(frame.message as string, frame.session);
        break;
    }
  }

  createSession(session?: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.pending.set("create", (v) => resolve(v as string));
      this.send({ op: "session", action: "create", session });
      setTimeout(() => {
        if (this.pending.has("create")) {
          this.pending.delete("create");
          reject(new Error("create session timed out"));
        }
      }, 5000);
    });
  }

  sendMessage(session: string, text: string): void {
    this.send({ op: "session", action: "message", session, text });
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
    client.on({
      onChunk: (_s, c) => {
        if (settled) return;
        queue.push(c);
        wake();
      },
      onDone: (_s) => {
        if (settled) return;
        settled = true;
        queue.push(END);
        wake();
      },
      // Unknown/reaped/busy session or a dropped socket: end the turn with an
      // error chunk instead of waiting forever for a `done` that never comes.
      onError: (message, session) => {
        if (settled || (session !== undefined && session !== sessionId)) return;
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
    client.sendMessage(sessionId, text);
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
    client.on({
      onChunk: (session, chunk) => {
        if (session !== sessionId) return;
        arm();
        options.onChunk?.(chunk);
      },
      onDone: (session) => {
        if (session === sessionId) settle();
      },
      onError: (message, session) => {
        if (session === undefined || session === sessionId) settle(new Error(message));
      },
      onClose: () => settle(new Error("connection to the node closed before the turn finished")),
    });
    arm();
    try {
      client.sendMessage(sessionId, text);
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
