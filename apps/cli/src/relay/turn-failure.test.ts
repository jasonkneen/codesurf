// A turn that fails outside the model stream must reach the front as an error.
// Real case: a node started without an API key. Its Agent throws while
// connecting the provider, before any chunk exists. The host used to swallow
// the throw and send a bare `done`, so the TUI showed "Done in 0.0s" with
// nothing else. Real engine node, real WebSocket; the runner throws exactly
// where the keyless Agent does.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StreamChunk } from "../types/index";
import { EngineNode } from "./engine-node";
import { NodeSessionHost } from "./host";
import { runRemoteTurn, SessionStreamClient } from "./session-stream";

const KEYLESS = "xAI provider session requested without a configured API key.";

// biome-ignore lint/correctness/useYield: fails before its first chunk, like the keyless Agent.
async function* keylessRunner(): AsyncGenerator<StreamChunk> {
  throw new Error(KEYLESS);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a turn that throws before streaming", () => {
  it("reaches observers as an error chunk and leaves the session unfinished", async () => {
    const host = new NodeSessionHost(keylessRunner);
    const id = host.createSession("s1");
    const chunks: StreamChunk[] = [];
    let ended = false;
    host.attach(id, { onChunk: (c) => chunks.push(c), onEnd: () => (ended = true) });

    await expect(host.message(id, "hi")).rejects.toThrow(KEYLESS);
    expect(chunks).toEqual([{ type: "error", content: KEYLESS }]);
    expect(ended).toBe(true);
    expect(host.status(id)?.finished).toBe(false);
    expect(host.status(id)?.text).toContain(KEYLESS);
  });

  describe("over the wire", () => {
    let node: EngineNode;
    let client: SessionStreamClient;

    beforeAll(async () => {
      node = new EngineNode({ turnRunner: keylessRunner, port: 0 });
      await node.start();
      const start = Date.now();
      while (node.port() === 0 && Date.now() - start < 3000) await sleep(10);
      client = new SessionStreamClient(`ws://127.0.0.1:${node.port()}`);
      await client.connect();
    });

    afterAll(async () => {
      client.close();
      await node.close();
    });

    it("the front gets the error, not a silent empty turn", async () => {
      const session = await client.createSession();
      const chunks: StreamChunk[] = [];
      await runRemoteTurn(client, session, "hi", { onChunk: (c) => chunks.push(c), idleTimeoutMs: 5000 });
      expect(chunks).toEqual([{ type: "error", content: KEYLESS }]);
      expect((await client.status(session))?.finished).toBe(false);
    });
  });
});
