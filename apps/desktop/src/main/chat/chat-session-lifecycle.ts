export interface ConfirmedStopResult {
  ok: boolean
  error?: string
}

export interface ConfirmedSessionClearDependencies {
  stopExecution(): Promise<ConfirmedStopResult> | ConfirmedStopResult
  clearPersistedState(): Promise<void> | void
  evictSessionState(): Promise<void> | void
}

/**
 * Clear authoritative state and then local session maps only after provider
 * teardown has positively completed. A failed or unconfirmed stop leaves every
 * session identifier available for a later retry.
 */
export async function runConfirmedSessionClear(
  dependencies: ConfirmedSessionClearDependencies,
): Promise<ConfirmedStopResult> {
  const stopped = await dependencies.stopExecution()
  if (!stopped.ok) return stopped

  try {
    await dependencies.clearPersistedState()
  } catch (error) {
    return {
      ok: false,
      error: `Could not clear persisted daemon session: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  await dependencies.evictSessionState()
  return { ok: true }
}
