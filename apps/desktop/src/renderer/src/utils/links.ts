import { toFileUrl } from './dnd'

export const CODESURF_OPEN_LINK_EVENT = 'codesurf:open-link'

export type CodeSurfOpenLinkDetail = {
  href: string
}

export function findAnchorFromEventTarget(event: Event): HTMLAnchorElement | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  for (const entry of path) {
    if (!(entry instanceof Element)) continue
    const anchor = entry.closest('a')
    if (anchor instanceof HTMLAnchorElement) return anchor
  }

  const rawTarget = event.target
  const target = rawTarget instanceof Element
    ? rawTarget
    : rawTarget instanceof Node
      ? rawTarget.parentElement
      : null

  const anchor = target?.closest('a')
  return anchor instanceof HTMLAnchorElement ? anchor : null
}

export function stripLocalPathLocation(value: string): string {
  const lineHashIndex = value.indexOf('#L')
  const colonLineMatch = value.match(/:\d+(?::\d+)?$/)

  if (lineHashIndex >= 0) return value.slice(0, lineHashIndex)
  if (colonLineMatch) return value.slice(0, value.length - colonLineMatch[0].length)
  return value
}

export function normalizeLocalPathCandidate(rawValue: string): string | null {
  const trimmed = String(rawValue ?? '').trim()
  if (!trimmed) return null

  if (trimmed.startsWith('file://')) {
    try {
      return stripLocalPathLocation(decodeURIComponent(new URL(trimmed).pathname))
    } catch {
      return null
    }
  }

  if (!trimmed.startsWith('/')) return null
  if (/[\r\n]/.test(trimmed)) return null
  return stripLocalPathLocation(trimmed)
}

export function normalizeOpenableHref(rawHref: string): string | null {
  const trimmed = String(rawHref ?? '').trim()
  if (!trimmed) return null

  const localPath = normalizeLocalPathCandidate(trimmed)
  if (localPath) return toFileUrl(localPath)

  return trimmed
}

export function dispatchOpenLink(rawHref: string): boolean {
  const href = normalizeOpenableHref(rawHref)
  if (!href) return false

  window.dispatchEvent(new CustomEvent<CodeSurfOpenLinkDetail>(CODESURF_OPEN_LINK_EVENT, {
    detail: { href },
  }))
  return true
}
