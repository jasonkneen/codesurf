import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createElement } from 'react'
import {
  act,
  create,
  type ReactTestRenderer,
} from 'react-test-renderer'
import type {
  Dispatch,
  SetStateAction,
} from 'react'
import type { GroupState, TileState } from '../src/shared/types.ts'
import {
  useCanvasDragSync,
  type CanvasDragState,
  type UseCanvasDragSyncOptions,
} from '../src/renderer/src/hooks/useCanvasDragSync.ts'

type TestListener = (event: { clientX: number; clientY: number }) => void

class FakeWindow {
  readonly listeners = new Map<string, Set<TestListener>>()
  addCount = 0
  removeCount = 0

  addEventListener(type: string, listener: TestListener): void {
    const listeners = this.listeners.get(type) ?? new Set<TestListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
    this.addCount += 1
  }

  removeEventListener(type: string, listener: TestListener): void {
    this.listeners.get(type)?.delete(listener)
    this.removeCount += 1
  }

  emit(type: string, clientX = 0, clientY = 0): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ clientX, clientY })
    }
  }

  setTimeout(callback: () => void): number {
    callback()
    return 1
  }

  clearTimeout(): void {}
}

function tile(
  id: string,
  x: number,
  y: number,
  width = 100,
  height = 80,
): TileState {
  return { id, type: 'note', x, y, width, height, zIndex: 1 }
}

function applyState<T>(current: T, action: SetStateAction<T>): T {
  return typeof action === 'function'
    ? (action as (previous: T) => T)(current)
    : action
}

function DragHarness({ options }: { options: UseCanvasDragSyncOptions }) {
  useCanvasDragSync(options)
  return null
}

