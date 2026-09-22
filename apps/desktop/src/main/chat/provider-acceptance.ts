const ACCEPTED_STREAM_EVENT_TYPES = new Set([
  'text',
  'thinking',
  'reasoning',
  'tool_start',
  'tool_use',
  'tool_input',
  'tool_progress',
  'tool_summary',
  'ask_user_question',
])

/** Setup/session/lifecycle events are not proof that the prompt was accepted. */
export function isProviderAcceptanceEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false
  const descriptor = Object.getOwnPropertyDescriptor(event, 'type')
  return Boolean(
    descriptor
    && 'value' in descriptor
    && typeof descriptor.value === 'string'
    && ACCEPTED_STREAM_EVENT_TYPES.has(descriptor.value),
  )
}

export function isSuccessfulProviderCompletion(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false
  const status = Object.getOwnPropertyDescriptor(state, 'status')
  const error = Object.getOwnPropertyDescriptor(state, 'error')
  return status?.value === 'completed' && !error?.value
}

export type ProviderCompletionPollOutcome =
  | 'accepted'
  | 'rejected'
  | 'timeout'
  | 'superseded'

/**
 * Bounded polling for detached jobs. The caller supplies lifecycle ownership
 * so a replacement turn/card stop cannot leave an orphaned loop behind.
 */
export async function pollProviderCompletion(options: {
  readState: () => Promise<unknown | null>
  isActive: () => boolean
  wait?: (milliseconds: number) => Promise<void>
  intervalMs?: number
  maxAttempts?: number
}): Promise<ProviderCompletionPollOutcome> {
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const intervalMs = Math.max(1, Math.floor(options.intervalMs ?? 750))
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 80))

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!options.isActive()) return 'superseded'
    await wait(intervalMs)
    if (!options.isActive()) return 'superseded'
    const state = await options.readState().catch(() => null)
    if (!state || typeof state !== 'object') continue
    const status = Object.getOwnPropertyDescriptor(state, 'status')?.value
    if (status === 'running' || status === 'queued' || status === 'starting') continue
    return isSuccessfulProviderCompletion(state) ? 'accepted' : 'rejected'
  }

  return 'timeout'
}
