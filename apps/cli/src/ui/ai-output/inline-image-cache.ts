// Disk cache for sharp-resized inline-image PNGs.
//
// The key includes the source file's mtime and size so an image edited or
// overwritten in place (screenshots reuse temp names) never serves a stale
// preview. Entries are pruned by age and count so the directory stays bounded.

import { createHash } from "node:crypto";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface InlineImageSizing {
  maxWidthCells: number;
  maxHeightCells: number;
  cellPxW: number;
  cellPxH: number;
}

export function inlineImageCacheKey(
  src: string,
  source: { mtimeMs: number; size: number },
  sizing: InlineImageSizing,
): string {
  return createHash("sha1")
    .update(
      `${src}|${source.mtimeMs}|${source.size}|${sizing.maxWidthCells}x${sizing.maxHeightCells}|${sizing.cellPxW}x${sizing.cellPxH}`,
    )
    .digest("hex")
    .slice(0, 16);
}

export const INLINE_IMAGE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const INLINE_IMAGE_CACHE_MAX_FILES = 200;

/** Delete cache PNGs older than maxAgeMs, then the oldest beyond maxFiles.
 *  Best-effort: filesystem errors are ignored. Returns the number removed. */
export function pruneInlineImageCache(
  dir: string,
  opts: { maxAgeMs?: number; maxFiles?: number; now?: number } = {},
): number {
  const maxAgeMs = opts.maxAgeMs ?? INLINE_IMAGE_CACHE_MAX_AGE_MS;
  const maxFiles = opts.maxFiles ?? INLINE_IMAGE_CACHE_MAX_FILES;
  const now = opts.now ?? Date.now();
  let entries: { path: string; mtimeMs: number }[];
  try {
    entries = readdirSync(dir)
      .filter((name) => name.endsWith(".png"))
      .map((name) => {
        const path = join(dir, name);
        return { path, mtimeMs: statSync(path).mtimeMs };
      });
  } catch {
    return 0;
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let removed = 0;
  entries.forEach((entry, index) => {
    if (index < maxFiles && now - entry.mtimeMs <= maxAgeMs) return;
    try {
      unlinkSync(entry.path);
      removed++;
    } catch {
      // best-effort
    }
  });
  return removed;
}
