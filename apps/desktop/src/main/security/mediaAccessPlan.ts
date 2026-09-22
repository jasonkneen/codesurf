import type { MediaAccessKind } from './permissionBoundaryTypes.ts'

export type MediaAccessPlan = 'grant' | 'ask' | 'settings'

export function planOsMediaAccess(status: string): MediaAccessPlan {
  if (status === 'granted') return 'grant'
  if (status === 'not-determined' || status === 'unknown') return 'ask'
  return 'settings'
}

export function parseMediaAccessKind(value: unknown): MediaAccessKind {
  return value === 'camera' ? 'camera' : 'microphone'
}
