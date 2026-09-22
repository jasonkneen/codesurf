// Frame extraction + caching for the pets renderer.
//
// Slices a single animation row out of a pet spritesheet using the
// shared atlas geometry (see ./atlas.ts) and writes each frame to disk
// as PNG. Kitty graphics protocol consumes PNG only — WebP sources
// (the codex-rs / hatch-pet canonical format) are decoded by sharp here.
//
// Cache layout:
//   ~/.grok/pets-cache/<pet-id>/<fingerprint>/<row>-<n>.png
//
// `fingerprint` is `size-mtime` of the source spritesheet so manual
// edits invalidate naturally. Old fingerprints are pruned on write.
//
// Falls back to a single-image PNG transcode when the spritesheet
// dimensions don't match the canonical 1536×1872 atlas — that path
// covers users dropping in plain images that aren't sprite grids.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AnimationRow, ATLAS, cellRect, FRAME_DURATIONS, frameCount } from "./atlas";
import type { PetManifest } from "./manifest";

const CACHE_ROOT = join(homedir(), ".grok", "pets-cache");

export interface ExtractedFrame {
  /** Absolute PNG path. */
  path: string;
  /** Duration this frame should remain on screen, in milliseconds. */
  durationMs: number;
}

export interface FrameSet {
  row: AnimationRow | "static";
  frames: ExtractedFrame[];
  /** True when we sliced from a canonical-size spritesheet. */
  fromSpritesheet: boolean;
}

/**
 * Extract every frame of `row` from the pet's spritesheet and return
 * the cached PNG paths in order. Cheap on cache hits — only fingerprint
 * + readdir, no decode.
 *
 * For non-canonical-size source images, returns a single static frame
 * (the whole image transcoded to PNG) regardless of `row`.
 */
export async function extractRowFrames(pet: PetManifest, row: AnimationRow): Promise<FrameSet> {
  const fingerprint = fingerprintFor(pet.spritesheetPath);
  const cacheDir = join(CACHE_ROOT, pet.id, fingerprint);

  // Cache hit fast path: if the row's PNGs are already on disk, return.
  if (existsSync(cacheDir)) {
    const cached = readCachedRow(cacheDir, row);
    if (cached) {
      return cached;
    }
  }

  // Otherwise prune stale fingerprints for this pet and decode fresh.
  pruneOtherFingerprints(pet.id, fingerprint);
  mkdirSync(cacheDir, { recursive: true });

  const { default: sharp } = await import("sharp");
  const meta = await sharp(pet.spritesheetPath).metadata();
  const isCanonical = meta.width === ATLAS.totalWidth && meta.height === ATLAS.totalHeight;

  if (!isCanonical) {
    // Static fallback: whole image as a single PNG, ~zero atlas math.
    const outPath = join(cacheDir, "static-0.png");
    await sharp(pet.spritesheetPath, { page: 0 }).png().toFile(outPath);
    return {
      row: "static",
      frames: [{ path: outPath, durationMs: 1000 }],
      fromSpritesheet: false,
    };
  }

  const count = frameCount(row);
  const durations = FRAME_DURATIONS[row];
  const frames: ExtractedFrame[] = [];
  for (let i = 0; i < count; i++) {
    const outPath = join(cacheDir, `${row}-${i}.png`);
    const rect = cellRect(row, i);
    if (!existsSync(outPath)) {
      await sharp(pet.spritesheetPath, { page: 0 })
        .extract({ left: rect.sx, top: rect.sy, width: rect.sw, height: rect.sh })
        .png()
        .toFile(outPath);
    }
    frames.push({ path: outPath, durationMs: Math.round(durations[i]! * 1000) });
  }
  return { row, frames, fromSpritesheet: true };
}

function fingerprintFor(sourcePath: string): string {
  const stat = statSync(sourcePath);
  return `${stat.size}-${Math.trunc(stat.mtimeMs)}`;
}

function readCachedRow(cacheDir: string, row: AnimationRow): FrameSet | null {
  // Static fallback branch: a single static-0.png means the source
  // wasn't a canonical spritesheet last time; honour that.
  const staticPath = join(cacheDir, "static-0.png");
  if (existsSync(staticPath)) {
    return {
      row: "static",
      frames: [{ path: staticPath, durationMs: 1000 }],
      fromSpritesheet: false,
    };
  }
  const count = frameCount(row);
  const durations = FRAME_DURATIONS[row];
  const frames: ExtractedFrame[] = [];
  for (let i = 0; i < count; i++) {
    const candidate = join(cacheDir, `${row}-${i}.png`);
    if (!existsSync(candidate)) return null;
    frames.push({ path: candidate, durationMs: Math.round(durations[i]! * 1000) });
  }
  return { row, frames, fromSpritesheet: true };
}

function pruneOtherFingerprints(petId: string, keepFingerprint: string): void {
  const petDir = join(CACHE_ROOT, petId);
  if (!existsSync(petDir)) return;
  try {
    for (const entry of readdirSync(petDir)) {
      if (entry === keepFingerprint) continue;
      try {
        rmSync(join(petDir, entry), { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
}
