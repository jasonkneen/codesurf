// Regression for review finding A3: an MCP connect that completes after the
// session was reset or the Agent was cleaned up must not resurrect its bundle.
//
// `resolveMcpBundle` shares one in-flight connect per session (that sharing is
// deliberate and preserved). What was broken: the connect's `then` published
// its bundle unconditionally and its `finally` cleared the promise slot
// unconditionally, so a late completion could install servers into the
// replacement session (or after teardown), and could erase a newer attempt's
// ownership. Every scenario below drives the provider with deferred promises
// so the interleavings are exact.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpToolBundle } from "../mcp/runtime";
import { buildMockBashSink } from "./mock-bash-sink";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeBundle(id: string) {
  const close = vi.fn(async () => {});
  const bundle = {
    id,
    tools: {},
    serverIds: [id],
    toolCountsByServerId: new Map<string, number>(),
    listResources: async () => [],
    listPrompts: async () => [],
    readResource: async () => null,
    getPrompt: async () => null,
    errors: [],
    close,
  } as unknown as McpToolBundle & { id: string };
  return { bundle, close };
}

/** Let every already-settled promise continuation run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// The bundle now lives on the Agent's `SessionToolsets` (see
// ./session-toolsets.ts). Reaching through it keeps these assertions on the
// real owner rather than on a delegating shim.
type McpInternals = {
  resolveMcpBundle(): Promise<McpToolBundle>;
  mcpBundle: McpToolBundle | null;
  mcpBundlePromise: Promise<McpToolBundle> | null;
};

interface ToolsetsInternals {
  toolsets: {
    resolveBundle(): Promise<McpToolBundle>;
    bundle: McpToolBundle | null;
    bundlePromise: Promise<McpToolBundle> | null;
  };
}

/** Present the extracted owner under the names these tests were written to. */
function mcpInternals(agent: unknown): McpInternals {
  const { toolsets } = agent as ToolsetsInternals;
  return {
    resolveMcpBundle: () => toolsets.resolveBundle(),
    get mcpBundle() {
      return toolsets.bundle;
    },
    get mcpBundlePromise() {
      return toolsets.bundlePromise;
    },
  } as McpInternals;
}

async function importAgentWithMcpProvider() {
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

  // The host facade wraps provider failures into an empty bundle, which would
  // hide the rejection scenario. Replace only `mcp.getToolBundle` with a
  // direct pass-through to a queue of deferreds; every other service is real.
  const attempts: Array<ReturnType<typeof deferred<McpToolBundle>>> = [];
  const getToolBundle = vi.fn(() => {
    const attempt = deferred<McpToolBundle>();
    attempts.push(attempt);
    return attempt.promise;
  });
  vi.doMock("../core/plugins", async () => {
    const actual = await vi.importActual<typeof import("../core/plugins")>("../core/plugins");
    return {
      ...actual,
      getHostServices: () => ({
        ...actual.getHostServices(),
        mcp: { isEnabled: () => true, getToolBundle },
      }),
    };
  });

  const { setBashSink } = await import("../core/plugins");
  setBashSink(buildMockBashSink().sink);

  const { Agent } = await import("./agent");
  const agent = new Agent(undefined, undefined, undefined, undefined, { persistSession: false });
  return { agent, internals: mcpInternals(agent), attempts, getToolBundle };
}

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    const { setBashSink } = await import("../core/plugins");
    setBashSink(null);
  } catch {}
  vi.resetModules();
  vi.doUnmock("../core/plugins");
  vi.doUnmock("../storage/index");
});

