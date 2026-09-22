import { isAbsolute, relative, resolve } from 'path'

export function assertSafeWorkspacePath(workspacePath: string): string {
  const resolved = resolve(String(workspacePath ?? '').trim())
  if (!resolved) throw new Error('Invalid workspace path')
  return resolved
}

export function assertSafePathSegment(value: string, label: string): string {
  const segment = String(value ?? '').trim()
  if (
    !segment
    || segment === '.'
    || segment === '..'
    || segment.includes('/')
    || segment.includes('\\')
    || segment.includes('\0')
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return segment
}

export function resolveInside(root: string, ...segments: string[]): string {
  const base = resolve(root)
  const target = resolve(base, ...segments)
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Path escapes expected directory')
  }
  return target
}