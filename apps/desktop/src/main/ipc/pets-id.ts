// Pure helpers for pet id parsing — split out of pets.ts so this logic can
// be unit-tested without importing electron (pets.ts pulls in ipcMain).

import { assertSafePathSegment } from '../security/pathSegments.ts'

/** Extract and validate the suffix segment from a suffixed pet id
 *  (`originalId__dirName`, produced by listPetManifests when the same pet
 *  id appears in multiple scan dirs).
 *
 *  Splits on the FIRST `__` only — the remainder (which may itself contain
 *  `__`, since the sanitizer that builds it keeps underscores) is the full
 *  suffix. Returns null when the id has no `__`, the suffix is empty, or
 *  the suffix fails path-segment validation (e.g. traversal attempts like
 *  `../x`, `..`, or `a/b`). */
export function parseSuffixedPetId(id: string): string | null {
  const sep = id.indexOf('__')
  if (sep === -1) return null
  const suffix = id.slice(sep + 2)
  if (!suffix) return null
  try {
    assertSafePathSegment(suffix, 'pet id suffix')
  } catch {
    return null
  }
  return suffix
}
