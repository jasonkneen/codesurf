/**
 * React hooks for reading v2 plugin contributions (commands, footer, panels,
 * settings sections, layout presets) aggregated across enabled plugins.
 *
 * Backed by the `ext:contributions` IPC (see src/main/ipc/extensions.ts). Refreshes
 * on the same `codesurf:extensions-changed` window event used by useExtensions, so a
 * <Slot> re-renders when a plugin is enabled/disabled/reloaded.
 *
 * This is the consumer side of the contribution registry — host regions call
 * useContributions('footer') (etc.) and render the results, so a plugin can place UI
 * in a surface with zero edits to that surface.
 */

import { useState, useEffect, useCallback } from 'react'
import type {
  ExtensionCommandContrib,
  ExtensionFooterContrib,
  ExtensionPanelContrib,
  ExtensionSettingsSectionContrib,
  ExtensionLayoutPresetContrib,
} from '../../../shared/types'

const el = (window as { electron?: any }).electron
const EXTENSIONS_CHANGED_EVENT = 'codesurf:extensions-changed'

export type Owned<T> = T & { extId: string }

export interface PluginContributions {
  commands: Owned<ExtensionCommandContrib>[]
  footer: Owned<ExtensionFooterContrib>[]
  panels: Owned<ExtensionPanelContrib>[]
  settingsSections: Owned<ExtensionSettingsSectionContrib>[]
  layoutPresets: Owned<ExtensionLayoutPresetContrib>[]
}

const EMPTY: PluginContributions = {
  commands: [],
  footer: [],
  panels: [],
  settingsSections: [],
  layoutPresets: [],
}

/** All v2 contributions, refreshing when the plugin set changes. */
export function usePluginContributions(enabled = true): PluginContributions {
  const [contributions, setContributions] = useState<PluginContributions>(EMPTY)

  const load = useCallback(async (cancelledRef?: { current: boolean }) => {
    if (!enabled) {
      if (!cancelledRef?.current) setContributions(EMPTY)
      return
    }
    try {
      const all = await el?.extensions?.contributions?.()
      if (!cancelledRef?.current && all) setContributions({ ...EMPTY, ...all })
    } catch (err) {
      console.warn('[useContributions] Failed to load contributions:', err)
    }
  }, [enabled])

  useEffect(() => {
    const cancelledRef = { current: false }
    void load(cancelledRef)
    return () => { cancelledRef.current = true }
  }, [load])

  useEffect(() => {
    if (!enabled) return
    const handleChanged = () => { void load() }
    window.addEventListener(EXTENSIONS_CHANGED_EVENT, handleChanged)
    return () => window.removeEventListener(EXTENSIONS_CHANGED_EVENT, handleChanged)
  }, [enabled, load])

  return contributions
}

/** A single surface kind, sorted by `order` ascending where present. */
export function useContributions<K extends keyof PluginContributions>(
  kind: K,
  enabled = true,
): PluginContributions[K] {
  const all = usePluginContributions(enabled)
  const items = all[kind]
  return [...items].sort(
    (a, b) => ((a as { order?: number }).order ?? 0) - ((b as { order?: number }).order ?? 0),
  ) as PluginContributions[K]
}
