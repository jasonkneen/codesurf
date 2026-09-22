export type ScanLocationProbe = { ok: true } | { ok: false, code: string }

export type UnreadableScanLocation = { path: string, code: string }

/**
 * Optional scan roots (Cursor, Continue, workspace-local skills, …) often
 * do not exist. ENOENT is absence, not a read failure.
 */
export function isUnreadableScanLocationCode(code: string | undefined | null): boolean {
  if (!code || code === 'ENOENT') return false
  return true
}

export function unreadableScanLocationsFromProbes(
  results: readonly { path: string, probe: ScanLocationProbe | null | undefined }[],
): UnreadableScanLocation[] {
  const unreadable: UnreadableScanLocation[] = []
  for (const { path, probe } of results) {
    if (!probe || probe.ok === true) continue
    if (!isUnreadableScanLocationCode(probe.code)) continue
    unreadable.push({ path, code: probe.code || 'UNKNOWN' })
  }
  return unreadable
}
