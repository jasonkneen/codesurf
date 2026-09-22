import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  isUnreadableScanLocationCode,
  unreadableScanLocationsFromProbes,
} from '../src/renderer/src/lib/scanLocationProbe.ts'

describe('isUnreadableScanLocationCode', () => {
  test('missing optional folders are not warnings', () => {
    expect(isUnreadableScanLocationCode('ENOENT')).toBe(false)
    expect(isUnreadableScanLocationCode(undefined)).toBe(false)
    expect(isUnreadableScanLocationCode(null)).toBe(false)
    expect(isUnreadableScanLocationCode('')).toBe(false)
  })

  test('permission and type errors still warn', () => {
    expect(isUnreadableScanLocationCode('EACCES')).toBe(true)
    expect(isUnreadableScanLocationCode('EPERM')).toBe(true)
    expect(isUnreadableScanLocationCode('ENOTDIR')).toBe(true)
    expect(isUnreadableScanLocationCode('UNKNOWN')).toBe(true)
  })
})

describe('unreadableScanLocationsFromProbes', () => {
  test('the four missing default skill folders do not produce a banner', () => {
    const workspace = '/Users/jkneen/clawd/collaborator-clone'
    const unreadable = unreadableScanLocationsFromProbes([
      { path: `${workspace}/.claude/commands`, probe: { ok: true } },
      { path: `${workspace}/.claude/skills`, probe: { ok: false, code: 'ENOENT' } },
      { path: `${workspace}/.opencode/skills`, probe: { ok: false, code: 'ENOENT' } },
      { path: `${workspace}/.cursor/rules`, probe: { ok: false, code: 'ENOENT' } },
      { path: `${workspace}/.continue/prompts`, probe: { ok: false, code: 'ENOENT' } },
    ])
    expect(unreadable).toEqual([])
  })

  test('a file configured as a skill location still warns', () => {
    const unreadable = unreadableScanLocationsFromProbes([
      { path: '/tmp/skills', probe: { ok: false, code: 'ENOTDIR' } },
      { path: '/tmp/missing', probe: { ok: false, code: 'ENOENT' } },
      { path: '/tmp/ok', probe: { ok: true } },
      { path: '/tmp/no-api', probe: null },
    ])
    expect(unreadable).toEqual([{ path: '/tmp/skills', code: 'ENOTDIR' }])
  })
})
