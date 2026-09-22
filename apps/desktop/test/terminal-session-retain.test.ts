import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTerminalSessionLease } from '../src/renderer/src/lib/terminalSessionRetain.ts'

describe('terminal session retain/release', () => {
  test('fullscreen unmount does not detach while the canvas instance is still mounted', () => {
    const detached: string[] = []
    const scheduled: Array<() => void> = []
    const lease = createTerminalSessionLease({
      detach: tileId => { detached.push(tileId) },
      schedule: callback => { scheduled.push(callback) },
    })

    lease.retain('term-1')
    lease.retain('term-1')
    lease.release('term-1')
    for (const callback of scheduled) callback()
    assert.deepEqual(detached, [])
    assert.equal(lease.count('term-1'), 1)
  })

  test('a same-commit remount does not detach before the new instance retains', () => {
    const detached: string[] = []
    const scheduled: Array<() => void> = []
    const lease = createTerminalSessionLease({
      detach: tileId => { detached.push(tileId) },
      schedule: callback => { scheduled.push(callback) },
    })

    lease.retain('term-1')
    lease.release('term-1')
    lease.retain('term-1')
    for (const callback of scheduled) callback()
    assert.deepEqual(detached, [])
    assert.equal(lease.count('term-1'), 1)
  })

  test('the last instance detaches the PTY', () => {
    const detached: string[] = []
    const scheduled: Array<() => void> = []
    const lease = createTerminalSessionLease({
      detach: tileId => { detached.push(tileId) },
      schedule: callback => { scheduled.push(callback) },
    })

    lease.retain('term-1')
    lease.release('term-1')
    for (const callback of scheduled) callback()
    assert.deepEqual(detached, ['term-1'])
    assert.equal(lease.count('term-1'), 0)
  })

  test('TerminalTile uses the shared lease instead of detaching on every unmount', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/components/TerminalTile.tsx'), 'utf8')
    assert.match(source, /terminalSessionLease\.retain\(tileId\)/)
    assert.match(source, /terminalSessionLease\.release\(tileId\)/)
    assert.doesNotMatch(source, /terminal\?\.detach\?\.\(tileId\)/)
  })
})
