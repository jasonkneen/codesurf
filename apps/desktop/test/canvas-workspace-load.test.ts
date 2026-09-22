import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { CanvasState, GroupState, LockedConnection, TileState } from '../src/shared/types.ts'
import type { PanelNode } from '../src/renderer/src/components/panelLayoutTree.ts'
import { applyEmptyCanvasWorkspaceState, applySavedCanvasState } from '../src/renderer/src/lib/canvasWorkspaceLoad.ts'
import { createLeaf } from '../src/renderer/src/components/panelLayoutTree.ts'

describe('empty canvas workspace hydration', () => {
  test('clears every authoritative canvas ref before lifecycle persistence can observe the new owner', () => {
    let tiles = [{ id: 'tile-a' }] as TileState[]
    let groups = [{ id: 'group-a' }] as GroupState[]
    let lockedConnections = [{
      sourceTileId: 'tile-a',
      targetTileId: 'tile-b',
    }] as LockedConnection[]
    let panelLayout = { type: 'leaf', id: 'panel-a', tabs: ['tile-a'], activeTab: 'tile-a' } as PanelNode
    let activePanelId: string | null = 'panel-a'
    let expandedTileId: string | null = 'tile-a'
    let expandedCanvasGroupId: string | null = 'group-a'
    let expandLayoutGroupId: string | null = 'group-a'
    const savedLayoutRef = { current: panelLayout as PanelNode | null }
    const expandedCanvasGroupIdRef = { current: expandedCanvasGroupId }
    const expandLayoutGroupIdRef = { current: expandLayoutGroupId }
    const expandedCanvasPriorViewportRef = {
      current: { tx: 20, ty: 30, zoom: 2 } as CanvasState['viewport'] | null,
    }
    let viewportReset = false

    applyEmptyCanvasWorkspaceState({
      setTiles: next => { tiles = next },
      setGroups: next => { groups = next },
      setLockedConnections: next => { lockedConnections = next },
      setPanelLayout: next => { panelLayout = next as PanelNode },
      setActivePanelId: next => { activePanelId = next },
      setExpandedTileId: next => { expandedTileId = next },
      setExpandedCanvasGroupId: next => { expandedCanvasGroupId = next },
      setExpandLayoutGroupId: next => { expandLayoutGroupId = next },
      savedLayoutRef,
      expandedCanvasGroupIdRef,
      expandLayoutGroupIdRef,
      expandedCanvasPriorViewportRef,
    }, () => {
      viewportReset = true
    })

    assert.deepEqual(tiles, [])
    assert.deepEqual(groups, [])
    assert.deepEqual(lockedConnections, [])
    assert.equal(viewportReset, true)
    assert.equal(savedLayoutRef.current, null)
    assert.equal(panelLayout, null)
    assert.equal(activePanelId, null)
    assert.equal(expandedTileId, null)
    assert.equal(expandedCanvasGroupId, null)
    assert.equal(expandedCanvasGroupIdRef.current, null)
    assert.equal(expandLayoutGroupId, null)
    assert.equal(expandLayoutGroupIdRef.current, null)
    assert.equal(expandedCanvasPriorViewportRef.current, null)
  })
})

describe('applySavedCanvasState layout-group binding', () => {
  test('restores expandLayoutGroupId when that group still exists', () => {
    const layout = createLeaf(['tile-a'])
    let expandLayoutGroupId: string | null = null
    const expandLayoutGroupIdRef = { current: null as string | null }
    const savedLayoutRef = { current: null as PanelNode | null }
    const expandedCanvasGroupIdRef = { current: null as string | null }
    const expandedCanvasPriorViewportRef = { current: null }

    applySavedCanvasState({
      tiles: [{ id: 'tile-a', type: 'note', x: 0, y: 0, width: 100, height: 100, zIndex: 1, groupId: 'g1' }],
      groups: [{ id: 'g1', layoutMode: true, layout }],
      viewport: { tx: 0, ty: 0, zoom: 1 },
      nextZIndex: 2,
      tabViewActive: true,
      panelLayout: layout,
      expandLayoutGroupId: 'g1',
    }, {
      setTiles: () => {},
      setGroups: () => {},
      restoreViewport: () => {},
      setNextZIndex: () => {},
      setPanelLayout: () => {},
      setActivePanelId: () => {},
      setExpandedTileId: () => {},
      setExpandedCanvasGroupId: () => {},
      setExpandLayoutGroupId: next => { expandLayoutGroupId = next },
      savedLayoutRef,
      expandedCanvasGroupIdRef,
      expandLayoutGroupIdRef,
      expandedCanvasPriorViewportRef,
    })

    assert.equal(expandLayoutGroupId, 'g1')
    assert.equal(expandLayoutGroupIdRef.current, 'g1')
  })

  test('drops a stale expandLayoutGroupId whose group is gone', () => {
    let expandLayoutGroupId: string | null = 'missing'
    const expandLayoutGroupIdRef = { current: 'missing' as string | null }
    applySavedCanvasState({
      tiles: [{ id: 'tile-a', type: 'note', x: 0, y: 0, width: 100, height: 100, zIndex: 1 }],
      groups: [],
      viewport: { tx: 0, ty: 0, zoom: 1 },
      nextZIndex: 1,
      tabViewActive: true,
      panelLayout: createLeaf(['tile-a']),
      expandLayoutGroupId: 'missing',
    }, {
      setTiles: () => {},
      setGroups: () => {},
      restoreViewport: () => {},
      setNextZIndex: () => {},
      setPanelLayout: () => {},
      setActivePanelId: () => {},
      setExpandedTileId: () => {},
      setExpandedCanvasGroupId: () => {},
      setExpandLayoutGroupId: next => { expandLayoutGroupId = next },
      savedLayoutRef: { current: null },
      expandedCanvasGroupIdRef: { current: null },
      expandLayoutGroupIdRef,
      expandedCanvasPriorViewportRef: { current: null },
    })
    assert.equal(expandLayoutGroupId, null)
    assert.equal(expandLayoutGroupIdRef.current, null)
  })
})
