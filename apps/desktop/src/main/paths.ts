import { homedir } from 'os'
import { join, resolve } from 'path'
import { assertSafePathSegment } from './security/pathSegments.ts'

export const APP_NAME = 'CodeSurf'
export const APP_ID = 'com.huggiapps.codesurf'

/** Canonical home under ~/.codesurf */
export const CODESURF_HOME_DIRNAME = '.codesurf'
/** Previous product home (~/.contex) — migrated at startup */
export const LEGACY_HOME_DIRNAME = '.contex'

/**
 * Per-workspace tile protocol directory name (messages, objective, skills).
 * Prefer `.codesurf`; still read legacy `.contex` / `.collab` when present.
 */
export const TILE_CONTEXT_DIRNAME = '.codesurf'
export const LEGACY_TILE_CONTEXT_DIRNAMES = ['.contex', '.collab'] as const
/** @deprecated use LEGACY_TILE_CONTEXT_DIRNAMES[1] */
export const LEGACY_TILE_CONTEXT_DIRNAME = '.collab'

// Tests can redirect the app home via CODESURF_HOME so they never touch the
// real ~/.codesurf (must be set before this module is imported).
const codesurfHomeOverride = process.env.CODESURF_HOME?.trim()

export const CODESURF_HOME = codesurfHomeOverride
  ? resolve(codesurfHomeOverride)
  : join(homedir(), CODESURF_HOME_DIRNAME)
export const LEGACY_HOME = join(homedir(), LEGACY_HOME_DIRNAME)
export const WORKSPACES_DIR = join(CODESURF_HOME, 'workspaces')
export const JOBS_DIR = join(CODESURF_HOME, 'jobs')
export const TIMELINES_DIR = join(CODESURF_HOME, 'timelines')

// Back-compat aliases for older imports still mid-migration
export const CONTEX_HOME = CODESURF_HOME
export const CONTEX_HOME_DIRNAME = CODESURF_HOME_DIRNAME

export function workspaceTileDir(workspacePath: string, tileId: string): string {
  return join(workspacePath, TILE_CONTEXT_DIRNAME, assertSafePathSegment(tileId, 'tileId'))
}

export function legacyWorkspaceTileDir(workspacePath: string, tileId: string): string {
  return join(workspacePath, LEGACY_TILE_CONTEXT_DIRNAME, assertSafePathSegment(tileId, 'tileId'))
}

/** All known tile-protocol roots for a workspace (canonical first, then legacies). */
export function workspaceTileProtocolRoots(workspacePath: string): string[] {
  return [
    join(workspacePath, TILE_CONTEXT_DIRNAME),
    ...LEGACY_TILE_CONTEXT_DIRNAMES.map((name) => join(workspacePath, name)),
  ]
}

export function workspaceTileContextDir(workspacePath: string, tileId: string): string {
  return join(workspaceTileDir(workspacePath, tileId), 'context')
}

export function legacyWorkspaceTileContextDir(workspacePath: string, tileId: string): string {
  return join(legacyWorkspaceTileDir(workspacePath, tileId), 'context')
}

export function workspaceTileMessagesDir(workspacePath: string, tileId: string): string {
  return join(workspaceTileDir(workspacePath, tileId), 'messages')
}

export function workspaceTileMessageMailboxDir(workspacePath: string, tileId: string, mailbox: string): string {
  return join(workspaceTileMessagesDir(workspacePath, tileId), assertSafePathSegment(mailbox, 'mailbox'))
}
