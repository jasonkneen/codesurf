import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT_DIR = process.cwd()
const APP_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/App.tsx'), 'utf8')
const HOOK_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useRenderTileBody.tsx'), 'utf8')

describe('useRenderTileBody extraction', () => {
  test('App delegates tile body rendering to the hook', () => {
    expect(APP_SOURCE).toContain("from './hooks/useRenderTileBody'")
    expect(APP_SOURCE).toContain('useRenderTileBody({')
    expect(APP_SOURCE).not.toContain('case \'terminal\':')
  })

  test('hook owns lazy tile imports and type switch', () => {
    expect(HOOK_SOURCE).toContain("case 'terminal':")
    expect(HOOK_SOURCE).toContain('LazyBrowserTile')
    expect(HOOK_SOURCE).toContain('LazyExtensionTile')
    expect(HOOK_SOURCE).toContain('function toBrowserTileUrl')
  })
})