import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GatewayServer, startGatewayServer } from "./http-server";

const TOKEN = "test-token";

async function post(url: string, path: string, body: unknown, token = TOKEN) {
  return fetch(url + path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function dataLines(body: string): (string | null)[] {
  return body
    .split("\n\n")
    .map((frame) => {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      return line ? line.slice(5).trim() : null;
    })
    .filter((l) => l !== null && l.length > 0);
}

describe("gateway OpenAI-style LLM surface", () => {
  let server: GatewayServer;
  let url: string;

  beforeAll(async () => {
    const started = await startGatewayServer({
      token: TOKEN,
      runner: async function* () {
        yield { type: "content", content: "Hello" } as never;
        yield { type: "content", content: " world" } as never;
        yield { type: "done" } as never;
      },
    });
    server = started.server;
    url = started.url;
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns a non-stream chat completion", async () => {
    const response = await post(url, "/v1/chat/completions", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      object: string;
      choices: { message: { role: string; content: string } }[];
    };
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.role).toBe("assistant");
    expect(json.choices[0].message.content).toBe("Hello world");
  });

  it("streams chat completion deltas as SSE with a [DONE] terminator", async () => {
    const response = await post(url, "/v1/chat/completions", {
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(response.status).toBe(200);
    expect((response.headers.get("content-type") ?? "").includes("text/event-stream")).toBe(true);
    const body = await response.text();
    const data = dataLines(body);
    expect(data[data.length - 1]).toBe("[DONE]");
    const deltas = data
      .filter((d) => d !== "[DONE]")
      .map((d) => {
        const parsed = JSON.parse(d ?? "{}") as {
          choices: { delta: { content?: string } }[];
        };
        return parsed.choices?.[0]?.delta?.content;
      })
      .filter((c): c is string => typeof c === "string");
    expect(deltas.join("")).toBe("Hello world");
  });

  it("rejects a request with no user message", async () => {
    const response = await post(url, "/v1/chat/completions", {
      messages: [{ role: "assistant", content: "no user here" }],
    });
    expect(response.status).toBe(400);
  });

  it("breaks the stream on a runner error without hanging", async () => {
    const broken = await startGatewayServer({
      token: TOKEN,
      runner: async function* () {
        yield { type: "content", content: "partial" } as never;
        throw new Error("boom");
      },
    });
    try {
      const response = await post(broken.url, "/v1/chat/completions", {
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });
      const body = await response.text();
      const data = dataLines(body);
      expect(data[data.length - 1]).toBe("[DONE]");
    } finally {
      await broken.server.close();
    }
  });
});
