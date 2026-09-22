import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ abortOptions: [] as unknown[] }));

vi.mock("../agent/agent", () => ({
  Agent: class {
    async *processMessage() {
      yield { type: "content", content: "partial" };
      await new Promise(() => {});
    }
    abort(options?: unknown) {
      calls.abortOptions.push(options);
    }
    async cleanup() {}
  },
}));

const { GatewayAgentHost } = await import("./agent-host");

describe("GatewayAgentHost disconnect abort", () => {
  it("cancels the turn without a user interrupt when the client disconnects", async () => {
    const host = new GatewayAgentHost({});
    const controller = new AbortController();
    const session = { id: "g1", createdAt: new Date().toISOString(), presentation: "native" as const };
    const iterator = host.runner(session, "hi", controller.signal)[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    expect(calls.abortOptions).toEqual([{ userInitiated: false }]);
  });
});
