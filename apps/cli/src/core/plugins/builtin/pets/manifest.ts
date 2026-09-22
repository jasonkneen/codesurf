// Pet bundle discovery + manifest loading.
//
// Ported from cursorbuddy's electron/services/pet-store.js conventions so
// grok-cli reads the same on-disk bundles cursorbuddy and openclicky use.
//
// Bundle layout (canonical, set by the hatch-pet skill):
//
//   <pet-id>/
//     pet.json          { id, displayName, description, spritesheetPath }
//     spritesheet.webp  1536 × 1872, 8 × 9 grid of 192 × 208 cells
//
// Scan order (first hit wins, ids dedup with a suffix when needed):
//   1. $CODEX_HOME/pets         (default ~/.codex/pets — primary, same as
//                                cursorbuddy/openclicky)
//   2. ~/.grok/pets             (grok-cli-specific overlay)
//   3. ~/.codesurf/pets         (codesurf-specific overlay)
//
// `spritesheetPath` is resolved relative to the bundle dir, with
// `spritesheet.webp` and `spritesheet.png` fallbacks when the manifest
// path doesn't exist (matching cursorbuddy behaviour for users who edit
// the file manually).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { ATLAS } from "./atlas";

export const DISABLED_PET_ID = "disabled";

export interface PetManifest {
  id: string;
  displayName: string;
  description: string;
  /** Absolute path to the spritesheet file (WebP or PNG). */
  spritesheetPath: string;
  /** Directory the pet was loaded from. */
  bundleDir: string;
  /** MIME hint derived from the spritesheet extension. */
  spritesheetMime: "image/webp" | "image/png" | "application/octet-stream";
}

interface RawManifest {
  id?: unknown;
  displayName?: unknown;
  description?: unknown;
  spritesheetPath?: unknown;
}

function petsDirs(): string[] {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return [join(codexHome, "pets"), join(homedir(), ".grok", "pets"), join(homedir(), ".codesurf", "pets")];
}

function mimeFor(filePath: string): PetManifest["spritesheetMime"] {
  switch (extname(filePath).toLowerCase()) {
    case ".webp":
      return "image/webp";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

function loadBundleMetadata(bundleDir: string): PetManifest | null {
  const manifestPath = join(bundleDir, "pet.json");
  if (!existsSync(manifestPath)) return null;

  let raw: RawManifest;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8")) as RawManifest;
  } catch {
    return null;
  }

  // Validate the four required fields. Matches cursorbuddy.
  const required: Array<keyof RawManifest> = ["id", "displayName", "description", "spritesheetPath"];
  for (const key of required) {
    if (typeof raw[key] !== "string" || (raw[key] as string).length === 0) {
      return null;
    }
  }

  // Resolve spritesheet path with the canonical fallbacks.
  let spritesheetPath = resolve(bundleDir, raw.spritesheetPath as string);
  if (!existsSync(spritesheetPath)) {
    for (const fallback of ["spritesheet.webp", "spritesheet.png"]) {
      const candidate = join(bundleDir, fallback);
      if (existsSync(candidate)) {
        spritesheetPath = candidate;
        break;
      }
    }
  }
  if (!existsSync(spritesheetPath)) return null;

  return {
    id: raw.id as string,
    displayName: raw.displayName as string,
    description: raw.description as string,
    spritesheetPath,
    bundleDir,
    spritesheetMime: mimeFor(spritesheetPath),
  };
}

/** Load a specific pet by id. Honours scan order. */
export function loadPetManifest(id: string): PetManifest | null {
  for (const dir of petsDirs()) {
    const candidate = join(dir, id);
    if (!existsSync(candidate)) continue;
    const m = loadBundleMetadata(candidate);
    if (m && m.id === id) return m;
  }
  // Also handle suffix-renamed collisions produced by listPetManifests.
  if (id.includes("__")) {
    const [, suffix] = id.split("__");
    if (suffix) {
      for (const dir of petsDirs()) {
        const candidate = join(dir, suffix);
        if (!existsSync(candidate)) continue;
        const m = loadBundleMetadata(candidate);
        if (m) {
          return { ...m, id };
        }
      }
    }
  }
  return null;
}

/**
 * Discover every valid pet across all scan dirs. On id collisions across
 * locations, keep both entries by suffixing the secondary id with the
 * directory name (cursorbuddy's strategy — keeps users from losing a pet
 * silently when two locations declare the same id).
 */
export function listPetManifests(): PetManifest[] {
  const out: PetManifest[] = [];
  const seenIds = new Set<string>();

  for (const dir of petsDirs()) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const bundleDir = join(dir, entry);
      const meta = loadBundleMetadata(bundleDir);
      if (!meta) continue;

      if (seenIds.has(meta.id)) {
        const suffixed = `${meta.id}__${entry.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
        out.push({
          ...meta,
          id: suffixed,
          displayName: `${meta.displayName} (${entry})`,
        });
        seenIds.add(suffixed);
        continue;
      }

      seenIds.add(meta.id);
      out.push(meta);
    }
  }

  out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return out;
}

/**
 * Probe whether the spritesheet at this path matches the canonical atlas
 * dimensions. Cheap header read via sharp's metadata. Returns true only
 * when dimensions are exact — anything else gets rendered as a static
 * single-image fallback by the renderer.
 */
export async function isCanonicalSpritesheet(filePath: string): Promise<boolean> {
  try {
    const { default: sharp } = await import("sharp");
    const meta = await sharp(filePath).metadata();
    return meta.width === ATLAS.totalWidth && meta.height === ATLAS.totalHeight;
  } catch {
    return false;
  }
}
