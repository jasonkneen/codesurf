/**
 * Format "time remaining until rate limit resets" with thresholded urgency.
 *
 * Used by the MainStatusBar quota badge and any future per-tile usage
 * display. Pure function — no React, no globals — so it's trivial to unit
 * test (see rateLimitDuration.test.ts).
 *
 * Tier definitions:
 *
 *   diff <= 0           expired   "Reset now"
 *   diff <  5m          urgent    "Resets in 4m"        (caller may tick)
 *   diff <  60m         urgent    "Resets in 47m"
 *   diff <  4h          warn      "Resets in 3h 12m"
 *   diff <  24h         calm      "Resets in 14h"
 *   else                calm      "Resets May 5"
 *
 * Why these thresholds:
 *   - 5m is the floor for "you have time to think before this matters"; any
 *     less and the user wants a tick. Anything more and a tick is just noise.
 *   - 60m is when the user can probably finish what they're doing. Above
 *     this is a planning concern, below it is an interruption concern.
 *   - 4h covers "rest of the workday" — if you have <4h, the warning helps
 *     you avoid hitting the limit mid-task.
 *   - 24h is the cliff between "today" and "later this week". The format
 *     switches because precise minutes stop mattering.
 *
 * If you tune these, prefer raising the urgent threshold to reduce alarm
 * fatigue rather than lowering it. Most users have multi-hour windows; a
 * 47-minute "URGENT" badge cried wolf is worse than a 14-minute one.
 */

export type RateLimitUrgency = 'calm' | 'warn' | 'urgent' | 'expired'

export interface RateLimitDurationDisplay {
  /** Human-readable string, e.g. "Resets in 4h 12m" or "Resets May 5". */
  label: string
  /** Urgency tier — UI maps this to color. */
  urgency: RateLimitUrgency
  /** Whether the UI should re-render this label every minute. */
  shouldTick: boolean
}

const ONE_MIN_MS = 60 * 1000
const ONE_HOUR_MS = 60 * ONE_MIN_MS

function formatHoursMinutes(diffMs: number): string {
  const totalMins = Math.max(0, Math.round(diffMs / ONE_MIN_MS))
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (hours === 0) return `${mins}m`
  if (mins === 0) return `${hours}h`
  return `${hours}h ${mins}m`
}

function formatDate(resetMs: number): string {
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(resetMs)
}

export function formatRateLimitDuration(input: {
  resetsAt: string | undefined
  /** Inject Date.now() for testability. */
  now?: number
}): RateLimitDurationDisplay {
  const nowMs = input.now ?? Date.now()
  const resetMs = input.resetsAt ? Date.parse(input.resetsAt) : Number.NaN

  if (!input.resetsAt || Number.isNaN(resetMs)) {
    return { label: '—', urgency: 'calm', shouldTick: false }
  }

  const diffMs = resetMs - nowMs

  if (diffMs <= 0) {
    return { label: 'Reset now', urgency: 'expired', shouldTick: false }
  }

  if (diffMs < 5 * ONE_MIN_MS) {
    return { label: `Resets in ${formatHoursMinutes(diffMs)}`, urgency: 'urgent', shouldTick: true }
  }

  if (diffMs < 60 * ONE_MIN_MS) {
    return { label: `Resets in ${formatHoursMinutes(diffMs)}`, urgency: 'urgent', shouldTick: false }
  }

  if (diffMs < 4 * ONE_HOUR_MS) {
    return { label: `Resets in ${formatHoursMinutes(diffMs)}`, urgency: 'warn', shouldTick: false }
  }

  if (diffMs < 24 * ONE_HOUR_MS) {
    return { label: `Resets in ${formatHoursMinutes(diffMs)}`, urgency: 'calm', shouldTick: false }
  }

  return { label: `Resets ${formatDate(resetMs)}`, urgency: 'calm', shouldTick: false }
}
