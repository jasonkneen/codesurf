import { randomUUID } from 'node:crypto'

export const WINDOW_PERSISTENCE_REQUEST_CHANNEL = 'window:persistence-request'
export const WINDOW_PERSISTENCE_READY_CHANNEL = 'window:persistence-ready'
export const WINDOW_PERSISTENCE_BARRIER_TIMEOUT_MS = 2_000

export type WindowPersistenceReason = 'close' | 'quit' | 'reload' | 'force-reload'
export type PersistenceWindowRole = 'primary-canvas' | 'auxiliary'

type TimeoutHandle = ReturnType<typeof setTimeout> | number

export interface PersistenceBarrierWebContents {
  readonly id: number
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

export interface PersistenceBarrierWindow {
  readonly webContents: PersistenceBarrierWebContents
  isDestroyed(): boolean
  close(): void
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown
  on(event: 'closed' | 'focus', listener: () => void): unknown
  off(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown
  off(event: 'closed' | 'focus', listener: () => void): unknown
}

export interface PersistenceBarrierIpcEvent {
  sender: PersistenceBarrierWebContents
}

export interface PersistenceBarrierIpc {
  on(
    channel: typeof WINDOW_PERSISTENCE_READY_CHANNEL,
    listener: (event: PersistenceBarrierIpcEvent, payload: unknown) => void,
  ): unknown
  off(
    channel: typeof WINDOW_PERSISTENCE_READY_CHANNEL,
    listener: (event: PersistenceBarrierIpcEvent, payload: unknown) => void,
  ): unknown
}

export type WindowPersistenceBarrierOptions = {
  timeoutMs?: number
  createNonce?: () => string
  setTimeout?: (callback: () => void, timeoutMs: number) => TimeoutHandle
  clearTimeout?: (handle: TimeoutHandle) => void
}

type PendingChallenge = {
  nonce: string
  timeoutHandle: TimeoutHandle
  resolve: () => void
}

type InstalledBarrier = {
  readonly window: PersistenceBarrierWindow
  readonly sender: PersistenceBarrierWebContents
  readonly role: PersistenceWindowRole
  focusSequence: number | null
  dispose: () => void
  accept: (nonce: string) => boolean
  requestPersistence: (reason: WindowPersistenceReason) => Promise<void>
  requestClose: (reason: 'close' | 'quit') => Promise<void>
}

/**
 * Installs a reusable persistence challenge per BrowserWindow. A renderer
 * cannot approve another window's transition: IPC routing is keyed by the
 * exact WebContents object and every transition carries a fresh nonce.
 *
 * Whole-app shutdown is deliberately ordered. Auxiliary windows settle first,
 * followed by primary canvas windows, with the most recently focused primary
 * last so its canvas snapshot is the deterministic final writer. If no primary
 * has emitted focus, the lowest WebContents id is the stable fallback winner.
 */
export function createWindowPersistenceBarrierRegistry(
  ipc: PersistenceBarrierIpc,
  options: WindowPersistenceBarrierOptions = {},
): {
  install: (
    window: PersistenceBarrierWindow,
    options: { role: PersistenceWindowRole },
  ) => () => void
  requestPersistence: (
    window: PersistenceBarrierWindow,
    reason: WindowPersistenceReason,
  ) => Promise<void>
  closeAll: () => Promise<void>
  dispose: () => void
} {
  const timeoutMs = options.timeoutMs ?? WINDOW_PERSISTENCE_BARRIER_TIMEOUT_MS
  const createNonce = options.createNonce ?? randomUUID
  const scheduleTimeout = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay))
  const cancelTimeout = options.clearTimeout ?? (handle => clearTimeout(handle))
  const barriers = new Map<PersistenceBarrierWebContents, InstalledBarrier>()
  let focusSequence = 0
  let wholeAppClosing = false

  const onPersistenceReady = (
    event: PersistenceBarrierIpcEvent,
    payload: unknown,
  ): void => {
    const nonce = payload && typeof payload === 'object'
      ? (payload as { nonce?: unknown }).nonce
      : null
    if (typeof nonce !== 'string' || nonce.length === 0) return
    barriers.get(event.sender)?.accept(nonce)
  }
  ipc.on(WINDOW_PERSISTENCE_READY_CHANNEL, onPersistenceReady)

