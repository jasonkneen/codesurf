/**
 * risk-06: scope Chrome cookie injection to an approved-domains allowlist.
 *
 * `syncCookiesToPartition` used to inject the ENTIRE decrypted cookie jar — every
 * auth/session cookie for every site — into a browser-tile partition that then
 * navigates arbitrary URLs, handing ambient authority to any page/agent driving
 * the tile. This pure matcher lets the sync filter cookies to domains the user
 * has approved. Kept electron-free so it is unit-testable
 * (`test/chrome-domain-allowlist.test.ts`).
 *
 * Default/empty-allowlist behavior (the runtime tail) is decided by the caller:
 * an empty list means "no restriction yet" (inject all + warn) so existing sync
 * is never silently killed before the approval UI exists.
 */

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+/, '')
}

// True when `hostKey` (a Chrome cookie `host_key`, possibly leading-dot) is the
// approved domain itself or a subdomain of it. The subdomain check requires a
// dot boundary (`.${approved}`) so `evilexample.com` does NOT match an approved
// `example.com`.
export function isCookieDomainApproved(hostKey: string, approvedDomains: string[]): boolean {
  const host = normalizeDomain(hostKey)
  if (!host) return false
  for (const approved of approvedDomains) {
    const a = normalizeDomain(approved)
    if (!a) continue
    if (host === a || host.endsWith(`.${a}`)) return true
  }
  return false
}
