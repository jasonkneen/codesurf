import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { prepareBatchToolInvocation } from "./helpers";

const options = { toolCallId: "call-1", messages: [] };

describe("prepareBatchToolInvocation", () => {
  it("refuses an approval-required call instead of executing it", async () => {
    const needsApproval = vi.fn(() => true);
    const editFile = tool({
      description: "edit",
      inputSchema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }),
      needsApproval,
      execute: async () => ({ success: true }),
    });

    const invocation = await prepareBatchToolInvocation(
      editFile,
      "edit_file",
      JSON.stringify({ path: "a.ts", old_string: "x", new_string: "y" }),
      options,
    );

    expect(invocation.ok).toBe(false);
    if (invocation.ok) throw new Error("unreachable");
    expect(invocation.result.success).toBe(false);
    expect(invocation.result.output).toMatch(/requires user approval/);
    expect(needsApproval).toHaveBeenCalledWith({ path: "a.ts", old_string: "x", new_string: "y" }, options);
  });

  it("honors a boolean needsApproval declaration", async () => {
    const paid = tool({
      description: "paid",
      inputSchema: z.object({ url: z.string() }),
      needsApproval: true,
      execute: async () => ({ success: true }),
    });
    const invocation = await prepareBatchToolInvocation(paid, "paid_request", '{"url":"https://x"}', options);
    expect(invocation.ok).toBe(false);
  });

  it("rejects input that fails the declared schema before any effect", async () => {
    const write = tool({
      description: "write",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async () => ({ success: true }),
    });
    const invocation = await prepareBatchToolInvocation(write, "write_file", '{"path":42}', options);
    expect(invocation.ok).toBe(false);
    if (invocation.ok) throw new Error("unreachable");
    expect(invocation.result.output).toMatch(/invalid arguments/);
  });

  it("rejects malformed JSON arguments", async () => {
    const write = tool({
      description: "write",
      inputSchema: z.object({ path: z.string() }),
      execute: async () => ({ success: true }),
    });
    const invocation = await prepareBatchToolInvocation(write, "write_file", "{not json", options);
    expect(invocation.ok).toBe(false);
    if (invocation.ok) throw new Error("unreachable");
    expect(invocation.result.output).toMatch(/invalid JSON arguments/);
  });

  it("admits a valid call that needs no approval, with the validated input", async () => {
    const read = tool({
      description: "read",
      inputSchema: z.object({ path: z.string(), start_line: z.number().optional() }),
      needsApproval: () => false,
      execute: async () => ({ success: true }),
    });
    const invocation = await prepareBatchToolInvocation(read, "read_file", '{"path":"a.ts"}', options);
    expect(invocation).toEqual({ ok: true, input: { path: "a.ts" } });
  });

  it("admits tools without an input schema (dynamic/MCP tools) after JSON parsing", async () => {
    const invocation = await prepareBatchToolInvocation({}, "mcp_tool", '{"q":1}', options);
    expect(invocation).toEqual({ ok: true, input: { q: 1 } });
  });
});
