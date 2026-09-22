import { describe, expect, it } from "vitest";
import { NodeSessionHost } from "./host";
import { JobHost } from "./jobs";
import { TraceStore } from "./trace";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function* noop(): AsyncGenerator<never> {}

describe("reaping (session/job/trace TTL — the abandoned-state guard)", () => {
  it("evicts idle sessions past their idle TTL and calls onEvict", async () => {
    const evicted: string[] = [];
    const host = new NodeSessionHost(noop, { idleTtlMs: 20, onEvict: (id) => evicted.push(id) });
    const id = host.createSession();
    expect(host.count()).toBe(1);
    await sleep(40);
    expect(host.reap()).toBe(1);
    expect(host.count()).toBe(0);
    expect(evicted).toContain(id);
  });

  it("keeps a recently-touched session alive past the idle TTL", async () => {
    const host = new NodeSessionHost(noop, { idleTtlMs: 20 });
    const id = host.createSession();
    await sleep(30);
    host.status(id); // activity touch
    await sleep(10);
    expect(host.reap()).toBe(0);
  });

  it("reaps finished jobs older than the TTL", async () => {
    const host = new JobHost(async (_s) => ({ statement: "x", anchors: [], handle: "h" }));
    host.submit({ type: "t", tool: "t", args: {}, principal: "p", scope: "s" });
    await sleep(30);
    expect(host.reapFinished(0)).toBe(1);
  });

  it("reaps traces older than the TTL", () => {
    const store = new TraceStore();
    store.record({
      traceId: "tr1",
      spanId: "s1",
      node: "n",
      event: "reply",
      at: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    expect(store.reap(60_000)).toBe(1);
  });
});

/** A turn that runs until released (or aborted). */
function gatedRunner() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let aborted = false;
  async function* runner(_id: string, _text: string, signal: AbortSignal): AsyncGenerator<never> {
    signal.addEventListener("abort", () => {
      aborted = true;
      release();
    });
    await gate;
  }
  return { runner, release: () => release(), aborted: () => aborted };
}

describe("session host lifecycle (M9/M10)", () => {
  it("destroy() calls onEvict so the owner disposes the Agent, and aborts a running turn", async () => {
    const evicted: string[] = [];
    const gated = gatedRunner();
    const host = new NodeSessionHost(gated.runner, { onEvict: (id) => evicted.push(id) });
    const id = host.createSession();
    const turn = host.message(id, "hi");
    expect(host.destroy(id)).toBe(true);
    expect(evicted).toEqual([id]);
    expect(gated.aborted()).toBe(true);
    await turn;
    expect(host.destroy(id)).toBe(false);
    expect(evicted).toEqual([id]);
  });

  it("the idle reaper never evicts a session with a running turn", async () => {
    const evicted: string[] = [];
    const gated = gatedRunner();
    const host = new NodeSessionHost(gated.runner, { idleTtlMs: 10, onEvict: (id) => evicted.push(id) });
    const id = host.createSession();
    const turn = host.message(id, "long");
    await sleep(30);
    expect(host.reap()).toBe(0);
    expect(evicted).toEqual([]);
    gated.release();
    await turn;
    await sleep(30);
    expect(host.reap()).toBe(1);
    expect(evicted).toEqual([id]);
  });

  it("rejects a second message while a turn is running (one turn per session)", async () => {
    const gated = gatedRunner();
    const host = new NodeSessionHost(gated.runner);
    const id = host.createSession();
    const turn = host.message(id, "first");
    await expect(host.message(id, "second")).rejects.toThrow(/busy/);
    expect(host.enqueue(id, "third")).toBe(false);
    gated.release();
    await turn;
    expect(host.status(id)?.text).not.toContain("error");
  });
});
