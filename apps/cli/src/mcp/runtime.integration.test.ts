import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "../utils/settings";
import { buildMcpToolSet } from "./runtime";

const FIXTURE_PATH = resolve(__dirname, "fixtures/test-server.ts");

function fixtureServer(): McpServerConfig {
  return {
    id: "fixture-test-server",
    label: "Fixture Test Server",
    enabled: true,
    transport: "stdio",
    command: "bun",
    args: [FIXTURE_PATH],
  };
}

describe("buildMcpToolSet (integration with fixture stdio server)", () => {
  it("connects, lists tools, and exposes lazy resources/prompts accessors", async () => {
    const bundle = await buildMcpToolSet([fixtureServer()]);

    try {
      // Connection succeeded — no errors recorded.
      expect(bundle.errors).toEqual([]);
      expect(bundle.serverIds).toEqual(["fixture-test-server"]);

      // Tools: prefixed name, advertised description preserved (with [MCP …] tag).
      const toolNames = Object.keys(bundle.tools);
      expect(toolNames).toEqual(["mcp_fixture-test-server__echo"]);
      const echoTool = bundle.tools["mcp_fixture-test-server__echo"];
      expect(echoTool?.description).toContain("[MCP Fixture Test Server]");
      expect(echoTool?.description).toContain("Echo the input text");

      // Per-server tool count is reported on the bundle without parsing names.
      expect(bundle.toolCountsByServerId.get("fixture-test-server")).toBe(1);

      // Resources: lazy listing returns the two advertised resources.
      const resources = await bundle.listResources("fixture-test-server");
      expect(resources).toHaveLength(2);
      expect(resources.map((r) => r.uri).sort()).toEqual(["fixture://config", "fixture://greeting"]);
      const greeting = resources.find((r) => r.uri === "fixture://greeting");
      expect(greeting?.mimeType).toBe("text/plain");
      const config = resources.find((r) => r.uri === "fixture://config");
      expect(config?.mimeType).toBe("application/json");

      // Prompts: lazy listing returns the one advertised prompt with its argument.
      const prompts = await bundle.listPrompts("fixture-test-server");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        name: "greet",
        description: expect.stringContaining("greeting"),
      });
      expect(prompts[0]?.arguments).toBeDefined();
      expect(prompts[0]?.arguments?.[0]?.name).toBe("name");

      // Unknown server returns empty lists, not an error.
      expect(await bundle.listResources("nope")).toEqual([]);
      expect(await bundle.listPrompts("nope")).toEqual([]);
    } finally {
      await bundle.close();
    }
  }, 15_000);

  it("readResource returns text contents for an advertised URI", async () => {
    const bundle = await buildMcpToolSet([fixtureServer()]);
    try {
      const greeting = await bundle.readResource("fixture-test-server", "fixture://greeting");
      expect(greeting).not.toBeNull();
      expect(greeting?.contents).toHaveLength(1);
      expect(greeting?.contents[0]?.uri).toBe("fixture://greeting");
      expect(greeting?.contents[0]?.mimeType).toBe("text/plain");
      expect(greeting?.contents[0]?.text).toContain("Hello from the codesurf fixture");
      expect(greeting?.contents[0]?.blob).toBeUndefined();

      const config = await bundle.readResource("fixture-test-server", "fixture://config");
      expect(config?.contents[0]?.mimeType).toBe("application/json");
      expect(config?.contents[0]?.text).toContain('"env":');

      // Unknown server → null. Unknown URI → null (server throws, we swallow).
      expect(await bundle.readResource("nope", "fixture://greeting")).toBeNull();
      expect(await bundle.readResource("fixture-test-server", "fixture://does-not-exist")).toBeNull();
    } finally {
      await bundle.close();
    }
  }, 15_000);

  it("getPrompt renders a prompt with arguments into role-tagged text messages", async () => {
    const bundle = await buildMcpToolSet([fixtureServer()]);
    try {
      const rendered = await bundle.getPrompt("fixture-test-server", "greet", { name: "alice" });
      expect(rendered).not.toBeNull();
      expect(rendered?.messages).toHaveLength(1);
      expect(rendered?.messages[0]?.role).toBe("user");
      expect(rendered?.messages[0]?.text).toBe("Hello, alice! Welcome to the fixture server.");

      // Unknown server → null. Unknown prompt name → null.
      expect(await bundle.getPrompt("nope", "greet")).toBeNull();
      expect(await bundle.getPrompt("fixture-test-server", "does-not-exist")).toBeNull();
    } finally {
      await bundle.close();
    }
  }, 15_000);
});
