import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const HARNESS_HTML = join(ROOT_DIR, 'examples', 'extensions', '_harness', 'index.html')

test('extension harness exposes chat-surface controls and payload inspection', async () => {
  const html = await readFile(HARNESS_HTML, 'utf8')

  assert.match(html, /id="entry-kind"/, 'missing mode selector for tile vs chat surface')
  assert.match(html, /Chat Surface/, 'missing chat surface UI label')
  assert.match(html, /id="btn-surface-flush"/, 'missing surface flush control')
  assert.match(html, /id="btn-surface-clear"/, 'missing surface clear control')
  assert.match(html, /id="surface-payload-view"/, 'missing surface payload preview panel')
  assert.match(html, /surface\.setPayload/, 'missing harness handling for surface payload updates')
  assert.match(html, /surface\.requestFlush/, 'missing harness requestFlush simulation')
  assert.match(html, /surface\.clear/, 'missing harness clear simulation')
})
