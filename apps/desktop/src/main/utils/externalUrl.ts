const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function normalizeSafeExternalUrl(rawUrl: string): string | null {
  const trimmed = String(rawUrl ?? '').trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    if (!SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return null
    return parsed.toString()
  } catch {
    return null
  }
}
