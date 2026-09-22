import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const EXT_DIR = join(ROOT_DIR, 'bundled-extensions', 'qa-workbench')

async function readManifest() {
  return JSON.parse(await readFile(join(EXT_DIR, 'extension.json'), 'utf8'))
}

function runNode(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', rejectPromise)
    child.once('close', code => resolvePromise({ code: code ?? 1, stdout, stderr }))
  })
}

test('qa-workbench is bundled as a host-backed browser QA tile and chat surface', async () => {
  const manifest = await readManifest()

  assert.equal(manifest.id, 'qa-workbench')
  assert.equal(manifest.name, 'QA Workbench')
  assert.equal(manifest.tier, 'power')
  assert.equal(manifest.main, 'main.js')
  assert.equal(manifest.ui.mode, 'native')

  const tile = manifest.contributes.tiles.find(entry => entry.type === 'qa-workbench')
  assert.ok(tile, 'expected qa-workbench tile contribution')
  assert.equal(tile.entry, 'tile/index.html')
  assert.deepEqual(tile.defaultSize, { w: 720, h: 560 })

  const surface = manifest.contributes.chatSurfaces.find(entry => entry.id === 'qa-report')
  assert.ok(surface, 'expected qa-report chat surface contribution')
  assert.equal(surface.entry, 'surface/index.html')
  assert.equal(surface.emits, 'text')

  assert.deepEqual(manifest.contributes.context.consumes.sort(), [
    'ctx:browser:evidence_snapshot',
    'ctx:browser:evidence_summary',
    'ctx:browser:page_health',
    'ctx:browser:title',
    'ctx:browser:viewport',
  ].sort())
  assert.deepEqual(manifest.contributes.context.produces.sort(), [
    'ctx:qa-workbench:report',
    'ctx:qa-workbench:visual_fix_handoff',
  ].sort())

  const actionNames = manifest.contributes.actions.map(action => action.name).sort()
  assert.deepEqual(actionNames, ['captureAll', 'generateReport', 'getVisualFixHandoff'])
})

test('qa-workbench tile can open chat surfaces for QA report and Builder fixes', async () => {
  const tileHtml = await readFile(join(EXT_DIR, 'tile', 'index.html'), 'utf8')
  assert.match(tileHtml, /id="chatBtn"/)
  assert.match(tileHtml, /Send to chat/)
  assert.match(tileHtml, /id="builderBtn"/)
  assert.match(tileHtml, /Fix in Builder/)
  assert.match(tileHtml, /getVisualFixHandoff/)
  assert.match(tileHtml, /initialContext/)
  assert.match(tileHtml, /ctx:qa-workbench:visual_fix_handoff/)
  assert.match(tileHtml, /window\.contex\.chat\.openSurface/)
  assert.match(tileHtml, /extId: 'qa-workbench'/)
  assert.match(tileHtml, /surfaceId: 'qa-report'/)
  assert.match(tileHtml, /extId: 'builder'/)
  assert.match(tileHtml, /surfaceId: 'builder'/)
})

