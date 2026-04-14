/**
 * React hook to fetch extension tile types from the main process.
 * Refreshes on mount — extensions are loaded at startup and don't change dynamically (yet).
 */

import { useState, useEffect, useCallback } from 'react'
import type { ExtensionTileContrib } from '../../../shared/types'

const el = (window as any).electron
const EXTENSIONS_CHANGED_EVENT = 'codesurf:extensions-changed'

type ExtensionEntrySummary = {
  id: string
  name: string
}

export function useExtensions(workspacePath?: string | null, enabled = true) {
  const [extensionTiles, setExtensionTiles] = useState<ExtensionTileContrib[]>([])
  const [extensionEntries, setExtensionEntries] = useState<ExtensionEntrySummary[]>([])

  const load = useCallback(async (cancelledRef?: { current: boolean }) => {
    if (!enabled) {
      if (!cancelledRef?.current) {
        setExtensionTiles([])
        setExtensionEntries([])
      }
      return
    }
    try {
      await el.extensions?.refresh?.(workspacePath ?? null)
      const [tiles, entries] = await Promise.all([
        el.extensions?.listTiles?.(),
        el.extensions?.list?.(),
      ])
      if (!cancelledRef?.current && tiles) {
        setExtensionTiles(tiles)
      }
      if (!cancelledRef?.current && entries) {
        setExtensionEntries(entries.map((entry: ExtensionEntrySummary) => ({ id: entry.id, name: entry.name })))
      }
    } catch (err) {
      console.warn('[useExtensions] Failed to load extension tiles:', err)
    }
  }, [enabled, workspacePath])

  useEffect(() => {
    if (!enabled) {
      setExtensionTiles([])
      setExtensionEntries([])
      return
    }
    const cancelledRef = { current: false }
    void load(cancelledRef)
    return () => { cancelledRef.current = true }
  }, [enabled, load])

  useEffect(() => {
    if (!enabled) return
    const handleChanged = () => { void load() }
    window.addEventListener(EXTENSIONS_CHANGED_EVENT, handleChanged)
    return () => window.removeEventListener(EXTENSIONS_CHANGED_EVENT, handleChanged)
  }, [enabled, load])

  return { extensionTiles, extensionEntries }
}
