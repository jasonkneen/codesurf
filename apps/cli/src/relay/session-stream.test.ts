import { describe, expect, it } from "vitest";
import { EngineNode } from "./engine-node";
import { createRemoteSessionTurn, runRemoteTurn, SessionStreamClient } from "./session-stream";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(node: { port(): number }, timeoutMs = 3000) {
  const start = Date.now();
  while (node.port() === 0 && Date.now() - start < timeoutMs) await sleep(10);
  return node.port();
}

async function* echoRunner(_s: string, message: string): AsyncGenerator<{ type: "content"; content: string }> {
  yield { type: "content", content: `echo:${message}` };
}

describe("session streaming (mode-2 front plane)", () => {
  it("streams live chunks from a node session to a front over WS", async () => {
    const node = new EngineNode({ nodeId: "n-stream", turnRunner: echoRunner, port: 0 });
    await node.start();
    const url = `ws://127.0.0.1:${await waitForPort(node)}`;
    const client = new SessionStreamClient(url);
    const saw: string[] = [];
    let done = false;
    client.on({
      onChunk: (_s, c) => {
        if (c.type === "content" && c.content) saw.push(c.content);
      },
      onDone: () => {
        done = true;
      },
    });
    await client.connect();
    const session = await client.createSession();
    expect(session).toBeTruthy();
    client.sendMessage(session, "hello");
    await sleep(200);
    expect(done).toBe(true);
    expect(saw.join("")).toContain("echo:hello");
    client.close();
    await node.close();
  });

  it("keeps the session alive when the front disconnects (client-death resilience)", async () => {
    const node = new EngineNode({ nodeId: "n-res", turnRunner: echoRunner, port: 0 });
    await node.start();
    const url = `ws://127.0.0.1:${await waitForPort(node)}`;
    const client = new SessionStreamClient(url);
    await client.connect();
    const session = await client.createSession();
    client.sendMessage(session, "fork");
    client.close(); // front dies mid-flight
    await sleep(150);
    const status = node.sessions.status(session);
    expect(status).not.toBeNull(); // node still owns the session — turn continued
    await node.close();
  });

  it("bridges a remote session stream into an AsyncGenerator (TUI turn engine)", async () => {
    const node = new EngineNode({ nodeId: "n-gen", turnRunner: echoRunner, port: 0 });
    await node.start();
    const url = `ws://127.0.0.1:${await waitForPort(node)}`;
    const client = new SessionStreamClient(url);
    await client.connect();
    const session = await client.createSession();
    const gen = createRemoteSessionTurn(client, session, "hello");
    const saw: string[] = [];
    for await (const c of gen) {
      if ((c as { type?: string }).type === "content" && (c as { content?: string }).content) {
        saw.push((c as { content: string }).content);
      }
    }
    expect(saw.join("")).toContain("echo:hello");
    client.close();
    await node.close();
  });
});

describe("session stream failure paths (M13)", () => {
  it("answers a message to an unknown/reaped session with an error frame, and runRemoteTurn rejects", async () => {
    const node = new EngineNode({ nodeId: "n-gone", turnRunner: echoRunner, port: 0 });
    await node.start();
    const client = new SessionStreamClient(`ws://127.0.0.1:${await waitForPort(node)}`);
    try {
      await client.connect();
      await expect(runRemoteTurn(client, "sess-reaped", "hi", { idleTimeoutMs: 2000 })).rejects.toThrow(
        /unknown session sess-reaped/,
      );
    } finally {
      client.close();
      await node.close();
    }
  });

  it("runRemoteTurn rejects when the socket closes mid-turn instead of hanging", async () => {
    async function* stuck(): AsyncGenerator<never> {
      await new Promise(() => {});
    }
    const node = new EngineNode({ nodeId: "n-close", turnRunner: stuck, port: 0 });
    await node.start();
    const client = new SessionStreamClient(`ws://127.0.0.1:${await waitForPort(node)}`);
    await client.connect();
    const session = await client.createSession();
    const turn = runRemoteTurn(client, session, "hi", { idleTimeoutMs: 5000 });
    await sleep(50);
    const rejected = expect(turn).rejects.toThrow(/closed/);
    await node.close();
    await rejected;
  });

  it("runRemoteTurn rejects after the idle timeout when the node goes silent", async () => {
    async function* stuck(): AsyncGenerator<never> {
      await new Promise(() => {});
    }
    const node = new EngineNode({ nodeId: "n-idle", turnRunner: stuck, port: 0 });
    await node.start();
    const client = new SessionStreamClient(`ws://127.0.0.1:${await waitForPort(node)}`);
    try {
      await client.connect();
      const session = await client.createSession();
      await expect(runRemoteTurn(client, session, "hi", { idleTimeoutMs: 100 })).rejects.toThrow(/timed out/);
    } finally {
      client.close();
      await node.close();
    }
  });

  it("authenticates with the token from the resolver hook (token-protected node)", async () => {
    const node = new EngineNode({ nodeId: "n-auth", turnRunner: echoRunner, port: 0, authToken: "tok" });
    await node.start();
    const url = `ws://127.0.0.1:${await waitForPort(node)}`;
    await expect(new SessionStreamClient(url).connect()).rejects.toThrow(/connect failed/);
    const previous = SessionStreamClient.tokenResolver;
    SessionStreamClient.tokenResolver = () => "tok";
    const client = new SessionStreamClient(url);
    try {
      await client.connect();
      const session = await client.createSession();
      const saw: string[] = [];
      await runRemoteTurn(client, session, "hey", {
        onChunk: (c) => {
          if (c.type === "content" && c.content) saw.push(c.content);
        },
      });
      expect(saw.join("")).toBe("echo:hey");
    } finally {
      SessionStreamClient.tokenResolver = previous;
      client.close();
      await node.close();
    }
  });
});

describe("createRemoteSessionTurn failure paths (M13, TUI front)", () => {
  it("ends with an error chunk for an unknown session instead of hanging", async () => {
    const node = new EngineNode({ nodeId: "n-tui-gone", turnRunner: echoRunner, port: 0 });
    await node.start();
    const client = new SessionStreamClient(`ws://127.0.0.1:${await waitForPort(node)}`);
    try {
      await client.connect();
      const chunks = [];
      for await (const chunk of createRemoteSessionTurn(client, "sess-reaped", "hi")) chunks.push(chunk);
      expect(chunks).toEqual([{ type: "error", content: "unknown session sess-reaped" }]);
    } finally {
      client.close();
      await node.close();
    }
  });
});
