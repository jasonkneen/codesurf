import { promises as fs } from 'fs'
import { dirname, join, resolve } from 'path'
import { log } from './utils/logger.ts'

const migrationLog = log.scope('Migration')
import {
  APP_NAME,
  CODESURF_HOME,
  LEGACY_HOME,
  LEGACY_TILE_CONTEXT_DIRNAME,
  TILE_CONTEXT_DIRNAME,
  WORKSPACES_DIR,
} from './paths'

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/** True when the path exists and is itself a symlink (does NOT follow it). */
async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await fs.lstat(path)).isSymbolicLink()
  } catch {
    return false
  }
}

/** True when both paths resolve to the same real directory. */
async function resolvesToSame(a: string, b: string): Promise<boolean> {
  try {
    return (await fs.realpath(a)) === (await fs.realpath(b))
  } catch {
    return false
  }
}

/** Recursively copy src into dest, skipping files that already exist in dest. */
async function mergeDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)

    if (entry.isSymbolicLink()) {
      if (await exists(destPath)) continue

      const linkTarget = await fs.readlink(srcPath)
      const resolvedTarget = resolve(dirname(srcPath), linkTarget)
      let linkType: 'file' | 'dir' | 'junction' = 'file'
      try {
        const targetStat = await fs.stat(resolvedTarget)
        if (targetStat.isDirectory()) {
          linkType = process.platform === 'win32' ? 'junction' : 'dir'
        }
      } catch {
        // Broken symlink or missing target — preserve the link as-is.
      }

      await fs.symlink(linkTarget, destPath, linkType)
      continue
    }

    if (entry.isDirectory()) {
      await mergeDir(srcPath, destPath)
      continue
    }

    if (entry.isFile()) {
      if (!(await exists(destPath))) {
        await fs.copyFile(srcPath, destPath)
      }
      continue
    }

    console.warn(`[Migration] Skipping unsupported entry: ${srcPath}`)
  }
}

/**
 * Migrate ~/.contex -> ~/.codesurf.
 * If .codesurf doesn't exist, just rename.
 * If both exist, merge legacy contents into .codesurf (files in .codesurf win).
 */
async function migrateHomeDirectory(): Promise<void> {
  if (!(await exists(LEGACY_HOME))) return

  if (!(await exists(CODESURF_HOME))) {
    // Clean case: just rename
    await fs.rename(LEGACY_HOME, CODESURF_HOME)
    migrationLog.info(`Renamed ${LEGACY_HOME} -> ${CODESURF_HOME}`)
  } else {
    // Both exist — but `exists()` uses fs.access, which FOLLOWS symlinks. A
    // user who relocated app data with `~/.codesurf -> ~/.contex` satisfied
    // both checks, mergeDir then copied the directory into itself (so every
    // destination already existed and nothing was copied), and the rm below
    // destroyed the only copy: all workspaces, canvas state, secrets and
    // permissions, leaving ~/.codesurf dangling. Bail before deleting anything
    // if either path is a symlink or they resolve to the same directory.
    if (await resolvesToSame(LEGACY_HOME, CODESURF_HOME)) {
      migrationLog.warn(
        `Skipping migration: ${CODESURF_HOME} and ${LEGACY_HOME} resolve to the same directory`,
      )
      return
    }
    if (await isSymlink(CODESURF_HOME) || await isSymlink(LEGACY_HOME)) {
      migrationLog.warn(
        `Skipping migration: one of ${CODESURF_HOME} / ${LEGACY_HOME} is a symlink; refusing to delete`,
      )
      return
    }

    // Both exist: merge legacy into new (new wins on conflict)
    migrationLog.info(`Merging ${LEGACY_HOME} into ${CODESURF_HOME}`)
    await mergeDir(LEGACY_HOME, CODESURF_HOME)
    migrationLog.info(`Merge complete, removing ${LEGACY_HOME}`)
    await fs.rm(LEGACY_HOME, { recursive: true, force: true })
  }
}

/** Rewrite workspace paths in config.json that still reference ~/.contex */
async function migrateConfigPaths(): Promise<void> {
  const configPath = join(CODESURF_HOME, 'config.json')
  if (!(await exists(configPath))) return

  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const updated = raw.replaceAll(LEGACY_HOME, CODESURF_HOME)
    if (updated !== raw) {
      await fs.writeFile(configPath, updated)
      migrationLog.info('Updated paths in config.json')
    }
  } catch (error) {
    console.warn(`[Migration] Failed to update config paths:`, error)
  }
}

async function migrateWorkspaceTileDirs(): Promise<void> {
  if (!(await exists(WORKSPACES_DIR))) return

  const workspaceIds = await fs.readdir(WORKSPACES_DIR)
  for (const workspaceId of workspaceIds) {
    const workspacePath = join(WORKSPACES_DIR, workspaceId)
    const legacyDir = join(workspacePath, LEGACY_TILE_CONTEXT_DIRNAME)
    const newDir = join(workspacePath, TILE_CONTEXT_DIRNAME)

    if (!(await exists(legacyDir)) || await exists(newDir)) continue

    await fs.rename(legacyDir, newDir)
    migrationLog.info(`Renamed ${legacyDir} -> ${newDir}`)
  }
}

export async function migrateLegacyStorage(): Promise<void> {
  try {
    await migrateHomeDirectory()
    await fs.mkdir(CODESURF_HOME, { recursive: true })
    await migrateConfigPaths()
    await migrateWorkspaceTileDirs()
  } catch (error) {
    console.error(`[Migration] ${APP_NAME} storage migration failed:`, error)
    throw error
  }
}
