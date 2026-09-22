/**
 * Shared types for provider usage tracking.
 *
 * Designed to be the single shape all readers (codex / claude / live event /
 * future gemini & opencode) emit, and the single shape the renderer consumes
 * via IPC. Keeping this in `src/main/usage/` rather than `src/shared/` because
 * the renderer's view is reached through an IPC adapter, not direct imports.
 */

export type UsageProviderId = 'claude' | 'codex' | 'opencode' | 'openclaw' | 'hermes' | 'gemini'

/** Where a snapshot came from. Drives stale-data warnings in the UI. */
export type UsageSnapshotSource =
  | 'live-event'        // freshly observed during a turn
  | 'session-archive'   // parsed from on-disk session files (codex)
  | 'transcripts'       // parsed from on-disk chat transcripts (claude)
  | 'unknown'

/**
 * One quota window for a provider — typically the 5-hour rolling session and
 * the weekly tier cap. Modeled as optional fields so providers that only emit
 * partial data (e.g. resetsAt without used_pct) still produce a useful row.
 */
export interface UsageWindow {
  /** Stable label: '5h' | 'Weekly' | 'Daily' | provider-specific. */
  window: string
  /** 0..100 — already clamped before storage. */
  usedPercent?: number
  /** ISO timestamp when this window resets. */
  resetsAt?: string
  /** Window length in minutes (300 for 5h, 10080 for Weekly, 1440 for Daily). */
  windowDurationMins?: number
}

/**
 * Aggregated rolling usage totals, mirroring dpcode's "24h / 7d / 30d" lines.
 * Token totals only — no quota interpretation. Useful for "you've spent X
 * tokens this week" displays even when no rate-limit window is known.
 */
export interface UsageTotals {
  tokens24h: number
  tokens7d: number
  tokens30d: number
  sessions24h: number
  sessions7d: number
  sessions30d: number
}

/** What we persist to ~/.codesurf/usage/<provider>.json and surface to the UI. */
export interface UsageSnapshot {
  provider: UsageProviderId
  /** ISO timestamp of when this snapshot was last refreshed. */
  updatedAt: string
  source: UsageSnapshotSource
  /** Quota windows. Empty array is valid ("no known quota"). */
  windows: UsageWindow[]
  /** Optional rolling totals if the reader could compute them. */
  totals?: UsageTotals
  /**
   * Optional status string the provider stamps on the rate-limit event itself.
   * Claude emits 'rejected' / 'allowed_warning' here.
   */
  status?: string
}

/** A row stored in `provider_rate_limits_index` — denormalized for fast reads. */
export interface UsageIndexRow {
  provider: UsageProviderId
  deviceId: string
  updatedAt: string
  filePath: string
  primaryWindow: string | null
  primaryUsedPct: number | null
  primaryResetsAt: string | null
  secondaryWindow: string | null
  secondaryUsedPct: number | null
  secondaryResetsAt: string | null
  status: string | null
  source: UsageSnapshotSource
  sourceMtimeMs: number
  sourceSizeBytes: number
}