describe('canvas drag listener runtime', () => {
  test('keeps listeners stable while every gesture branch uses the latest state', async () => {
    const fakeWindow = new FakeWindow()
    const originalWindow = globalThis.window
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
    const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
    let nextFrameId = 1
    const frames = new Map<number, FrameRequestCallback>()
    globalThis.window = fakeWindow as unknown as Window & typeof globalThis
    globalThis.requestAnimationFrame = callback => {
      const id = nextFrameId++
      frames.set(id, callback)
      return id
    }
    globalThis.cancelAnimationFrame = id => {
      frames.delete(id)
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true

    const flushFrames = () => {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(performance.now())
    }

    let tiles = [
      tile('tile-a', 0, 0),
      tile('tile-b', 120, 20),
      tile('tile-c', 500, 500),
    ]
    const tilesRef = { current: tiles }
    let groups: GroupState[] = []
    const groupsRef = { current: groups }
    let dragState: CanvasDragState = { type: null }
    let selectedTileIds = new Set<string>()
    let suppressedConnections = new Set<string>()
    const suppressedConnectionsRef = { current: suppressedConnections }
    const panelTileIdsRef = { current: new Set<string>() }
    const groupBoundsRef = { current: (_id: string) => null as { x: number; y: number; w: number; h: number } | null }
    const viewport = { tx: 5, ty: 7, zoom: 2 }
    const pendingViewportRef = { current: viewport }
    const panVelocityRef = { current: { vx: 0, vy: 0 } }
    const panLastPos = { current: { x: 0, y: 0, t: performance.now() - 16 } }
    const viewportGestures: typeof viewport[] = []
    const pointerWorld: ({ x: number; y: number } | null)[] = []
    const locks: [string, string][] = []
    const saves: {
      tiles: TileState[]
      groups: GroupState[] | undefined
      before: TileState[] | undefined
    }[] = []
    let inertiaStarts = 0
    let latestGroups = groups
    let latestDragUpdate = dragState

    const setTiles: Dispatch<SetStateAction<TileState[]>> = action => {
      tiles = applyState(tiles, action)
      tilesRef.current = tiles
    }
    const setGroups: Dispatch<SetStateAction<GroupState[]>> = action => {
      groups = applyState(groups, action)
      groupsRef.current = groups
      latestGroups = groups
    }
    const setDragState: Dispatch<SetStateAction<CanvasDragState>> = action => {
      dragState = applyState(dragState, action)
      latestDragUpdate = dragState
    }
    const setSelectedTileIds: Dispatch<SetStateAction<Set<string>>> = action => {
      selectedTileIds = applyState(selectedTileIds, action)
    }
    const setSuppressedConnections: Dispatch<SetStateAction<Set<string>>> = action => {
      suppressedConnections = applyState(suppressedConnections, action)
      suppressedConnectionsRef.current = suppressedConnections
    }
    const canvasRef = {
      current: {
        getBoundingClientRect: () => ({ left: 10, top: 20 }),
      } as HTMLDivElement,
    }

    const optionsFor = (nextDragState: CanvasDragState): UseCanvasDragSyncOptions => ({
      canvasRef,
      dragState: nextDragState,
      setDragState,
      engine: {
        viewport,
        setViewport: () => {},
        pendingViewportRef,
        panVelocityRef,
        panLastPos,
        startPanInertia: () => { inertiaStarts += 1 },
        screenToWorld: (x, y) => ({ x: x / 2, y: y / 2 }),
        saveCanvas: (nextTiles, _nextViewport, _nextZIndex, nextGroups, before) => {
          saves.push({ tiles: nextTiles, groups: nextGroups, before })
        },
        nextZIndex: 10,
        applyViewportGesture: next => { viewportGestures.push(next) },
      },
      tilesRef,
      groupsRef,
      groups,
      setTiles,
      setGroups,
      setGuides: () => {},
      setCanvasPointerWorld: action => {
        const previous = pointerWorld.at(-1) ?? null
        pointerWorld.push(applyState(previous, action))
      },
      setSelectedTileIds,
      setSuppressedConnections,
      suppressedConnectionsRef,
      panelTileIdsRef,
      groupBoundsRef,
      snapValue: Math.round,
      resolveManualConnectionTarget: () => 'tile-b',
      lockConnection: (source, target) => { locks.push([source, target]) },
      triggerDiscoveryPulse: () => {},
      getMinTileWidth: () => 40,
      getMinTileHeight: () => 30,
    })

    let renderer: ReactTestRenderer | undefined
    const renderState = async (nextDragState: CanvasDragState) => {
      dragState = nextDragState
      latestDragUpdate = nextDragState
      await act(async () => {
        if (renderer) {
          renderer.update(createElement(DragHarness, { options: optionsFor(nextDragState) }))
        } else {
          renderer = create(createElement(DragHarness, { options: optionsFor(nextDragState) }))
        }
      })
    }
    const startGesture = async (nextDragState: CanvasDragState) => {
      await renderState({ type: null })
      await renderState(nextDragState)
    }

    try {
      await renderState({ type: null })
      assert.equal(fakeWindow.addCount, 2)

      await startGesture({
        type: 'select',
        startWx: 0,
        startWy: 0,
        curWx: 0,
        curWy: 0,
      })
      fakeWindow.emit('mousemove', 35, 47)
      flushFrames()
      assert.deepEqual(latestDragUpdate, {
        type: 'select',
        startWx: 0,
        startWy: 0,
        curWx: 10,
        curWy: 10,
      })

      await startGesture({
        type: 'pan',
        startX: 0,
        startY: 0,
        initTx: 30,
        initTy: 40,
      })
      fakeWindow.emit('mousemove', 20, 30)
      assert.deepEqual(viewportGestures.at(-1), { tx: 50, ty: 70, zoom: 2 })
      fakeWindow.emit('mouseup')
      assert.equal(inertiaStarts, 1)

      groups = [{ id: 'layout-group', layoutMode: true }]
      groupsRef.current = groups
      latestGroups = groups
      await startGesture({
        type: 'group-resize',
        groupId: 'layout-group',
        dir: 'se',
        startX: 0,
        startY: 0,
        initBounds: { x: 0, y: 0, w: 100, h: 100 },
        snapshots: [],
      })
      fakeWindow.emit('mousemove', 100, 50)
      flushFrames()
      assert.deepEqual(latestGroups[0].layoutBounds, { x: 0, y: 0, w: 150, h: 125 })

      tiles = [tile('tile-a', 0, 0, 50, 40), tile('tile-b', 50, 50, 50, 40)]
      tilesRef.current = tiles
      groups = [{ id: 'free-group' }]
      groupsRef.current = groups
      await startGesture({
        type: 'group-resize',
        groupId: 'free-group',
        dir: 'se',
        startX: 1,
        startY: 1,
        initBounds: { x: 0, y: 0, w: 100, h: 100 },
        snapshots: [
          { id: 'tile-a', x: 0, y: 0, width: 50, height: 40 },
          { id: 'tile-b', x: 50, y: 50, width: 50, height: 40 },
        ],
      })
      fakeWindow.emit('mousemove', 101, 101)
      flushFrames()
      assert.deepEqual(
        tiles.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })),
        [
          { id: 'tile-a', x: 0, y: 0, width: 75, height: 60 },
          { id: 'tile-b', x: 75, y: 75, width: 75, height: 60 },
        ],
      )

      groups = [{ id: 'layout-move', layoutMode: true }]
      groupsRef.current = groups
      latestGroups = groups
      await startGesture({
        type: 'group',
        groupId: 'layout-move',
        startX: 2,
        startY: 2,
        initLayoutBounds: { x: 10, y: 20, w: 200, h: 100 },
        snapshots: [],
      })
      fakeWindow.emit('mousemove', 42, 62)
      flushFrames()
      assert.deepEqual(latestGroups[0].layoutBounds, { x: 30, y: 50, w: 200, h: 100 })

      tiles = [tile('tile-a', 10, 20), tile('tile-b', 100, 200), tile('outside', 500, 500)]
      tilesRef.current = tiles
      groups = [{ id: 'free-move' }]
      groupsRef.current = groups
      await startGesture({
        type: 'group',
        groupId: 'free-move',
        startX: 3,
        startY: 3,
        snapshots: [
          { id: 'tile-a', x: 10, y: 20 },
          { id: 'tile-b', x: 100, y: 200 },
        ],
      })
      fakeWindow.emit('mousemove', 43, 63)
      flushFrames()
      assert.deepEqual([tiles[0].x, tiles[0].y, tiles[1].x, tiles[1].y], [30, 50, 120, 230])
      assert.equal(tiles[2].x, 500)

      await startGesture({
        type: 'connection',
        sourceTileId: 'tile-a',
        startX: 4,
        startY: 4,
        side: 'right',
        anchor: { side: 'right', x: 0, y: 0, gridX: 0, gridY: 0 },
        current: { x: 0, y: 0 },
        targetTileId: null,
      })
      fakeWindow.emit('mousemove', 80, 60)
      flushFrames()
      assert.deepEqual(pointerWorld.at(-1), { x: 40, y: 30 })
      assert.equal(
        latestDragUpdate.type === 'connection' ? latestDragUpdate.targetTileId : null,
        'tile-b',
      )
      await renderState(latestDragUpdate)
      fakeWindow.emit('mouseup')
      assert.deepEqual(locks.at(-1), ['tile-a', 'tile-b'])

      tiles = [tile('tile-a', 0, 0), tile('tile-b', 120, 20), tile('tile-c', 500, 500)]
      tilesRef.current = tiles
      groups = []
      groupsRef.current = groups
      suppressedConnections = new Set(['tile-a:tile-c', 'tile-b:tile-c'])
      suppressedConnectionsRef.current = suppressedConnections
      saves.length = 0
      await startGesture({
        type: 'tile',
        tileId: 'tile-a',
        startX: 5,
        startY: 5,
        initX: 0,
        initY: 0,
        groupSnapshots: [{ id: 'tile-b', x: 120, y: 20 }],
      })
      fakeWindow.emit('mousemove', 45, 65)
      flushFrames()
      assert.deepEqual([tiles[0].x, tiles[0].y, tiles[1].x, tiles[1].y], [20, 30, 140, 50])
      fakeWindow.emit('mouseup')
      assert.deepEqual([...suppressedConnections], ['tile-b:tile-c'])
      assert.equal(saves.length, 1)
      assert.deepEqual(
        saves[0].before?.map(({ id, x, y }) => ({ id, x, y })),
        [
          { id: 'tile-a', x: 0, y: 0 },
          { id: 'tile-b', x: 120, y: 20 },
          { id: 'tile-c', x: 500, y: 500 },
        ],
      )

      tiles = [tile('tile-a', 10, 20, 100, 80), tile('tile-b', 400, 400)]
      tilesRef.current = tiles
      await startGesture({
        type: 'resize',
        tileId: 'tile-a',
        dir: 'nw',
        startX: 6,
        startY: 6,
        initX: 10,
        initY: 20,
        initW: 100,
        initH: 80,
      })
      fakeWindow.emit('mousemove', 46, 26)
      flushFrames()
      assert.deepEqual(
        { x: tiles[0].x, y: tiles[0].y, width: tiles[0].width, height: tiles[0].height },
        { x: 30, y: 30, width: 80, height: 70 },
      )

      tiles = [tile('inside', 0, 0, 50, 50), tile('panel', 0, 0, 50, 50), tile('outside', 100, 100, 20, 20)]
      tilesRef.current = tiles
      panelTileIdsRef.current = new Set(['panel'])
      selectedTileIds = new Set()
      await startGesture({
        type: 'select',
        startWx: -10,
        startWy: -10,
        curWx: 60,
        curWy: 60,
      })
      fakeWindow.emit('mouseup')
      assert.deepEqual([...selectedTileIds], ['inside'])

      assert.equal(fakeWindow.addCount, 2)
      assert.equal(fakeWindow.removeCount, 0)
      await act(async () => {
        renderer?.unmount()
      })
      assert.equal(fakeWindow.removeCount, 2)
    } finally {
      if (renderer) {
        await act(async () => {
          renderer?.unmount()
        })
      }
      globalThis.window = originalWindow
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame
      globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
    }
  })
})
