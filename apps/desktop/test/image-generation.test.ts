import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { expect } from './node-expect.ts'
import { DEFAULT_SETTINGS, withDefaultSettings } from '../src/shared/types.ts'
import {
  extractGeminiInlineImage,
  makeImageOutputPath,
  mimeTypeForImagePath,
  selectImageProvider,
} from '../src/main/image-generation.ts'

describe('image generation helpers', () => {
  test('selects enabled Gemini image provider with an API key', () => {
    const settings = withDefaultSettings({
      generationProviders: {
        ...DEFAULT_SETTINGS.generationProviders,
        gemini: {
          ...DEFAULT_SETTINGS.generationProviders.gemini,
          enabled: true,
          apiKey: 'test-key',
        },
      },
    })

    const selection = selectImageProvider(settings)

    assert.notEqual(typeof selection, 'string')
    if (typeof selection === 'string') return
    expect(selection.provider.id).toBe('gemini')
    expect(selection.model).toBe('gemini-2.5-flash-image')
  })

  test('returns a loud setup error when no image provider can run', () => {
    const selection = selectImageProvider(withDefaultSettings({}))

    assert.equal(typeof selection, 'string')
    expect(selection).toContain('No enabled image provider')
  })

  test('extracts image payloads from Gemini inlineData responses', () => {
    const image = extractGeminiInlineImage({
      candidates: [{
        content: {
          parts: [
            { text: 'done' },
            { inlineData: { mimeType: 'image/png', data: 'abc123' } },
          ],
        },
      }],
    })

    expect(image).toEqual({ mimeType: 'image/png', data: 'abc123' })
  })

  test('builds local output paths beside the source image', () => {
    const sourcePath = '/tmp/source image.jpg'

    expect(mimeTypeForImagePath(sourcePath)).toBe('image/jpeg')
    expect(makeImageOutputPath(sourcePath, 'caption.png', 'image/png')).toBe('/tmp/caption.png')
    assert.match(makeImageOutputPath(sourcePath, undefined, 'image/png'), /^\/tmp\/source-image-edited-\d+\.png$/)
  })
})
