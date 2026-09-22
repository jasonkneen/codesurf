import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import { parseMediaAccessKind, planOsMediaAccess } from '../src/main/security/mediaAccessPlan.ts'

describe('planOsMediaAccess', () => {
  test('asks macOS the first time, grants when already allowed, otherwise opens Settings', () => {
    expect(planOsMediaAccess('granted')).toBe('grant')
    expect(planOsMediaAccess('not-determined')).toBe('ask')
    expect(planOsMediaAccess('unknown')).toBe('ask')
    expect(planOsMediaAccess('denied')).toBe('settings')
    expect(planOsMediaAccess('restricted')).toBe('settings')
  })

  test('parseMediaAccessKind defaults to microphone', () => {
    expect(parseMediaAccessKind('camera')).toBe('camera')
    expect(parseMediaAccessKind('microphone')).toBe('microphone')
    expect(parseMediaAccessKind(undefined)).toBe('microphone')
  })
})
