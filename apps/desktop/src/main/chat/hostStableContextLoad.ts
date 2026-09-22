/** Daemon jobs rebuild trusted memory/skills themselves. Prefetching them
 *  on the host is a wasted /memory/load + /skills/list round trip. */
export function hostShouldPrefetchStableContext(daemonHost: { type?: string } | null | undefined): boolean {
  return daemonHost == null
}
