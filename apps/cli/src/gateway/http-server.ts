// Gateway HTTP server (Phase 1 W2). Node http only — no extra deps. Serves the
// engine's session/tool plane over HTTP; message turns stream as SSE frames of
// the exact StreamChunk events a local turn produces. The turn runner is the
// real seam to an engine Agent (bound by the serve host); this module owns the
// wire, auth, and routing.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { acpEnvelope, acpError, acpToSse, chunkToAcp } from "./acp";
import {
  chunkText,
  lastUserMessage,
  type OpenAIChatCompletionRequest,
  openaiCompletion,
  openaiContentFrame,
  openaiDone,
  openaiRoleFrame,
  openaiStopFrame,
} from "./openai";
import { GatewaySessionRegistry } from "./session-registry";
import { chunkToSse, sseError } from "./sse";
import { tokensEqual } from "./token";
import type { GatewaySessionInput, GatewayTurnRunner } from "./types";

export interface GatewayServerOptions {
  token: string;
  runner: GatewayTurnRunner;
  registry?: GatewaySessionRegistry;
  /** Called after a session is removed (host cleanup hook). */
  onRemove?: (id: string) => void;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(payload);
}

function notFound(response: ServerResponse): void {
  sendJson(response, 404, { error: "not_found" });
}

function unauthorized(response: ServerResponse): void {
  sendJson(response, 401, { error: "unauthorized" });
}

function jsonError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message });
}

/**
 * Abort signal for one streamed turn: fires when the HTTP client goes away
 * before the response finished (the `close` event on a response that has not
 * finished writing). Uses the response, not the request — the request's
 * `close` fires once its body has been read, long before the turn ends.
 */
function clientDisconnectSignal(response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableFinished) controller.abort();
  });
  return controller.signal;
}

export class GatewayServer {
  private readonly server: Server;
  private readonly registry: GatewaySessionRegistry;
  /** Sessions with a turn in flight — one turn at a time per session. */
  private readonly turning = new Set<string>();

  constructor(private readonly options: GatewayServerOptions) {
    this.registry = options.registry ?? new GatewaySessionRegistry();
    this.server = createServer((request, response) => this.handle(request, response));
  }

