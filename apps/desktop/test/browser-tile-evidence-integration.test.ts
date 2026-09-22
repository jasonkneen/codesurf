import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT_DIR = process.cwd()
const BROWSER_TILE_SOURCE = [
  readFileSync(join(ROOT_DIR, 'src/renderer/src/components/BrowserTile.tsx'), 'utf8'),
  readFileSync(join(ROOT_DIR, 'src/renderer/src/components/browser/BrowserEvidenceDrawer.tsx'), 'utf8'),
  readFileSync(join(ROOT_DIR, 'src/renderer/src/components/browser/browserEvidenceViewModel.ts'), 'utf8'),
  readFileSync(join(ROOT_DIR, 'src/renderer/src/components/browser/useBrowserWebviewLifecycle.ts'), 'utf8'),
].join('\n')

describe('BrowserTile browser evidence integration', () => {
  test('uses shared evidence helpers instead of ad-hoc diagnostics state', () => {
    expect(BROWSER_TILE_SOURCE).toContain("../../../shared/browserEvidence")
    expect(BROWSER_TILE_SOURCE).toContain('appendBrowserEvidence')
    expect(BROWSER_TILE_SOURCE).toContain('createBrowserEvidenceEvent')
    expect(BROWSER_TILE_SOURCE).toContain('createBrowserEvidenceSnapshot')
    expect(BROWSER_TILE_SOURCE).toContain('formatBrowserEvidenceReport')
    expect(BROWSER_TILE_SOURCE).toContain('summarizeBrowserEvidence')
  })

  test('records console and load failure events as browser evidence', () => {
    expect(BROWSER_TILE_SOURCE).toContain("kind: 'console'")
    expect(BROWSER_TILE_SOURCE).toContain("kind: 'load-failure'")
    expect(BROWSER_TILE_SOURCE).toContain("kind: 'lifecycle'")
    expect(BROWSER_TILE_SOURCE).toContain('did-frame-finish-load')
    expect(BROWSER_TILE_SOURCE).toContain('browser.evidence')
  })

  test('renders a compact evidence drawer with filters and QA actions', () => {
    expect(BROWSER_TILE_SOURCE).toContain('Browser evidence')
    expect(BROWSER_TILE_SOURCE).toContain('Evidence drawer')
    expect(BROWSER_TILE_SOURCE).toContain('evidenceFilter')
    expect(BROWSER_TILE_SOURCE).toContain('Copy report')
    expect(BROWSER_TILE_SOURCE).toContain('Capture snapshot')
    expect(BROWSER_TILE_SOURCE).toContain('Clear evidence')
    expect(BROWSER_TILE_SOURCE).toContain('Open QA Workbench')
    expect(BROWSER_TILE_SOURCE).toContain('Attach QA report to chat')
    expect(BROWSER_TILE_SOURCE).toContain('dispatchCreateTile')
    expect(BROWSER_TILE_SOURCE).toContain('dispatchOpenChatSurface')
  })

  test('answers read-only browser evidence requests over the workspace-scoped tile bus', () => {
    expect(BROWSER_TILE_SOURCE).toContain('if (!workspaceId || !window.electron?.bus) return')
    expect(BROWSER_TILE_SOURCE).toContain('`tile:${workspaceId}:${tileId}`')
    expect(BROWSER_TILE_SOURCE).toContain('`browser:${workspaceId}:${tileId}:mcp`')
    expect(BROWSER_TILE_SOURCE).toContain(
      '[workspaceId, tileId, navigate, reload, goBack, goForward, switchMode, publishEvidenceSnapshot]',
    )
    expect(BROWSER_TILE_SOURCE).not.toContain(
      'window.electron.bus.subscribe(`tile:${tileId}`, `browser:${tileId}:mcp`',
    )
    expect(BROWSER_TILE_SOURCE).toContain("browser_get_evidence")
    expect(BROWSER_TILE_SOURCE).toContain('browser.evidence.snapshot')
    expect(BROWSER_TILE_SOURCE).toContain('browser.page_health')
    expect(BROWSER_TILE_SOURCE).toContain('ctx:browser:viewport')
    expect(BROWSER_TILE_SOURCE).toContain('ctx:browser:evidence_snapshot')
    expect(BROWSER_TILE_SOURCE).toContain('BrowserEvidenceViewport')
  })
})
