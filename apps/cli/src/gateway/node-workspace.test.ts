// One node, many folders: a session runs entirely in the folder its front
// asked for. Real engine node over a real WebSocket, real Agent, real kernel
// bash + file tools, real session store and settings files. Only the model is
// scripted: it reads an instruction out of the user message and emits the
// matching tool calls, so every file below is written by the actual tools.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

interface ModelCall {
  modelId: string;
  system: string;
}

const calls = vi.hoisted(() => [] as ModelCall[]);

// biome-ignore lint/suspicious/noExplicitAny: SDK v3 usage shape, not asserted on.
const usage = (): any => ({ inputTokens: { total: 0 }, outputTokens: { total: 0 }, totalTokens: { total: 0 } });

interface Instruction {
  bash?: string;
  write?: { path: string; content: string };
}

// biome-ignore lint/suspicious/noExplicitAny: the v3 prompt union is wide; only text parts are read.
function textOf(message: any): string {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .map((part: { type: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}

function scriptedModel(modelId: string) {
  // biome-ignore lint/suspicious/noExplicitAny: SDK stream-part union is easier to satisfy loosely.
  const doStream: any = async (options: { prompt: any[] }) => {
    const prompt = options.prompt;
    calls.push({
      modelId,
      system: prompt
        .filter((m) => m.role === "system")
        .map(textOf)
        .join("\n"),
    });
    const lastUser = prompt.map((m) => m.role).lastIndexOf("user");
    const answered = prompt.slice(lastUser + 1).some((m) => m.role === "tool");
    // Let concurrent sessions interleave inside their turns.
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (answered) {
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "done" },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: "stop", usage: usage() },
          ],
        }),
      };
    }
    const match = /<<(.*?)>>/s.exec(textOf(prompt[lastUser]));
    const instruction = JSON.parse(match?.[1] ?? "{}") as Instruction;
    const toolCalls = [];
    if (instruction.bash) {
      toolCalls.push({
        type: "tool-call",
        toolCallId: "bash-1",
        toolName: "bash",
        input: JSON.stringify({ command: instruction.bash }),
      });
    }
    if (instruction.write) {
      toolCalls.push({
        type: "tool-call",
        toolCallId: "write-1",
        toolName: "write_file",
        input: JSON.stringify(instruction.write),
      });
    }
    return {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          ...toolCalls,
          { type: "finish", finishReason: "tool-calls", usage: usage() },
        ],
      }),
    };
  };
  return new MockLanguageModelV3({ doStream });
}

vi.mock("../core/plugins", async () => {
  const actual = await vi.importActual<typeof import("../core/plugins")>("../core/plugins");
  return {
    ...actual,
    resolveModelRuntimeViaKernel: vi.fn(async (modelId: string) => ({
      model: scriptedModel(modelId),
      modelId,
      modelInfo: undefined,
      providerOptions: undefined,
    })),
    runtimeUsesSendTurn: vi.fn(() => false),
  };
});

