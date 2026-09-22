import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const CSS = readFileSync(resolve(process.cwd(), 'src/renderer/src/index.css'), 'utf8')
const COMPOSER = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/chat/ChatTileComposer.tsx'), 'utf8')

describe('chat composer corner chrome', () => {
  test('bottom inset is large enough that the panel radius cannot clip a nested corner', () => {
    const inset = CSS.match(/--cs-chat-composer-bottom-inset:\s*(\d+)px/)
    expect(inset?.[1] == null ? 0 : Number(inset[1])).toBeGreaterThan(9)
  })

  test('the card does not layer a 0.5px border on top of the edge-shadow hairline', () => {
    expect(COMPOSER).toContain("border: 'none'")
    expect(COMPOSER).not.toContain('0.5px solid ${composerBorder}')
  })
})
