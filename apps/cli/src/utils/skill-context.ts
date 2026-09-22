// Cache-safe progressive skill context.
//
// Prompt caching is PREFIX-based: the provider reuses the longest identical
// leading span of the request. That single fact dictates the whole design here.
//
//   adding a skill    -> appended AFTER everything already sent, so the entire
//                        previous prefix still matches. CACHE SAFE.
//   removing a skill  -> shortens/rewrites the middle, so every token after it
//                        differs. CACHE HOSTILE — invalidates the whole tail.
//   reordering        -> same problem as removing.
//
// So within a session the disclosed set only ever GROWS, in insertion order.
// A turn that needs skills the model has not seen appends them; a turn that
// needs fewer leaves the block untouched rather than shrinking it. The set is
// only reset at a point where the cache is being discarded anyway (/clear, a
// compaction, a new session) — `reset()`.
//
// The cost of never removing is bounded and small: each retained skill is one
// <skill> entry (~130 tokens), and a session realistically touches a handful.
// Re-paying a full prefill to reclaim ~130 tokens is a bad trade every time.

import { type DiscoveredSkill, formatSkillsTiered, type SkillPromptOverlays, selectSkillsForPrompt } from "./skills";

export interface SkillContextStats {
  /** Skills currently disclosed in full. */
  disclosed: number;
  /** Skills present as names only. */
  indexed: number;
  /** How many were appended by the most recent turn (0 => prefix reused). */
  addedLastTurn: number;
  /** Names appended by the most recent turn, for the cache-stats line. */
  addedNames: string[];
}

/**
 * Per-conversation accumulator deciding which skills are disclosed in full.
 *
 * Construct one per conversation. Call `update(userMessage)` at the start of
 * each turn, then `render()` for the system-prompt section.
 */
export class ProgressiveSkillContext {
  /** Insertion-ordered: the render order must never change once a skill is in. */
  private readonly disclosed = new Map<string, DiscoveredSkill>();
  private lastAdded: string[] = [];

  constructor(private readonly options: { maxFullPerTurn?: number } = {}) {}

  /**
   * Fold this turn's relevant skills into the disclosed set.
   *
   * Returns the names newly appended. An empty array means the skills block is
   * byte-identical to last turn — i.e. a guaranteed cache hit on that span.
   */
  update(catalog: DiscoveredSkill[], userMessage: string): string[] {
    const selection = selectSkillsForPrompt(catalog, userMessage, {
      maxFull: this.options.maxFullPerTurn ?? 10,
    });
    const added: string[] = [];
    for (const skill of selection.full) {
      if (this.disclosed.has(skill.name)) continue;
      this.disclosed.set(skill.name, skill);
      added.push(skill.name);
    }
    this.lastAdded = added;
    return added;
  }

  /**
   * Render the skills section: everything disclosed so far in full, plus a
   * name-only index of the rest of the catalog.
   */
  render(catalog: DiscoveredSkill[], overlays?: SkillPromptOverlays): string | null {
    const full = [...this.disclosed.values()];
    const fullNames = new Set(full.map((s) => s.name));
    const indexed = catalog.filter((s) => !fullNames.has(s.name));
    return formatSkillsTiered({ full, indexed }, overlays);
  }

  stats(catalog: DiscoveredSkill[]): SkillContextStats {
    return {
      disclosed: this.disclosed.size,
      indexed: Math.max(0, catalog.length - this.disclosed.size),
      addedLastTurn: this.lastAdded.length,
      addedNames: [...this.lastAdded],
    };
  }

  /** Drop everything. Only call where the cache is being discarded anyway. */
  reset(): void {
    this.disclosed.clear();
    this.lastAdded = [];
  }
}

/**
 * Format the per-turn cache line, e.g.
 *   cache: 48,102 read · 1,204 written · skills 3 full / 255 indexed (+1 pixijs)
 *
 * `read` being large and `written` small is the healthy steady state: the
 * prefix was reused. A large `written` on a later turn means something ahead of
 * the cached span changed — that is the signal a prompt section is unstable.
 */
export function formatCacheStatsLine(
  usage: { cacheReadTokens?: number; cacheWriteTokens?: number; inputTokens?: number },
  skills?: SkillContextStats,
): string {
  const n = (v: number | undefined): string => (v ?? 0).toLocaleString();
  const parts = [`${n(usage.cacheReadTokens)} read`, `${n(usage.cacheWriteTokens)} written`];
  if (usage.inputTokens !== undefined) parts.push(`${n(usage.inputTokens)} in`);
  let line = `cache: ${parts.join(" · ")}`;
  if (skills) {
    line += ` · skills ${skills.disclosed} full / ${skills.indexed} indexed`;
    if (skills.addedLastTurn > 0) {
      const shown = skills.addedNames.slice(0, 3).join(", ");
      const more = skills.addedNames.length > 3 ? `, +${skills.addedNames.length - 3}` : "";
      line += ` (+${skills.addedLastTurn}: ${shown}${more})`;
    }
  }
  return line;
}
