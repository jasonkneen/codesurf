// Session-stable prompt context.
//
// Extracted from `Agent`, which had accumulated five separate snapshot fields
// and their lazy resolvers alongside everything else it owns. They are one
// responsibility: the parts of the system prompt that must stay byte-identical
// for the whole session so the provider's prefix cache keeps hitting.
//
// The invariant is why this is a unit and not five fields. Skills, overlays,
// AGENTS.md, the sub-agent roster and learning notes are all read from disk,
// and all of them are rewritten while a session runs (skill-optimizer rewrites
// overlays at the end of a turn; the user edits AGENTS.md). Re-reading any of
// them mid-session changes bytes the model was already sent, silently
// invalidating the cached prefix. Each is therefore read once and frozen until
// `reset()` starts a new cache generation.

import { filterEnabledSkills } from "../core/persistence/skills-enablement";
import { loadCustomInstructions } from "../utils/instructions";
import { type CustomSubagentConfig, loadValidSubAgents } from "../utils/settings";
import { ProgressiveSkillContext, type SkillContextStats } from "../utils/skill-context";
import { discoverSkills, formatSkillsTiered, selectSkillsForPrompt } from "../utils/skills";
import { loadLearningPromptNotes } from "./learning/self-learning";
import { loadSkillOverlays, type SkillOverlayRef } from "./learning/skill-overlay";

/** How many skills were disclosed this turn, for the cache stats line. */
export interface PromptContextStats {
  skills: SkillContextStats;
}

export class SessionPromptContext {
  /** Progressive disclosure state: which skills have been shown this session. */
  private readonly skillContext = new ProgressiveSkillContext();
  private skillOverlays: ReturnType<typeof loadSkillOverlays> | undefined;
  private customInstructions: string | null | undefined;
  private subagentRoster: CustomSubagentConfig[] | undefined;
  private learningNotes: string | null | undefined;
  private lastStats: PromptContextStats | null = null;

  /**
   * The skills section for a main-loop turn.
   *
   * Progressive: the context accumulates what has already been disclosed, so a
   * later turn only adds newly relevant skills instead of resending the set.
   * Skills are an optimization, so any failure yields no section rather than
   * failing the turn.
   */
  skillsSection(cwd: string, userMessage: string): string | null {
    try {
      const catalog = filterEnabledSkills(discoverSkills(cwd));
      if (catalog.length === 0) return null;
      this.skillContext.update(catalog, userMessage);
      this.lastStats = { skills: this.skillContext.stats(catalog) };
      return this.skillContext.render(catalog, this.overlays(catalog));
    } catch {
      return null;
    }
  }

  /**
   * The skills section for a one-shot sub-agent run.
   *
   * A sub-agent is a fresh cache generation and a single turn, so there is
   * nothing to accumulate: select against the delegated prompt and render once.
   * Its stats deliberately do not touch `lastStats`, which describes the main
   * loop's prefix.
   */
  subagentSkillsSection(cwd: string, prompt: string): string | null {
    try {
      const catalog = filterEnabledSkills(discoverSkills(cwd));
      if (catalog.length === 0) return null;
      return formatSkillsTiered(selectSkillsForPrompt(catalog, prompt, { maxFull: 5 }), this.overlays(catalog));
    } catch {
      return null;
    }
  }

  /**
   * Learned examples rendered inside already-disclosed skill entries.
   *
   * Selected per skill by its source path, so two projects with a same-named
   * skill do not share overlays.
   */
  private overlays(catalog: ReadonlyArray<SkillOverlayRef>): ReturnType<typeof loadSkillOverlays> {
    this.skillOverlays ??= loadSkillOverlays(catalog);
    return this.skillOverlays;
  }

  /** Session-stable AGENTS.md / CLAUDE.md for this workspace. */
  instructions(cwd: string): string | null {
    if (this.customInstructions === undefined) this.customInstructions = loadCustomInstructions(cwd);
    return this.customInstructions;
  }

  /** Session-stable custom sub-agent roster. */
  roster(): CustomSubagentConfig[] {
    if (this.subagentRoster === undefined) this.subagentRoster = loadValidSubAgents();
    return this.subagentRoster;
  }

  /** Session-stable learning notes. */
  notes(): string | null {
    if (this.learningNotes === undefined) this.learningNotes = loadLearningPromptNotes();
    return this.learningNotes;
  }

  /** Skill disclosure counts from the most recent main-loop turn. */
  stats(): PromptContextStats | null {
    return this.lastStats;
  }

  /**
   * Start a new cache generation: drop every snapshot so the next turn reads
   * fresh from disk. Called when the prefix is already being invalidated
   * (session reset, compaction), never mid-session.
   */
  reset(): void {
    this.skillContext.reset();
    this.skillOverlays = undefined;
    this.customInstructions = undefined;
    this.subagentRoster = undefined;
    this.learningNotes = undefined;
    this.lastStats = null;
  }
}
