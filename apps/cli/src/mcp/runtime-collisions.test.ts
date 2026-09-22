import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../utils/settings";

const { createMCPClientMock } = vi.hoisted(() => ({ createMCPClientMock: vi.fn() }));

vi.mock("@ai-sdk/mcp", () => ({ createMCPClient: createMCPClientMock }));

import { buildMcpToolSet, findMcpServerIdCollisions } from "./runtime";

/** Tool names each fake server advertises, keyed by the `name` passed to createMCPClient. */
let toolsByClientName: Record<string, string[]> = {};

function remoteServer(id: string, label = id, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id, label, enabled: true, transport: "http", url: "http://127.0.0.1:9/mcp", ...overrides };
}

describe("findMcpServerIdCollisions", () => {
  it("flags every member of a sanitised-prefix collision and of a duplicate-id group", () => {
    const dotted = remoteServer("a.b", "Dotted");
    const underscored = remoteServer("a_b", "Underscored");
    const dupOne = remoteServer("dup", "Dup One");
    const dupTwo = remoteServer("dup", "Dup Two");
    const lonely = remoteServer("solo");

    const collisions = findMcpServerIdCollisions([dotted, underscored, dupOne, dupTwo, lonely]);

    expect(collisions.get(dotted)).toContain('collides with "Underscored"');
    expect(collisions.get(underscored)).toContain('collides with "Dotted"');
    expect(collisions.get(dupOne)).toContain('duplicate server id "dup"');
    expect(collisions.get(dupTwo)).toContain('duplicate server id "dup"');
    expect(collisions.has(lonely)).toBe(false);
  });
});

describe("buildMcpToolSet id collisions", () => {
  beforeEach(() => {
    toolsByClientName = {};
    createMCPClientMock.mockReset();
    createMCPClientMock.mockImplementation(async ({ name }: { name: string }) => ({
      tools: async () =>
        Object.fromEntries(
          (toolsByClientName[name] ?? ["echo"]).map((toolName) => [
            toolName,
            { description: `${toolName} from ${name}`, inputSchema: {} },
          ]),
        ),
      close: vi.fn(async () => {}),
    }));
  });

  it("rejects servers whose sanitised ids collide before any of them is set up", async () => {
    const bundle = await buildMcpToolSet([remoteServer("a.b", "Dotted"), remoteServer("a_b", "Underscored")]);

    expect(createMCPClientMock).not.toHaveBeenCalled();
    expect(bundle.serverIds).toEqual([]);
    expect(Object.keys(bundle.tools)).toEqual([]);
    expect(bundle.errors).toHaveLength(2);
    expect(bundle.errors[0]).toMatch(/^Dotted: server id "a\.b" collides with "Underscored"/);
    expect(bundle.errors[1]).toMatch(/^Underscored: server id "a_b" collides with "Dotted"/);
    await bundle.close();
  });

  it("rejects duplicate raw ids before setup", async () => {
    const bundle = await buildMcpToolSet([remoteServer("dup", "Dup One"), remoteServer("dup", "Dup Two")]);

    expect(createMCPClientMock).not.toHaveBeenCalled();
    expect(bundle.serverIds).toEqual([]);
    expect(bundle.errors).toEqual([
      expect.stringMatching(/^Dup One: duplicate server id "dup" \(also used by "Dup Two"\)/),
      expect.stringMatching(/^Dup Two: duplicate server id "dup" \(also used by "Dup One"\)/),
    ]);
    await bundle.close();
  });

  it("still sets up the non-colliding servers in the same call", async () => {
    const bundle = await buildMcpToolSet([
      remoteServer("a.b", "Dotted"),
      remoteServer("ok", "Fine"),
      remoteServer("a_b", "Underscored"),
    ]);

    expect(createMCPClientMock).toHaveBeenCalledTimes(1);
    expect(createMCPClientMock.mock.calls[0]?.[0]).toMatchObject({ name: "codesurf-ok" });
    expect(bundle.serverIds).toEqual(["ok"]);
    expect(Object.keys(bundle.tools)).toEqual(["mcp_ok__echo"]);
    expect(bundle.toolCountsByServerId.get("ok")).toBe(1);
    expect(bundle.errors).toHaveLength(2);
    await bundle.close();
  });

  it("ignores disabled servers when detecting collisions", async () => {
    const bundle = await buildMcpToolSet([
      remoteServer("a.b", "Dotted"),
      remoteServer("a_b", "Underscored", { enabled: false }),
    ]);

    expect(bundle.errors).toEqual([]);
    expect(bundle.serverIds).toEqual(["a.b"]);
    expect(Object.keys(bundle.tools)).toEqual(["mcp_a_b__echo"]);
    await bundle.close();
  });

  it("never overwrites an already registered prefixed tool name during setup", async () => {
    // Prefixes differ (mcp_a__b vs mcp_a) so this is not an id collision, but
    // "a__b" + "c" and "a" + "b__c" both render as mcp_a__b__c.
    toolsByClientName = { "codesurf-a__b": ["c"], "codesurf-a": ["b__c", "other"] };
    const bundle = await buildMcpToolSet([remoteServer("a__b", "First"), remoteServer("a", "Second")]);

    expect(bundle.serverIds).toEqual(["a__b", "a"]);
    expect(Object.keys(bundle.tools).sort()).toEqual(["mcp_a__b__c", "mcp_a__other"]);
    expect(bundle.tools.mcp_a__b__c?.description).toContain("[MCP First]");
    expect(bundle.toolCountsByServerId.get("a__b")).toBe(1);
    expect(bundle.toolCountsByServerId.get("a")).toBe(1);
    expect(bundle.errors).toEqual([
      expect.stringMatching(/^Second: tool "b__c" skipped; "mcp_a__b__c" is already registered/),
    ]);
    await bundle.close();
  });
});
