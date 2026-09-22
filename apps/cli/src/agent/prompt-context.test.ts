// The session-stability invariant of the prompt context.
//
// Every one of these snapshots exists to keep the provider's cached prefix
// valid: re-reading any of them mid-session changes bytes the model was already
// sent. The tests assert the freeze holds even when the file on disk changes,
// and that `reset()` — and only `reset()` — lets the new content through.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loaders = vi.hoisted(() => ({
  loadCustomInstructions: vi.fn<(cwd: string) => string | null>(),
  loadValidSubAgents: vi.fn<() => Array<{ name: string }>>(),
  loadLearningPromptNotes: vi.fn<() => string | null>(),
  loadSkillOverlays: vi.fn(() => new Map()),
  discoverSkills: vi.fn<() => unknown[]>(),
  filterEnabledSkills: vi.fn((skills: unknown[]) => skills),
  selectSkillsForPrompt: vi.fn(() => ({ full: [], indexed: [] })),
  formatSkillsTiered: vi.fn(() => "SUBAGENT SKILLS"),
}));

vi.mock("../utils/instructions", () => ({ loadCustomInstructions: loaders.loadCustomInstructions }));
vi.mock("../utils/settings", () => ({ loadValidSubAgents: loaders.loadValidSubAgents }));
vi.mock("./learning/self-learning", () => ({ loadLearningPromptNotes: loaders.loadLearningPromptNotes }));
vi.mock("./learning/skill-overlay", () => ({ loadSkillOverlays: loaders.loadSkillOverlays }));
vi.mock("../core/persistence/skills-enablement", () => ({ filterEnabledSkills: loaders.filterEnabledSkills }));
vi.mock("../utils/skills", () => ({
  discoverSkills: loaders.discoverSkills,
  selectSkillsForPrompt: loaders.selectSkillsForPrompt,
  formatSkillsTiered: loaders.formatSkillsTiered,
}));
vi.mock("../utils/skill-context", () => ({
  ProgressiveSkillContext: class {
    update = vi.fn();
    stats = vi.fn(() => ({ full: 1, indexed: 2, newlyDisclosed: [] }));
    render = vi.fn(() => "SKILLS SECTION");
    reset = vi.fn();
  },
}));

const { SessionPromptContext } = await import("./prompt-context");

beforeEach(() => {
  loaders.loadCustomInstructions.mockReturnValue("AGENTS v1");
  loaders.loadValidSubAgents.mockReturnValue([{ name: "reviewer" }]);
  loaders.loadLearningPromptNotes.mockReturnValue("notes v1");
  loaders.discoverSkills.mockReturnValue([{ name: "skill-a" }]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SessionPromptContext — session stability", () => {
  it("reads each snapshot from disk exactly once, however often it is asked", () => {
    const context = new SessionPromptContext();

    for (let i = 0; i < 3; i += 1) {
      context.instructions("/repo");
      context.roster();
      context.notes();
    }

    expect(loaders.loadCustomInstructions).toHaveBeenCalledTimes(1);
    expect(loaders.loadValidSubAgents).toHaveBeenCalledTimes(1);
    expect(loaders.loadLearningPromptNotes).toHaveBeenCalledTimes(1);
  });

  it("keeps returning the first value after the file on disk changes", () => {
    const context = new SessionPromptContext();
    expect(context.instructions("/repo")).toBe("AGENTS v1");
    expect(context.notes()).toBe("notes v1");

    // The user edits AGENTS.md and the optimizer rewrites the notes mid-session.
    loaders.loadCustomInstructions.mockReturnValue("AGENTS v2");
    loaders.loadLearningPromptNotes.mockReturnValue("notes v2");

    // Serving v2 now would invalidate the cached prefix the model already has.
    expect(context.instructions("/repo")).toBe("AGENTS v1");
    expect(context.notes()).toBe("notes v1");
  });

  it("caches a null result too, rather than re-reading a missing file every turn", () => {
    loaders.loadCustomInstructions.mockReturnValue(null);
    loaders.loadLearningPromptNotes.mockReturnValue(null);
    const context = new SessionPromptContext();

    expect(context.instructions("/repo")).toBeNull();
    expect(context.instructions("/repo")).toBeNull();
    expect(context.notes()).toBeNull();
    expect(context.notes()).toBeNull();

    expect(loaders.loadCustomInstructions).toHaveBeenCalledTimes(1);
    expect(loaders.loadLearningPromptNotes).toHaveBeenCalledTimes(1);
  });

  it("reset() starts a new cache generation and picks the new content up", () => {
    const context = new SessionPromptContext();
    context.instructions("/repo");
    context.roster();
    context.notes();

    loaders.loadCustomInstructions.mockReturnValue("AGENTS v2");
    loaders.loadLearningPromptNotes.mockReturnValue("notes v2");
    loaders.loadValidSubAgents.mockReturnValue([{ name: "researcher" }]);

    context.reset();

    expect(context.instructions("/repo")).toBe("AGENTS v2");
    expect(context.notes()).toBe("notes v2");
    expect(context.roster()).toEqual([{ name: "researcher" }]);
    expect(loaders.loadCustomInstructions).toHaveBeenCalledTimes(2);
  });

  it("loads skill overlays once and shares them between main and sub-agent sections", () => {
    const context = new SessionPromptContext();
    context.skillsSection("/repo", "do the thing");
    context.subagentSkillsSection("/repo", "review this");
    context.skillsSection("/repo", "another turn");

    expect(loaders.loadSkillOverlays).toHaveBeenCalledTimes(1);
  });
});

describe("SessionPromptContext — sections", () => {
  it("renders the progressive section and records its stats for the cache line", () => {
    const context = new SessionPromptContext();
    expect(context.skillsSection("/repo", "hello")).toBe("SKILLS SECTION");
    expect(context.stats()?.skills).toEqual({ full: 1, indexed: 2, newlyDisclosed: [] });
  });

  it("renders a sub-agent section without disturbing the main loop's stats", () => {
    const context = new SessionPromptContext();
    context.skillsSection("/repo", "hello");
    const before = context.stats();

    expect(context.subagentSkillsSection("/repo", "review")).toBe("SUBAGENT SKILLS");
    // The sub-agent is a separate cache generation; its selection must not be
    // reported as what the main loop disclosed.
    expect(context.stats()).toBe(before);
  });

  it("returns no section when there are no skills, and never throws on a bad catalog", () => {
    const context = new SessionPromptContext();

    loaders.discoverSkills.mockReturnValue([]);
    expect(context.skillsSection("/repo", "hello")).toBeNull();
    expect(context.subagentSkillsSection("/repo", "hello")).toBeNull();

    loaders.discoverSkills.mockImplementation(() => {
      throw new Error("unreadable skills directory");
    });
    // Skills are an optimization: a broken catalog must not fail the turn.
    expect(context.skillsSection("/repo", "hello")).toBeNull();
    expect(context.subagentSkillsSection("/repo", "hello")).toBeNull();
  });
});
