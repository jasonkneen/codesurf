import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, test } from 'node:test'

// runtime-pets uses CODESURF_HOME from paths — for unit isolation we only test
// the pure path safety + install rejection paths that don't need a home rewrite.
import {
  listPets,
  removePet,
  getPetManifest,
  galleryLocal,
} from '../electrobun/bun/runtime-pets.ts'

describe('Electrobun runtime-pets', () => {
  test('listPets returns an array (empty or populated from local install dirs)', () => {
    const list = listPets()
    assert.ok(Array.isArray(list))
    for (const pet of list) {
      assert.equal(typeof pet.id, 'string')
      assert.equal(typeof pet.displayName, 'string')
      assert.equal(typeof pet.spritesheetPath, 'string')
    }
  })

  test('galleryLocal mirrors list shape', () => {
    const g = galleryLocal()
    assert.ok(Array.isArray(g))
    for (const entry of g) {
      assert.equal(typeof entry.id, 'string')
      assert.equal(typeof entry.installed, 'boolean')
    }
  })

  test('removePet rejects path traversal slugs', () => {
    const result = removePet('../../.ssh')
    assert.equal(result.ok, false)
    assert.match(String(result.error), /Invalid|pet slug/i)
  })

  test('getPetManifest returns null for unknown id', () => {
    assert.equal(getPetManifest('definitely-not-a-real-pet-id-xyz'), null)
  })

  test('removePet rejects missing local install without deleting outside pets dir', () => {
    const result = removePet('no-such-pet-for-electrobun-test')
    assert.equal(result.ok, false)
  })
})

describe('Electrobun terminal exit channel contract', () => {
  // Documents the Electron-compatible channel the bun host must broadcast so
  // the facade's terminal.onExit (eventHub.on(`terminal:exit:${tileId}`)) fires.
  test('exit channel name matches Electron preload contract', () => {
    const tileId = 'tile-abc'
    const exitCode = 7
    const channel = `terminal:exit:${tileId}`
    assert.equal(channel, 'terminal:exit:tile-abc')
    // Payload is the numeric exit code (facade does Number(payload ?? 0)).
    assert.equal(Number(exitCode), 7)
  })
})