  const install = (
    window: PersistenceBarrierWindow,
    installOptions: { role: PersistenceWindowRole },
  ): (() => void) => {
    const sender = window.webContents
    const existing = barriers.get(sender)
    if (existing) return existing.dispose

    let pendingChallenge: PendingChallenge | null = null
    let requestTail: Promise<void> = Promise.resolve()
    let closeRequest: Promise<void> | null = null
    let closeAllowed = false
    let disposed = false

    const completeChallenge = (nonce: string): boolean => {
      if (disposed || pendingChallenge?.nonce !== nonce) return false
      const pending = pendingChallenge
      pendingChallenge = null
      cancelTimeout(pending.timeoutHandle)
      pending.resolve()
      return true
    }

    const runChallenge = (reason: WindowPersistenceReason): Promise<void> => {
      if (disposed || window.isDestroyed() || sender.isDestroyed()) {
        return Promise.resolve()
      }
      return new Promise<void>(resolve => {
        const nonce = createNonce()
        const timeoutHandle = scheduleTimeout(() => {
          completeChallenge(nonce)
        }, timeoutMs)
        pendingChallenge = { nonce, timeoutHandle, resolve }
        try {
          sender.send(WINDOW_PERSISTENCE_REQUEST_CHANNEL, {
            nonce,
            reason,
            canvasOwner: installOptions.role === 'primary-canvas',
          })
        } catch {
          completeChallenge(nonce)
        }
      })
    }

    const requestPersistence = (reason: WindowPersistenceReason): Promise<void> => {
      const request = requestTail
        .catch(() => {})
        .then(() => runChallenge(reason))
      requestTail = request.catch(() => {})
      return request
    }

    const requestClose = (reason: 'close' | 'quit'): Promise<void> => {
      if (reason === 'close') {
        if (closeRequest) return closeRequest
        let individualClose!: Promise<void>
        individualClose = requestPersistence('close').then(() => {
          // App quit may begin while this individual challenge is pending. Do
          // not let it close (and disappear from ownership order); closeAll
          // will issue a fresh quit challenge at the window's ordered slot.
          if (wholeAppClosing) {
            if (closeRequest === individualClose) closeRequest = null
            return
          }
          if (disposed || window.isDestroyed()) return
          closeAllowed = true
          window.close()
        })
        closeRequest = individualClose
        return individualClose
      }

      // A quit always receives a fresh challenge, even when an individual
      // close was already pending. This is essential for the designated final
      // primary to actually be the final canvas writer.
      const precedingClose = closeRequest ?? Promise.resolve()
      const quitClose = precedingClose
        .catch(() => {})
        .then(async () => {
          if (disposed || window.isDestroyed()) return
          await requestPersistence('quit')
          if (disposed || window.isDestroyed()) return
          closeAllowed = true
          window.close()
        })
      closeRequest = quitClose
      return quitClose
    }

    const onClose = (event: { preventDefault(): void }): void => {
      if (closeAllowed || disposed) return
      event.preventDefault()
      void requestClose('close')
    }

    const barrier: InstalledBarrier = {
      window,
      sender,
      role: installOptions.role,
      focusSequence: null,
      dispose: () => {},
      accept: completeChallenge,
      requestPersistence,
      requestClose,
    }

    const onFocus = (): void => {
      if (barrier.role !== 'primary-canvas') return
      focusSequence += 1
      barrier.focusSequence = focusSequence
    }

    const dispose = (): void => {
      if (disposed) return
      disposed = true
      if (pendingChallenge) {
        const pending = pendingChallenge
        pendingChallenge = null
        cancelTimeout(pending.timeoutHandle)
        pending.resolve()
      }
      barriers.delete(sender)
      window.off('close', onClose)
      window.off('closed', dispose)
      window.off('focus', onFocus)
    }
    barrier.dispose = dispose

    barriers.set(sender, barrier)
    window.on('close', onClose)
    window.on('closed', dispose)
    window.on('focus', onFocus)
    return dispose
  }

  const requestPersistence = (
    window: PersistenceBarrierWindow,
    reason: WindowPersistenceReason,
  ): Promise<void> => {
    return barriers.get(window.webContents)?.requestPersistence(reason) ?? Promise.resolve()
  }

