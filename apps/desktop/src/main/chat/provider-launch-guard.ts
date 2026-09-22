export interface ProviderLaunchGuard {
  isCurrent(): boolean
}

export type ProviderPrelaunchResult<T> =
  | { ok: true; value: T }
  | { ok: false }

export interface ProviderPrelaunchOperation<TPrepared, TLaunched> {
  guard?: ProviderLaunchGuard
  prepare(): Promise<TPrepared> | TPrepared
  disposePrepared?(prepared: TPrepared): Promise<void> | void
  launch(prepared: TPrepared): TLaunched
}

export type GuardedPreparationResult<T> =
  | { ok: true; value: T }
  | { ok: false }

/** Re-check a turn lease after awaited setup and dispose stale prepared state. */
export async function awaitGuardedPreparation<T>(
  guard: ProviderLaunchGuard | undefined,
  preparation: Promise<T>,
  dispose?: (value: T) => void | Promise<void>,
): Promise<GuardedPreparationResult<T>> {
  const value = await preparation
  if (!guard || guard.isCurrent()) return { ok: true, value }
  await dispose?.(value)
  return { ok: false }
}

export function providerLaunchIsCurrent(guard?: ProviderLaunchGuard): boolean {
  return guard?.isCurrent() ?? true
}

/**
 * The last asynchronous boundary before an adapter starts provider work.
 * Preparation is dependency-injected so tests can hold it open while the
 * Electron lifecycle fence is invalidated. A stale prepared value is always
 * disposed and is never passed to the launch callback.
 */
export class ProviderPrelaunchBoundary {
  readonly provider: 'codex' | 'opencode' | 'csagent'

  constructor(provider: 'codex' | 'opencode' | 'csagent') {
    this.provider = provider
  }

  async run<TPrepared, TLaunched>(
    operation: ProviderPrelaunchOperation<TPrepared, TLaunched>,
  ): Promise<ProviderPrelaunchResult<TLaunched>> {
    if (!providerLaunchIsCurrent(operation.guard)) return { ok: false }

    const prepared = await operation.prepare()
    if (!providerLaunchIsCurrent(operation.guard)) {
      await operation.disposePrepared?.(prepared)
      return { ok: false }
    }

    try {
      return { ok: true, value: operation.launch(prepared) }
    } catch (error) {
      // Launch is the ownership handoff point. If the provider refuses to
      // start, prepared state (temporary files, servers, or sessions) still
      // belongs to this boundary and must be released before the error travels
      // back to the caller. Preserve the launch error if cleanup itself fails.
      try {
        await operation.disposePrepared?.(prepared)
      } catch {
        // The original launch failure is the actionable error for the caller.
      }
      throw error
    }
  }
}

/** Adapter-owned instances used at the production spawn/server/prompt seams. */
export const codexPrelaunchBoundary = new ProviderPrelaunchBoundary('codex')
export const openCodePrelaunchBoundary = new ProviderPrelaunchBoundary('opencode')
export const csagentPrelaunchBoundary = new ProviderPrelaunchBoundary('csagent')
