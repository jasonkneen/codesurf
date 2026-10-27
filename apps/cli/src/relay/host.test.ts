import { describe, expect, it } from "vitest";
import type { StreamChunk } from "../types/index";
import { type HostedTurnRunner, NodeSessionHost, type SessionObserver } from "./host";

function makeObserver() {
  const received: string[] = [];
  let ended = false;
  const observer: SessionObserver = {
    onChunk(chunk) {
      if (chunk.type === "content" && typeof chunk.content === "string") received.push(chunk.content);
    },
    onEnd() {
      ended = true;
    },
  };
  return { observer, received, ended: () => ended };
}

function delayedRunner(): HostedTurnRunner {
  return async function* (_id: string, _msg: string, _signal: AbortSignal): AsyncIterable<StreamChunk> {
    yield { type: "content", content: "a" } as StreamChunk;
    await new Promise((r) => setTimeout(r, 6));
    yield { type: "content", content: "b" } as StreamChunk;
    await new Promise((r) => setTimeout(r, 6));
    yield { type: "content", content: "c" } as StreamChunk;
    await new Promise((r) => setTimeout(r, 6));
    yield { type: "done" } as StreamChunk;
  };
}

describe("node session host (client-death resilience)", () => {
  it("creates a session and reports status", () => {
    const host = new NodeSessionHost(delayedRunner());
    const id = host.createSession("sess-1");
    expect(id).toBe("sess-1");
    expect(host.status("sess-1")?.turning).toBe(false);
  });

  it("delivers a turn to an attached observer", async () => {
    const host = new NodeSessionHost(delayedRunner());
    const id = host.createSession();
    const { observer, received, ended } = makeObserver();
    host.attach(id, observer);
    await host.message(id, "go");
    expect(received).toEqual(["a", "b", "c"]);
    expect(ended()).toBe(true);
    expect(host.status(id)?.turning).toBe(false);
    expect(host.destroy(id)).toBe(true);
    expect(host.status(id)).toBeNull();
  });

  it("keeps the turn running after the observer detaches mid-turn", async () => {
    const host = new NodeSessionHost(delayedRunner());
    const id = host.createSession();
    const { observer, received, ended } = makeObserver();
    host.attach(id, observer);
    const running = host.message(id, "go");
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (received.length >= 1) {
          clearInterval(timer);
          resolve(undefined);
        }
      }, 1);
    });
    host.detach(id, observer);
    const mid = received.length;
    await running;
    expect(host.status(id)?.turning).toBe(false);
    expect(ended()).toBe(false);
    expect(received.length).toBeLessThan(3);
    expect(received.length).toBeGreaterThanOrEqual(mid);
  });

  it("completes a turn with no observers (front already gone)", async () => {
    const host = new NodeSessionHost(delayedRunner());
    const id = host.createSession();
    await host.message(id, "go");
    expect(host.status(id)?.turning).toBe(false);
    expect(host.destroy(id)).toBe(true);
  });

  it("abort stops the running turn but keeps the session", async () => {
    const host = new NodeSessionHost(async function* (_id, _msg, signal) {
      yield { type: "content", content: "a" } as StreamChunk;
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const id = host.createSession();
    expect(host.abort(id)).toBe(false); // nothing running

    const running = host.message(id, "go");
    expect(host.abort(id)).toBe(true);
    expect(host.stopping(id)).not.toBeNull();
    await running;

    expect(host.status(id)?.turning).toBe(false);
    expect(host.stopping(id)).toBeNull();
  });

  it("detaches a turn's own observer when that turn ends", async () => {
    const host = new NodeSessionHost(delayedRunner());
    const id = host.createSession();
    const { observer, ended } = makeObserver();
    await host.message(id, "go", "t1", observer);
    expect(ended()).toBe(true);
    expect(host.status(id)?.observers).toBe(0);
  });
});
