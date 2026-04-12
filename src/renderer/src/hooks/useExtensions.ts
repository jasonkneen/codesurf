/**
 * React hook to fetch extension tile types from the main process.
 * Refreshes on mount — extensions are loaded at startup and don't change dynamically (yet).
 */

import { useState, useEffect, useCallback } from 'react'
import type { ExtensionTileContrib } from '../../../shared/types'

const el = (window as any).electron
const EXTENSIONS_CHANGED_EVENT = 'codesurf:extensions-changed'

export function useExtensions(workspacePath?: string | null) {
  const [extensionTiles, setExtensionTiles] = useState<ExtensionTileContrib[]>([])

  const load = useCallback(async (cancelledRef?: { current: boolean }) => {
    try {
      await el.extensions?.refresh?.(workspacePath ?? null)
      const tiles = await el.extensions?.listTiles?.()
      if (!cancelledRef?.current && tiles) {
        setExtensionTiles(tiles)
      }
    } catch (err) {
      console.warn('[useExtensions] Failed to load extension tiles:', err)
    }
  }, [workspacePath])

  useEffect(() => {
    const cancelledRef = { current: false }
    void load(cancelledRef)
    return () => { cancelledRef.current = true }
  }, [load])

  useEffect(() => {
    const handleChanged = () => { void load() }
    window.addEventListener(EXTENSIONS_CHANGED_EVENT, handleChanged)
    return () => window.removeEventListener(EXTENSIONS_CHANGED_EVENT, handleChanged)
  }, [load])

  return { extensionTiles }
}
