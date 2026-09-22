/**
 * Pure activity-store retention policy. Electron-free so unit tests can gate
 * caps under plain `node --test` without touching the home-directory store.
 */

export const MAX_ACTIVITY_RECORDS = 5000
/** Drop records older than 30 days (by updatedAt). */
export const MAX_ACTIVITY_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface CapableActivityRecord {
  updatedAt: number
}

/**
 * Enforce count + age caps. Newest-by-updatedAt wins when over the count cap.
 * Returns the same array reference when nothing is trimmed.
 */
export function capActivityRecords<T extends CapableActivityRecord>(
  records: T[],
  now: number = Date.now(),
  options?: { maxRecords?: number, maxAgeMs?: number },
): T[] {
  const maxRecords = options?.maxRecords ?? MAX_ACTIVITY_RECORDS
  const maxAgeMs = options?.maxAgeMs ?? MAX_ACTIVITY_AGE_MS

  let next = records
  if (maxAgeMs > 0) {
    const cutoff = now - maxAgeMs
    const filtered = next.filter(r => r.updatedAt >= cutoff)
    if (filtered.length !== next.length) next = filtered
  }

  if (next.length > maxRecords) {
    next = [...next]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, maxRecords)
  }

  return next
}
