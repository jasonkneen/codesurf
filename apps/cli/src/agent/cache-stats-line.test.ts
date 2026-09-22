// `Agent.getCacheStatsLine` — the per-turn cache/context line the UI renders.
//
// The formatting itself is covered in utils/skill-context.test.ts. What is
// covered HERE is the Agent-level contract that the formatter cannot see:
//   - null when the provider reported no usage (so the UI can skip the row),
//   - the skills segment is sourced from `lastContextStats`, which is only
//     populated once a turn has actually resolved a skills section,
//   - `resetProgressiveContext()` really does clear it.
//
// A regression in any of those shows up as a stats line that lies about cache
// behaviour, which is the one thing this line exists to be trusted about.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DiscoveredSkill } from "../utils/skills";
import { buildMockBashSink } from "./mock-bash-sink";

const skill = (name: string, description: string): DiscoveredSkill => ({
  name,
  description,
  skillMdPath: `/skills/${name}/SKILL.md`,
  rootDir: `/skills/${name}`,
  scope: "user",
});

const CATALOG = [
  skill("pixijs", "PixiJS v8 rendering, sprites, and the scene graph"),
  skill("blender-modeling", "Model meshes and topology in Blender"),
  skill("telegram", "Send and receive Telegram messages"),
];

/** Agent instance with the private members this suite drives, minus the casts. */
type AgentInternals = {
  promptContext: { skillsSection(cwd: string, userMessage: string): string | null };
};

/**
 * Imported ONCE for the suite. The mocks below are identical for every test, so
 * the only thing a test actually needs fresh is an Agent *instance* — and that
 * is cheap. Resetting modules per test instead re-imports the whole agent graph
 * eight times, which blows the 5s default timeout on a loaded machine. See the
 * `fileParallelism: false` note in vitest.config.ts for the same failure mode.
 */
let AgentCtor: typeof import("./agent").Agent;

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

  // Skill discovery walks the real filesystem and enablement reads the user's
  // settings file. Pin both so the disclosed/indexed counts are deterministic
  // instead of "whatever this machine has installed".
  vi.doMock("../utils/skills", async () => {
    const actual = await vi.importActual<typeof import("../utils/skills")>("../utils/skills");
    return { ...actual, discoverSkills: () => CATALOG };
  });
  vi.doMock("../core/persistence/skills-enablement", async () => {
    const actual = await vi.importActual<typeof import("../core/persistence/skills-enablement")>(
      "../core/persistence/skills-enablement",
    );
    return { ...actual, filterEnabledSkills: (skills: DiscoveredSkill[]) => skills };
  });

  // Bind a mock bash sink AFTER `vi.resetModules()` so we hit the freshly
  // re-imported loader's module-level `bashSink` slot.
  const { setBashSink } = await import("../core/plugins");
  setBashSink(buildMockBashSink().sink);

  return import("./agent");
}

beforeAll(async () => {
  ({ Agent: AgentCtor } = await importAgentModule());
});

afterAll(async () => {
  vi.restoreAllMocks();
  try {
    const { setBashSink } = await import("../core/plugins");
    setBashSink(null);
  } catch {}
  vi.resetModules();
  vi.doUnmock("../storage/index");
  vi.doUnmock("../utils/skills");
  vi.doUnmock("../core/persistence/skills-enablement");
});

/**
 * Fresh instance per test. Progressive-skill disclosure state lives on the
 * instance (`this.skillContext` / `this.lastContextStats`), so a new Agent is
 * sufficient isolation — no module reset required.
 */
function newAgent() {
  return new AgentCtor(undefined, undefined, undefined, undefined, { persistSession: false });
}

describe("Agent.getCacheStatsLine", () => {
  it("returns null when the provider reported no usage", async () => {
    const agent = await newAgent();
    // The UI uses null as "render nothing" — not an empty row.
    expect(agent.getCacheStatsLine()).toBeNull();
    expect(agent.getCacheStatsLine(undefined)).toBeNull();
  });

  it("renders read/written counts for a normal usage object", async () => {
    const agent = await newAgent();
    const line = agent.getCacheStatsLine({
      cacheReadTokens: 48102,
      cacheWriteTokens: 1204,
      inputTokens: 52000,
    });
    expect(line).toBe("cache: 48,102 read · 1,204 written · 52,000 in");
  });

  it("omits the skills segment until a turn has resolved a skills section", async () => {
    const agent = await newAgent();
    // Fresh agent: no turn has run, so there are no skill stats to report.
    const line = agent.getCacheStatsLine({ cacheReadTokens: 10, cacheWriteTokens: 20 });
    expect(line).toBe("cache: 10 read · 20 written");
    expect(line).not.toContain("skills");
  });

  it("reports a cold first turn as 0 read rather than hiding it", async () => {
    const agent = await newAgent();
    // A cold cache is exactly the case the line must stay visible for: 0 read /
    // large written is the signal the prefix missed.
    expect(agent.getCacheStatsLine({ cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0 })).toBe(
      "cache: 0 read · 0 written · 0 in",
    );
    expect(agent.getCacheStatsLine({ cacheReadTokens: 0, cacheWriteTokens: 12345 })).toBe(
      "cache: 0 read · 12,345 written",
    );
  });

  it("treats missing individual counters as 0 instead of dropping the line", async () => {
    const agent = await newAgent();
    // Providers that report usage but no cache fields (codex, some gateways)
    // still get a line — `inputTokens` is the only optional-and-omitted part.
    expect(agent.getCacheStatsLine({})).toBe("cache: 0 read · 0 written");
    expect(agent.getCacheStatsLine({ inputTokens: 900 })).toBe("cache: 0 read · 0 written · 900 in");
  });

  it("carries the skills segment once a turn has disclosed skills", async () => {
    const agent = await newAgent();
    // This is the real wiring: the prompt context is what populates the
    // stats the line reads. Without it the segment must not appear.
    (agent as unknown as AgentInternals).promptContext.skillsSection("/mock/cwd", "fix the pixijs sprites");

    const line = agent.getCacheStatsLine({ cacheReadTokens: 1000, cacheWriteTokens: 200 });
    expect(line).toContain("cache: 1,000 read · 200 written");
    expect(line).toContain("skills 1 full / 2 indexed");
    // The attribution clause is what makes a cache miss diagnosable.
    expect(line).toContain("(+1: pixijs)");
  });

  it("drops the added-skills clause on a turn that appended nothing", async () => {
    const agent = await newAgent();
    const internals = agent as unknown as AgentInternals;
    internals.promptContext.skillsSection("/mock/cwd", "fix the pixijs sprites");
    // Second turn re-asks for the same skill: nothing appended => cache hit.
    internals.promptContext.skillsSection("/mock/cwd", "more pixijs sprites work");

    const line = agent.getCacheStatsLine({ cacheReadTokens: 1000, cacheWriteTokens: 0 }) ?? "";
    expect(line).toContain("skills 1 full / 2 indexed");
    expect(line).not.toContain("(+");
  });

  it("clears the skills segment after resetProgressiveContext", async () => {
    const agent = await newAgent();
    (agent as unknown as AgentInternals).promptContext.skillsSection("/mock/cwd", "fix the pixijs sprites");
    expect(agent.getCacheStatsLine({ cacheReadTokens: 1 })).toContain("skills");

    // Session switch / compaction: the cache generation is gone, so the stats
    // that described it must not survive into the next one.
    agent.resetProgressiveContext();
    expect(agent.getCacheStatsLine({ cacheReadTokens: 1 })).toBe("cache: 1 read · 0 written");
  });
});
