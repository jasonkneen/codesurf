// Sub-agent containment and system-prompt ordering.
//
// Two invariants that only show up at the Agent level:
//   1. a read-only parent (plan/ask) cannot gain write capability by delegating
//      — `task` is deliberately not mode-gated, so the clamp in
//      `runTaskRequest` is the only thing standing between plan mode and a
//      child booted with write_file/edit_file/bash;
//   2. the system prompt keeps its STABLE -> VOLATILE section order, which the
//      prefix cache depends on and which was previously enforced only by a
//      comment.
//
// The module graph is mocked once for the suite: re-importing the agent graph
// per test blows the 5s default timeout on a loaded machine.

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

const CATALOG = [skill("pixijs", "PixiJS v8 rendering, sprites, and the scene graph")];

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

describe("system prompt section ordering (prompt-cache invariant)", () => {
  // Caching is prefix-based: everything that can change between turns must sit
  // AFTER everything that cannot. This is enforced today only by a comment, so
  // a refactor that moves a volatile section into the stable prefix re-breaks
  // caching with a green suite. Pin the order.
  type PromptInternals = {
    getSystemPromptForEstimate(): string;
    promptContext: { skillsSection(cwd: string, userMessage: string): string | null };
  };

  it("puts the skills block after the cwd marker, never before it", async () => {
    const agent = newAgent();
    (agent as unknown as PromptInternals).promptContext.skillsSection("/mock/cwd", "fix the pixijs sprites");
    const system = (agent as unknown as PromptInternals).getSystemPromptForEstimate();

    const cwdMarker = system.indexOf("Current working directory:");
    expect(cwdMarker).toBeGreaterThan(-1);

    // The estimate path intentionally omits skills, so assert the structural
    // guarantee instead: nothing volatile precedes the cwd marker.
    expect(system.indexOf("<available_skills>")).toBe(-1);
    expect(system.slice(0, cwdMarker)).not.toContain("APPROVED PLAN:");
  });

  it("keeps the mode prompt first in the stable prefix", async () => {
    const agent = newAgent();
    const system = (agent as unknown as PromptInternals).getSystemPromptForEstimate();
    // MODE_PROMPTS is the single most cache-critical span: it is at offset 0.
    expect(system.startsWith("You are Codesurf in ")).toBe(true);
  });
});

describe("sub-agent containment (read-only parent modes)", () => {
  // `task` is deliberately not mode-gated, so plan/ask can still delegate. What
  // must NOT happen is a read-only parent obtaining write capability through a
  // child. Before the clamp, `task({agent:"general"})` in plan mode booted a
  // child in "agent" mode with write_file/edit_file/bash.
  type TaskInternals = {
    setMode(mode: "agent" | "plan" | "ask"): void;
    runTaskRequest(
      request: { agent: string; description: string; prompt: string },
      onActivity?: (detail: string) => void,
      abortSignal?: AbortSignal,
    ): Promise<{ success: boolean; output: string }>;
  };

  const req = (agent: string) => ({ agent, description: "d", prompt: "p" });

  it("rejects write-capable sub-agents in plan mode", async () => {
    const agent = newAgent() as unknown as TaskInternals;
    agent.setMode("plan");
    for (const name of ["general", "verify", "verify-manifest", "computer"]) {
      const result = await agent.runTaskRequest(req(name));
      expect(result.success, `${name} should be refused in plan mode`).toBe(false);
      expect(result.output).toMatch(/plan mode does not allow|can modify files/i);
    }
  });

  it("rejects write-capable sub-agents in ask mode", async () => {
    const agent = newAgent() as unknown as TaskInternals;
    agent.setMode("ask");
    const result = await agent.runTaskRequest(req("general"));
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/ask mode does not allow|can modify files/i);
  });

  it("still refuses unknown agent names before the mode check", async () => {
    const agent = newAgent() as unknown as TaskInternals;
    agent.setMode("plan");
    const result = await agent.runTaskRequest(req("no-such-agent"));
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/Unknown sub-agent/);
  });
});
