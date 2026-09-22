import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMockBashSink } from "./mock-bash-sink";

async function importAgentModule() {
  vi.resetModules();
  vi.doMock("../storage/index", () => ({
    appendCompaction: vi.fn(),
    appendMessages: vi.fn(() => []),
    buildChatEntries: vi.fn(() => []),
    getNextMessageSequence: vi.fn(() => 0),
    getSessionTotalTokens: vi.fn(() => 0),
    loadTranscript: vi.fn(() => []),
    loadTranscriptState: vi.fn(() => ({ messages: [], seqs: [] })),
    recordUsageEvent: vi.fn(),
    SessionStore: class {
      getWorkspace() {
        return null;
      }
      openSession() {
        return null;
      }
      createSession() {
        return null;
      }
      setModel() {}
      getRequiredSession() {
        return null;
      }
      setMode() {}
      touchSession() {}
    },
  }));

  // Bind a mock bash sink AFTER `vi.resetModules()` so we hit the freshly
  // re-imported loader's module-level `bashSink` slot (the top-of-file
  // `setBashSink` import points at a stale module graph after reset).
  const { setBashSink } = await import("../core/plugins");
  const { sink } = buildMockBashSink();
  setBashSink(sink);

  return import("./agent");
}

afterEach(async () => {
  vi.restoreAllMocks();
  // Clear the bash sink we bound in importAgentModule so the next test
  // starts from a clean state.
  try {
    const { setBashSink } = await import("../core/plugins");
    setBashSink(null);
  } catch {}
  vi.resetModules();
  vi.doUnmock("../storage/index");
});

describe("Agent sandbox mode", () => {
  it("can switch sandbox mode at runtime", async () => {
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      sandboxMode: "off",
    });

    expect(agent.getSandboxMode()).toBe("off");

    agent.setSandboxMode("shuru");

    expect(agent.getSandboxMode()).toBe("shuru");
  });

  it("passes sandbox mode into background delegations", async () => {
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      sandboxMode: "shuru",
    });
    const startMock = vi.fn(async () => ({ success: true, output: "ok" }));
    (agent as unknown as { delegations: { start: typeof startMock } }).delegations.start = startMock;

    // Delegation moved to `SessionDelegations`; reach it on its owner rather
    // than through a shim on the Agent.
    await (
      agent as unknown as { sessionDelegations: { runDelegation: (request: unknown) => Promise<unknown> } }
    ).sessionDelegations.runDelegation({
      agent: "explore",
      description: "Inspect",
      prompt: "Look around",
    });

    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "explore" }),
      expect.objectContaining({ sandboxMode: "shuru" }),
    );
  });

  it("can get and set sandbox settings", async () => {
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      sandboxMode: "shuru",
      sandboxSettings: { allowNet: true, cpus: 4 },
    });

    expect(agent.getSandboxSettings()).toEqual({ allowNet: true, cpus: 4 });

    agent.setSandboxSettings({ allowNet: false, memory: 2048 });
    expect(agent.getSandboxSettings()).toEqual({ allowNet: false, memory: 2048 });
  });

  it("passes sandbox settings into background delegations", async () => {
    const { Agent } = await importAgentModule();
    const settings = { allowNet: true, allowedHosts: ["api.openai.com"] };
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      sandboxMode: "shuru",
      sandboxSettings: settings,
    });
    const startMock = vi.fn(async () => ({ success: true, output: "ok" }));
    (agent as unknown as { delegations: { start: typeof startMock } }).delegations.start = startMock;

    // Delegation moved to `SessionDelegations`; reach it on its owner rather
    // than through a shim on the Agent.
    await (
      agent as unknown as { sessionDelegations: { runDelegation: (request: unknown) => Promise<unknown> } }
    ).sessionDelegations.runDelegation({
      agent: "explore",
      description: "Inspect",
      prompt: "Look around",
    });

    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "explore" }),
      expect.objectContaining({ sandboxSettings: settings }),
    );
  });

  it("gives schedules the session's live sandbox, not the process default", async () => {
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      sandboxMode: "off",
    });
    agent.setSandboxMode("shuru");
    agent.setSandboxSettings({ allowNet: false, allowedHosts: ["example.com"] });

    const schedules = (agent as unknown as { schedules: { getSandbox: () => unknown } }).schedules;

    expect(schedules.getSandbox()).toEqual({
      mode: "shuru",
      settings: { allowNet: false, allowedHosts: ["example.com"] },
    });
  });
});
