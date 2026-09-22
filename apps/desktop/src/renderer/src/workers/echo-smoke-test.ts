/**
 * Phase 0 smoke test — verifies Vite's `?worker&inline` syntax compiles
 * and the useWorker hook plumbs a round-trip cleanly.
 *
 * NOT imported anywhere by default. To run: temporarily import this file
 * from App.tsx and call `runEchoSmokeTest()` once on mount, then check the
 * DevTools console.
 *
 * Safe to delete once Phase 1 lands.
 */
import EchoWorker from './echo.worker?worker&inline'

export async function runEchoSmokeTest(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const worker = new EchoWorker()
    const start = performance.now()
    worker.onmessage = (e: MessageEvent<{ requestId: number; payload: unknown; _echo?: boolean }>) => {
      const elapsed = performance.now() - start
      const ok = e.data._echo === true && e.data.requestId === 42 && e.data.payload === 'hello'
      // eslint-disable-next-line no-console
      console.log(`[echo-smoke] round-trip ${ok ? 'OK' : 'FAIL'} in ${elapsed.toFixed(2)}ms`, e.data)
      worker.terminate()
      resolve(ok)
    }
    worker.onerror = (e: ErrorEvent) => {
      // eslint-disable-next-line no-console
      console.error('[echo-smoke] worker error:', e.message)
      worker.terminate()
      resolve(false)
    }
    worker.postMessage({ requestId: 42, payload: 'hello' })
  })
}
