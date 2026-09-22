// Image format conversion for the pets renderer.
//
// Kitty graphics (f=100) accepts PNG only. Codex-rs pets ship WebP
// spritesheets — and users may drop in JPGs, GIFs, etc. — so we transcode
// to PNG on first use and cache the result keyed on the source's mtime+size
// fingerprint. Cache hits skip the decode.
//
// Cache layout:
//   ~/.grok/pets-cache/<pet-id>/<fingerprint>.png
//
// Old cache files are pruned when a new fingerprint is written so the
// directory doesn't grow unbounded across pet edits.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_ROOT = join(homedir(), ".grok", "pets-cache");

// Codex-rs spritesheet geometry (see codex-rs/tui/src/pets/catalog.rs:3-8).
// We use these constants to detect spritesheets by exact dimension and
// extract just the top-left frame for static rendering.
const CODEX_FRAME_WIDTH = 192;
const CODEX_FRAME_HEIGHT = 208;
const CODEX_FRAME_COLUMNS = 8;
const CODEX_FRAME_ROWS = 9;
const CODEX_SHEET_WIDTH = CODEX_FRAME_WIDTH * CODEX_FRAME_COLUMNS; // 1536
const CODEX_SHEET_HEIGHT = CODEX_FRAME_HEIGHT * CODEX_FRAME_ROWS; // 1872

export interface ConvertResult {
  /** Absolute path to a PNG suitable for Kitty graphics. */
  pngPath: string;
  /** True when we transcoded; false when source was already PNG. */
  converted: boolean;
}

/**
 * Return a PNG path for `sourcePath`. If the source is already a PNG, the
 * source path is returned unchanged. Otherwise we decode the source and
 * write a PNG into the per-pet cache, taking the **first frame** of any
 * animated/sprite image so the static-frame MVP renderer has something
 * usable. Errors propagate — callers should surface them in the chat.
 */
export async function ensurePng(petId: string, sourcePath: string): Promise<ConvertResult> {
  if (sourcePath.toLowerCase().endsWith(".png")) {
    return { pngPath: sourcePath, converted: false };
  }

  const fingerprint = fingerprintFor(sourcePath);
  const petCacheDir = join(CACHE_ROOT, petId);
  const cachedPath = join(petCacheDir, `${fingerprint}.png`);

  if (existsSync(cachedPath)) {
    return { pngPath: cachedPath, converted: false };
  }

  if (!existsSync(petCacheDir)) {
    mkdirSync(petCacheDir, { recursive: true });
  }

  // Lazy import keeps the ~30MB sharp binary out of the cold-start path for
  // users who never select a non-PNG pet.
  const { default: sharp } = await import("sharp");

  // `page: 0` grabs the first frame of an animated WebP/GIF; harmless for
  // single-frame images.
  let pipeline = sharp(sourcePath, { page: 0 });

  // If this is a codex-rs spritesheet (8 columns × 9 rows of 192×208 frames
  // arranged into a single 1536×1872 image), extract just the top-left
  // frame. Otherwise the Kitty renderer would compress the whole grid into
  // a 4×3-cell sprite, which is unreadable. The dimensions check is exact
  // so we don't mis-crop user-supplied non-spritesheet images.
  const meta = await pipeline.metadata();
  if (meta.width === CODEX_SHEET_WIDTH && meta.height === CODEX_SHEET_HEIGHT) {
    pipeline = sharp(sourcePath, { page: 0 }).extract({
      left: 0,
      top: 0,
      width: CODEX_FRAME_WIDTH,
      height: CODEX_FRAME_HEIGHT,
    });
  }

  await pipeline.png().toFile(cachedPath);

  // Prune any older fingerprints for this pet so the cache stays small.
  try {
    for (const entry of readdirSync(petCacheDir)) {
      if (entry !== `${fingerprint}.png` && entry.endsWith(".png")) {
        unlinkSync(join(petCacheDir, entry));
      }
    }
  } catch {
    // Pruning is best-effort.
  }

  return { pngPath: cachedPath, converted: true };
}

function fingerprintFor(sourcePath: string): string {
  const stat = statSync(sourcePath);
  // mtime + size is enough to invalidate after edits; we don't need a
  // cryptographic hash for a render cache.
  return `${stat.size}-${Math.trunc(stat.mtimeMs)}`;
}
