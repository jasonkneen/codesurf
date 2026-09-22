/**
 * Resolve web-host base URL for browser / Native shells.
 *
 * Priority:
 * 1. window.__CODESURF_HOST__ (injected)
 * 2. import.meta.env.VITE_CODESURF_HOST (build/dev)
 * 3. same-origin (vite proxy or production reverse proxy)
 * 4. default localhost:4177
 */

export interface HostResolutionOptions {
  injectedHost?: unknown
  envHost?: unknown
  locationOrigin?: string | null
  locationPort?: string | null
}

export interface HostTokenResolutionOptions {
  injectedToken?: unknown
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function runtimeHostOptions(): HostResolutionOptions {
  const w = typeof window === 'undefined'
    ? undefined
    : window as Window & { __CODESURF_HOST__?: string }
  let envHost: unknown
  try {
    envHost = (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_CODESURF_HOST
  } catch {
    // `import.meta.env` is unavailable in a few non-Vite test shells.
  }
  return {
    injectedHost: w?.__CODESURF_HOST__,
    envHost,
    locationOrigin: w?.location?.origin,
    locationPort: w?.location?.port,
  }
}

/**
 * Resolve the daemon/web-host base. Optional arguments make precedence
 * testable without changing globals in a renderer test.
 */
export function resolveHostBase(options: HostResolutionOptions = runtimeHostOptions()): string {
  const injected = nonEmptyString(options.injectedHost)
  if (injected) return injected.replace(/\/$/, '')

  const envHost = nonEmptyString(options.envHost)
  if (envHost) return envHost.replace(/\/$/, '')

  if (options.locationOrigin && /^https?:\/\//i.test(options.locationOrigin)) {
    // Browser deployments use one HTTPS origin for the UI and narrow reverse
    // proxy routes. Vite's :5173 proxy is the local version of that contract.
    return ''
  }

  return 'http://127.0.0.1:4177'
}

/**
 * Host authorization is deliberately separate from terminal gateway auth.
 * The token is runtime-injected by a local dev shell or Native sidecar. It is
 * never read from a build-time Vite variable or encoded in a URL.
 */
export function resolveHostToken(options?: HostTokenResolutionOptions): string | null {
  if (options) return nonEmptyString(options.injectedToken)
  if (typeof window === 'undefined') return null
  return nonEmptyString((window as Window & { __CODESURF_HOST_TOKEN__?: string }).__CODESURF_HOST_TOKEN__)
}

/**
 * Build request headers for local-host APIs. The host capability token is not
 * related to terminal gateway bearer authorization, so terminal transport must
 * not reuse this helper for its session/attach protocol.
 */
export function createHostHeaders(headers?: HeadersInit): Headers {
  const merged = new Headers(headers)
  const token = resolveHostToken()
  if (token) merged.set('X-Codesurf-Host', token)
  return merged
}

export function hostUrl(path: string): string {
  const base = resolveHostBase()
  const p = path.startsWith('/') ? path : `/${path}`
  return `${base}${p}`
}
