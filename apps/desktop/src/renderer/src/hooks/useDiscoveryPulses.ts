import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { AppSettings, TileState } from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/types'
import { formatGridBounds } from '../lib/connectionRoutes'
import {
  DISCOVERY_PULSE_DURATION_MS,
  findDiscoveryMatch,
  getDiscoveryMaxDistance,
  type DiscoveryPulse,
} from '../lib/discoveryRuntime'

const GRID = 20

export type UseDiscoveryPulsesOptions = {
  enabled: boolean
  settings: Pick<AppSettings, 'gridSize' | 'gridSpacingSmall' | 'gridSpacingLarge'>
  panelTileIdsRef: RefObject<Set<string>>
}

export function useDiscoveryPulses(options: UseDiscoveryPulsesOptions) {
  const { enabled, settings, panelTileIdsRef } = options
  const [discoveryPulses, setDiscoveryPulses] = useState<DiscoveryPulse[]>([])
  const discoveryTimeoutsRef = useRef<number[]>([])

  const triggerDiscoveryPulse = useCallback((tileId: string, tileList: TileState[]) => {
    if (!enabled) return
    const gridStep = Math.max(8, settings.gridSize || settings.gridSpacingSmall || GRID)
    const maxDistance = getDiscoveryMaxDistance(settings.gridSpacingLarge || DEFAULT_SETTINGS.gridSpacingLarge)
    const discovery = findDiscoveryMatch(tileId, tileList, panelTileIdsRef.current ?? new Set(), gridStep, maxDistance)
    if (!discovery?.match) return

    const sourceTile = tileList.find(tile => tile.id === tileId)
    if (!sourceTile) return

    const pulse: DiscoveryPulse = {
      id: `pulse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sourceTileId: sourceTile.id,
      targetTileId: discovery.match.tile.id,
      route: discovery.match.route,
      startedAt: Date.now(),
      durationMs: DISCOVERY_PULSE_DURATION_MS,
      matchLabels: discovery.match.matchLabels,
      sourceGridLabel: formatGridBounds(discovery.sourceRef.gridBounds),
      targetGridLabel: formatGridBounds(discovery.match.targetRef.gridBounds),
    }

    setDiscoveryPulses(prev => {
      const next = prev.filter(existing => !(existing.sourceTileId === pulse.sourceTileId && existing.targetTileId === pulse.targetTileId))
      return [...next, pulse]
    })

    const timeout = window.setTimeout(() => {
      setDiscoveryPulses(prev => prev.filter(existing => existing.id !== pulse.id))
    }, pulse.durationMs + 180)
    discoveryTimeoutsRef.current.push(timeout)
  }, [enabled, settings.gridSize, settings.gridSpacingSmall, settings.gridSpacingLarge, panelTileIdsRef])

  useEffect(() => () => {
    discoveryTimeoutsRef.current.forEach(timeout => window.clearTimeout(timeout))
    discoveryTimeoutsRef.current = []
  }, [])

  return { discoveryPulses, triggerDiscoveryPulse }
}