import { describe, expect, it } from "vitest";
import { type QueuedSubmission, reserveQueuedSubmission } from "./queue-submissions";

function makeRefs() {
  return {
    queuedMessagesRef: { current: [] as QueuedSubmission[] },
    nextQueueIdRef: { current: 0 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const macrotask = () => new Promise<void>((r) => setImmediate(r));

describe("reserveQueuedSubmission", () => {
  it("claims the id and the queue position synchronously, before preparation settles", () => {
    const refs = makeRefs();
    const b = deferred<string>();

    const entry = reserveQueuedSubmission(refs, { text: "B @b", displayText: "B @b", prepare: () => b.promise });

    expect(entry.id).toBe("q0");
    expect(refs.nextQueueIdRef.current).toBe(1);
    expect(refs.queuedMessagesRef.current).toHaveLength(1);
    expect(refs.queuedMessagesRef.current[0]).toBe(entry);
    expect(entry.text).toBe("B @b");
    expect(typeof entry.prepareText).toBe("function");
  });

  it("keeps Enter order when preparations complete in reverse", async () => {
    const refs = makeRefs();
    const b = deferred<string>();
    const c = deferred<string>();
    const started: string[] = [];

    reserveQueuedSubmission(refs, {
      text: "B",
      displayText: "B",
      prepare: () => {
        started.push("B");
        return b.promise;
      },
    });
    reserveQueuedSubmission(refs, {
      text: "C",
      displayText: "C",
      prepare: () => {
        started.push("C");
        return c.promise;
      },
    });
    // Preparation starts eagerly, at reservation time, in Enter order.
    expect(started).toEqual(["B", "C"]);

    c.resolve("C expanded");
    b.resolve("B expanded");
    await macrotask();

    expect(refs.queuedMessagesRef.current.map((m) => m.text)).toEqual(["B", "C"]);
    const head = refs.queuedMessagesRef.current.shift()!;
    await expect(head.prepareText!()).resolves.toBe("B expanded");
    const next = refs.queuedMessagesRef.current.shift()!;
    await expect(next.prepareText!()).resolves.toBe("C expanded");
  });

  it("memoizes the preparation so dispatch does not expand twice", async () => {
    const refs = makeRefs();
    let calls = 0;
    const entry = reserveQueuedSubmission(refs, {
      text: "B",
      displayText: "B",
      prepare: () => {
        calls += 1;
        return Promise.resolve("B expanded");
      },
    });

    await expect(entry.prepareText!()).resolves.toBe("B expanded");
    await expect(entry.prepareText!()).resolves.toBe("B expanded");
    expect(calls).toBe(1);
  });

  it("does not turn a failed preparation of a dropped slot into an unhandled rejection", async () => {
    const refs = makeRefs();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const entry = reserveQueuedSubmission(refs, {
        text: "B",
        displayText: "B",
        prepare: () => Promise.reject(new Error("daemon down")),
      });
      // abortActiveRun / resetToNewSession replace the queue array; nothing
      // ever awaits this slot's preparation.
      refs.queuedMessagesRef.current = [];
      await macrotask();
      expect(unhandled).toEqual([]);

      // A turn that does dispatch the slot still sees the failure.
      await expect(entry.prepareText!()).rejects.toThrow("daemon down");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("leaves prepareText unset for submissions that need no preparation", () => {
    const refs = makeRefs();
    const entry = reserveQueuedSubmission(refs, { text: "plain", displayText: "plain" });
    expect(entry.prepareText).toBeUndefined();
    expect(refs.queuedMessagesRef.current).toEqual([{ id: "q0", text: "plain", displayText: "plain" }]);
  });
});
