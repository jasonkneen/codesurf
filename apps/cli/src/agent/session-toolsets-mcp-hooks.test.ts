import type { ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setHooksSink } from "../core/plugins/index";
import { wrapMcpToolsWithHooks } from "./session-toolsets";

// Regression: MCP tools were merged into the turn's ToolSet raw, so they never
// went through PreToolUse / PostToolUse — and a PreToolUse hook that BLOCKS
// was silently ignored for exactly the tools that reach third-party servers.

function emptyHookResult() {
  return { blocked: false, blockingErrors: [], commandErrors: [], additionalContexts: [] };
}

function installHooks(pre: () => ReturnType<typeof emptyHookResult>) {
  const sink = {
    runPre: vi.fn(async () => pre()),
    runPost: vi.fn(async () => emptyHookResult()),
    runFailure: vi.fn(async () => emptyHookResult()),
    runEvent: vi.fn(async () => emptyHookResult()),
  };
  setHooksSink(sink as never);
  return sink;
}

/** An MCP tool as `@ai-sdk/mcp` builds it: the server's CallToolResult comes back as-is. */
function mcpTools(result: unknown) {
  const execute = vi.fn(async () => result);
  const tools = {
    mcp_fs__delete: { description: "[MCP fs] delete", inputSchema: {} as never, execute },
  } as unknown as ToolSet;
  return { tools, execute };
}

const options = { toolCallId: "c1", messages: [] };

afterEach(() => {
  setHooksSink(null);
});

describe("MCP tools and the tool-use hooks", () => {
  it("does not call the server when PreToolUse blocks", async () => {
    installHooks(() => ({ ...emptyHookResult(), blocked: true, blockingErrors: [{ stderr: "no deletes" }] as never }));
    const { tools, execute } = mcpTools({ content: [{ type: "text", text: "deleted" }] });

    const result = await wrapMcpToolsWithHooks(tools).mcp_fs__delete?.execute?.({ path: "/" }, options);

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, output: "[Hook blocked] no deletes" });
  });

  it("passes the server result through unchanged and fires PostToolUse", async () => {
    const sink = installHooks(emptyHookResult);
    const serverResult = { content: [{ type: "text", text: "deleted" }] };
    const { tools } = mcpTools(serverResult);

    const result = await wrapMcpToolsWithHooks(tools).mcp_fs__delete?.execute?.({ path: "/tmp/x" }, options);

    expect(result).toBe(serverResult);
    expect(sink.runPre).toHaveBeenCalledWith("mcp_fs__delete", { path: "/tmp/x" }, undefined, undefined);
    expect(sink.runPost).toHaveBeenCalledTimes(1);
    expect(sink.runFailure).not.toHaveBeenCalled();
  });

  it("reports an isError result through the failure hook", async () => {
    const sink = installHooks(emptyHookResult);
    const { tools } = mcpTools({ isError: true, content: [{ type: "text", text: "permission denied" }] });

    await wrapMcpToolsWithHooks(tools).mcp_fs__delete?.execute?.({ path: "/" }, options);

    expect(sink.runFailure).toHaveBeenCalledWith(
      "mcp_fs__delete",
      { path: "/" },
      "permission denied",
      undefined,
      undefined,
    );
    expect(sink.runPost).not.toHaveBeenCalled();
  });
});
