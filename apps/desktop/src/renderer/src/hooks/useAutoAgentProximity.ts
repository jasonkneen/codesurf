import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { AppSettings, TileState } from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/types'
import {
  findDiscoveryMatch,
  getDiscoveryMaxDistance,
} from '../lib/discoveryRuntime'

const GRID = 20
const PROXIMITY_ENABLE_DISTANCE = 0.8
const PROXIMITY_DISABLE_DISTANCE = 1.0
const PROXIMITY_DEBOUNCE_MS = 300

export type UseAutoAgentProximityOptions = {
  enabled: boolean
  miniChatMode: boolean
  workspaceId: string | undefined
  tiles: TileState[]
  dragActive: boolean
  settings: Pick<AppSettings, 'gridSize' | 'gridSpacingSmall' | 'gridSpacingLarge'>
  panelTileIdsRef: RefObject<Set<string>>
  setTiles: Dispatch<SetStateAction<TileState[]>>
}

export function useAutoAgentProximity(options: UseAutoAgentProximityOptions): void {
  const {
    enabled,
    miniChatMode,
    workspaceId,
    tiles,
    dragActive,
    settings,
    panelTileIdsRef,
    setTiles,
  } = options

  const autoAgentModeTilesRef = useRef<Set<string>>(new Set())
  const autoAgentModeTimersRef = useRef<Map<string, number>>(new Map())
  const proximityDebounceTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (miniChatMode) return
    if (!workspaceId) return
    if (!enabled) return
    if (dragActive) return

    const gridStep = Math.max(8, settings.gridSize || settings.gridSpacingSmall || GRID)
    const maxDistance = getDiscoveryMaxDistance(settings.gridSpacingLarge || DEFAULT_SETTINGS.gridSpacingLarge)
    const enableThreshold = maxDistance * PROXIMITY_ENABLE_DISTANCE
    const disableThreshold = maxDistance * PROXIMITY_DISABLE_DISTANCE

    const chatTileProximities = new Map<string, { hasMatch: boolean; distance: number }>()

    for (const tile of tiles) {
      if (tile.type !== 'chat') continue

      const discovery = findDiscoveryMatch(tile.id, tiles, panelTileIdsRef.current ?? new Set(), gridStep, maxDistance)
      const hasCompatibleMatch = Boolean(
        discovery?.match && discovery.match.matchLabels.length > 0
          && !(discovery.match.matchLabels.length === 1 && discovery.match.matchLabels[0] === 'nearest'),
      )
      if (!hasCompatibleMatch) {
        chatTileProximities.set(tile.id, { hasMatch: false, distance: Infinity })
      } else {
        chatTileProximities.set(tile.id, { hasMatch: true, distance: discovery!.match!.distance })
      }
    }

    if (proximityDebounceTimerRef.current) {
      window.clearTimeout(proximityDebounceTimerRef.current)
    }

    proximityDebounceTimerRef.current = window.setTimeout(() => {
      const autoEnabled = autoAgentModeTilesRef.current
      const timers = autoAgentModeTimersRef.current
      const now = Date.now()
      let hasChanges = false
      const newAutoEnabled = new Set(autoEnabled)

      for (const [tileId, proximity] of chatTileProximities) {
        const isAutoEnabled = autoEnabled.has(tileId)
        const lastChange = timers.get(tileId) || 0
        const timeSinceChange = now - lastChange

        if (timeSinceChange < 1000) continue

        if (!isAutoEnabled && proximity.hasMatch && proximity.distance <= enableThreshold) {
          newAutoEnabled.add(tileId)
          timers.set(tileId, now)
          hasChanges = true

          setTiles(prev => prev.map(tile => {
            if (tile.id !== tileId) return tile
            return { ...tile, autoAgentMode: true }
          }))

          void window.electron.canvas.saveTileState(workspaceId, tileId, {
            agentMode: true,
            autoAgentMode: true,
          })

          console.log(`[AutoAgent] Enabled agentMode for ${tileId} (distance: ${Math.round(proximity.distance)}px)`)
        } else if (isAutoEnabled && (!proximity.hasMatch || proximity.distance > disableThreshold)) {
          newAutoEnabled.delete(tileId)
          timers.set(tileId, now)
          hasChanges = true

          setTiles(prev => prev.map(tile => {
            if (tile.id !== tileId) return tile
            return { ...tile, autoAgentMode: false }
          }))

          void window.electron.canvas.saveTileState(workspaceId, tileId, {
            agentMode: false,
            autoAgentMode: false,
          })

          console.log(`[AutoAgent] Disabled agentMode for ${tileId}`)
        }
      }

      if (hasChanges) {
        autoAgentModeTilesRef.current = newAutoEnabled
      }
    }, PROXIMITY_DEBOUNCE_MS)

    return () => {
      if (proximityDebounceTimerRef.current) {
        window.clearTimeout(proximityDebounceTimerRef.current)
      }
    }
  }, [enabled, tiles, dragActive, settings.gridSize, settings.gridSpacingSmall, settings.gridSpacingLarge, workspaceId, miniChatMode, panelTileIdsRef, setTiles])
}