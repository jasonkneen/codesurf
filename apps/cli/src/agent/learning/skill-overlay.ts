// Skill overlays — per-skill few-shot examples mined from high-feedback traces
// (D3). Stored as JSON sidecars under ~/.codesurf/skill-overlays/ and injected
// into the skill's prompt entry on the next session. Adapted from OpenJarvis's
// optimized.toml overlay idea, kept as plain JSON for a TS CLI.
//
// Identity: an overlay belongs to a skill SOURCE (its SKILL.md path), not just
// a skill name. Two projects can each ship a `demo` skill; their overlays are
// separate files and never cross over. A user-scope skill has one source, so
// its overlay is shared by every project that discovers it — that is the
// intentional-sharing policy.
//
// Filesystem only (no sqlite) so this is safe to import from utils/skills.ts
// (which feeds the system prompt) without pulling the DB into that graph.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultCodesurfHome } from "@codesurf/daemon";

export interface SkillFewShot {
  query: string;
  result: string;
}

export interface SkillOverlay {
  /** Skill name (matches DiscoveredSkill.name). */
  skill: string;
  /**
   * Stable identity: the absolute SKILL.md path the examples were mined for.
   * Absent only on legacy name-keyed overlay files.
   */
  source?: string;
  fewShot: SkillFewShot[];
  /** How many traces the examples were mined from. */
  sampleCount: number;
  updatedAt: string;
}

/** The subset of a discovered skill needed to select its overlay. */
export interface SkillOverlayRef {
  name: string;
  skillMdPath: string;
}

function overlayDir(): string {
  return path.join(defaultCodesurfHome(), "skill-overlays");
}

/** Filesystem-safe filename for a skill name. */
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function normalizeSource(source: string): string {
  return path.resolve(source);
}

function sourceTag(source: string): string {
  return createHash("sha256").update(normalizeSource(source)).digest("hex").slice(0, 10);
}

/** `<name>-<sourceTag>.json` for a sourced overlay; legacy `<name>.json` otherwise. */
function overlayFileName(overlay: SkillOverlay): string {
  const base = safeName(overlay.skill);
  return overlay.source ? `${base}-${sourceTag(overlay.source)}.json` : `${base}.json`;
}

export function saveSkillOverlay(overlay: SkillOverlay): void {
  try {
    const dir = overlayDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record: SkillOverlay = overlay.source ? { ...overlay, source: normalizeSource(overlay.source) } : overlay;
    fs.writeFileSync(path.join(dir, overlayFileName(record)), JSON.stringify(record, null, 2), "utf-8");
  } catch {
    // Best effort — overlays are an optimization, never required.
  }
}

function readAllOverlays(): SkillOverlay[] {
  const out: SkillOverlay[] = [];
  try {
    const dir = overlayDir();
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf-8")) as SkillOverlay;
        if (raw && typeof raw.skill === "string" && Array.isArray(raw.fewShot)) {
          out.push(raw);
        }
      } catch {
        // Skip a malformed overlay file.
      }
    }
  } catch {
    // No overlays dir / unreadable — return what we have.
  }
  return out;
}

/**
 * Load overlays keyed by skill name. Returns an empty map on any error.
 *
 * With `skills` (the discovered catalog), each name maps to the overlay whose
 * `source` is that skill's SKILL.md — the only way a same-named skill in
 * another project stays isolated. Without it (legacy callers), a name is only
 * populated when it is unambiguous: sourced overlays win over a legacy
 * name-only file, and a name with overlays from several sources is skipped
 * rather than guessed.
 */
export function loadSkillOverlays(skills?: ReadonlyArray<SkillOverlayRef>): Map<string, SkillOverlay> {
  const map = new Map<string, SkillOverlay>();
  const overlays = readAllOverlays();

  if (skills) {
    for (const skill of skills) {
      const wanted = normalizeSource(skill.skillMdPath);
      const match = overlays.find((o) => o.skill === skill.name && o.source && normalizeSource(o.source) === wanted);
      if (match) map.set(skill.name, match);
    }
    return map;
  }

  const byName = new Map<string, SkillOverlay[]>();
  for (const overlay of overlays) {
    const arr = byName.get(overlay.skill) ?? [];
    arr.push(overlay);
    byName.set(overlay.skill, arr);
  }
  for (const [name, candidates] of byName) {
    const sourced = candidates.filter((o) => !!o.source);
    if (sourced.length === 0) {
      map.set(name, candidates[0]);
      continue;
    }
    const sources = new Set(sourced.map((o) => normalizeSource(o.source as string)));
    if (sources.size === 1) map.set(name, sourced[0]);
  }
  return map;
}
