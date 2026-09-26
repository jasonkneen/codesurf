import { describe, expect, it } from "vitest";
import { createRemoteSessionTurn, SessionStreamClient } from "./session-stream";

// A front that ends one turn early (e.g. on an error chunk) and starts the next
// used to receive the first turn's late `done` and end the new turn with it.

function fakeClient() {
  const client = new SessionStreamClient("ws://unused");
  const sent: Array<Record<string, unknown>> = [];
  const internals = client as unknown as {
    ws: { send(data: string): void; close(): void };
    ingest(raw: string): void;
  };
  internals.ws = { send: (data) => sent.push(JSON.parse(data)), close: () => {} };
  const deliver = (frame: Record<string, unknown>) => internals.ingest(JSON.stringify({ op: "session", ...frame }));
  return { client, sent, deliver };
}

describe("remote turn ids", () => {
  it("tags the message and ignores another turn's late frames", async () => {
    const { client, sent, deliver } = fakeClient();
    const chunks: unknown[] = [];
    const turn = createRemoteSessionTurn(client, "s1", "again");
    const pending = (async () => {
      for await (const chunk of turn) chunks.push(chunk);
    })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const myTurn = sent[0]?.turn as string;
    expect(sent[0]).toMatchObject({ action: "message", session: "s1", text: "again" });
    expect(typeof myTurn).toBe("string");

    deliver({ event: "done", session: "s1", finished: false, turn: "previous-turn" });
    deliver({ event: "chunk", session: "s1", chunk: { type: "content", content: "stale" }, turn: "previous-turn" });
    deliver({ event: "chunk", session: "other", chunk: { type: "content", content: "other session" }, turn: myTurn });
    deliver({ event: "chunk", session: "s1", chunk: { type: "content", content: "fresh" }, turn: myTurn });
    deliver({ event: "done", session: "s1", finished: true, turn: myTurn });
    await pending;

    expect(chunks).toEqual([{ type: "content", content: "fresh" }]);
  });

  it("still accepts untagged frames from a node that predates turn ids", async () => {
    const { client, deliver } = fakeClient();
    const chunks: unknown[] = [];
    const pending = (async () => {
      for await (const chunk of createRemoteSessionTurn(client, "s1", "hi")) chunks.push(chunk);
    })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    deliver({ event: "chunk", session: "s1", chunk: { type: "content", content: "ok" } });
    deliver({ event: "done", session: "s1", finished: true });
    await pending;
    expect(chunks).toEqual([{ type: "content", content: "ok" }]);
  });
});
