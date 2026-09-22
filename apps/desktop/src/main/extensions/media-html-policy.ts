import { createHash } from 'node:crypto'

const INLINE_SCRIPT_PATTERN = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi

function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>()
  for (const match of html.matchAll(INLINE_SCRIPT_PATTERN)) {
    const body = match[1] ?? ''
    const digest = createHash('sha256').update(body, 'utf8').digest('base64')
    hashes.add(`'sha256-${digest}'`)
  }
  return [...hashes].sort()
}

/**
 * Sensitive-media extensions retain network access for their declared use
 * cases, but executable code is restricted to attested same-origin resources
 * and the exact inline bodies present in the final verified HTML response.
 */
export function buildMediaExtensionCsp(html: string): string {
  const scriptSources = ["'self'", ...inlineScriptHashes(html)].join(' ')
  return [
    "default-src 'self'",
    `script-src ${scriptSources}`,
    "script-src-attr 'none'",
    "worker-src 'self'",
    "connect-src 'self' http: https: ws: wss:",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * srcdoc/MCP-UI delivery has no response headers. Place the policy before any
 * executable markup so the HTML parser applies it before encountering scripts.
 */
export function injectMediaExtensionCspMeta(
  html: string,
  csp = buildMediaExtensionCsp(html),
): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}">`
  const prefix = html.match(/^(?:\uFEFF)?\s*<!doctype[^>]*>/i)?.[0] ?? ''
  return `${prefix}${prefix ? '\n' : ''}${meta}\n${html.slice(prefix.length)}`
}

export function applyMediaExtensionHtmlPolicy(
  html: string,
  options?: { readonly injectMeta?: boolean },
): { readonly html: string; readonly csp: string } {
  const csp = buildMediaExtensionCsp(html)
  return {
    html: options?.injectMeta ? injectMediaExtensionCspMeta(html, csp) : html,
    csp,
  }
}
