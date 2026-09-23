// Real behaviour: spawns `bun src/index.ts node` detached in a temp config dir,
// waits for ping/pong, then stops it. Never touches the real ~/.codesurf.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeServer } from "../relay/server-discovery";
import { isPortFree, listServers, pickFreePort, serverStatus, startServer, stopServer } from "./lifecycle";
import { isPidAlive, logPath, recordPath } from "./registry";

const cliRoot = path.resolve(__dirname, "../..");
const bun = [
  process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, "bin", "bun"),
  path.join(os.homedir(), ".bun", "bin", "bun"),
]
  .filter((p): p is string => Boolean(p))
  .find((p) => fs.existsSync(p));
const entry = bun ? { command: bun, args: [path.join(cliRoot, "src", "index.ts")] } : undefined;

let configDir: string;
const saved = { home: process.env.CODESURF_HOME, token: process.env.CODESURF_NODE_TOKEN };

beforeAll(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-server-life-"));
  // Registry + settings (CODESURF_CONFIG_DIR) and the node token (CODESURF_HOME)
  // both land in the temp dir; the spawned node inherits these.
  process.env.CODESURF_CONFIG_DIR = configDir;
  process.env.CODESURF_HOME = configDir;
  delete process.env.CODESURF_NODE_TOKEN;
});

afterAll(() => {
  process.env.CODESURF_HOME = saved.home;
  if (saved.home === undefined) delete process.env.CODESURF_HOME;
  if (saved.token !== undefined) process.env.CODESURF_NODE_TOKEN = saved.token;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("port picking", () => {
  it("skips a port in use and ports claimed by registered servers", async () => {
    const blocker = net.createServer();
    const busy = await new Promise<number>((resolve) =>
      blocker.listen(0, "127.0.0.1", () => resolve((blocker.address() as net.AddressInfo).port)),
    );
    try {
      expect(await isPortFree(busy)).toBe(false);
      const picked = await pickFreePort(busy, "127.0.0.1", new Set([busy + 1]));
      expect(picked).toBeGreaterThan(busy + 1);
    } finally {
      blocker.close();
    }
  });
});

describe.skipIf(!entry)("server start/status/stop against a real node", () => {
  it("starts detached, reports status, and stops", { timeout: 90_000 }, async () => {
    const port = await pickFreePort(41000);
    const { record, started } = await startServer({
      name: "life",
      port,
      cliVersion: "test",
      configDir,
      entry,
      readyTimeoutMs: 45_000,
    });
    try {
      expect(started).toBe(true);
      expect(record).toMatchObject({ name: "life", port, url: `ws://127.0.0.1:${port}` });
      expect(fs.existsSync(recordPath("life", configDir))).toBe(true);
      expect(fs.readFileSync(logPath("life", configDir), "utf8")).toContain("codesurf node listening");
      expect(await probeServer(record.url)).toBe(true);

      const status = await serverStatus("life", { configDir });
      expect(status).toMatchObject({ reachable: true, record: { pid: record.pid } });
      expect((await listServers({ configDir })).map((s) => s.record.name)).toEqual(["life"]);

      // Starting the same name again is idempotent.
      const again = await startServer({ name: "life", cliVersion: "test", configDir, entry });
      expect(again).toMatchObject({ started: false, record: { pid: record.pid } });
    } finally {
      const stopped = await stopServer("life", { configDir });
      expect(stopped.record?.pid).toBe(record.pid);
      expect(stopped.forced).toBe(false);
    }
    expect(isPidAlive(record.pid)).toBe(false);
    expect(fs.existsSync(recordPath("life", configDir))).toBe(false);
    expect(await probeServer(record.url)).toBe(false);
    expect(await serverStatus("life", { configDir })).toBeNull();
  });

  it("stop is a no-op for an unknown server", async () => {
    expect(await stopServer("nope", { configDir })).toEqual({ record: null, forced: false });
  });

  it("rejects an explicit port that is in use", async () => {
    const blocker = net.createServer();
    const busy = await new Promise<number>((resolve) =>
      blocker.listen(0, "127.0.0.1", () => resolve((blocker.address() as net.AddressInfo).port)),
    );
    try {
      await expect(startServer({ name: "busy", port: busy, cliVersion: "test", configDir, entry })).rejects.toThrow(
        /already in use/,
      );
    } finally {
      blocker.close();
    }
  });
});