describe("MCP bundle lifecycle across reset and cleanup (A3)", () => {
  it("shares one connect between concurrent callers and clears the slot after it settles", async () => {
    const { internals, attempts, getToolBundle } = await importAgentWithMcpProvider();
    const first = internals.resolveMcpBundle();
    const second = internals.resolveMcpBundle();
    expect(getToolBundle).toHaveBeenCalledTimes(1);

    const { bundle } = makeBundle("a");
    attempts[0]!.resolve(bundle);
    await expect(first).resolves.toBe(bundle);
    await expect(second).resolves.toBe(bundle);
    expect(internals.mcpBundle).toBe(bundle);
    expect(internals.mcpBundlePromise).toBeNull();
  });

  it("disposes a connect that completes after a session reset and never publishes it", async () => {
    const { agent, internals, attempts, getToolBundle } = await importAgentWithMcpProvider();
    const oldCaller = internals.resolveMcpBundle();
    expect(getToolBundle).toHaveBeenCalledTimes(1);

    // Session switch / compaction path: drops MCP state while the connect is in flight.
    agent.resetProgressiveContext();
    await settle();

    const stale = makeBundle("stale");
    attempts[0]!.resolve(stale.bundle);
    await settle();

    // The late bundle was closed, not installed. The old caller joined a fresh
    // connect for the new session instead of getting the disposed bundle.
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(internals.mcpBundle).toBeNull();
    expect(getToolBundle).toHaveBeenCalledTimes(2);

    const fresh = makeBundle("fresh");
    attempts[1]!.resolve(fresh.bundle);
    await expect(oldCaller).resolves.toBe(fresh.bundle);
    expect(internals.mcpBundle).toBe(fresh.bundle);
    expect(fresh.close).not.toHaveBeenCalled();
  });

  it("disposes a connect that completes after cleanup and admits no further connect", async () => {
    const { agent, internals, attempts, getToolBundle } = await importAgentWithMcpProvider();
    const oldCaller = internals.resolveMcpBundle();
    // Reject would surface as an unhandled rejection between awaits; attach
    // the expectation before the timeline advances.
    const rejection = expect(oldCaller).rejects.toThrow(/shut down/);

    await agent.cleanup();

    const stale = makeBundle("stale");
    attempts[0]!.resolve(stale.bundle);
    await rejection;

    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(internals.mcpBundle).toBeNull();
    expect(internals.mcpBundlePromise).toBeNull();
    // Shutdown closed admission: no reconnect was started for the old caller,
    // and a new caller is refused outright.
    expect(getToolBundle).toHaveBeenCalledTimes(1);
    await expect(internals.resolveMcpBundle()).rejects.toThrow(/shut down/);
    expect(getToolBundle).toHaveBeenCalledTimes(1);
  });

  it("keeps the new connect's ownership when the old one completes afterwards", async () => {
    const { agent, internals, attempts, getToolBundle } = await importAgentWithMcpProvider();
    const oldCaller = internals.resolveMcpBundle();
    agent.resetProgressiveContext();
    await settle();

    const newCaller = internals.resolveMcpBundle();
    expect(getToolBundle).toHaveBeenCalledTimes(2);
    const newAttemptPromise = internals.mcpBundlePromise;
    expect(newAttemptPromise).not.toBeNull();

    // Old connect lands late: closed, and its finally must NOT clear the slot
    // the new attempt owns.
    const stale = makeBundle("stale");
    attempts[0]!.resolve(stale.bundle);
    await settle();
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(internals.mcpBundle).toBeNull();
    expect(internals.mcpBundlePromise).toBe(newAttemptPromise);

    // A third caller shares the new attempt rather than starting another.
    const thirdCaller = internals.resolveMcpBundle();
    expect(getToolBundle).toHaveBeenCalledTimes(2);

    const fresh = makeBundle("fresh");
    attempts[1]!.resolve(fresh.bundle);
    await expect(newCaller).resolves.toBe(fresh.bundle);
    await expect(oldCaller).resolves.toBe(fresh.bundle);
    await expect(thirdCaller).resolves.toBe(fresh.bundle);
    expect(internals.mcpBundle).toBe(fresh.bundle);
    expect(internals.mcpBundlePromise).toBeNull();
  });

  it("an old connect's rejection does not disturb the replacement attempt", async () => {
    const { agent, internals, attempts, getToolBundle } = await importAgentWithMcpProvider();
    const oldCaller = internals.resolveMcpBundle();
    const oldRejection = expect(oldCaller).rejects.toThrow("server exploded");
    agent.resetProgressiveContext();
    await settle();

    const newCaller = internals.resolveMcpBundle();
    const newAttemptPromise = internals.mcpBundlePromise;
    expect(getToolBundle).toHaveBeenCalledTimes(2);

    attempts[0]!.reject(new Error("server exploded"));
    await oldRejection;
    expect(internals.mcpBundlePromise).toBe(newAttemptPromise);

    const thirdCaller = internals.resolveMcpBundle();
    expect(getToolBundle).toHaveBeenCalledTimes(2);

    const fresh = makeBundle("fresh");
    attempts[1]!.resolve(fresh.bundle);
    await expect(newCaller).resolves.toBe(fresh.bundle);
    await expect(thirdCaller).resolves.toBe(fresh.bundle);
    expect(internals.mcpBundle).toBe(fresh.bundle);
    expect(internals.mcpBundlePromise).toBeNull();
  });
});
