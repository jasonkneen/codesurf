import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT_DIR = process.cwd()
const WEBVIEW_MANAGER_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/browser/webviewManager.ts'), 'utf8')
const BROWSER_TILE_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/BrowserTile.tsx'), 'utf8')
const EMBEDDED_PREVIEW_SOURCE = WEBVIEW_MANAGER_SOURCE.slice(
  WEBVIEW_MANAGER_SOURCE.indexOf('function createFallbackWebview'),
  WEBVIEW_MANAGER_SOURCE.indexOf('function createElectrobunWebview'),
)

describe('BrowserTile embedded preview fallback', () => {
  test('keeps the non-Electron iframe to the minimum preview capabilities', () => {
    expect(EMBEDDED_PREVIEW_SOURCE).toContain("frame.setAttribute('sandbox', 'allow-scripts allow-forms')")
    expect(EMBEDDED_PREVIEW_SOURCE).toContain("frame.referrerPolicy = 'no-referrer'")
    expect(EMBEDDED_PREVIEW_SOURCE).not.toContain('allow-same-origin')
    expect(EMBEDDED_PREVIEW_SOURCE).not.toContain("frame.setAttribute('allow'")
    expect(EMBEDDED_PREVIEW_SOURCE).not.toContain('allow-downloads')
  })

  test('labels the fallback as an embedded preview and avoids unsupported browser controls', () => {
    expect(WEBVIEW_MANAGER_SOURCE).toContain('isEmbeddedPreviewWebview')
    expect(BROWSER_TILE_SOURCE).toContain('Embedded preview')
    expect(BROWSER_TILE_SOURCE).toContain('Sites that block embedding cannot load here')
    expect(BROWSER_TILE_SOURCE).toContain('{isEmbeddedPreview ? (')
  })
})