const { bootstrapPlugins, shutdownPlugins, __resetPluginsForTests } = await import("../core/plugins");
const { createNativePluginModule } = await import("../core/plugins/native/host");
const { bashToolsPlugin } = await import("../core/plugins/native/bash-tools");
const { fileToolsPlugin } = await import("../core/plugins/native/file-tools");
const { EngineNode } = await import("../relay/engine-node");
const { SessionStreamClient, runRemoteTurn } = await import("../relay/session-stream");
const { NodeAgentHost } = await import("./node-host");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("codesurf node: per-session working folder", () => {
  let root: string;
  let dirA: string;
  let dirB: string;
  let agentHost: InstanceType<typeof NodeAgentHost>;
  let engine: InstanceType<typeof EngineNode>;
  let client: InstanceType<typeof SessionStreamClient>;

  beforeAll(async () => {
    __resetPluginsForTests();
    await bootstrapPlugins([createNativePluginModule(bashToolsPlugin), createNativePluginModule(fileToolsPlugin)]);

    root = realpathSync(mkdtempSync(join(tmpdir(), "codesurf-node-ws-")));
    dirA = join(root, "projectA");
    dirB = join(root, "projectB");
    for (const [dir, tag] of [
      [dirA, "alpha"],
      [dirB, "beta"],
    ] as const) {
      mkdirSync(join(dir, ".grok"), { recursive: true });
      writeFileSync(join(dir, ".grok", "settings.json"), JSON.stringify({ model: `model-${tag}` }));
      writeFileSync(join(dir, "AGENTS.md"), `Project instructions marker: ${tag.toUpperCase()}-RULES\n`);
    }

    agentHost = new NodeAgentHost({ apiKey: "test-key", autoApprove: true });
    engine = new EngineNode({
      turnRunner: agentHost.runner,
      port: 0,
      onSessionEvict: (sessionId) => void agentHost.disposeSession(sessionId),
    });
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
    rmSync(root, { recursive: true, force: true });
  });

  const turn = (session: string, instruction: Instruction, via = client) =>
    runRemoteTurn(via, session, `please <<${JSON.stringify(instruction)}>>`, { idleTimeoutMs: 20_000 });

  it("runs two concurrent sessions each in its own folder: bash, write_file, settings, AGENTS.md", async () => {
    // Two fronts (a client holds one set of turn handlers), one node.
    const frontB = new SessionStreamClient(`ws://127.0.0.1:${engine.port()}`);
    await frontB.connect();
    const a = await client.createSession({ cwd: dirA });
    const b = await frontB.createSession({ cwd: dirB });
    calls.length = 0;

    await Promise.all([
      turn(a, { bash: "pwd > where.txt", write: { path: "note.txt", content: "from A" } }),
      turn(b, { bash: "pwd > where.txt", write: { path: "note.txt", content: "from B" } }, frontB),
    ]);
    frontB.close();

    expect(readFileSync(join(dirA, "where.txt"), "utf8").trim()).toBe(dirA);
    expect(readFileSync(join(dirB, "where.txt"), "utf8").trim()).toBe(dirB);
    expect(readFileSync(join(dirA, "note.txt"), "utf8")).toBe("from A");
    expect(readFileSync(join(dirB, "note.txt"), "utf8")).toBe("from B");
    expect(existsSync(join(process.cwd(), "note.txt"))).toBe(false);

    // Each session picked its model from its own folder's .grok/settings.json
    // and got its own folder's AGENTS.md (project instructions) in the system prompt.
    const alpha = calls.filter((c) => c.modelId === "model-alpha");
    const beta = calls.filter((c) => c.modelId === "model-beta");
    expect(alpha.length).toBeGreaterThan(0);
    expect(beta.length).toBeGreaterThan(0);
    expect(alpha.every((c) => c.system.includes("ALPHA-RULES") && !c.system.includes("BETA-RULES"))).toBe(true);
    expect(beta.every((c) => c.system.includes("BETA-RULES") && !c.system.includes("ALPHA-RULES"))).toBe(true);

    const listed = await client.listSessions();
    expect(listed.find((s) => s.id === a)?.cwd).toBe(dirA);
    expect(listed.find((s) => s.id === b)?.cwd).toBe(dirB);

    // Destroying one session leaves the other's shell and tools working.
    client.destroy(a);
    await sleep(50);
    await turn(b, { bash: "pwd > again.txt" });
    expect(readFileSync(join(dirB, "again.txt"), "utf8").trim()).toBe(dirB);
    client.destroy(b);
  });

  it("a `cd` in one session does not move another session's shell", async () => {
    const a = await client.createSession({ cwd: dirA });
    const b = await client.createSession({ cwd: dirB });
    mkdirSync(join(dirA, "sub"), { recursive: true });

    await turn(a, { bash: "cd sub" });
    await turn(b, { bash: "pwd > after-cd.txt" });
    await turn(a, { bash: "pwd > after-cd.txt" });

    expect(readFileSync(join(dirB, "after-cd.txt"), "utf8").trim()).toBe(dirB);
    expect(readFileSync(join(dirA, "sub", "after-cd.txt"), "utf8").trim()).toBe(join(dirA, "sub"));
    client.destroy(a);
    client.destroy(b);
  });

  it("a session created without a cwd runs in the node's own folder", async () => {
    const session = await client.createSession();
    const out = join(root, "node-pwd.txt");
    await turn(session, { bash: `pwd > ${out}` });
    expect(readFileSync(out, "utf8").trim()).toBe(realpathSync(process.cwd()));
    const status = await client.status(session);
    expect(status?.cwd).toBe(realpathSync(process.cwd()));
    client.destroy(session);
  });

  it("rejects a cwd that is relative, missing, or not a directory", async () => {
    await expect(client.createSession({ cwd: "relative/path" })).rejects.toThrow(/absolute path/);
    await expect(client.createSession({ cwd: join(root, "missing") })).rejects.toThrow(/does not exist/);
    await expect(client.createSession({ cwd: join(dirA, "AGENTS.md") })).rejects.toThrow(/not a directory/);
    await expect(client.createSession({ cwd: dirA, sandboxMode: "bogus" as "off" })).rejects.toThrow(
      /unknown sandbox mode/,
    );
    // The old string form still works.
    expect(await client.createSession("named-session")).toBe("named-session");
    client.destroy("named-session");
  });
});
