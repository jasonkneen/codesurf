// A server has no TUI to prompt for a key. Two guarantees, on a real node over a
// real WebSocket with the real Agent and the real xAI provider:
//   1. With no key anywhere, a turn fails loudly, and the error says where this
//      server reads its key from. It is never a silent, empty "done".
//   2. The key is read on every turn, not once at boot, so a key added to the
//      user settings after the server started works without a restart. This
//      holds for a new session and for a session opened while keyless.
// The xAI endpoint is a local HTTP stub (CODESURF_BASE_URL) that records the
// bearer token it was sent, so "the next turn used the new key" is observed on
// the wire, not inferred.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __resetPluginsForTests, bootstrapPlugins, shutdownPlugins } from "../core/plugins";
import { loadBuiltinPlugins } from "../core/plugins/builtin";
import { EngineNode } from "../relay/engine-node";
import { runRemoteTurn, SessionStreamClient } from "../relay/session-stream";
import type { StreamChunk } from "../types/index";
import { getUserSettingsPath } from "../utils/settings";
import { NodeAgentHost } from "./node-host";

const KEY_ENV = ["CODESURF_API_KEY", "MINIMAX_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "CODESURF_MODEL"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("codesurf node credentials", () => {
  const savedEnv = new Map<string, string | undefined>();
  const seenTokens: string[] = [];
  let stub: Server;
  let workdir: string;
  let agentHost: NodeAgentHost;
  let engine: EngineNode;
  let client: SessionStreamClient;

  beforeAll(async () => {
    for (const name of [...KEY_ENV, "CODESURF_BASE_URL"]) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
    stub = createServer((req, res) => {
      seenTokens.push(String(req.headers.authorization ?? ""));
      req.resume();
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stub: key rejected", type: "invalid_request_error" } }));
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    process.env.CODESURF_BASE_URL = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/v1`;

    rmSync(getUserSettingsPath(), { force: true });
    workdir = mkdtempSync(join(tmpdir(), "codesurf-node-cred-"));
    __resetPluginsForTests();
    await bootstrapPlugins([...(await loadBuiltinPlugins())]);

    // No --api-key and none in settings/env: the node boots keyless.
    agentHost = new NodeAgentHost({});
    engine = new EngineNode({ turnRunner: agentHost.runner, port: 0 });
    await engine.start();
    const start = Date.now();
    while (engine.port() === 0 && Date.now() - start < 3000) await sleep(10);
    client = new SessionStreamClient(`ws://127.0.0.1:${engine.port()}`);
    await client.connect();
  });

  afterAll(async () => {
    client?.close();
    await agentHost?.cleanup();
    await engine?.close().catch(() => {});
    await shutdownPlugins();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    rmSync(workdir, { recursive: true, force: true });
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  async function turn(session: string): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = [];
    await runRemoteTurn(client, session, "hello", { onChunk: (c) => chunks.push(c), idleTimeoutMs: 20_000 });
    return chunks;
  }

  const errorsOf = (chunks: StreamChunk[]) =>
    chunks.filter((c) => c.type === "error").map((c) => String((c as { content?: unknown }).content));

  let keylessSession = "";

  it("fails a keyless turn loudly, saying where the key goes", async () => {
    keylessSession = await client.createSession({ cwd: workdir });
    const errors = errorsOf(await turn(keylessSession));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("This server has no API key");
    expect(errors[0]).toContain(getUserSettingsPath());
    expect(errors[0]).toContain("codesurf server restart");
    expect((await client.status(keylessSession))?.finished).toBe(false);
    expect(seenTokens).toEqual([]);
  });

  it("uses a key added to the user settings after boot, with no restart", async () => {
    mkdirSync(dirname(getUserSettingsPath()), { recursive: true });
    writeFileSync(getUserSettingsPath(), JSON.stringify({ apiKey: "xai-added-after-boot" }));

    // A new session, and the session that was opened while keyless.
    const fresh = await client.createSession({ cwd: workdir });
    const freshErrors = errorsOf(await turn(fresh));
    const retryErrors = errorsOf(await turn(keylessSession));

    // Both turns reached the provider with the new key (the stub rejects it,
    // which is the error the front now sees, not the "no API key" one).
    expect(seenTokens.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seenTokens)).toEqual(new Set(["Bearer xai-added-after-boot"]));
    for (const errors of [freshErrors, retryErrors]) {
      expect(errors.join("\n")).not.toContain("no API key");
    }
  });

  it("uses a rotated key on the very next turn of an existing session", async () => {
    const session = await client.createSession({ cwd: workdir });
    await turn(session);
    writeFileSync(getUserSettingsPath(), JSON.stringify({ apiKey: "xai-rotated" }));
    seenTokens.length = 0;
    await turn(session);
    expect(seenTokens.length).toBeGreaterThan(0);
    expect(new Set(seenTokens)).toEqual(new Set(["Bearer xai-rotated"]));
  });
});
