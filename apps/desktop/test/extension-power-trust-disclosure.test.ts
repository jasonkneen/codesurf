import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  POWER_EXTENSION_TRUST_DISCLOSURE,
  getExtensionTrustDisclosure,
} from '../src/renderer/src/components/extensionTrustDisclosure.ts'

const root = process.cwd()

test('POWER disclosure states the real child-process and capability boundary', () => {
  assert.equal(getExtensionTrustDisclosure('safe'), null)
  assert.equal(
    getExtensionTrustDisclosure('power'),
    POWER_EXTENSION_TRUST_DISCLOSURE,
  )
  assert.match(POWER_EXTENSION_TRUST_DISCLOSURE, /isolated child process/)
  assert.match(POWER_EXTENSION_TRUST_DISCLOSURE, /not a security sandbox/)
  assert.match(POWER_EXTENSION_TRUST_DISCLOSURE, /ambient Node\.js filesystem and process access/)
  assert.match(POWER_EXTENSION_TRUST_DISCLOSURE, /Capability grants limit CodeSurf APIs only/)
})

test('Gallery visibly renders the trust disclosure only for POWER cards', async () => {
  const source = await readFile(
    join(root, 'src/renderer/src/components/ExtensionsGallery.tsx'),
    'utf8',
  )

  assert.match(
    source,
    /const trustDisclosure = getExtensionTrustDisclosure\(ext\.tier\)/,
  )
  assert.match(
    source,
    /\{trustDisclosure && \(\s*<div\s+aria-label="POWER plugin trust notice"/,
  )
  assert.match(source, /<span>\{trustDisclosure\}<\/span>/)
})

test('canonical trust and authoring docs do not overclaim POWER sandboxing', async () => {
  const [architecture, authoring] = await Promise.all([
    readFile(join(root, 'docs/plugins/00-architecture.md'), 'utf8'),
    readFile(join(root, 'docs/plugins/01-authoring.md'), 'utf8'),
  ])

  for (const document of [architecture, authoring]) {
    assert.match(document, /utility-process child/)
    assert.match(document, /not a security sandbox/i)
    assert.match(document, /ambient Node\.js access/)
    assert.match(document, /CodeSurf APIs/)
    assert.match(document, /Node built-ins/)
  }
})
