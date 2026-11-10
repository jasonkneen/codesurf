// ACP client for the codesurf gateway (Phase 1 W3). Thin fetch wrapper over
// the /acp endpoints, mirroring GatewayClient for the session API. Lets an
// external agent client (agensis, an IDE host, another engine front) drive
// engine sessions over the versioned ACP envelope.

import { type AcpEvent, type AcpMessage, acpEnvelope, parseAcpFrame } from "./acp";
import type { GatewaySessionInput } from "./types";

export class AcpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(this.baseUrl + path, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  }

  private async json<T>(response: Response): Promise<T> {
    if (!response.ok) throw new Error(`acp request failed (${response.status})`);
    return (await response.json()) as T;
  }

  /** Initialize an ACP session; returns the init-success message. */
  async initSession(input: GatewaySessionInput = {}): Promise<AcpEvent> {
    const response = await this.request("/acp/sessions", { method: "POST", body: JSON.stringify(input) });
    const message = (await this.json(response)) as AcpMessage;
    return message.message;
  }

  /** Read a session's status message. */
  async status(sessionId: string): Promise<AcpEvent> {
    const response = await this.request(`/acp/sessions/${sessionId}`);
    const message = (await this.json(response)) as AcpMessage;
    return message.message;
  }

  /**
   * Send a prompt and aggregate the streamed ACP events. Returns the raw
   * envelope list (fidelity-preserving) plus the concatenated assistant text.
   */
  async prompt(sessionId: string, prompt: string): Promise<{ events: AcpMessage[]; text: string }> {
    const response = await this.request(`/acp/sessions/${sessionId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`acp prompt failed (${response.status}): ${text.slice(0, 200)}`);
    }
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      throw new Error(`expected SSE stream, got ${response.headers.get("content-type")}`);
    }
    const body = await response.text();
    const events: AcpMessage[] = [];
    const text: string[] = [];
    for (const frame of body.split("\n\n")) {
      const message = parseAcpFrame(frame);
      if (!message) continue;
      events.push(message);
      const ev = message.message;
      if (ev.type === "message/stream/update" && ev.event === "content" && typeof ev.chunk.content === "string") {
        text.push(ev.chunk.content);
      }
      if (ev.type === "agent/error") throw new Error(ev.error);
    }
    return { events, text: text.join("") };
  }

  /** End (delete) a session. */
  async endSession(sessionId: string): Promise<AcpEvent> {
    const response = await this.request(`/acp/sessions/${sessionId}`, { method: "DELETE" });
    const message = (await this.json(response)) as AcpMessage;
    return message.message;
  }
}

// Re-export for convenience so test/external callers can build envelopes too.
export { acpEnvelope };
