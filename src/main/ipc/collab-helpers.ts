/**
 * Filesystem helpers for the collab tile-context directories.
 *
 * Kept free of the `electron` import so the destructive paths can be exercised
 * directly by unit tests (same split as terminal.ts / terminal-helpers.ts).
 */
import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * Every tile id the renderer mints is `tile-` prefixed — `tile-${Date.now()}`,
 * `tile-${Date.now()}-${index}`, `tile-template-${baseId}-${n}`. A tile context
 * directory is named for its tile id, so that prefix is what distinguishes a
 * tile directory from the reserved siblings the app keeps in the same root
 * (agents/, sessions/, skills/, tools/, plugins/, extensions/, relay state...).
 */
export function isTileContextDirName(name: string): boolean {
  return name.startsWith('tile-')
}

export async function removeDirIfExists(path: string): Promise<void> {
  try {
    await fs.rm(path, { recursive: true, force: true })
  } catch {
    // ignore missing paths
  }
}

/**
 * Remove tile context directories under `rootDir` whose tile is no longer on the
 * canvas.
 *
 * Only directories that are themselves tile directories are candidates. Anything
 * unrecognised is left alone: an un-pruned orphan is a bounded disk leak, whereas
 * deleting a directory this function does not understand destroys user data.
 */
export async function pruneOrphanedTileDirs(rootDir: string, validTileIds: Set<string>): Promise<string[]> {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true })
    const removed: string[] = []

    await Promise.all(entries.map(async entry => {
      if (!entry.isDirectory()) return
      if (entry.name.startsWith('.')) return
      if (!isTileContextDirName(entry.name)) return
      if (validTileIds.has(entry.name)) return
      await removeDirIfExists(join(rootDir, entry.name))
      removed.push(entry.name)
    }))

    return removed.sort()
  } catch {
    return []
  }
}
