// Parity acceptance for the converted `/routing` command.
//
// The V1 builtin printed its report straight into the transcript, so the test
// surface is the exact text of every branch: no data, data with routing off,
// data with routing on, a single-class filter, and the below-threshold gate.
// The trace store is mocked so the numbers are deterministic; everything else
// (fiber lifecycle, contribution registry, settings resolution) is the real
// runtime, mounted on a root with fake `HostBindings`.

import { type Context, createCodesurfRoot, type HostBindings, mountPlugin } from "@codesurf/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClass } from "../../../agent/routing/classify";
import type { StoredTrace, TraceFilter, TraceOutcome } from "../../../storage/traces";

const { listTracesMock } = vi.hoisted(() => ({ listTracesMock: vi.fn() }));
vi.mock("../../../storage/traces", () => ({ listTraces: listTracesMock }));

import { routingCommandPlugin } from "./routing-command";

const ENV_VAR = "LEARNING_ADAPTIVEMODELROUTING";

function trace(model: string, outcome: TraceOutcome | null, feedback: number | null = null): StoredTrace {
  return {
    traceId: `trace-${model}-${outcome}`,
    sessionId: "session",
    messageSeq: null,
    query: "q",
    agentMode: null,
    model,
    queryClass: null,
    result: null,
    outcome,
    feedback,
    startedAt: new Date(0),
    endedAt: null,
    totalTokens: 0,
    totalLatencyMs: 0,
    stepCount: 0,
  };
}

/** Point the mocked trace store at a per-class table. */
function setTraces(table: Partial<Record<QueryClass, StoredTrace[]>>): void {
  listTracesMock.mockImplementation((filter: TraceFilter = {}) => table[filter.queryClass as QueryClass] ?? []);
}

function bootRoutingRoot(overrides: Partial<HostBindings> = {}): { root: Context; appended: string[] } {
  const appended: string[] = [];
  const root = createCodesurfRoot({
    appendAssistant: (text) => appended.push(text),
    ...overrides,
  });
  return { root, appended };
}

async function mountAndInvoke(root: Context, args: string): Promise<ReturnType<typeof mountPlugin>> {
  const fiber = mountPlugin(root, routingCommandPlugin);
  await fiber;
  const command = root.contributions.listCommands()[0];
  if (!command) throw new Error("/routing was not registered");
  await command.handler({ args });
  return fiber;
}

const NO_DATA =
  "No routing data yet. Models, scores and outcomes are recorded for every turn; rate turns with /feedback to enrich the scores. Check back after a few turns.";
const BANNER_OFF = "Adaptive model routing is OFF - data below is collected but not acted on. Enable in /flags.";
const BANNER_ON = "Adaptive model routing is ON - each turn is routed to the best-scoring model below.";
const LEGEND =
  "score = 0.6*outcome + 0.4*feedback (feedback from /feedback, defaults to 0.5 when unrated). * = current leader.";

// Five successful turns on "alpha" (composite 0.6*1 + 0.4*0.5 = 0.8) clear the
// five-sample gate; two failures on "beta" (0.4*0.5 = 0.2) do not.
const CODE_TRACES: StoredTrace[] = [
  ...Array.from({ length: 5 }, () => trace("alpha", "success")),
  ...Array.from({ length: 2 }, () => trace("beta", "failure")),
];

const CODE_BLOCK = [
  "code: best model -> alpha",
  "  * alpha - score 0.800 over 5 turn(s)",
  "    beta - score 0.200 over 2 turn(s) (below 5-sample threshold - not yet eligible)",
].join("\n");

const EMPTY_BLOCKS = [
  "math: no turns recorded yet",
  "short: no turns recorded yet",
  "long: no turns recorded yet",
  "general: no turns recorded yet",
];

