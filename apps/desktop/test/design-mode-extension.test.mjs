import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const BUILDER_DIR = join(ROOT_DIR, 'bundled-extensions', 'builder')
const SKETCH_DIR = join(ROOT_DIR, 'bundled-extensions', 'sketch')
const QA_DIR = join(ROOT_DIR, 'bundled-extensions', 'qa-workbench')

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

test('builder declares screenshot-driven design mode context and actions', async () => {
  const manifest = await readJson(join(BUILDER_DIR, 'extension.json'))
  const context = manifest.contributes.context

  assert.ok(context.consumes.includes('ctx:sketch:image'))
  assert.ok(context.consumes.includes('ctx:qa-workbench:report'))
  assert.ok(context.consumes.includes('ctx:qa-workbench:visual_fix_handoff'))
  assert.ok(context.consumes.includes('ctx:browser:evidence_summary'))
  assert.ok(context.consumes.includes('ctx:browser:evidence_snapshot'))
  assert.ok(context.consumes.includes('ctx:browser:page_health'))
  assert.ok(context.consumes.includes('ctx:browser:viewport'))
  assert.ok(context.produces.includes('ctx:builder:visual_refs'))
  assert.ok(context.produces.includes('ctx:builder:visual_verification_prompt'))
  assert.ok(context.produces.includes('ctx:builder:qa_handoff'))

  const actionNames = manifest.contributes.actions.map(action => action.name).sort()
  assert.ok(actionNames.includes('addVisualReference'))
  assert.ok(actionNames.includes('clearVisualReferences'))
  assert.ok(actionNames.includes('buildVisualVerificationPrompt'))
})

test('builder surface imports screenshots and sends multimodal visual references to generation', async () => {
  const html = await readFile(join(BUILDER_DIR, 'surface', 'index.html'), 'utf8')

  assert.match(html, /id="screenshotInput"/)
  assert.match(html, /id="screenshotBtn"/)
  assert.match(html, /data-template="match-screenshot"/)
  assert.match(html, /data-template="visual-verify"/)
  assert.match(html, /data-template="qa-fix"/)
  assert.match(html, /FileReader/)
  assert.match(html, /dragover/)
  assert.match(html, /paste/)
  assert.match(html, /image_url/)
  assert.match(html, /buildUserMessageContent/)
  assert.match(html, /ctx:builder:visual_refs/)
  assert.match(html, /ctx:builder:visual_verification_prompt/)
  assert.match(html, /ctx:builder:qa_handoff/)
  assert.match(html, /ctx:qa-workbench:report/)
  assert.match(html, /ctx:qa-workbench:visual_fix_handoff/)
  assert.match(html, /maybeApplyQaHandoffPrompt/)
  assert.match(html, /window\.contex\.chat\.openSurface\(\{ extId: 'qa-workbench', surfaceId: 'qa-report' \}\)/)
})

test('sketch publishes screenshot context and can hand off to builder', async () => {
  const manifest = await readJson(join(SKETCH_DIR, 'extension.json'))
  const context = manifest.contributes.context

  assert.ok(context.produces.includes('ctx:sketch:image'))
  assert.ok(context.produces.includes('ctx:sketch:design_handoff'))
  assert.ok(context.consumes.includes('ctx:builder:visual_refs'))

  const html = await readFile(join(SKETCH_DIR, 'surface', 'index.html'), 'utf8')
  assert.match(html, /id="importImage"/)
  assert.match(html, /id="sendBuilder"/)
  assert.match(html, /Drop screenshot or image to insert/)
  assert.match(html, /ctx:sketch:image/)
  assert.match(html, /ctx:sketch:design_handoff/)
  assert.match(html, /window\.contex\.chat\.openSurface\(\{ extId: 'builder', surfaceId: 'builder' \}\)/)
})

test('qa report chat surface publishes report context for design-mode handoff', async () => {
  const html = await readFile(join(QA_DIR, 'surface', 'index.html'), 'utf8')

  assert.match(html, /ctx:qa-workbench:report/)
  assert.match(html, /context\.set/)
  assert.match(html, /publishQaContext/)
})
