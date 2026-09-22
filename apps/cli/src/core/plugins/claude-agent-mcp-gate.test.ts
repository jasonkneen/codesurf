import { describe, expect, it } from "vitest";
import { buildMcpDenyHook, mcpDenyReason } from "./native/claude-agent-provider";

// Regression: the MCP gate lived only in `canUseTool`, and under
// `permissionMode: "bypassPermissions"` the SDK approves every tool call
// BEFORE that callback is consulted — it says so itself through the
// CLAUDE_SDK_CAN_USE_TOOL_SHADOWED warning.
//
// That left yolo mode open for exactly the tools the gate exists to stop:
// connectors the API gateway injects (Gmail, Drive, Calendar, Linear), which
// `mcpServers` cannot unload and `disallowedTools` cannot express as a
// wildcard. The rule now also runs as a PreToolUse hook, which permission mode
// does not shadow.

const enabled = (...prefixes: string[]) => ({
  mcpEnabled: true,
  allowedPrefixes: new Set(prefixes),
});

describe("mcpDenyReason", () => {
  it("has no opinion on a non-MCP tool", () => {
    expect(mcpDenyReason(enabled("mcp__codesurf__"), "Bash")).toBeNull();
    expect(mcpDenyReason(enabled(), "Read")).toBeNull();
  });

  it("denies every MCP tool when MCP is off", () => {
    const policy = { mcpEnabled: false, allowedPrefixes: new Set<string>() };
    expect(mcpDenyReason(policy, "mcp__codesurf__run")).toMatch(/MCP is disabled/i);
    expect(mcpDenyReason(policy, "mcp__gmail__send_email")).toMatch(/MCP is disabled/i);
  });

  it("denies a gateway connector that no enabled server published", () => {
    // The case that matters: these arrive from the API gateway, not from the
    // local `mcpServers` map, so nothing upstream of this rule removes them.
    const policy = enabled("mcp__codesurf__");
    expect(mcpDenyReason(policy, "mcp__gmail__send_email")).toMatch(/not from a Codesurf-enabled server/i);
    expect(mcpDenyReason(policy, "mcp__google_drive__read_file")).toMatch(/not from a Codesurf-enabled server/i);
    expect(mcpDenyReason(policy, "mcp__linear__create_issue")).toMatch(/not from a Codesurf-enabled server/i);
  });

  it("allows an MCP tool from an enabled server", () => {
    expect(mcpDenyReason(enabled("mcp__codesurf__"), "mcp__codesurf__run")).toBeNull();
    expect(mcpDenyReason(enabled("mcp__codesurf__", "mcp__linear__"), "mcp__linear__create_issue")).toBeNull();
  });

  it("denies when MCP is enabled but no server is", () => {
    expect(mcpDenyReason(enabled(), "mcp__anything__at_all")).toMatch(/not from a Codesurf-enabled server/i);
  });
});

describe("buildMcpDenyHook", () => {
  const run = (policy: Parameters<typeof buildMcpDenyHook>[0], toolName: string) =>
    buildMcpDenyHook(policy)(
      { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: {}, tool_use_id: "t1" } as never,
      "t1",
      { signal: new AbortController().signal },
    );

  it("denies a connector the user never enabled", async () => {
    const output = (await run(enabled("mcp__codesurf__"), "mcp__gmail__send_email")) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/not from a Codesurf-enabled server/i);
  });

  it("stays silent on tools it has no opinion about, so other policy still decides", async () => {
    expect(await run(enabled("mcp__codesurf__"), "Bash")).toEqual({});
    expect(await run(enabled("mcp__codesurf__"), "mcp__codesurf__run")).toEqual({});
  });

  it("survives a malformed hook payload without allowing anything by accident", async () => {
    const hook = buildMcpDenyHook({ mcpEnabled: false, allowedPrefixes: new Set<string>() });
    // A missing tool_name must not throw; it simply is not an MCP tool name.
    await expect(
      hook({ hook_event_name: "PreToolUse" } as never, undefined, { signal: new AbortController().signal }),
    ).resolves.toEqual({});
  });
});

describe("session options wiring", () => {
  it("registers the gate as a PreToolUse hook, which permission mode cannot shadow", async () => {
    const { buildSessionOptions } = await import("./native/claude-agent-provider");
    const { options } = buildSessionOptions("claude-sonnet-4-5", {
      isEnabled: () => false,
      getToolBundle: async () => null,
    } as never);

    const preToolUse = options.hooks?.PreToolUse;
    expect(preToolUse, "PreToolUse hook missing — the MCP gate is shadowed in yolo mode").toBeDefined();
    expect(preToolUse?.[0]?.hooks?.length).toBeGreaterThan(0);

    // And it actually denies, rather than merely being present.
    const hook = preToolUse?.[0]?.hooks?.[0];
    const output = (await hook?.(
      {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__gmail__send_email",
        tool_input: {},
        tool_use_id: "t1",
      } as never,
      "t1",
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});
