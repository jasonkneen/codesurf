// WebSocket relay transport (Phase 3 W3). A RelayTransport over real WebSockets,
// behind the same seam the in-memory peer uses — so a hub can be reached by
// remote nodes/fronts over the wire. Includes the server (each socket becomes a
// hub spoke, node ids taken from messages) and a client end.
//
// Auth: when an authToken is configured, the WS upgrade and GET /files require
// it (Authorization: Bearer <token>, or ?token=<token> for clients that cannot
// set headers). Any request carrying a browser Origin that is not explicitly
// allowed is refused, so a web page can never drive the node from a browser.

import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { WebSocket, WebSocketServer } from "ws";
import { tokensEqual } from "../gateway/token";
import { handleFileRequest } from "./file-server";
import type { Hub } from "./hub";
import type { RelayMessage } from "./protocol";
import type { RelayHandler, RelayTransport } from "./transport";

/** A RelayTransport over a single WebSocket (per-socket hub spoke or raw end). */
export class WsSocketTransport implements RelayTransport {
  private readonly handlers: RelayHandler[] = [];
  private closed = false;

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => this.ingest(String(data)));
    socket.on("error", () => {});
  }

  async send(message: RelayMessage): Promise<void> {
    if (this.closed) throw new Error("transport closed");
    this.socket.send(JSON.stringify(message));
  }

  onMessage(handler: RelayHandler): void {
    this.handlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.socket.on("close", handler);
  }

  private ingest(raw: string): void {
    let message: RelayMessage;
    try {
      message = JSON.parse(raw) as RelayMessage;
    } catch {
      return;
    }
    for (const handler of this.handlers) {
      try {
        handler(message);
      } catch {
        // one listener must not break delivery to the rest.
      }
    }
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.socket.close();
    }
  }
}

/** Client end: connects to ws://url and forwards the mesh protocol. */
export class WsRelayClient implements RelayTransport {
  private readonly handlers: RelayHandler[] = [];
  private readonly socket: WebSocket;

  constructor(
    public readonly url: string,
    options: { token?: string } = {},
  ) {
    this.socket = new WebSocket(url, options.token ? { headers: { authorization: `Bearer ${options.token}` } } : {});
    this.socket.onmessage = (event) => this.ingest(String(event.data as string));
  }

  private waitOpen(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      this.socket.onopen = () => resolve();
    });
  }

  async send(message: RelayMessage): Promise<void> {
    await this.waitOpen();
    this.socket.send(JSON.stringify(message));
  }

  onMessage(handler: RelayHandler): void {
    this.handlers.push(handler);
  }

  private ingest(raw: string): void {
    let message: RelayMessage;
    try {
      message = JSON.parse(raw) as RelayMessage;
    } catch {
      return;
    }
    for (const handler of this.handlers) {
      try {
        handler(message);
      } catch {
        // ignore listener failure
      }
    }
  }

  async close(): Promise<void> {
    this.socket.close();
  }
}

import type { SessionFrameIn, SessionFrameOut } from "./session-stream";

export interface WsRelayServerOptions {
  hub: Hub;
  host?: string;
  port?: number;
  /** Optional handler for `op: "session"` frames (live streaming channel), bypassing relay tool routing. */
  onSessionFrame?: (frame: SessionFrameIn, sendBack: (out: SessionFrameOut) => void) => void;
  /** Directories GET /files may read. Default: cwd + tmpdir (screenshots). */
  fileRoots?: readonly string[];
  /**
   * Bearer token required on the WS upgrade and GET /files. Unset means no
   * token check — only for in-process/test hubs; `codesurf node` always sets it.
   */
  authToken?: string;
  /** Browser origins allowed to connect / read files. Any other Origin is refused. */
  allowedOrigins?: readonly string[];
}

/** Steward principal stamped on every spoke that authenticated with the node token. */
export const WIRE_PRINCIPAL = "wire";

/** Token presented on a request: Authorization bearer, else the `token` query param. */
export function requestToken(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization ?? "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7);
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("token");
  } catch {
    return null;
  }
}

/**
 * WS relay server: every accepted socket becomes a hub spoke; the node id is
 * taken from each message.from (auto-attach), and a socket close retires it.
 */
export class WsRelayServer {
  private readonly http: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<WsSocketTransport>();
  readonly hub: Hub;
  private readonly options: WsRelayServerOptions;
  private readonly fileRoots: readonly string[];
  /** Resolves once the server is bound; rejects on a listen error (e.g. port in use). */
  readonly ready: Promise<void>;

  constructor(options: WsRelayServerOptions) {
    this.options = options;
    this.hub = options.hub;
    this.fileRoots = options.fileRoots ?? [process.cwd(), tmpdir()];
    const fileOptions = { allowedOrigins: options.allowedOrigins ?? [] };
    this.http = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path === "/files" || req.method === "OPTIONS") {
        // Preflight carries no credentials; it only ever grants allowed origins.
        const denied = req.method === "OPTIONS" ? this.originDenied(req) : this.rejectStatus(req);
        if (denied) {
          res.writeHead(denied);
          res.end();
          return;
        }
        handleFileRequest(req, res, this.fileRoots, fileOptions);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    this.wss = new WebSocketServer({
      server: this.http,
      verifyClient: (info, callback) => {
        const status = this.rejectStatus(info.req);
        if (status) callback(false, status);
        else callback(true);
      },
    });
    this.wss.on("connection", (socket) => this.onConnection(socket));
    // ws re-emits the http server's errors; they surface through `ready`.
    this.wss.on("error", () => {});
    this.ready = new Promise<void>((resolve, reject) => {
      this.http.once("listening", () => resolve());
      this.http.once("error", reject);
    });
    this.ready.catch(() => {}); // observed via `ready`; never an unhandled rejection
    this.http.listen(options.port ?? 0, options.host ?? "127.0.0.1");
  }

  private originDenied(req: IncomingMessage): 403 | null {
    const origin = req.headers.origin;
    if (origin && !(this.options.allowedOrigins ?? []).includes(origin)) return 403;
    return null;
  }

  /** 403 for a disallowed browser Origin, 401 for a missing/wrong token, else null. */
  private rejectStatus(req: IncomingMessage): 401 | 403 | null {
    const originDenied = this.originDenied(req);
    if (originDenied) return originDenied;
    const expected = this.options.authToken;
    if (expected === undefined) return null;
    const presented = requestToken(req);
    return presented !== null && tokensEqual(presented, expected) ? null : 401;
  }

  private onConnection(socket: WebSocket): void {
    const spoke = new WsSocketTransport(socket);
    this.sockets.add(spoke);
    if (this.options.onSessionFrame) {
      // Live streaming channel: op:"session" frames never touch the relay hub.
      spoke.onMessage((msg) => {
        if ((msg as { op?: string }).op === "session") {
          this.options.onSessionFrame?.(
            msg as unknown as SessionFrameIn,
            // A chunk racing a closed socket must not become an unhandled rejection.
            (out) => void spoke.send(out as unknown as RelayMessage).catch(() => {}),
          );
        }
      });
    }
    this.hub.attachAny(spoke, this.options.authToken !== undefined ? { principal: WIRE_PRINCIPAL } : {});
    spoke.onClose(() => {
      this.sockets.delete(spoke);
      this.hub.detachTransport(spoke);
    });
  }

  /** The bound port (for clients/tests). */
  port(): number {
    const address = this.http.address();
    return address && typeof address === "object" ? address.port : 0;
  }

  async close(): Promise<void> {
    for (const spoke of this.sockets) await spoke.close();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}
