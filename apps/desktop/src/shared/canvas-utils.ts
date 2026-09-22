const CURVIER_BLOCK_RADIUS_STEPS = [0, 3, 4, 6, 8, 12, 16, 24, 32, 40] as const

export function getCurvierBlockRadius(radius?: number): number {
  const current = Number.isFinite(radius) ? Math.max(0, Math.round(radius as number)) : 12
  if (current <= 0) return 0

  for (let index = 0; index < CURVIER_BLOCK_RADIUS_STEPS.length; index++) {
    const step = CURVIER_BLOCK_RADIUS_STEPS[index]
    if (current <= step) return step
  }

  return current
}
