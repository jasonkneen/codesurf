import { describe, expect, it, vi } from "vitest";

const agents = vi.hoisted(() => ({ decisions: [] as boolean[], aborts: 0, abortOptions: [] as unknown[] }));

vi.mock("../agent/agent", () => ({
  Agent: class {
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
