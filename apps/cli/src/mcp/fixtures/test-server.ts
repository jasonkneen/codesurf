#!/usr/bin/env bun
/**
 * Spec-compliant MCP test server (stdio transport).
 *
 * Used as a fixture for integration tests of `buildMcpToolSet` and as a
 * reference implementation when wiring resources/prompts UX. Advertises:
 *   - 1 tool:      echo(text) → echoes the input
 *   - 2 resources: fixture://greeting (text/plain), fixture://config (JSON)
 *   - 1 prompt:    greet(name) → "Hello, {name}!" message
 *
 * Run manually:
 *   bun src/mcp/fixtures/test-server.ts
 *
 * Wire into a config:
 *   { transport: "stdio", command: "bun", args: ["<abs path to this file>"] }
 *
 * IMPORTANT: stdout is reserved for the JSON-RPC protocol. Anything we want
 * to log goes to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "codesurf-fixture-test-server",
  version: "0.1.0",
});

// ── Tool: echo ──────────────────────────────────────────────────────────────
server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Echo the input text back to the caller.",
    inputSchema: { text: z.string().describe("Text to echo back") },
  },
  async ({ text }) => ({
    content: [{ type: "text", text }],
  }),
);

// ── Resources ───────────────────────────────────────────────────────────────
server.registerResource(
  "greeting",
  "fixture://greeting",
  {
    title: "Greeting",
    description: "A static greeting message.",
    mimeType: "text/plain",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.toString(),
        mimeType: "text/plain",
        text: "Hello from the codesurf fixture MCP server.",
      },
    ],
  }),
);

server.registerResource(
  "config",
  "fixture://config",
  {
    title: "Fixture Config",
    description: "A small JSON document advertised as application/json.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify({ env: "fixture", version: "0.1.0", flags: ["test", "demo"] }, null, 2),
      },
    ],
  }),
);

// ── Prompt: greet ───────────────────────────────────────────────────────────
server.registerPrompt(
  "greet",
  {
    title: "Greet someone",
    description: "Produce a friendly greeting for the named person.",
    argsSchema: { name: z.string().describe("Name of the person to greet") },
  },
  async ({ name }) => ({
    messages: [
      {
        role: "user",
        content: { type: "text", text: `Hello, ${name}! Welcome to the fixture server.` },
      },
    ],
  }),
);

// ── Boot ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[fixture-test-server] connected\n");
