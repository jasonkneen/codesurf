import type { ExecutionHostRecord } from '../../shared/types'
import type { ExecutionMode } from '../../shared/execution-types'

export interface AttachmentRoutePolicyInput {
  selectedHost: ExecutionHostRecord | null
  executionMode: ExecutionMode
  /** Set only after the host has validated a selection receipt/capability. */
  hasHostAttachments: boolean
}

/**
 * Daemon chat jobs intentionally reject binary attachments until every daemon
 * provider transport carries verified bytes. Automatic local-daemon routing
 * therefore falls back to the capable in-process runtime for attachment turns.
 * Explicit daemon pins fail closed instead of silently violating user intent.
 */
export function routeHostForAttachments({
  selectedHost,
  executionMode,
  hasHostAttachments,
}: AttachmentRoutePolicyInput): ExecutionHostRecord | null {
  if (!hasHostAttachments || selectedHost?.type !== 'local-daemon') return selectedHost
  if (executionMode === 'auto' || executionMode === 'prefer-local-daemon') return null
  throw new Error(
    'Attachments require the local runtime because daemon-backed chat does not yet transport verified image bytes.',
  )
}
