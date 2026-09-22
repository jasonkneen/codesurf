import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  findClearPosition,
  getMinTileHeight,
  getMinTileWidth,
  rectsOverlap,
} from '../src/renderer/src/utils/tilePlacement.ts'
import type { TileState } from '../src/shared/types.ts'

function tile(id: string, x: number, y: number, w: number, h: number): TileState {
  return {
    id,
    type: 'note',
    x,
    y,
    width: w,
    height: h,
    zIndex: 1,
  }
}

describe('tilePlacement', () => {
  test('getMinTileWidth respects chat and extension tiles', () => {
    expect(getMinTileWidth('chat')).toBe(450)
    expect(getMinTileWidth('ext:demo')).toBe(150)
    expect(getMinTileWidth('note')).toBe(200)
  })

  test('getMinTileHeight respects files and extension tiles', () => {
    expect(getMinTileHeight('files')).toBe(300)
    expect(getMinTileHeight('ext:demo')).toBe(100)
    expect(getMinTileHeight('note')).toBe(150)
  })

  test('rectsOverlap detects intersection', () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 })).toBe(true)
    expect(rectsOverlap({ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 0, w: 100, h: 100 })).toBe(false)
  })

  test('findClearPosition returns preferred when unobstructed', () => {
    const position = findClearPosition(120, 80, 200, 150, [tile('a', 0, 0, 100, 100)], new Set(), 20)
    expect(position).toEqual({ x: 120, y: 80 })
  })

  test('findClearPosition steps away from blocked tiles', () => {
    const position = findClearPosition(
      100,
      100,
      200,
      150,
      [tile('a', 100, 100, 200, 150)],
      new Set(),
      20,
    )
    const candidate = { x: position.x, y: position.y, w: 200, h: 150 }
    expect(position.x === 100 && position.y === 100).toBe(false)
    const blocked = { x: 100, y: 100, w: 200, h: 150 }
    expect(rectsOverlap(candidate, blocked)).toBe(false)
  })

  test('findClearPosition ignores panel-blocked tile ids', () => {
    const position = findClearPosition(
      100,
      100,
      200,
      150,
      [tile('panel-tab', 100, 100, 200, 150)],
      new Set(['panel-tab']),
      20,
    )
    expect(position).toEqual({ x: 100, y: 100 })
  })
})