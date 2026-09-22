import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import { isInsideComposerMenu } from '../src/renderer/src/hooks/useChatTileComposerMenus.ts'

const ROOT = process.cwd()
const HOOK = readFileSync(join(ROOT, 'src/renderer/src/hooks/useChatTileComposerMenus.ts'), 'utf8')
const PANEL = readFileSync(join(ROOT, 'src/renderer/src/components/PanelLayout.tsx'), 'utf8')

type FakeNode = {
  closest?: (selector: string) => FakeNode | null
  parentElement?: FakeNode | null
  contains?: (node: FakeNode) => boolean
}

function fakeEl(opts: { portal?: boolean, parent?: FakeNode | null } = {}): FakeNode {
  const node: FakeNode = {
    parentElement: opts.parent ?? null,
    closest(selector) {
      if (selector === '[data-chat-menu-portal="true"]' && opts.portal) return node
      return opts.parent?.closest?.(selector) ?? null
    },
    contains(other) {
      let cur: FakeNode | null | undefined = other
      while (cur) {
        if (cur === node) return true
        cur = cur.parentElement
      }
      return false
    },
  }
  return node
}

describe('isInsideComposerMenu', () => {
  test('clicks on the trigger stay inside, clicks on the transcript dismiss', () => {
    const trigger = fakeEl()
    const child = fakeEl({ parent: trigger })
    const transcript = fakeEl()
    const portal = fakeEl({ portal: true })
    const item = fakeEl({ parent: portal, portal: true })
    const roots = [{ current: trigger as unknown as Element }]

    expect(isInsideComposerMenu(trigger as unknown as EventTarget, roots)).toBe(true)
    expect(isInsideComposerMenu(child as unknown as EventTarget, roots)).toBe(true)
    expect(isInsideComposerMenu(item as unknown as EventTarget, roots)).toBe(true)
    expect(isInsideComposerMenu(transcript as unknown as EventTarget, roots)).toBe(false)
  })
})

describe('composer menu outside dismiss', () => {
  test('listens on capture so panel-layout stopPropagation cannot swallow the click', () => {
    expect(PANEL).toContain('onMouseDown={e => e.stopPropagation()}')
    expect(HOOK).toContain("document.addEventListener('pointerdown', handlePointerDown, true)")
    expect(HOOK).toContain("document.addEventListener('mousedown', handlePointerDown, true)")
    expect(HOOK).toContain('isInsideComposerMenu')
  })
})
