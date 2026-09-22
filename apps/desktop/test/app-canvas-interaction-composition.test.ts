import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const APP = readFileSync(join(ROOT, 'src/renderer/src/App.tsx'), 'utf8')
const HOOK = readFileSync(join(ROOT, 'src/renderer/src/hooks/useAppCanvasInteraction.ts'), 'utf8')
const POINTER = readFileSync(join(ROOT, 'src/renderer/src/hooks/useAppCanvasPointerInteraction.ts'), 'utf8')
const GROUP = readFileSync(join(ROOT, 'src/renderer/src/hooks/useAppCanvasGroupInteraction.ts'), 'utf8')
const INTERACTION_MODULES = `${HOOK}\n${POINTER}\n${GROUP}`

describe('useAppCanvasInteraction composition', () => {
  test('hook composes the interaction forest', () => {
    assert.match(HOOK, /export function useAppCanvasInteraction/)
    assert.match(HOOK, /useAppCanvasPointerInteraction/)
    assert.match(HOOK, /useAppCanvasGroupInteraction/)
    assert.match(INTERACTION_MODULES, /useCanvasPointerHandlers/)
    assert.match(INTERACTION_MODULES, /useConnectionHandleHover/)
    assert.match(INTERACTION_MODULES, /useCanvasContextMenu/)
    assert.match(INTERACTION_MODULES, /useCanvasDragSync/)
    assert.match(INTERACTION_MODULES, /useCanvasGroupManager/)
    assert.match(INTERACTION_MODULES, /useCanvasKeyboard/)
    assert.match(INTERACTION_MODULES, /useTileContextMenu/)
    assert.match(INTERACTION_MODULES, /useCanvasExpandedGroup/)
    assert.match(INTERACTION_MODULES, /useCanvasTileShortcuts/)
    assert.match(INTERACTION_MODULES, /useEnforceTileMinimumSizes/)
    assert.match(INTERACTION_MODULES, /useLockedConnectionHelpers/)
  })

  test('lockConnection and triggerDiscoveryPulse are inputs (not created inside)', () => {
    assert.match(HOOK, /lockConnection: \(tileA: string, tileB: string\) => void/)
    assert.match(HOOK, /triggerDiscoveryPulse: \(tileId: string, tileList: TileState\[\]\) => void/)
    assert.equal(/useLockConnection\(/.test(HOOK), false)
    assert.equal(/useDiscoveryPulses\(/.test(HOOK), false)
  })

  test('App wires the composition hook instead of inlining interaction hooks', () => {
    assert.match(APP, /useAppCanvasInteraction/)
    assert.equal(/useCanvasPointerHandlers\(/.test(APP), false)
    assert.equal(/useCanvasDragSync\(/.test(APP), false)
    assert.equal(/useCanvasGroupManager\(/.test(APP), false)
    assert.equal(/useCanvasKeyboard\(/.test(APP), false)
    assert.equal(/useCanvasTileShortcuts\(/.test(APP), false)
    assert.equal(/useEnforceTileMinimumSizes\(/.test(APP), false)
    assert.equal(/useLockedConnectionHelpers\(/.test(APP), false)
    assert.equal(/useTileContextMenu\(/.test(APP), false)
    assert.equal(/useCanvasContextMenu\(/.test(APP), false)
    assert.equal(/useCanvasExpandedGroup\(/.test(APP), false)
    // Early lock + discovery stay in App
    assert.match(APP, /useLockConnection\(/)
    assert.match(APP, /useDiscoveryPulses\(/)
  })
})
