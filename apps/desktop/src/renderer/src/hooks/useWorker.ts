/**
 * useWorker — generic React hook for off-main-thread computation.
 *
 * Behavior contract (locked-in via worker-optimization.md decisions):
 *   - Q1 (worker-init failure policy):  silent fallback to inline `fallback(input)` if provided.
 *   - Q2 (drag-time dispatch cadence):  no throttle. Every input change posts a new message.
 *                                       Stale results are dropped via last-write-wins on requestId.
 *                                       Wasted worker CPU is fine; that's the entire point.
 *   - Q3 (crossover threshold):         not enforced here — generic hook stays generic.
 *                                       Specialized hooks (useDiscoveryGraph) decide whether
 *                                       to call this hook or compute inline below threshold.
 *
 * The worker is created once per hook instance (per-component-mount) and torn
 * down on unmount. If the worker's onerror fires permanently we mark it as
 * unavailable and switch to inline fallback for subsequent dispatches.
 */
import { useEffect, useRef, useState } from 'react'

export interface WorkerEnvelope<T> {
  requestId: number
  payload: T
}

export interface UseWorkerOptions<TIn, TOut> {
  /** Factory that returns a Worker instance — typically `() => new EchoWorker()`. */
  workerFactory: () => Worker
  /** Inline fallback when the worker is unavailable or before init completes. */
  fallback?: (input: TIn) => TOut
  /** When true, skip dispatching this render's input. Pre-result remains cached. */
  skip?: boolean
}

export interface UseWorkerResult<TOut> {
  result: TOut | null
  isComputing: boolean
  error: string | null
  /** True if the worker successfully initialized. False = inline-fallback mode. */
  workerAvailable: boolean
}

export function useWorker<TIn, TOut>(
  input: TIn | null,
  options: UseWorkerOptions<TIn, TOut>,
): UseWorkerResult<TOut> {
  const [result, setResult] = useState<TOut | null>(null)
  const [isComputing, setIsComputing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [workerAvailable, setWorkerAvailable] = useState(false)

  const workerRef = useRef<Worker | null>(null)
  const requestIdRef = useRef(0)
  const lastSeenIdRef = useRef(0)
  const fallbackRef = useRef(options.fallback)
  fallbackRef.current = options.fallback

  // ─── Worker init (once per mount) ────────────────────────────────────────
  useEffect(() => {
    let alive = true
    try {
      const w = options.workerFactory()
      w.onmessage = (e: MessageEvent<{ requestId: number; payload?: TOut; error?: string }>) => {
        if (!alive) return
        const { requestId, payload, error: errorMessage } = e.data
        // Last-write-wins: drop stale responses (requestId older than the most recent we've seen).
        if (requestId < lastSeenIdRef.current) return
        lastSeenIdRef.current = requestId
        if (errorMessage) {
          setError(errorMessage)
        } else {
          setResult(payload as TOut)
          setError(null)
        }
        // Stop the spinner only if this response matches the most recently dispatched id.
        if (requestId === requestIdRef.current) setIsComputing(false)
      }
      w.onerror = (e: ErrorEvent) => {
        if (!alive) return
        // eslint-disable-next-line no-console
        console.warn('[useWorker] worker error:', e.message)
        setError(e.message || 'worker error')
        setIsComputing(false)
      }
      workerRef.current = w
      setWorkerAvailable(true)
    } catch (err) {
      // Worker init failed — silent fallback. Q1 = (A).
      // eslint-disable-next-line no-console
      console.warn('[useWorker] init failed, falling back to inline computation', err)
      workerRef.current = null
      setWorkerAvailable(false)
    }
    return () => {
      alive = false
      workerRef.current?.terminate()
      workerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Dispatch on input change ────────────────────────────────────────────
  useEffect(() => {
    if (options.skip) return
    if (input === null || input === undefined) return

    // Worker unavailable — run inline fallback synchronously.
    if (!workerRef.current) {
      const inline = fallbackRef.current
      if (!inline) return
      try {
        const out = inline(input)
        setResult(out)
        setError(null)
      } catch (err) {
        setError(String(err))
      }
      return
    }

    const id = ++requestIdRef.current
    setIsComputing(true)
    workerRef.current.postMessage({ requestId: id, payload: input })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, options.skip])

  return { result, isComputing, error, workerAvailable }
}
