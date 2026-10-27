// Steering a server turn: the front stops the node's running turn (Ctrl+X,
// queue send-now) and sends the next message straight away. The wire had no
// way to stop a turn short of destroying the session, so the stop only reached
// the front's local Agent and the follow-up was refused with "session … is
// busy with a running turn".
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../types/index";
import { EngineNode } from "./engine-node";
import { type HostedTurnRunner, NodeSessionHost } from "./host";
import {
  createRemoteSessionTurn,
  type SessionFrameIn,
  type SessionFrameOut,
  SessionStreamClient,
  SessionStreamServer,
  STOP_GRACE_MS,
} from "./session-stream";

const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

/** "long" runs until stopped, then takes a moment to unwind; anything else finishes at once. */
const runner: HostedTurnRunner = async function* (_id, message, signal) {
  yield { type: "content", content: `start:${message}` } as StreamChunk;
  if (message === "long") {
    await untilAborted(signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  yield { type: "content", content: `end:${message}` } as StreamChunk;
};

function serve(turnRunner: HostedTurnRunner = runner) {
  const host = new NodeSessionHost(turnRunner);
  const server = new SessionStreamServer(host);
  const frames: SessionFrameOut[] = [];
  const send = (frame: Omit<SessionFrameIn, "op">) =>
    server.handle({ op: "session", ...frame }, (out) => frames.push(out));
  send({ action: "create", session: "s1" });
  return { host, frames, send };
}

async function until(check: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the node");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const contentOf = (frames: SessionFrameOut[], turn: string) =>
  frames.filter((f) => f.event === "chunk" && f.turn === turn).map((f) => f.chunk?.content);

afterEach(() => {
  vi.useRealTimers();
});

describe("steering a server turn", () => {
  it("runs a message sent right behind abort once the stopped turn unwinds", async () => {
    const { host, frames, send } = serve();
    send({ action: "message", session: "s1", text: "long", turn: "t1" });
    await until(() => contentOf(frames, "t1").length > 0);

    send({ action: "abort", session: "s1" });
    send({ action: "message", session: "s1", text: "steer", turn: "t2" });
    await until(() => frames.some((f) => f.event === "done" && f.turn === "t2"));

    expect(frames.filter((f) => f.event === "error")).toEqual([]);
    expect(frames.some((f) => f.event === "done" && f.turn === "t1")).toBe(true);
    // Each turn's frames reach the front once, under its own id.
    expect(contentOf(frames, "t2")).toEqual(["start:steer", "end:steer"]);
    expect(host.status("s1")?.turning).toBe(false);
  });

  it("still refuses a message while a turn that was not stopped is running", async () => {
    const { host, frames, send } = serve();
    send({ action: "message", session: "s1", text: "long", turn: "t1" });
    await until(() => contentOf(frames, "t1").length > 0);

    send({ action: "message", session: "s1", text: "other", turn: "t2" });

    expect(frames).toContainEqual(
      expect.objectContaining({ event: "error", turn: "t2", message: "session s1 is busy with a running turn" }),
    );
    host.abort("s1");
    await until(() => host.status("s1")?.turning === false);
  });

  it("refuses the steer when the stopped turn has not unwound within the grace period", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const wedged = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { frames, send } = serve(async function* () {
      yield { type: "content", content: "working" } as StreamChunk;
      await wedged; // ignores the abort signal
    });
    send({ action: "message", session: "s1", text: "go", turn: "t1" });
    await vi.advanceTimersByTimeAsync(0);

    send({ action: "abort", session: "s1" });
    send({ action: "message", session: "s1", text: "steer", turn: "t2" });
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS + 1);

    expect(frames).toContainEqual(
      expect.objectContaining({
        event: "error",
        turn: "t2",
        message: "session s1 is still stopping its previous turn",
      }),
    );
    // The refused message must not start late once the wedged turn ends.
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.filter((f) => f.turn === "t2" && f.event !== "error")).toEqual([]);
  });

  it("steers over a real socket the way the TUI does: abort, then the next message streams", async () => {
    const node = new EngineNode({ nodeId: "n-steer", turnRunner: runner, port: 0 });
    await node.start();
    await until(() => node.port() !== 0);
    const client = new SessionStreamClient(`ws://127.0.0.1:${node.port()}`);
    try {
      await client.connect();
      const session = await client.createSession();
      const first = createRemoteSessionTurn(client, session, "long");
      expect((await first.next()).value).toEqual({ type: "content", content: "start:long" });

      client.abort(session);
      const chunks: StreamChunk[] = [];
      for await (const chunk of createRemoteSessionTurn(client, session, "do not push")) chunks.push(chunk);

      expect(chunks).toEqual([
        { type: "content", content: "start:do not push" },
        { type: "content", content: "end:do not push" },
      ]);
    } finally {
      client.close();
      await node.close();
    }
  });

  it("sends an abort frame for the session from the front", () => {
    const client = new SessionStreamClient("ws://unused");
    const sent: unknown[] = [];
    (client as unknown as { ws: { send(data: string): void; close(): void } }).ws = {
      send: (data) => sent.push(JSON.parse(data)),
      close: () => {},
    };

    client.abort("s1");

    expect(sent).toEqual([{ op: "session", action: "abort", session: "s1" }]);
  });
});
