import { describe, expect, it, vi } from "vitest";

const agents = vi.hoisted(() => ({
  decisions: [] as boolean[],
  aborts: 0,
  abortOptions: [] as unknown[],
  options: [] as Array<Record<string, unknown> | undefined>,
  reloads: 0,
  saved: new Set<string>(),
}));

vi.mock("../storage/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage/index")>()),
  SessionStore: class {
    getSessionById(id: string) {
      return agents.saved.has(id) ? { id } : null;
    }
  },
}));

vi.mock("../agent/agent", () => ({
  Agent: class {
    constructor(_a?: unknown, _b?: unknown, _c?: unknown, _d?: unknown, options?: Record<string, unknown>) {
      agents.options.push(options);
    }
    reloadTranscript() {
      agents.reloads++;
    }
    async *processMessage() {
      yield {
        type: "tool_approval_request",
        approvalId: "ap-1",
        toolCall: { id: "t1", type: "function", function: { name: "bash", arguments: '{"command":"rm -rf ~"}' } },
      };
    }
    respondToToolApproval(_id: string, approve: boolean) {
      agents.decisions.push(approve);
    }
    async *continueAfterToolApproval() {
      yield { type: "content", content: "after" };
    }
    abort(options?: unknown) {
      agents.aborts++;
      agents.abortOptions.push(options);
    }
    async cleanup() {}
  },
}));

const { NodeAgentHost } = await import("./node-host");

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iterable) {
    // consume
  }
}

describe("NodeAgentHost approvals (C1)", () => {
  it("denies a tool approval when no front requester is configured", async () => {
    agents.decisions.length = 0;
    const host = new NodeAgentHost({});
    await drain(host.runner("s1", "hi", new AbortController().signal));
    expect(agents.decisions).toEqual([false]);
  });

  it("approves only with the explicit autoApprove opt-in", async () => {
    agents.decisions.length = 0;
    const host = new NodeAgentHost({ autoApprove: true });
    await drain(host.runner("s2", "hi", new AbortController().signal));
    expect(agents.decisions).toEqual([true]);
  });

  it("aborts the agent turn when the runner signal fires", async () => {
    agents.aborts = 0;
    agents.abortOptions.length = 0;
    const host = new NodeAgentHost({});
    const controller = new AbortController();
    const iterator = host.runner("s3", "hi", controller.signal)[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    expect(agents.aborts).toBe(1);
    // Host-driven cancel must not fire the process-wide UserInterrupt.
    expect(agents.abortOptions).toEqual([{ userInitiated: false }]);
    await iterator.return?.(undefined);
  });
});

describe("NodeAgentHost sessions", () => {
  it("continues a saved session the front attached with, and reloads it each turn", async () => {
    agents.options.length = 0;
    agents.reloads = 0;
    agents.saved.add("ab6d1949800d");
    const host = new NodeAgentHost({});
    await drain(host.runner("ab6d1949800d", "hi", new AbortController().signal));
    await drain(host.runner("ab6d1949800d", "again", new AbortController().signal));
    expect(agents.options).toHaveLength(1);
    expect(agents.options[0]).toMatchObject({ persistSession: true, session: "ab6d1949800d" });
    expect(agents.reloads).toBe(1);
  });

  it("starts a fresh session for a relay-only id", async () => {
    agents.options.length = 0;
    const host = new NodeAgentHost({});
    await drain(host.runner("sess-1", "hi", new AbortController().signal));
    expect(agents.options[0]).not.toHaveProperty("session");
  });
});
