/**
 * UsageSnapshot store - pointer + overlay persistence.
 *
 * On disk:
 *   ~/.codesurf/usage/<provider>.json   - canonical full snapshot
 *   provider_rate_limits_index        - SQLite row mirroring hot fields
 *
 * The JSON file is truth. The SQLite row exists only so the status-bar
 * "highest used quota across all providers" query can run in microseconds
 * without reading every JSON file. If SQLite is wiped, callers can rebuild
 * rows by reading the JSON dir; if the JSON dir is wiped, the next snapshot
 * write recreates both.
 *
 * Concurrency:
 *   - JSON writes are atomic (write to .tmp, fsync, rename).
 *   - SQLite upserts use the same monotonic-updated_at guard as dpcode's
 *     projection: an older snapshot cannot overwrite a newer one even if
 *     events arrive out of order.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'node:crypto'
import { CODESURF_HOME } from '../paths'
import { getDb, getDeviceId } from '../db'
import type { UsageIndexRow, UsageProviderId, UsageSnapshot } from './types'

const USAGE_DIR = join(CODESURF_HOME, 'usage')

function ensureUsageDir(): void {
  mkdirSync(USAGE_DIR, { recursive: true })
}

export function getSnapshotFilePath(provider: UsageProviderId): string {
  return join(USAGE_DIR, `${provider}.json`)
}

function atomicWriteJson(filePath: string, value: unknown): { mtimeMs: number; sizeBytes: number } {
  mkdirSync(dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  const payload = `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(tempPath, payload, 'utf8')
  renameSync(tempPath, filePath)
  const info = statSync(filePath)
  return { mtimeMs: info.mtimeMs, sizeBytes: info.size }
}

function pickWindow(
  snapshot: UsageSnapshot,
  preferred: ReadonlyArray<string>,
): UsageSnapshot['windows'][number] | null {
  for (const label of preferred) {
    const match = snapshot.windows.find(w => w.window === label)
    if (match) return match
  }
  return snapshot.windows[0] ?? null
}

/**
 * Map a snapshot to the denormalized fields stored in `provider_rate_limits_index`.
 *
 * We pick the "primary" window as the shortest known window (5h or Daily), and
 * "secondary" as the longer one (Weekly). This matches Codex's primary/secondary
 * vocabulary directly and gives Claude's five_hour/seven_day a sensible mapping.
 */
function denormalize(snapshot: UsageSnapshot): {
  primary: UsageSnapshot['windows'][number] | null
  secondary: UsageSnapshot['windows'][number] | null
} {
  const primary = pickWindow(snapshot, ['5h', 'Daily', 'Session'])
  const secondaryCandidates = snapshot.windows.filter(w => w !== primary)
  const secondary = secondaryCandidates.find(w => w.window === 'Weekly') ?? secondaryCandidates[0] ?? null
  return { primary, secondary }
}

/**
 * Persist a snapshot. Writes the JSON file first, then upserts the index row.
 *
 * The JSON-first ordering matters: if SQLite write fails, the JSON file is
 * still readable on next startup and the index can rebuild from it. If the
 * JSON write fails, we never poison the index with a stale pointer.
 */
export function writeSnapshot(snapshot: UsageSnapshot): { filePath: string } {
  ensureUsageDir()
  const filePath = getSnapshotFilePath(snapshot.provider)
  const { mtimeMs, sizeBytes } = atomicWriteJson(filePath, snapshot)

  const { primary, secondary } = denormalize(snapshot)
  const db = getDb()

  // Monotonic guard: only overwrite when the incoming updated_at is >= the
  // existing row's. WHERE clause on the conflict update is the same trick
  // dpcode uses; it survives out-of-order delivery from retries or replay.
  db.prepare(`
    INSERT INTO provider_rate_limits_index (
      provider, device_id, updated_at, file_path,
      primary_window, primary_used_pct, primary_resets_at,
      secondary_window, secondary_used_pct, secondary_resets_at,
      status, source, source_mtime_ms, source_size_bytes
    )
    VALUES (
      @provider, @deviceId, @updatedAt, @filePath,
      @primaryWindow, @primaryUsedPct, @primaryResetsAt,
      @secondaryWindow, @secondaryUsedPct, @secondaryResetsAt,
      @status, @source, @sourceMtimeMs, @sourceSizeBytes
    )
    ON CONFLICT (provider) DO UPDATE SET
      device_id           = excluded.device_id,
      updated_at          = excluded.updated_at,
      file_path           = excluded.file_path,
      primary_window      = excluded.primary_window,
      primary_used_pct    = excluded.primary_used_pct,
      primary_resets_at   = excluded.primary_resets_at,
      secondary_window    = excluded.secondary_window,
      secondary_used_pct  = excluded.secondary_used_pct,
      secondary_resets_at = excluded.secondary_resets_at,
      status              = excluded.status,
      source              = excluded.source,
      source_mtime_ms     = excluded.source_mtime_ms,
      source_size_bytes   = excluded.source_size_bytes
    WHERE excluded.updated_at >= provider_rate_limits_index.updated_at
  `).run({
    provider: snapshot.provider,
    deviceId: getDeviceId(),
    updatedAt: snapshot.updatedAt,
    filePath,
    primaryWindow: primary?.window ?? null,
    primaryUsedPct: primary?.usedPercent ?? null,
    primaryResetsAt: primary?.resetsAt ?? null,
    secondaryWindow: secondary?.window ?? null,
    secondaryUsedPct: secondary?.usedPercent ?? null,
    secondaryResetsAt: secondary?.resetsAt ?? null,
    status: snapshot.status ?? null,
    source: snapshot.source,
    sourceMtimeMs: Math.round(mtimeMs),
    sourceSizeBytes: sizeBytes,
  })

  return { filePath }
}

/** Read a single provider snapshot from disk. Returns null on missing/corrupt. */
export function readSnapshot(provider: UsageProviderId): UsageSnapshot | null {
  const filePath = getSnapshotFilePath(provider)
  if (!existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as UsageSnapshot
    if (!parsed || typeof parsed !== 'object' || parsed.provider !== provider) return null
    return parsed
  } catch {
    return null
  }
}

/** Read all known snapshots in one pass. Used by the status-bar aggregator. */
export function listSnapshots(): UsageSnapshot[] {
  if (!existsSync(USAGE_DIR)) return []
  const files = readdirSync(USAGE_DIR).filter(name => name.endsWith('.json'))
  const snapshots: UsageSnapshot[] = []
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(USAGE_DIR, file), 'utf8')) as UsageSnapshot
      if (parsed && typeof parsed === 'object' && typeof parsed.provider === 'string') {
        snapshots.push(parsed)
      }
    } catch {
      // skip corrupt files; they will be overwritten on next snapshot write
    }
  }
  return snapshots
}

/** Read all index rows. Cheaper than listSnapshots for status-bar polling. */
export function listIndexRows(): UsageIndexRow[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT
      provider,
      device_id           AS deviceId,
      updated_at          AS updatedAt,
      file_path           AS filePath,
      primary_window      AS primaryWindow,
      primary_used_pct    AS primaryUsedPct,
      primary_resets_at   AS primaryResetsAt,
      secondary_window    AS secondaryWindow,
      secondary_used_pct  AS secondaryUsedPct,
      secondary_resets_at AS secondaryResetsAt,
      status,
      source,
      source_mtime_ms     AS sourceMtimeMs,
      source_size_bytes   AS sourceSizeBytes
    FROM provider_rate_limits_index
    ORDER BY provider ASC
  `).all() as UsageIndexRow[]
  return rows
}
