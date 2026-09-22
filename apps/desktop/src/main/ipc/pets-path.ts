/**
 * Pure path helpers for pet bundle directories.
 * Kept Electron-free so unit tests can import under plain `node --test`.
 */

import { assertSafePathSegment, resolveInside } from '../security/pathSegments.ts'

/**
 * Resolve a pet slug/id to a path under `root`. Rejects traversal (`..`,
 * separators, absolute paths) so install/remove cannot escape the pets dir.
 */
export function resolvePetBundleDir(root: string, slug: string): string {
  const safe = assertSafePathSegment(slug, 'pet slug')
  return resolveInside(root, safe)
}

export function tryResolvePetBundleDir(root: string, slug: string): string | null {
  try {
    return resolvePetBundleDir(root, slug)
  } catch {
    return null
  }
}
