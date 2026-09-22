// Activation-order regression tests for the Phase 2 step 7b Agent rewire
// from a self-owned `BashTool` to `services.bash.*`. Mitigates risk R1 from
// the migration plan: if the bash sink is unbound when the Agent reads
// `services.bash`, the failure must be loud (clear error message), NOT silent
// (`undefined`). Covers both activation orders: correct (extensions
// first → Agent) succeeds; incorrect (Agent before extensions) throws.
//
// Tests use `vi.resetModules()` so each case sees a fresh loader module
// graph. Bash sinks are bound via the freshly-imported `setBashSink` to avoid
// the stale-module-graph trap (top-of-file imports point at a dead loader
// after `resetModules`).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMockBashSink } from "./mock-bash-sink";

async function importAgentModule() {
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
  return import("./agent");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  try {
    const { setBashSink } = await import("../core/plugins");
    setBashSink(null);
  } catch {}
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../storage/index");
});

describe("Agent bash rewire (Phase 2 step 7b) — activation order R1", () => {
  it("succeeds when the bash sink is bound BEFORE the Agent is constructed", async () => {
    // Correct order: bind sink → import Agent → construct.
    const { setBashSink } = await import("../core/plugins");
    const { sink, state } = buildMockBashSink({ initialCwd: "/correct/order/cwd" });
    setBashSink(sink);

    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      sandboxMode: "shuru",
    });

    // The Agent's `getCwd()` reads through `services.bash.cwd()` — should now
    // see the mock sink's value.
    expect(agent.getCwd()).toBe("/correct/order/cwd");
    // Sandbox mode hookup ran in the ctor; the sink's state captures it.
    expect(state.sandboxMode).toBe("shuru");
    expect(agent.getSandboxMode()).toBe("shuru");
  });

  it("throws loudly when the Agent is constructed BEFORE the bash sink is bound", async () => {
    // Wrong order: no sink bound, then construct Agent. The ctor's
    // `services.bash.setSandboxMode(...)` call hits `requireBashSink()` and
    // throws — that's R1's loud-failure contract. The exact message is
    // owned by `loader.ts`'s `BASH_NOT_ACTIVE_MESSAGE`.
    const { setBashSink } = await import("../core/plugins");
    setBashSink(null);

    const { Agent } = await importAgentModule();

    expect(
      () =>
        new Agent(undefined, undefined, undefined, undefined, {
          persistSession: false,
          sandboxMode: "off",
        }),
    ).toThrow(/Bash sink is not active/i);
  });

  it("reads through the currently-bound sink when the sink is replaced after Agent construction", async () => {
    // Bind sink A → construct Agent → swap to sink B → Agent reads B's cwd.
    // Confirms that Agent doesn't cache a sink reference (it goes through
    // `getHostServices().bash.*` on every read).
    const { setBashSink } = await import("../core/plugins");
    const { sink: sinkA } = buildMockBashSink({ initialCwd: "/sink-a/cwd" });
    setBashSink(sinkA);

    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
    });

    expect(agent.getCwd()).toBe("/sink-a/cwd");

    const { sink: sinkB } = buildMockBashSink({ initialCwd: "/sink-b/cwd" });
    setBashSink(sinkB);

    expect(agent.getCwd()).toBe("/sink-b/cwd");
    expect(agent.getSandboxMode()).toBe("off");
  });

  it("Agent.getSandboxSettings() reflects the sink's current settings (not a stale ctor snapshot)", async () => {
    const { setBashSink } = await import("../core/plugins");
    const { sink, state } = buildMockBashSink();
    setBashSink(sink);

    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      sandboxSettings: { allowNet: false },
    });

    // Initial settings flowed through the ctor into the sink.
    expect(state.sandboxSettings).toEqual({ allowNet: false });

    // Mutate sink directly, then read via Agent — confirms Agent reads live.
    sink.setSandboxSettings({ allowNet: true, cpus: 8 });
    expect(agent.getSandboxSettings()).toEqual({ allowNet: true, cpus: 8 });
  });

  it("Agent.setSandboxMode() forwards to the bound sink", async () => {
    // Agent's setter goes through `services.bash.setSandboxMode(...)` —
    // confirms there's no leftover local state shadowing the sink.
    const { setBashSink } = await import("../core/plugins");
    const { sink, state } = buildMockBashSink();
    setBashSink(sink);

    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      sandboxMode: "off",
    });

    expect(state.sandboxMode).toBe("off");
    agent.setSandboxMode("shuru");
    expect(state.sandboxMode).toBe("shuru");
    expect(agent.getSandboxMode()).toBe("shuru");
  });

  it("Agent.setSandboxSettings() forwards to the bound sink", async () => {
    const { setBashSink } = await import("../core/plugins");
    const { sink, state } = buildMockBashSink();
    setBashSink(sink);

    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
    });

    agent.setSandboxSettings({ allowNet: true, memory: 4096 });
    expect(state.sandboxSettings).toEqual({ allowNet: true, memory: 4096 });
  });

  it("Agent ctor only forwards `sandboxSettings` when explicitly provided (R1: ambiguous-undefined)", async () => {
    // Regression: the ctor uses `if (options.sandboxSettings) bashServices.setSandboxSettings(...)`
    // — if a caller omits the option, we must NOT clobber any pre-existing
    // sandbox settings the kernel sink already had (e.g. from a previous
    // Agent in the same process or from extension defaults).
    const { setBashSink } = await import("../core/plugins");
    const { sink, state } = buildMockBashSink();
    sink.setSandboxSettings({ allowNet: true, cpus: 2 });
    setBashSink(sink);

    const { Agent } = await importAgentModule();
    new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      // sandboxSettings deliberately omitted
    });

    expect(state.sandboxSettings).toEqual({ allowNet: true, cpus: 2 });
  });

  it("Agent ctor's sandbox-mode hookup defaults to 'off' when not specified", async () => {
    const { setBashSink } = await import("../core/plugins");
    const { sink, state } = buildMockBashSink();
    // Pre-set to a non-off value so we can detect the default-off override.
    sink.setSandboxMode("shuru");
    setBashSink(sink);

    const { Agent } = await importAgentModule();
    new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      // sandboxMode deliberately omitted -> defaults to "off"
    });

    expect(state.sandboxMode).toBe("off");
  });
});
