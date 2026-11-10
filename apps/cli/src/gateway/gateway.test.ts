import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GatewayServer, startGatewayServer } from "./http-server";
import { GatewaySessionRegistry } from "./session-registry";
import { chunkToSse, sseError } from "./sse";
import type { GatewaySessionRecord } from "./types";

const TOKEN = "test-token";

async function request(
  serverUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const response = await fetch(`${serverUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // SSE / non-JSON bodies are returned as text.
  }
  return { status: response.status, json, text };
}

describe("sse mapper", () => {
  it("renders chunk types as SSE frames carrying the full chunk", () => {
    const frame = chunkToSse({ type: "content", content: "hi" });
    expect(frame).toContain("event: content");
    expect(JSON.parse(frame.split("\n")[1].replace(/^data: /, ""))).toEqual({ type: "content", content: "hi" });
  });

  it("renders error frames", () => {
    expect(sseError("boom")).toContain("event: error");
    expect(sseError("boom")).toContain('"boom"');
  });
});

describe("gateway http server", () => {
  let server: GatewayServer;
  let url: string;

  beforeAll(async () => {
    const started = await startGatewayServer({
      token: TOKEN,
      runner: async function* () {
        yield { type: "content", content: "streamed" } as never;
        yield { type: "done" } as never;
      },
    });
    server = started.server;
    url = started.url;
  });

  afterAll(async () => {
    await server.close();
  });

  it("rejects requests without a valid bearer token", async () => {
    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(401);
  });

  it("serves health", async () => {
    const result = await request(url, "GET", "/healthz");
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ ok: true });
  });

  it("creates, lists, gets and deletes sessions", async () => {
    const created = await request(url, "POST", "/sessions", { model: "grok-test", presentation: "code" });
    expect(created.status).toBe(201);
    const session = (created.json as { session: GatewaySessionRecord }).session;
    expect(session.presentation).toBe("code");

    const listed = await request(url, "GET", "/sessions");
    expect(listed.status).toBe(200);
    expect((listed.json as { sessions: GatewaySessionRecord[] }).sessions.map((s) => s.id)).toContain(session.id);

    const got = await request(url, "GET", `/sessions/${session.id}`);
    expect(got.status).toBe(200);

    const removed = await request(url, "DELETE", `/sessions/${session.id}`);
    expect(removed.status).toBe(200);
    expect(await request(url, "GET", `/sessions/${session.id}`)).toMatchObject({ status: 404 });
  });

  it("rejects an empty message turn", async () => {
    const created = await request(url, "POST", "/sessions", {});
    const session = (created.json as { session: GatewaySessionRecord }).session;
    const result = await request(url, "POST", `/sessions/${session.id}/messages`, { message: "  " });
    expect(result.status).toBe(400);
  });

  it("returns 404 for unknown sessions", async () => {
    const result = await request(url, "POST", "/sessions/nope/messages", { message: "hi" });
    expect(result.status).toBe(404);
  });

  it("streams turn chunks as SSE frames", async () => {
    const created = await request(url, "POST", "/sessions", {});
    const session = (created.json as { session: GatewaySessionRecord }).session;
    const response = await fetch(`${url}/sessions/${session.id}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: content");
    expect(text).toContain("streamed");
    expect(text).toContain("event: done");
  });
});

describe("gateway turn lifecycle (M10) and presentation default (L14)", () => {
  it("aborts the turn when the client disconnects, refuses a concurrent turn with 409, and does not abort a completed turn", async () => {
    const signals: AbortSignal[] = [];
    let release: () => void = () => {};
    const started = await startGatewayServer({
      token: TOKEN,
      runner: async function* (_session, message, signal) {
        signals.push(signal);
        yield { type: "content", content: `start:${message}` };
        if (message === "hang") {
          await new Promise<void>((resolve) => {
            release = resolve;
            signal.addEventListener("abort", () => resolve());
          });
        }
        yield { type: "content", content: "end" };
      },
    });
    try {
      const created = await request(started.url, "POST", "/sessions", {});
      const id = (created.json.session as GatewaySessionRecord).id;

      const controller = new AbortController();
      const hanging = await fetch(`${started.url}/sessions/${id}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ message: "hang" }),
        signal: controller.signal,
      });
      const reader = hanging.body!.getReader();
      await reader.read(); // first frame arrived: the turn is running

      const busy = await request(started.url, "POST", `/sessions/${id}/messages`, { message: "again" });
      expect(busy.status).toBe(409);

      controller.abort();
      await reader.cancel().catch(() => {});
      const t0 = Date.now();
      while (!signals[0]?.aborted && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10));
      expect(signals[0]?.aborted).toBe(true);

      const t1 = Date.now();
      let after = await request(started.url, "POST", `/sessions/${id}/messages`, { message: "ok" });
      while (after.status === 409 && Date.now() - t1 < 2000) {
        await new Promise((r) => setTimeout(r, 10));
        after = await request(started.url, "POST", `/sessions/${id}/messages`, { message: "ok" });
      }
      expect(after.status).toBe(200);
      expect(after.text).toContain("start:ok");
      expect(signals.at(-1)?.aborted).toBe(false);
    } finally {
      release();
      await started.server.close();
    }
  });

  it("applies the serve --presentation default to sessions that name none", async () => {
    const started = await startGatewayServer({
      token: TOKEN,
      runner: async function* () {},
      registry: new GatewaySessionRegistry("code"),
    });
    try {
      const created = await request(started.url, "POST", "/sessions", {});
      expect((created.json.session as GatewaySessionRecord).presentation).toBe("code");
      const explicit = await request(started.url, "POST", "/sessions", { presentation: "both" });
      expect((explicit.json.session as GatewaySessionRecord).presentation).toBe("both");
    } finally {
      await started.server.close();
    }
  });
});
