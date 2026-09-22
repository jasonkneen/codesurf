// Memoize expensive synchronous CLI availability probes (execFileSync of
// external binaries like `fractal`, `sbx`, `opencode`, `codex`). These get
// called from render-path credential checks — uncached, a single render could
// block the event loop for ~2s per pass, freezing the whole TUI.

const cache = new Map<string, { value: unknown; at: number }>();

export const CLI_CHECK_TTL_MS = 30_000;

/** Run `probe` at most once per `ttlMs` per `key`; return the cached result otherwise. */
export function cachedCliCheck<T>(key: string, probe: () => T, ttlMs: number = CLI_CHECK_TTL_MS): T {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.value as T;
  const value = probe();
  cache.set(key, { value, at: now });
  return value;
}

/** Test seam / manual refresh (e.g. after an install flow completes). */
export function clearCliCheckCache(): void {
  cache.clear();
}