test('qa-workbench shared helpers reduce browser evidence events into reports and chat payloads', async () => {
  const shared = await import(pathToFileURL(join(EXT_DIR, 'shared.js')).href)
  const state = shared.createWorkbenchState({ maxEvents: 3 })

  shared.applyBrowserBusEvent(state, {
    channel: 'tile:browser-1',
    type: 'browser.evidence',
    source: 'browser:browser-1',
    timestamp: 1000,
    payload: {
      event: {
        id: 'evt-1',
        tileId: 'browser-1',
        timestamp: 990,
        severity: 'error',
        kind: 'console',
        message: 'Uncaught TypeError: boom',
        source: 'console-message',
        url: 'https://example.test/app',
      },
      summary: { total: 1, errorCount: 1, warningCount: 0, infoCount: 0 },
      health: { status: 'error', label: 'Errors detected', issueCount: 1, loading: false },
      page: { url: 'https://example.test/app', title: 'Example App', isLoading: false, mode: 'desktop' },
    },
  })

  shared.applyBrowserBusEvent(state, {
    channel: 'tile:browser-1',
    type: 'browser.evidence.snapshot',
    source: 'browser:browser-1',
    timestamp: 1200,
    payload: {
      reason: 'browser_capture_snapshot',
      snapshot: {
        tileId: 'browser-1',
        capturedAt: 1200,
        page: { url: 'https://example.test/app', title: 'Example App', isLoading: false, mode: 'desktop' },
        summary: { total: 1, errorCount: 1, warningCount: 0, infoCount: 0 },
        health: { status: 'error', label: 'Errors detected', issueCount: 1, loading: false },
        viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
        events: [
          {
            id: 'evt-1',
            tileId: 'browser-1',
            timestamp: 990,
            severity: 'error',
            kind: 'console',
            message: 'Uncaught TypeError: boom',
            source: 'console-message',
            url: 'https://example.test/app',
          },
        ],
      },
      report: '# Browser QA Evidence\n\nExisting browser report text',
    },
  })

  const summary = shared.getWorkbenchSummary(state)
  assert.equal(summary.browserCount, 1)
  assert.equal(summary.issueCount, 1)
  assert.equal(summary.healthStatus, 'error')
  assert.equal(state.browsers['browser-1'].events.length, 1)
  assert.equal(state.browsers['browser-1'].latestSnapshot.reason, 'browser_capture_snapshot')

  const report = shared.buildQaWorkbenchReport(state, { now: 1300 })
  assert.match(report, /^# QA Workbench/m)
  assert.match(report, /Browser: browser-1/)
  assert.match(report, /Health: error/)
  assert.match(report, /Viewport: 1280×720 @2x/)
  assert.match(report, /Uncaught TypeError: boom/)
  assert.match(report, /Existing browser report text/)

  const payload = shared.buildChatSurfacePayload(state, { now: 1300 })
  assert.equal(payload.kind, 'text')
  assert.equal(payload.mime, 'text/markdown')
  assert.equal(payload.ext, 'md')
  assert.equal(payload.data, report)

  const handoff = shared.buildVisualFixHandoff(state, { now: 1300 })
  assert.equal(handoff.kind, 'qa-workbench.visual_fix_handoff')
  assert.match(handoff.prompt, /Fix this frontend using the QA Workbench browser evidence/)
  assert.equal(handoff.summary.issueCount, 1)
  assert.equal(handoff.browsers[0].viewport.width, 1280)
  assert.match(handoff.report, /Existing browser report text/)
})

test('validate-extension accepts bundled qa-workbench targets', async () => {
  const result = await runNode(['scripts/validate-extension.mjs', 'bundled-extensions/qa-workbench'])
  assert.equal(
    result.code,
    0,
    `validate-extension failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
  assert.match(result.stdout, /\[OK\] bundled-extensions\/qa-workbench|\[OK\] qa-workbench/)
  assert.match(result.stdout, /Summary: 1 passed, 0 failed/)
})

test('validate-extension rejects missing bundled chat surface entries', async (t) => {
  const id = `tmp-missing-surface-${process.pid}-${Date.now()}`
  const tempDir = join(ROOT_DIR, 'bundled-extensions', id)
  await mkdir(tempDir, { recursive: true })
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  await writeFile(join(tempDir, 'extension.json'), JSON.stringify({
    id,
    name: 'Missing Surface Fixture',
    version: '0.0.0',
    tier: 'safe',
    contributes: {
      chatSurfaces: [
        {
          id: 'missing-report',
          label: 'Missing Report',
          description: 'Fixture with a missing chat surface entry.',
          icon: 'bug',
          entry: 'surface/missing.html',
          emits: 'text',
          defaultHeight: 240,
          minHeight: 160,
        },
      ],
    },
    permissions: [],
  }, null, 2))

  const result = await runNode(['scripts/validate-extension.mjs', `bundled-extensions/${id}`])
  assert.notEqual(result.code, 0, `validate-extension unexpectedly passed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.match(result.stdout, /contributes\.chatSurfaces\[0\]\.entry points to a missing file: surface\/missing\.html/)
})
