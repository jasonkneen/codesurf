// MCP surface for the codesurf gateway (Phase 1 W2). Exposes engine sessions
// as MCP tools so any MCP client (IDE, agent host, …) can create sessions and
// message the engine; the engine runs its full tool plane (PTC included)
// server-side. This server is a thin client of the gateway HTTP API.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GatewayClient } from "./client";

const PRESENTATION = z.enum(["native", "code", "both"]).optional();

export function buildMcpServer(client: GatewayClient): McpServer {
  const server = new McpServer({ name: "codesurf-gateway", version: "0.1.0" });

  server.registerTool("codesurf_list_sessions", { title: "List engine gateway sessions" }, async () => {
    const sessions = await client.listSessions();
    return { content: [{ type: "text", text: sessions.map((s) => `${s.id} ${s.presentation}`).join("\n") }] };
  });

  server.registerTool(
    "codesurf_create_session",
    {
      title: "Create an engine gateway session",
      inputSchema: {
        model: z.string().optional().describe("Model id for the session"),
        presentation: PRESENTATION.describe("Tool presentation: native, code or both"),
      },
    },
    async (args) => {
      const session = await client.createSession({
        ...(args.model ? { model: args.model } : {}),
        ...(args.presentation ? { presentation: args.presentation } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(session) }] };
    },
  );

  server.registerTool(
    "codesurf_message",
    {
      title: "Send a message to an engine gateway session and return the reply",
      inputSchema: {
        message: z.string().min(1).describe("The user message to send"),
        sessionId: z.string().optional().describe("Existing session id; creates one when omitted"),
        presentation: PRESENTATION.describe("Tool presentation when creating a session"),
      },
    },
    async (args) => {
      let sessionId = args.sessionId;
      if (!sessionId) {
        sessionId = (
          await client.createSession({
            ...(args.presentation ? { presentation: args.presentation } : {}),
          })
        ).id;
      }
      const result = await client.sendMessage(sessionId, args.message);
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  return server;
}

export async function runMcpCommand(options: { gatewayUrl?: string }): Promise<never> {
  const baseUrl = (options.gatewayUrl || process.env.CODESURF_GATEWAY_URL || "http://127.0.0.1:3947").replace(
    /\/$/,
    "",
  );
  const { resolveGatewayToken } = await import("./token");
  const token = await resolveGatewayToken();
  const client = new GatewayClient(baseUrl, token);
  const server = buildMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>(() => {});
  return undefined as never;
}
