import { describe, expect, it } from "vitest";
import { EngineNode } from "./engine-node";
import { discoverLocalServers, probeServer } from "./server-discovery";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function* stub(): AsyncGenerator<{ type: "content"; content: string }> {}

describe("server discovery (localhost probe)", () => {
  it("detects a live codesurf node on a probed port", async () => {
    const node = new EngineNode({ nodeId: "disc", turnRunner: stub, port: 0 });
    await node.start();
    let port = 0;
    for (let i = 0; i < 30; i++) {
      if (node.port() !== 0) {
        port = node.port();
        break;
      }
      await sleep(100);
    }
    expect(port).toBeGreaterThan(0);
    expect(await probeServer(`ws://127.0.0.1:${port}`)).toBe(true);
    const found = await discoverLocalServers([{ host: "127.0.0.1", port }]);
    expect(found.some((s) => s.port === port)).toBe(true);
    await node.close();
  });

  it("does not report a dead port as reachable", async () => {
    // pick a port very unlikely to have a node (bind nothing; use ephemeral closed).
    expect(await probeServer("ws://127.0.0.1:1")).toBe(false);
  });
});
