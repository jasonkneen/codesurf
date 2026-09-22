import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "fs";
import path from "path";
import { buildMockBashSink } from "./mock-bash-sink";

// End-to-end verification of learned adaptive routing (#6): with the feature
// flag on and seeded history, a turn resolves to the historically-best model
// for the query class AND emits a visible note; with the flag off it uses the
// user's selected model. The runtime mock echoes/captures the model id passed
// to resolveModelRuntimeViaKernel so we can assert what routing chose.
// Bun-native (real storage via bun:sqlite), isolated via CODESURF_HOME.

function emptyHookResult() {
  return { blocked: false, blockingErrors: [], commandErrors: [], additionalContexts: [] };
}

let capturedModelId = "";
const provider = async (_input: unknown, controller: { emit: (event: unknown) => void }) => {
  controller.emit({ type: "text-delta", delta: "ok" });
  controller.emit({ type: "usage", usage: { inputTokens: 1, outputTokens: 1 } });
  controller.emit({ type: "done" });
  return { usage: { inputTokens: 1, outputTokens: 1 } };
};

const realExtensions = await import("../core/plugins");
const realHooks = await import("../hooks/index");

mock.module("../hooks/index", () => ({ ...realHooks, executeEventHooks: async () => emptyHookResult() }));
mock.module("../core/plugins", () => ({
  ...realExtensions,
  getEnabledToolSet: () => ({}),
  runtimeUsesSendTurn: () => true,
  resolveModelRuntimeViaKernel: async (modelId: string) => {
    capturedModelId = modelId;
    return {
      model: null,
      modelId,
      modelInfo: undefined,
      providerOptions: undefined,
      adapterId: "provider.adapter",
      providerId: "provider",
      session: {
        adapterId: "provider.adapter",
        providerId: "provider",
        mode: "persistent",
        sendTurn: (i: unknown, c: { emit: (e: unknown) => void }) => provider(i, c),
      },
    };
  },
}));

const { Agent } = await import("./agent");
const { recordTrace } = await import("../storage/traces");
const { closeDatabase } = await import("../storage/db");
const { SessionStore } = await import("../storage/sessions");
const { registerPluginModel } = await import("../core/plugins/registry");

const ROUTING_KEY = "featureFlags.learning.adaptiveModelRouting";
const tempRoot = path.join(process.cwd(), ".tmp-adaptive-routing-tests");
const originalCodesurfHome = process.env.CODESURF_HOME;

function seedClassHistory(sessionId: string) {
  // 6 winning "fast" traces and 6 losing "slow" traces, all class "code".
  for (let i = 0; i < 6; i++) {
    recordTrace({
      traceId: `fast-${i}`,
      sessionId,
      query: "q",
      model: "fast",
      queryClass: "code",
      outcome: "success",
      feedback: 0.9,
    });
    recordTrace({
      traceId: `slow-${i}`,
      sessionId,
      query: "q",
      model: "slow",
      queryClass: "code",
      outcome: "failure",
      feedback: 0.2,
    });
  }
}

describe("learned adaptive routing (#6)", () => {
  beforeEach(() => {
    fs.mkdirSync(tempRoot, { recursive: true });
    process.env.CODESURF_HOME = fs.mkdtempSync(path.join(tempRoot, "home-"));
    const cwd = fs.mkdtempSync(path.join(tempRoot, "cwd-"));
    closeDatabase();
    capturedModelId = "";
    realExtensions.setBashSink(buildMockBashSink({ initialCwd: cwd }).sink);
    realExtensions.getHostServices().settings.set(ROUTING_KEY, false);
    const sessionId = new SessionStore(cwd).createSession("provider-model", "agent", cwd).id;
    // Register the models that appear in the seeded traces so the adaptive router guard accepts them.
    registerPluginModel({
      id: "fast",
      providerId: "test",
      adapterId: "test",
      label: "fast",
      contextWindow: 128000,
      pluginId: "test",
    });
    registerPluginModel({
      id: "slow",
      providerId: "test",
      adapterId: "test",
      label: "slow",
      contextWindow: 128000,
      pluginId: "test",
    });
    seedClassHistory(sessionId);
  });

  afterEach(() => {
    closeDatabase();
    realExtensions.setBashSink(null);
    if (originalCodesurfHome === undefined) delete process.env.CODESURF_HOME;
    else process.env.CODESURF_HOME = originalCodesurfHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("routes a code query to the best-scoring model and announces it (flag on)", async () => {
    realExtensions.getHostServices().settings.set(ROUTING_KEY, true);
    const agent = new Agent(undefined, undefined, "provider-model");
    const chunks: Array<{ type: string; content?: string }> = [];
    for await (const chunk of agent.processMessage("write a function to sort a list")) {
      chunks.push(chunk as { type: string; content?: string });
    }
    expect(capturedModelId).toBe("fast");
    const note = chunks.find((c) => c.type === "content" && (c.content ?? "").includes("routed to fast"));
    expect(note).toBeDefined();
  });

  it("uses the user's selected model when the flag is off", async () => {
    // flag already false from beforeEach
    const agent = new Agent(undefined, undefined, "provider-model");
    const chunks: Array<{ type: string; content?: string }> = [];
    for await (const chunk of agent.processMessage("write a function to sort a list")) {
      chunks.push(chunk as { type: string; content?: string });
    }
    expect(capturedModelId).not.toBe("fast");
    expect(chunks.find((c) => (c.content ?? "").includes("routed to"))).toBeUndefined();
  });
});
