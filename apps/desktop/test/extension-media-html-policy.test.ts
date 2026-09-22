import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'
import {
  getBridgeScript,
  serializeForInlineScript,
} from '../src/main/extensions/bridge.ts'
import {
  applyMediaExtensionHtmlPolicy,
  buildMediaExtensionCsp,
  injectMediaExtensionCspMeta,
} from '../src/main/extensions/media-html-policy.ts'

function scriptHash(body: string): string {
  return `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`
}

describe('sensitive-media extension HTML policy', () => {
  test('hashes exact final bridge and inline script bodies without remote execution sources', () => {
    const bridge = getBridgeScript('tile-1', 'media-extension')
    const inline = 'globalThis.localExtensionScript = true'
    const html = `<html><head><script>${bridge}</script></head><body><script>${inline}</script></body></html>`
    const policy = applyMediaExtensionHtmlPolicy(html)

    assert.equal(policy.html, html)
    assert.match(policy.csp, new RegExp(scriptHash(bridge).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(policy.csp, new RegExp(scriptHash(inline).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(policy.csp, /script-src 'self'/)
    assert.match(policy.csp, /script-src-attr 'none'/)
    assert.match(policy.csp, /worker-src 'self'/)
    assert.match(policy.csp, /object-src 'none'/)
    assert.match(policy.csp, /base-uri 'none'/)
    assert.doesNotMatch(
      policy.csp.match(/script-src [^;]+/)?.[0] ?? '',
      /https?:|data:|blob:|\*/,
    )
  })

  test('handles mixed-case scripts and fails closed on quoted tag delimiters', () => {
    const mixedBody = 'globalThis.mixedCase = true'
    const mixed = buildMediaExtensionCsp(`<ScRiPt>${mixedBody}</sCrIpT>`)
    assert.match(
      mixed,
      new RegExp(scriptHash(mixedBody).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )

    const quotedBody = 'globalThis.mustNotBeAccidentallyAuthorized = true'
    const quoted = buildMediaExtensionCsp(
      `<script data-label=">">${quotedBody}</script>`,
    )
    assert.doesNotMatch(
      quoted,
      new RegExp(scriptHash(quotedBody).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )
  })

  test('places srcdoc policy before executable markup', () => {
    const html = '<!doctype html><html><head><script>safe()</script></head></html>'
    const protectedHtml = injectMediaExtensionCspMeta(html)
    const metaIndex = protectedHtml.indexOf('Content-Security-Policy')
    assert.ok(metaIndex > 0)
    assert.ok(metaIndex < protectedHtml.indexOf('<script>'))
  })

  test('escapes every script-context delimiter in bridge data', () => {
    const hostile = '</script><script>globalThis.pwned=1</script>&\u2028\u2029'
    const serialized = serializeForInlineScript(hostile)
    assert.equal(
      serialized,
      '"\\u003c/script\\u003e\\u003cscript\\u003eglobalThis.pwned=1\\u003c/script\\u003e\\u0026\\u2028\\u2029"',
    )

    const bridge = getBridgeScript(hostile, 'media-extension')
    const document = `<script>${bridge}</script>`
    assert.equal(document.match(/<script>/gi)?.length, 1)
    assert.equal(document.match(/<\/script>/gi)?.length, 1)
    assert.doesNotMatch(document, /globalThis\.pwned=1<\/script>/)
    assert.match(buildMediaExtensionCsp(document), /script-src 'self' 'sha256-/)
  })
})
