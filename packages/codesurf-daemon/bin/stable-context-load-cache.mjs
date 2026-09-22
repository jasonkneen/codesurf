/**
 * LRU for the memory/skills prompts assembled per chat job.
 *
 * These loads are expensive and stable within a burst of jobs, but they are NOT
 * stable across a memory edit or a skill install. The cache was previously a
 * pure LRU with no TTL, mtime check or invalidation hook, and neither loader
 * revalidated — so after editing memory files or installing a skill, every
 * later job in that workspace+card kept the FIRST job's prompts until 64 keys
 * evicted it or the daemon restarted, while /memory/load showed the UI fresh
 * data. stripUntrustedPrivilegedChatContext deletes the prompt fields from
 * every request, so the cache is always consulted.
 *
 * Two defences: a short TTL so a stale entry cannot outlive a user's edit by
 * more than the window, and an explicit invalidate() the write paths call.
 */
export const DEFAULT_STABLE_CONTEXT_TTL_MS = 30_000

export function createStableContextLoadCache(maxEntries = 64, options = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error('Stable context load cache size must be a positive integer')
  }
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
    ? options.ttlMs
    : DEFAULT_STABLE_CONTEXT_TTL_MS
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const entries = new Map()

  return {
    get(key) {
      if (!entries.has(key)) return { hit: false }
      const entry = entries.get(key)
      if (now() - entry.storedAt >= ttlMs) {
        entries.delete(key)
        return { hit: false }
      }
      entries.delete(key)
      entries.set(key, entry)
      return { hit: true, value: entry.value }
    },
    set(key, value) {
      entries.delete(key)
      entries.set(key, { value, storedAt: now() })
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) return
        entries.delete(oldest)
      }
    },
    /**
     * Drop cached entries. With no argument every entry is dropped; with a
     * workspaceId only that workspace's entries are (keys embed it).
     */
    invalidate(workspaceId) {
      if (workspaceId === undefined || workspaceId === null || workspaceId === '') {
        entries.clear()
        return
      }
      const needle = JSON.stringify(String(workspaceId).trim())
      for (const key of [...entries.keys()]) {
        // key is JSON [kind, workspaceId, cardId, target]
        const parts = JSON.parse(key)
        if (JSON.stringify(parts[1]) === needle) entries.delete(key)
      }
    },
    get size() {
      return entries.size
    },
    key(kind, request = {}) {
      return JSON.stringify([
        String(kind ?? ''),
        String(request.workspaceId ?? '').trim(),
        String(request.cardId ?? '').trim(),
        String(request.executionTarget === 'cloud' ? 'cloud' : 'local'),
      ])
    },
  }
}
