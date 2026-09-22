import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayClient } from "./client";
import { type GatewayServer, startGatewayServer } from "./http-server";
import { buildMcpServer } from "./mcp-server";

const TOKEN = "test-token";

describe("gateway MCP surface", () => {
  let server: GatewayServer;
  let mcpClient: Client;
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
    const client = new GatewayClient(url, TOKEN);
    const mcpServer = buildMcpServer(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    mcpClient = new Client({ name: "gateway-test", version: "0.0.1" });
    await mcpClient.connect(clientTransport);
  });

  afterAll(async () => {
    await mcpClient.close().catch(() => {});
    await server.close();
  });

  it("lists the gateway tools", async () => {
    const tools = await mcpClient.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["codesurf_create_session", "codesurf_list_sessions", "codesurf_message"]);
  });

  it("creates a session through MCP", async () => {
    const result = await mcpClient.callTool({
      name: "codesurf_create_session",
      arguments: { presentation: "code" },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(text).toContain('"id"');
    expect(text).toContain('"code"');
  });

  it("messages a session and returns the aggregated reply", async () => {
    const created = await mcpClient.callTool({
      name: "codesurf_create_session",
      arguments: {},
    });
    const text = (created.content as { type: string; text: string }[])[0]?.text ?? "";
    const sessionId = (JSON.parse(text) as { id: string }).id;

    const replied = await mcpClient.callTool({
      name: "codesurf_message",
      arguments: { sessionId, message: "hello" },
    });
    const reply = (replied.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(reply).toBe("streamed");
  });
});
