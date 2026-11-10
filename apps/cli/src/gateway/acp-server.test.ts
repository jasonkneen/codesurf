import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AcpClient } from "./acp-client";
import { type GatewayServer, startGatewayServer } from "./http-server";

const TOKEN = "test-token";

describe("gateway ACP surface", () => {
  let server: GatewayServer;
  let client: AcpClient;

  beforeAll(async () => {
    const started = await startGatewayServer({
      token: TOKEN,
      runner: async function* () {
        yield { type: "content", content: "streamed" } as never;
        yield { type: "done" } as never;
      },
    });
    server = started.server;
    client = new AcpClient(started.url, TOKEN);
  });

  afterAll(async () => {
    await server.close();
  });

  async function initSessionId(): Promise<{ sessionId: string; presentation?: string }> {
    const message = await client.initSession({});
    if (message.type !== "session/init/success") throw new Error(`init failed: ${message.type}`);
    return { sessionId: message.sessionId, presentation: message.presentation };
  }

  it("initializes an ACP session", async () => {
    const message = await client.initSession({ presentation: "code" });
    expect(message.type).toBe("session/init/success");
    if (message.type === "session/init/success") {
      expect(message.sessionId).toBeTruthy();
      expect(message.presentation).toBe("code");
    }
  });

  it("reports session status", async () => {
    const { sessionId } = await initSessionId();
    const status = await client.status(sessionId);
    expect(status.type).toBe("session/status");
  });

  it("streams a prompt through the ACP envelope and aggregates content", async () => {
    const { sessionId } = await initSessionId();
    const result = await client.prompt(sessionId, "hello");
    expect(result.text).toBe("streamed");
    const types = result.events.map((m) => m.message.type);
    expect(types[0]).toBe("message/stream/start");
    expect(types).toContain("message/stream/update");
    expect(types[types.length - 1]).toBe("message/stream/end");
  });

  it("ends a session", async () => {
    const { sessionId } = await initSessionId();
    const ended = await client.endSession(sessionId);
    expect(ended.type).toBe("session/end");
    if (ended.type === "session/end") expect(ended.removed).toBe(true);
  });

  it("rejects an unknown session prompt", async () => {
    await expect(client.prompt("missing", "hello")).rejects.toThrow();
  });
});
