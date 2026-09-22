/**
 * usePluginState — read/write a plugin's durable reactive store from the renderer.
 *
 * Backed by ext:store-* IPC + the event bus channel `plugin:<id>:state` (see
 * src/main/extensions/plugin-store.ts). Returns the current state and an updater that
 * shallow-merges a patch (optimistic locally, persisted + broadcast in main). Any
 * other view subscribed to the same plugin updates live.
 */

import { useState, useEffect, useCallback } from 'react'

const el = (window as { electron?: any }).electron

let subCounter = 0

export function usePluginState(
  extId: string,
): [Record<string, unknown>, (patch: Record<string, unknown>) => void] {
  const [state, setState] = useState<Record<string, unknown>>({})

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const initial = await el?.extensions?.storeGet?.(extId)
        if (!cancelled && initial) setState(initial)
      } catch (err) {
        console.warn('[usePluginState] initial read failed:', err)
      }
    })()

    const subId = `usePluginState:${extId}:${++subCounter}`
    let unsub: (() => void) | undefined
    try {
      unsub = el?.bus?.subscribe?.(`plugin:${extId}:state`, subId, (evt: { payload?: { state?: Record<string, unknown> } }) => {
        const next = evt?.payload?.state
        if (next && !cancelled) setState(next)
      })
    } catch (err) {
      console.warn('[usePluginState] subscribe failed:', err)
    }

    return () => {
      cancelled = true
      try { unsub?.() } catch { /* noop */ }
    }
  }, [extId])

  const update = useCallback((patch: Record<string, unknown>) => {
    setState(prev => ({ ...prev, ...patch }))
    void el?.extensions?.storeSet?.(extId, patch)
  }, [extId])

  return [state, update]
}
