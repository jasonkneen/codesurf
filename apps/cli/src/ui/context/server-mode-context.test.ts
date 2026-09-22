import { describe, expect, it, vi } from "vitest";
import type { RemoteFront } from "../../relay/session-stream";
import { replaceRemoteFront } from "./server-mode-context";

function front(sessionId: string): RemoteFront {
  return { client: { close: vi.fn() }, sessionId, url: "ws://node" } as unknown as RemoteFront;
}

describe("replaceRemoteFront", () => {
  it("closes the previous client when attaching/resuming another session", () => {
    const first = front("s1");
    const second = front("s2");
    const ref = { current: null as RemoteFront | null };

    expect(replaceRemoteFront(ref, first)).toBe(first);
    expect(replaceRemoteFront(ref, second)).toBe(second);

    expect(first.client.close).toHaveBeenCalledTimes(1);
    expect(second.client.close).not.toHaveBeenCalled();
    expect(ref.current).toBe(second);
  });

  it("closes the current client on detach", () => {
    const only = front("s1");
    const ref = { current: only as RemoteFront | null };

    expect(replaceRemoteFront(ref, null)).toBeNull();
    expect(only.client.close).toHaveBeenCalledTimes(1);
  });
});
