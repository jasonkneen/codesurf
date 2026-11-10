// Gateway HTTP client (Phase 1 W2). Fetch wrapper used by the MCP surface and
// any thin front; reads the same JSON/SSE wire the gateway serves.

import type { GatewaySessionInput, GatewaySessionRecord } from "./types";

async function request(baseUrl: string, token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(baseUrl + path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  return response;
}

export class GatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async health(): Promise<{ ok: boolean }> {
    const response = await request(this.baseUrl, this.token, "/healthz");
    return { ok: response.ok };
  }

  async createSession(input: GatewaySessionInput = {}): Promise<GatewaySessionRecord> {
    const response = await request(this.baseUrl, this.token, "/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`create session failed (${response.status})`);
    const json = (await response.json()) as { session: GatewaySessionRecord };
    return json.session;
  }

  async listSessions(): Promise<GatewaySessionRecord[]> {
    const response = await request(this.baseUrl, this.token, "/sessions");
    if (!response.ok) throw new Error(`list sessions failed (${response.status})`);
    const json = (await response.json()) as { sessions: GatewaySessionRecord[] };
    return json.sessions;
  }

  /** Send a message to a session and aggregate the streamed assistant text. */
  async sendMessage(sessionId: string, message: string): Promise<{ text: string; sessionId: string }> {
    const response = await request(this.baseUrl, this.token, `/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`message failed (${response.status}): ${text.slice(0, 200)}`);
    }
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      throw new Error(`expected SSE stream, got ${response.headers.get("content-type")}`);
    }
    const body = await response.text();
    const parts: string[] = [];
    const frames = body.split("\n\n");
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      let chunk: { type?: string; content?: string };
      try {
        chunk = JSON.parse(dataLine.slice(5).trim()) as { type?: string; content?: string };
      } catch {
        continue;
      }
      if (chunk.type === "content" && typeof chunk.content === "string") parts.push(chunk.content);
      if (chunk.type === "error") throw new Error(chunk.content ?? "agent turn failed");
      if (chunk.type === "done") break;
    }
    return { text: parts.join(""), sessionId };
  }
}
