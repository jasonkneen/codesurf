/**
 * Usage tracking entry point.
 *
 * One refreshAll() call sweeps every supported provider's on-disk archives,
 * builds a UsageSnapshot, and persists it via the snapshot store. The IPC
 * layer (Slice 2) calls this on app start and on user-triggered refresh.
 *
 * Provider coverage today:
 *   - codex     ✓ session-archive reader
 *   - claude    ✓ transcript reader (token totals only; windows from live events)
 *   - gemini    not yet (live-events-only is the planned default)
 *   - opencode  no quota concept on self-hosted; intentionally skipped
 *   - openclaw  no quota concept; intentionally skipped
 *   - hermes    no quota concept; intentionally skipped
 *
 * The "intentionally skipped" providers still get a stub snapshot row so the
 * status bar can render "self-hosted, no quota" instead of an awkward gap.
 */
import { readCodexUsageSnapshot } from './codex-reader'
import { readClaudeUsageSnapshot } from './claude-reader'
import { writeSnapshot } from './snapshot-store'
import type { UsageProviderId, UsageSnapshot } from './types'

export type { UsageSnapshot, UsageWindow, UsageTotals, UsageIndexRow, UsageProviderId } from './types'
export { readSnapshot, listIndexRows } from './snapshot-store'

const SELF_HOSTED_PROVIDERS: ReadonlyArray<UsageProviderId> = ['opencode', 'openclaw', 'hermes']

function makeSelfHostedSnapshot(provider: UsageProviderId): UsageSnapshot {
  return {
    provider,
    updatedAt: new Date().toISOString(),
    source: 'unknown',
    windows: [],
    status: 'self-hosted',
  }
}

/**
 * Refresh every provider's snapshot in parallel and persist results.
 *
 * Errors from one reader never block the others — each reader returns null on
 * failure rather than throwing, and we just skip null results. Self-hosted
 * providers always produce a "no quota" stub so the index row exists.
 */
export async function refreshAll(): Promise<UsageSnapshot[]> {
  const [codex, claude] = await Promise.all([
    readCodexUsageSnapshot().catch(() => null),
    readClaudeUsageSnapshot().catch(() => null),
  ])

  const snapshots: UsageSnapshot[] = []
  if (codex) snapshots.push(codex)
  if (claude) snapshots.push(claude)
  for (const provider of SELF_HOSTED_PROVIDERS) {
    snapshots.push(makeSelfHostedSnapshot(provider))
  }

  for (const snapshot of snapshots) {
    try {
      writeSnapshot(snapshot)
    } catch (err) {
      // Don't let one provider's persistence failure tank the whole sweep.
      // eslint-disable-next-line no-console
      console.warn(`[usage] failed to persist ${snapshot.provider}:`, err)
    }
  }
  return snapshots
}
