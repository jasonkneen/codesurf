import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface ChromeProfile {
  name: string
  dir: string
  email?: string
  avatarIcon?: string
}

export const CHROME_BASE = join(
  homedir(),
  'Library',
  'Application Support',
  'Google',
  'Chrome',
)

export function listProfiles(): ChromeProfile[] {
  try {
    const localState = JSON.parse(
      readFileSync(join(CHROME_BASE, 'Local State'), 'utf-8'),
    )
    const cache = localState?.profile?.info_cache
    if (!cache || typeof cache !== 'object') return []

    return Object.entries(cache).map(([dir, info]: [string, any]) => ({
      name: info.name || dir,
      dir,
      email: info.user_name || undefined,
      avatarIcon: info.avatar_icon || undefined,
    }))
  } catch {
    return []
  }
}

// A Chrome profile dir is always a single path segment ("Default", "Profile 1").
// Reject anything containing separators or traversal so a renderer-supplied
// value can't escape CHROME_BASE into arbitrary files (e.g. "../../../etc").
export function assertSafeProfileDir(profileDir: string): string {
  if (
    typeof profileDir !== 'string' ||
    profileDir.length === 0 ||
    profileDir.includes('/') ||
    profileDir.includes('\\') ||
    profileDir.includes('\0') ||
    profileDir === '.' ||
    profileDir === '..' ||
    profileDir.includes('..')
  ) {
    throw new Error(`Invalid Chrome profile dir: ${JSON.stringify(profileDir)}`)
  }
  return profileDir
}

export function profilePath(profileDir: string): string {
  return join(CHROME_BASE, assertSafeProfileDir(profileDir))
}
