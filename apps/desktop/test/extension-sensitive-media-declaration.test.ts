import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  EXTENSION_MEDIA_DIALOG_TEXT_BYTES,
  getDeclaredSensitiveMediaCapabilities,
  getDeclaredSensitiveMediaDeclaration,
  getSafeExtensionMediaAttribution,
  sanitizeExtensionMediaDialogText,
} from '../src/shared/extension-sensitive-media.ts'

describe('extension sensitive-media declarations', () => {
  test('preserves the first reason for each valid capability in canonical order', () => {
    const declaration = getDeclaredSensitiveMediaDeclaration([
      { name: 'camera', reason: 'Join video calls' },
      { name: 'fs', reason: 'Not a media capability' },
      { name: 'microphone', reason: 'Join audio calls' },
      { name: 'camera', reason: 'A duplicate must not replace the reviewed reason' },
      { name: 'display-capture' },
    ])

    assert.deepEqual(declaration.capabilities, [
      'microphone',
      'camera',
      'display-capture',
    ])
    assert.deepEqual(declaration.reasons, {
      microphone: 'Join audio calls',
      camera: 'Join video calls',
    })
    assert.deepEqual(
      getDeclaredSensitiveMediaCapabilities([
        { name: 'display-capture', reason: 'Present a window' },
        { name: 'camera' },
      ]),
      ['camera', 'display-capture'],
    )
  })

  test('does not coerce malformed reasons', () => {
    const declaration = getDeclaredSensitiveMediaDeclaration([
      { name: 'microphone', reason: undefined },
      { name: 'camera', reason: 42 as unknown as string },
    ])

    assert.deepEqual(declaration.capabilities, ['microphone', 'camera'])
    assert.deepEqual(declaration.reasons, {})
  })

  test('sanitizes untrusted native-dialog attribution with UTF-8 byte caps', () => {
    const hostileName = `\u202e  Video\u0000\t Helper \u2066${'雪'.repeat(200)}`
    const hostileReason = `\u200f present\n the\u0007 sales deck ${'🚀'.repeat(300)}`
    const attribution = getSafeExtensionMediaAttribution(
      'screen-helper',
      hostileName,
      hostileReason,
    )

    assert.equal(/[\p{Cc}\p{Bidi_Control}]/u.test(attribution.name), false)
    assert.equal(/[\p{Cc}\p{Bidi_Control}]/u.test(attribution.reason ?? ''), false)
    assert.equal(/\s{2,}/u.test(attribution.name), false)
    assert.equal(/\s{2,}/u.test(attribution.reason ?? ''), false)
    assert.ok(
      Buffer.byteLength(attribution.name, 'utf8')
        <= EXTENSION_MEDIA_DIALOG_TEXT_BYTES.extensionName,
    )
    assert.ok(
      Buffer.byteLength(attribution.reason ?? '', 'utf8')
        <= EXTENSION_MEDIA_DIALOG_TEXT_BYTES.reason,
    )
    assert.match(attribution.name, /^Video Helper/u)
    assert.match(attribution.reason ?? '', /^present the sales deck/u)
  })

  test('uses a bounded safe extension id when the display name is unusable', () => {
    const attribution = getSafeExtensionMediaAttribution(
      'safe-extension-id',
      '\u0000\u202e \t',
    )
    assert.deepEqual(attribution, {
      id: 'safe-extension-id',
      name: 'safe-extension-id',
    })

    const sourceLabel = sanitizeExtensionMediaDialogText(
      `\u202e\u0000 ${'雪'.repeat(100)}`,
      'Source 1',
      EXTENSION_MEDIA_DIALOG_TEXT_BYTES.sourceLabel,
    )
    assert.equal(/[\p{Cc}\p{Bidi_Control}]/u.test(sourceLabel), false)
    assert.ok(
      Buffer.byteLength(sourceLabel, 'utf8')
        <= EXTENSION_MEDIA_DIALOG_TEXT_BYTES.sourceLabel,
    )
    assert.equal(sanitizeExtensionMediaDialogText('anything', '', 0), '')
    assert.ok(
      Buffer.byteLength(
        sanitizeExtensionMediaDialogText('snow: 雪', '', 2),
        'utf8',
      ) <= 2,
    )
  })
})
