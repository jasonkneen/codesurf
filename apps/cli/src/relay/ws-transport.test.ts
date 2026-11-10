import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Hub } from "./hub";
import { RelayNode, type RemoteTool } from "./node";
import { Steward } from "./steward";
import { WsRelayClient, WsRelayServer } from "./ws-transport";

describe("websocket relay transport (Phase 3 W3)", () => {
  let server: WsRelayServer;
  let url: string;
  let a: RelayNode;
  let b: RelayNode;
  let aSpoke: WsRelayClient;
  let bSpoke: WsRelayClient;

  async function waitPort(ms = 3000): Promise<number> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const port = server.port();
      if (port > 0) return port;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("ws server did not bind a port");
  }

  async function waitDiscover(expectNode: string, ms = 5000): Promise<void> {
    const start = Date.now();
    await a.start();
    while (Date.now() - start < ms) {
      const nodes = await a.discover({ capabilities: ["nodeB_ping"] });
      if (nodes.includes(expectNode)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("nodeB never became discoverable over WS");
  }

  beforeAll(async () => {
    const hub = new Hub("hub");
    server = new WsRelayServer({ hub });
    const port = await waitPort();
    url = `ws://127.0.0.1:${port}`;

    bSpoke = new WsRelayClient(url);
    const bSteward = new Steward({ allow: { nodeB_ping: ["nodeA"] } });
    b = new RelayNode("nodeB", bSpoke, bSteward);
    b.registerTool({
      name: "nodeB_ping",
      description: "ping over ws",
      run: () => ({ statement: "pong", anchors: [], handle: "h" }),
    } satisfies RemoteTool);
    await b.start({ repo: "repo:/clientB" });

    aSpoke = new WsRelayClient(url);
    a = new RelayNode("nodeA", aSpoke, new Steward({ allow: {} }));
  });

  afterAll(async () => {
    await aSpoke.close().catch(() => {});
    await bSpoke.close().catch(() => {});
    await server.close().catch(() => {});
  });

  it("discovers a remote node and delegates through the hub over WS", async () => {
    await waitDiscover("nodeB");
    expect(await a.locate("repo:/clientB")).toBe("nodeB");
    const reply = await a.delegate("hub", "nodeB_ping", {}, "nodeA", "repo:/work");
    expect(reply.ok).toBe(true);
    expect(reply.statement).toBe("pong");
  });

  it("retires a remote node when its socket closes", async () => {
    await waitDiscover("nodeB");
    await bSpoke.close();
    const start = Date.now();
    let gone = false;
    while (Date.now() - start < 5000) {
      const nodes = await a.discover({ capabilities: ["nodeB_ping"] });
      if (!nodes.includes("nodeB")) {
        gone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(gone).toBe(true);
  });
});

describe("websocket relay auth (C1/H2)", () => {
  const token = "node-secret-token";
  let server: WsRelayServer;
  let base: string;
  let fileDir: string;

  beforeAll(async () => {
    fileDir = mkdtempSync(join(tmpdir(), "codesurf-wsauth-"));
    writeFileSync(join(fileDir, "a.txt"), "file-body");
    server = new WsRelayServer({ hub: new Hub("hub"), authToken: token, fileRoots: [fileDir] });
    await server.ready;
    base = `127.0.0.1:${server.port()}`;
  });

  afterAll(async () => {
    await server.close().catch(() => {});
    rmSync(fileDir, { recursive: true, force: true });
  });

  /** Open a raw socket; resolves "open" or the HTTP status of a refused upgrade. */
  function attempt(url: string, headers: Record<string, string> = {}): Promise<"open" | number> {
    return new Promise((resolve) => {
      const socket = new WebSocket(url, { headers });
      socket.on("open", () => {
        socket.close();
        resolve("open");
      });
      socket.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        socket.terminate();
      });
      socket.on("error", () => {});
    });
  }

  it("refuses an upgrade without the token, or with a wrong one", async () => {
    expect(await attempt(`ws://${base}`)).toBe(401);
    expect(await attempt(`ws://${base}/?token=wrong`)).toBe(401);
    expect(await attempt(`ws://${base}`, { authorization: "Bearer wrong" })).toBe(401);
  });

  it("accepts the token as a bearer header or a query param", async () => {
    expect(await attempt(`ws://${base}`, { authorization: `Bearer ${token}` })).toBe("open");
    expect(await attempt(`ws://${base}/?token=${token}`)).toBe("open");
  });

  it("refuses a browser Origin that is not allowed, even with the token", async () => {
    expect(await attempt(`ws://${base}/?token=${token}`, { origin: "https://evil.example" })).toBe(403);
  });

  it("requires the token on GET /files", async () => {
    const path = encodeURIComponent(join(fileDir, "a.txt"));
    expect((await fetch(`http://${base}/files?path=${path}`)).status).toBe(401);
    const ok = await fetch(`http://${base}/files?path=${path}&token=${token}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("file-body");
    const evil = await fetch(`http://${base}/files?path=${path}&token=${token}`, {
      headers: { origin: "https://evil.example" },
    });
    expect(evil.status).toBe(403);
  });
});
