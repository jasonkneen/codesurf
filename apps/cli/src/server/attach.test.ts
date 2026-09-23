// canRunTurns decides whether an attached/serverless TUI needs a local API key;
// runWireTurn is the headless `--connect -p` turn, checked against a real
// keyless node (the failure every new auto-started server hits first).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installNodeTokenResolver } from "../relay/server-discovery";
import { SessionStreamClient } from "../relay/session-stream";
import { canRunTurns, runWireTurn } from "./attach";
import { pickFreePort, startServer, stopServer } from "./lifecycle";

describe("canRunTurns (local API key requirement)", () => {
  it.each<[string, "local" | "server", boolean, boolean]>([
    ["attached, no local key -> can run (server owns the key)", "server", false, true],
    ["attached, local key too -> can run", "server", true, true],
    ["serverless, no local key -> key required", "local", false, false],
    ["serverless with a key -> can run", "local", true, true],
  ])("%s", (_label, kind, localModelCanRun, expected) => {
    expect(canRunTurns({ kind }, localModelCanRun)).toBe(expected);
  });
});

const cliRoot = path.resolve(__dirname, "../..");
const bun = [
  process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, "bin", "bun"),
  path.join(os.homedir(), ".bun", "bin", "bun"),
]
  .filter((p): p is string => Boolean(p))
  .find((p) => fs.existsSync(p));
const entry = bun ? { command: bun, args: [path.join(cliRoot, "src", "index.ts")] } : undefined;
const KEY_VARS = [
  "CODESURF_API_KEY",
  "MINIMAX_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "CODESURF_NODE_TOKEN",
];

describe.skipIf(!entry)("runWireTurn against a keyless node", () => {
  let configDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-wire-turn-"));
    for (const name of [...KEY_VARS, "CODESURF_HOME"]) saved[name] = process.env[name];
    for (const name of KEY_VARS) delete process.env[name];
    process.env.CODESURF_CONFIG_DIR = configDir;
    process.env.CODESURF_HOME = configDir;
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("rejects with the node's error instead of resolving silently", { timeout: 90_000 }, async () => {
    const { record } = await startServer({
      name: "keyless",
      port: await pickFreePort(41200),
      cliVersion: "test",
      configDir,
      entry,
      readyTimeoutMs: 45_000,
    });
    installNodeTokenResolver();
    const client = new SessionStreamClient(record.url);
    try {
      await client.connect();
      const session = await client.createSession({ cwd: configDir });
      const written: string[] = [];
      await expect(runWireTurn(client, session, "hi", (t) => written.push(t))).rejects.toThrow(/API key/);
      expect(written.join("")).toBe("");
    } finally {
      client.close();
      await stopServer("keyless", { configDir });
    }
  });
});
