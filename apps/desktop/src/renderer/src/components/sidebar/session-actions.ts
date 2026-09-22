export const SESSION_ACTION_BUTTON_SIZE = 28
export const SESSION_ACTION_ICON_SIZE = 16
const SESSION_CHECKPOINT_PILL_WIDTH = 36
const SESSION_CHECKPOINT_RESTORE_BUTTON_WIDTH = 18
const SESSION_ROW_EXTRA_GAP = 6

export function getSessionRowExtraWidth(checkpointCount: number | null | undefined, hasMiniWindowAction = false): number {
  const miniWindowActionWidth = hasMiniWindowAction
    ? SESSION_ROW_EXTRA_GAP + SESSION_ACTION_BUTTON_SIZE
    : 0

  if ((checkpointCount ?? 0) > 0) {
    return SESSION_CHECKPOINT_PILL_WIDTH
      + SESSION_ROW_EXTRA_GAP
      + SESSION_CHECKPOINT_RESTORE_BUTTON_WIDTH
      + SESSION_ROW_EXTRA_GAP
      + miniWindowActionWidth
      + SESSION_ACTION_BUTTON_SIZE
  }
  return miniWindowActionWidth + SESSION_ACTION_BUTTON_SIZE
}

export function getSessionArchiveActionLabel(isArchived: boolean): string {
  return isArchived ? 'Unarchive conversation' : 'Archive conversation'
}

/**
 * Compact codex-style relative time for sidebar session rows.
 * Examples: "just now", "20s", "5m", "3h", "2d", "1w", "4mo", "2y"
 */
export function formatSessionSidebarRelativeTime(timestamp: number | null | undefined, now: number = Date.now()): string {
  if (timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0) return ''
  const diffSeconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  const minutes = Math.max(1, Math.floor(diffSeconds / 60))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  const years = Math.floor(days / 365)
  return `${years}y`
}
