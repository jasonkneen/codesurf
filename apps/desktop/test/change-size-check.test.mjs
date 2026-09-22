import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  isProductionPath,
  parseNumstat,
  summarizeChange,
} from '../scripts/check-change-size.mjs'

describe('change-size review helper', () => {
  test('classifies production and review-support paths consistently', () => {
    assert.equal(isProductionPath('src/main/index.ts'), true)
    assert.equal(isProductionPath('packages/relay/src/relay.ts'), true)
    assert.equal(isProductionPath('test/relay.test.ts'), false)
    assert.equal(isProductionPath('src/main/index.test.ts'), false)
    assert.equal(isProductionPath('docs/design.md'), false)
    assert.equal(isProductionPath('package-lock.json'), false)
  })

  test('parses text and binary numstat without inflating line totals', () => {
    const files = parseNumstat([
      '300\t150\tsrc/main/index.ts',
      '200\t50\ttest/index.test.ts',
      '-\t-\tresources/icon.png',
      '',
    ].join('\n'))

    assert.deepEqual(files, [
      {
        path: 'src/main/index.ts',
        added: 300,
        deleted: 150,
        changed: 450,
        binary: false,
        production: true,
      },
      {
        path: 'test/index.test.ts',
        added: 200,
        deleted: 50,
        changed: 250,
        binary: false,
        production: false,
      },
      {
        path: 'resources/icon.png',
        added: 0,
        deleted: 0,
        changed: 0,
        binary: true,
        production: true,
      },
    ])
  })

  test('reports production and total thresholds independently', () => {
    const files = parseNumstat([
      '480\t0\tsrc/main/index.ts',
      '400\t0\ttest/index.test.ts',
    ].join('\n'))
    assert.deepEqual(summarizeChange(files), {
      total: 880,
      production: 480,
      totalLimit: 800,
      productionLimit: 500,
      overTotal: true,
      overProduction: false,
    })
  })
})