describe("native /routing command", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_VAR];
    delete process.env[ENV_VAR];
    listTracesMock.mockReset();
    setTraces({});
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = savedEnv;
  });

  it("keeps the V1 command and manifest identity", async () => {
    const { root } = bootRoutingRoot();
    const fiber = mountPlugin(root, routingCommandPlugin);
    await fiber;

    const command = root.contributions.listCommands()[0];
    expect(root.contributions.listCommands()).toHaveLength(1);
    expect(command?.name).toBe("/routing");
    expect(command?.description).toBe("Show tracked models and learned routing scores per query class.");
    expect(command?.argsHint).toBe("[code|math|short|long|general]");
    expect(command?.aliases).toBeUndefined();

    expect(routingCommandPlugin.manifest.id).toBe("builtin.commands.routing");
    expect(routingCommandPlugin.manifest.name).toBe("Routing Inspector");
    expect(routingCommandPlugin.manifest.version).toBe("1.0.0");
    expect(routingCommandPlugin.manifest.description).toBe(
      "Slash command `/routing` that shows tracked models, scores and routing standings.",
    );
    expect(routingCommandPlugin.manifest.enabledByDefault).toBe(true);
    expect(routingCommandPlugin.manifest.protected).toBe(false);
    expect(routingCommandPlugin.manifest.hidden).toBeUndefined();
    expect(routingCommandPlugin.manifest.group).toBeUndefined();
    expect(routingCommandPlugin.manifest.capabilities).toEqual(["commands"]);

    await fiber.dispose();
  });

  it("disposing the fiber removes the command from the root", async () => {
    const { root } = bootRoutingRoot();
    const fiber = mountPlugin(root, routingCommandPlugin);
    await fiber;
    expect(root.contributions.listCommands().map((c) => c.name)).toEqual(["/routing"]);

    await fiber.dispose();
    expect(root.contributions.listCommands()).toEqual([]);
  });

  it("reports no data when the trace store is empty", async () => {
    const { root, appended } = bootRoutingRoot();
    const fiber = await mountAndInvoke(root, "");

    expect(appended).toEqual([NO_DATA]);
    // Every class is polled with the V1 filter shape.
    expect(listTracesMock).toHaveBeenCalledWith({ queryClass: "code", limit: 500 });
    expect(listTracesMock.mock.calls.map((call) => (call[0] as TraceFilter).queryClass)).toEqual([
      "code",
      "math",
      "short",
      "long",
      "general",
    ]);
    await fiber.dispose();
  });

  it("treats cancelled turns as no data", async () => {
    setTraces({ code: [trace("alpha", "cancelled"), trace("alpha", "cancelled")] });
    const { root, appended } = bootRoutingRoot();
    const fiber = await mountAndInvoke(root, "");

    expect(appended).toEqual([NO_DATA]);
    await fiber.dispose();
  });

  it("prints the OFF banner, per-class standings and the legend", async () => {
    setTraces({ code: CODE_TRACES });
    const { root, appended } = bootRoutingRoot();
    const fiber = await mountAndInvoke(root, "");

    expect(appended).toEqual([[BANNER_OFF, CODE_BLOCK, ...EMPTY_BLOCKS, LEGEND].join("\n\n")]);
    await fiber.dispose();
  });

  it("prints the ON banner when the routing flag is set in settings", async () => {
    setTraces({ code: CODE_TRACES });
    const readKeys: string[] = [];
    const { root, appended } = bootRoutingRoot({
      getSetting: <T>(key: string): T | undefined => {
        readKeys.push(key);
        return true as T;
      },
    });
    const fiber = await mountAndInvoke(root, "");

    expect(readKeys).toContain("featureFlags.learning.adaptiveModelRouting");
    expect(appended[0]?.startsWith(BANNER_ON)).toBe(true);
    await fiber.dispose();
  });

  it("falls back to the env var, then to the off-by-default flag", async () => {
    process.env[ENV_VAR] = "1";
    setTraces({ code: CODE_TRACES });
    const first = bootRoutingRoot();
    const firstFiber = await mountAndInvoke(first.root, "");
    expect(first.appended[0]?.startsWith(BANNER_ON)).toBe(true);
    await firstFiber.dispose();

    process.env[ENV_VAR] = "off";
    const second = bootRoutingRoot();
    const secondFiber = await mountAndInvoke(second.root, "");
    expect(second.appended[0]?.startsWith(BANNER_OFF)).toBe(true);
    await secondFiber.dispose();
  });

  it("filters to a single query class, case-insensitively", async () => {
    setTraces({ code: CODE_TRACES });
    const { root, appended } = bootRoutingRoot();
    const fiber = await mountAndInvoke(root, "  CODE  ");

    expect(appended).toEqual([[BANNER_OFF, CODE_BLOCK, LEGEND].join("\n\n")]);
    await fiber.dispose();
  });

  it("shows every class when the argument is not a known query class", async () => {
    setTraces({ code: CODE_TRACES });
    const { root, appended } = bootRoutingRoot();
    const fiber = await mountAndInvoke(root, "bogus");

    expect(appended).toEqual([[BANNER_OFF, CODE_BLOCK, ...EMPTY_BLOCKS, LEGEND].join("\n\n")]);
    await fiber.dispose();
  });

  // The plugin hardcodes the routing flag's settings key, env var and default
  // rather than importing `src/ui/feature-flags` (that module imports the
  // extension loader barrel). This is the guard against the two drifting: the
  // test may import the host module even though the plugin may not.
  it("stays paired with the /flags descriptor it mirrors", async () => {
    const { envVarFor, getFlagDescriptor, settingsKeyFor } = await import("../../../ui/feature-flags");
    const descriptor = getFlagDescriptor("learning.adaptiveModelRouting");
    if (!descriptor) throw new Error("learning.adaptiveModelRouting descriptor is gone from FEATURE_FLAGS");

    expect(settingsKeyFor(descriptor)).toBe("featureFlags.learning.adaptiveModelRouting");
    expect(envVarFor(descriptor)).toBe(ENV_VAR);
    expect(descriptor.default).toBe(false);
    // Generous: this import pulls the host's UI/loader module graph, which the
    // plugin itself deliberately does not.
  }, 30_000);

  it("says no model qualifies while every model is below the sample gate", async () => {
    setTraces({ math: [trace("alpha", "success"), trace("beta", "success", 1)] });
    const { root, appended } = bootRoutingRoot();
    const fiber = await mountAndInvoke(root, "math");

    expect(appended[0]).toBe(
      [
        BANNER_OFF,
        [
          "math: no model qualifies yet (needs 5+ turns on one model)",
          "    beta - score 1.000 over 1 turn(s) (below 5-sample threshold - not yet eligible)",
          "    alpha - score 0.800 over 1 turn(s) (below 5-sample threshold - not yet eligible)",
        ].join("\n"),
        LEGEND,
      ].join("\n\n"),
    );
    await fiber.dispose();
  });
});
