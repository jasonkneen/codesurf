export class RelayProviderCancelledError extends Error {
  constructor(label: string, cause?: unknown) {
    super(
      `${label} turn was cancelled`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'RelayProviderCancelledError'
  }
}

export type RelayProviderCancellation = {
  abortController: AbortController
  cancelled: Promise<never>
  dispose(): void
}

/**
 * Link a runtime-owned signal to a provider-owned AbortController.
 *
 * SDK providers receive the child controller, while the cancellation promise
 * makes teardown observable even if an SDK is slow to reject its iterator.
 */
export function createRelayProviderCancellation(
  label: string,
  signal?: AbortSignal,
): RelayProviderCancellation {
  if (signal?.aborted) {
    throw new RelayProviderCancelledError(label, signal.reason)
  }

  const abortController = new AbortController()
  let rejectCancelled!: (error: Error) => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject
  })

  const onAbort = (): void => {
    if (abortController.signal.aborted) return
    const error = new RelayProviderCancelledError(label, signal?.reason)
    abortController.abort(error)
    rejectCancelled(error)
  }

  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()

  return {
    abortController,
    cancelled,
    dispose() {
      signal?.removeEventListener('abort', onAbort)
    },
  }
}