  const orderedCloseBarriers = (): InstalledBarrier[] => {
    const live = [...barriers.values()].filter(barrier => (
      !barrier.window.isDestroyed() && !barrier.sender.isDestroyed()
    ))
    const auxiliaries = live
      .filter(barrier => barrier.role === 'auxiliary')
      .sort((a, b) => a.sender.id - b.sender.id)
    const primaries = live
      .filter(barrier => barrier.role === 'primary-canvas')
    if (primaries.length === 0) return auxiliaries

    const focusedWinner = primaries
      .filter(barrier => barrier.focusSequence !== null)
      .sort((a, b) => (b.focusSequence ?? 0) - (a.focusSequence ?? 0))[0]
    const winner = focusedWinner
      ?? [...primaries].sort((a, b) => a.sender.id - b.sender.id)[0]
    const precedingPrimaries = primaries
      .filter(barrier => barrier !== winner)
      .sort((a, b) => a.sender.id - b.sender.id)
    return [...auxiliaries, ...precedingPrimaries, winner]
  }

  let closeAllPromise: Promise<void> | null = null
  const closeAll = (): Promise<void> => {
    if (closeAllPromise) return closeAllPromise
    wholeAppClosing = true
    closeAllPromise = orderedCloseBarriers().reduce(
      (tail, barrier) => tail.then(() => barrier.requestClose('quit')),
      Promise.resolve(),
    )
    return closeAllPromise
  }

  const dispose = (): void => {
    ipc.off(WINDOW_PERSISTENCE_READY_CHANNEL, onPersistenceReady)
    for (const barrier of [...barriers.values()]) barrier.dispose()
  }

  return { install, requestPersistence, closeAll, dispose }
}

export interface AppQuitBarrierApp {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown
  off(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown
  quit(): void
}

/**
 * Electron aborts app.quit when any BrowserWindow prevents its close. Hold the
 * first quit request, settle every window persistence challenge in ownership
 * order, then resume app.quit exactly once.
 */
/**
 * How many times shutdown cleanup may fail before the barrier stops blocking
 * quit. Retrying is right for a transient failure; blocking forever is not.
 */
export const MAX_QUIT_CLEANUP_ATTEMPTS = 3

export function installAppQuitBarrier(
  app: AppQuitBarrierApp,
  getRegistry: () => Pick<
    ReturnType<typeof createWindowPersistenceBarrierRegistry>,
    'closeAll'
  > | null,
  cleanup: () => void | Promise<void>,
  onError: (error: unknown) => void = error => {
    console.error('[window] persistence barrier failed:', error)
  },
): () => void {
  let resumeQuit = false
  let resumeScheduled = false
  let cleanupPromise: Promise<void> | null = null
  let cleanupFailures = 0

  const runCleanup = (): Promise<void> => {
    if (!cleanupPromise) {
      cleanupPromise = Promise.resolve().then(cleanup)
    }
    return cleanupPromise
  }

  const onBeforeQuit = (event: { preventDefault(): void }): void => {
    if (resumeQuit) return

    event.preventDefault()
    if (resumeScheduled) return
    resumeScheduled = true
    const registry = getRegistry()
    void (registry?.closeAll() ?? Promise.resolve())
      .catch(onError)
      .then(async () => {
        try {
          await runCleanup()
        } catch (error) {
          // Persistence challenges may fail open after reporting because the
          // renderer cannot keep external processes alive. Cleanup is
          // different: an unconfirmed provider process tree must keep app
          // shutdown fail-closed instead of orphaning descendants.
          //
          // Failing closed ONCE is intentional; failing closed forever is not.
          // Previously `resumeScheduled` stayed latched and `cleanupPromise`
          // memoized the rejection, so every later quit was preventDefault'd
          // and re-awaited the same cached failure — Cmd+Q, dock Quit and
          // window-all-closed all became silent no-ops and the only way out was
          // a force-quit, which skips the very persistence this barrier exists
          // to protect. Drop the memo and unlatch so the next quit genuinely
          // retries, and give up after a bounded number of attempts.
          cleanupFailures += 1
          onError(error)
          cleanupPromise = null
          resumeScheduled = false
          if (cleanupFailures >= MAX_QUIT_CLEANUP_ATTEMPTS) {
            onError(new Error(
              `[window] shutdown cleanup failed ${cleanupFailures} times; quitting anyway to avoid trapping the app`,
            ))
            resumeQuit = true
            app.quit()
          }
          return
        }
        if (resumeQuit) return
        resumeQuit = true
        app.quit()
      })
  }

  app.on('before-quit', onBeforeQuit)
  return () => app.off('before-quit', onBeforeQuit)
}