  listen(port: number, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        const address = this.server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      const authorization = request.headers.authorization ?? "";
      if (!authorization.startsWith("Bearer ") || !tokensEqual(authorization.slice(7), this.options.token)) {
        unauthorized(response);
        return;
      }

      if (request.method === "GET" && parts[0] === "healthz") {
        sendJson(response, 200, { ok: true, service: "codesurf-gateway" });
        return;
      }

      if (request.method === "GET" && parts[0] === "sessions" && parts.length === 1) {
        sendJson(response, 200, { sessions: this.registry.list() });
        return;
      }

      if (request.method === "POST" && parts[0] === "sessions" && parts.length === 1) {
        let input: GatewaySessionInput = {};
        const raw = await readBody(request);
        if (raw.trim().length > 0) {
          try {
            input = JSON.parse(raw) as GatewaySessionInput;
          } catch {
            jsonError(response, 400, "invalid_json");
            return;
          }
        }
        const session = this.registry.create(input);
        sendJson(response, 201, { session });
        return;
      }

      if (parts[0] === "sessions" && parts.length === 2) {
        const id = parts[1];
        if (request.method === "GET") {
          const session = this.registry.get(id);
          if (!session) return notFound(response);
          sendJson(response, 200, { session });
          return;
        }
        if (request.method === "DELETE") {
          if (!this.registry.remove(id)) return notFound(response);
          this.options.onRemove?.(id);
          sendJson(response, 200, { removed: true });
          return;
        }
      }

      if (request.method === "POST" && parts[0] === "sessions" && parts.length === 3 && parts[2] === "messages") {
        const session = this.registry.get(parts[1]);
        if (!session) return notFound(response);
        let body: { message?: string };
        try {
          body = JSON.parse(await readBody(request)) as { message?: string };
        } catch {
          jsonError(response, 400, "invalid_json");
          return;
        }
        const message = (body.message ?? "").trim();
        if (message.length === 0) {
          jsonError(response, 400, "empty_message");
          return;
        }
        if (this.turning.has(session.id)) {
          jsonError(response, 409, "session_busy");
          return;
        }
        this.turning.add(session.id);
        const signal = clientDisconnectSignal(response);
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        try {
          for await (const chunk of this.options.runner(session, message, signal)) {
            if (signal.aborted) break;
            response.write(chunkToSse(chunk));
          }
        } catch (error) {
          if (!signal.aborted) response.write(sseError(error instanceof Error ? error.message : String(error)));
        } finally {
          this.turning.delete(session.id);
        }
        response.end();
        return;
      }

      // --- ACP surface (W3): agent-client envelope ----------------------
      if (parts[0] === "acp" && parts[1] === "sessions") {
        if (request.method === "POST" && parts.length === 2) {
          let input: GatewaySessionInput = {};
          const raw = await readBody(request);
          if (raw.trim().length > 0) {
            try {
              input = JSON.parse(raw) as GatewaySessionInput;
            } catch {
              jsonError(response, 400, "invalid_json");
              return;
            }
          }
          const session = this.registry.create(input);
          sendJson(
            response,
            201,
            acpEnvelope({
              type: "session/init/success",
              sessionId: session.id,
              presentation: session.presentation,
              createdAt: session.createdAt,
            }),
          );
          return;
        }
        if (parts.length === 3) {
          const id = parts[2];
          const session = this.registry.get(id);
          if (!session) return notFound(response);
          if (request.method === "GET") {
            sendJson(
              response,
              200,
              acpEnvelope({
                type: "session/status",
                sessionId: id,
                presentation: session.presentation,
                createdAt: session.createdAt,
              }),
            );
            return;
          }
          if (request.method === "DELETE") {
            const removed = this.registry.remove(id);
            this.options.onRemove?.(id);
            sendJson(response, 200, acpEnvelope({ type: "session/end", sessionId: id, removed }));
            return;
          }
        }
        if (request.method === "POST" && parts.length === 4 && parts[3] === "prompt") {
          const id = parts[2];
          const session = this.registry.get(id);
          if (!session) return notFound(response);
          let body: { prompt?: string };
          try {
            body = JSON.parse(await readBody(request)) as { prompt?: string };
          } catch {
            jsonError(response, 400, "invalid_json");
            return;
          }
          const prompt = (body.prompt ?? "").trim();
          if (prompt.length === 0) {
            jsonError(response, 400, "empty_prompt");
            return;
          }
          if (this.turning.has(session.id)) {
            jsonError(response, 409, "session_busy");
            return;
          }
          this.turning.add(session.id);
          const signal = clientDisconnectSignal(response);
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          response.write(acpToSse(acpEnvelope({ type: "message/stream/start", sessionId: session.id })));
          try {
            for await (const chunk of this.options.runner(session, prompt, signal)) {
              if (signal.aborted) break;
              response.write(acpToSse(chunkToAcp(chunk, session.id)));
            }
          } catch (error) {
            if (!signal.aborted) response.write(acpError(error instanceof Error ? error.message : String(error)));
          } finally {
            this.turning.delete(session.id);
          }
          response.write(acpToSse(acpEnvelope({ type: "message/stream/end", sessionId: session.id })));
          response.end();
          return;
        }
      }

      // --- OpenAI-style surface (W3): LLM gateway role -------------------
      if (request.method === "POST" && parts[0] === "v1" && parts[1] === "chat" && parts[2] === "completions") {
        let body: OpenAIChatCompletionRequest;
        try {
          body = JSON.parse(await readBody(request)) as OpenAIChatCompletionRequest;
        } catch {
          jsonError(response, 400, "invalid_json");
          return;
        }
        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          jsonError(response, 400, "empty_messages");
          return;
        }
        const prompt = lastUserMessage(body.messages);
        if (!prompt) {
          jsonError(response, 400, "no_user_message");
          return;
        }
        const model = body.model ?? "codesurf-engine";
        const session = this.registry.create({ model, presentation: "native" });
        const signal = clientDisconnectSignal(response);

        if (body.stream) {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          response.write(openaiRoleFrame(model));
          try {
            for await (const chunk of this.options.runner(session, prompt, signal)) {
              if (signal.aborted) break;
              const text = chunkText(chunk);
              if (text) response.write(openaiContentFrame(model, text));
            }
          } catch (error) {
            response.write(
              openaiContentFrame(
                model,
                "\n[engine error: " + (error instanceof Error ? error.message : String(error)) + "]",
              ),
            );
          }
          response.write(openaiStopFrame(model));
          response.write(openaiDone());
          response.end();
        } else {
          const partsOut: string[] = [];
          try {
            for await (const chunk of this.options.runner(session, prompt, signal)) {
              if (signal.aborted) break;
              const text = chunkText(chunk);
              if (text) partsOut.push(text);
            }
          } catch (error) {
            partsOut.push("\n[engine error: " + (error instanceof Error ? error.message : String(error)) + "]");
          }
          sendJson(response, 200, openaiCompletion(model, partsOut.join("")));
        }

        // Stateless: drop the per-request session after the turn.
        if (this.registry.remove(session.id)) this.options.onRemove?.(session.id);
        return;
      }

      notFound(response);
    } catch (error) {
      jsonError(response, 500, error instanceof Error ? error.message : String(error));
    }
  }
}

export async function startGatewayServer(options: GatewayServerOptions & { port?: number; host?: string }) {
  const server = new GatewayServer(options);
  const host = options.host ?? "127.0.0.1";
  const port = await server.listen(options.port ?? 0, host);
  const urlHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return { server, port, url: `http://${urlHost}:${port}` };
}
