/**
 * Hydrate per-launch Native shell configuration before any host API call.
 *
 * The Native executable reads its own runtime config path and exposes only the
 * already-scoped values through a same-window bridge command. The renderer
 * never receives a filesystem path and never logs credential values.
 */

export interface NativeRuntimeConfig {
  hostBase?: string
  hostToken?: string
  terminal?: {
    endpoint?: string
    token?: string
  }
}

type NativeBridge = {
  invoke?: (name: string, args?: unknown) => Promise<unknown>
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseConfig(value: unknown): NativeRuntimeConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const terminal = raw.terminal && typeof raw.terminal === 'object' && !Array.isArray(raw.terminal)
    ? raw.terminal as Record<string, unknown>
    : null
  const config: NativeRuntimeConfig = {}
  const hostBase = nonEmptyString(raw.hostBase)
  const hostToken = nonEmptyString(raw.hostToken)
  const endpoint = nonEmptyString(terminal?.endpoint)
  const token = nonEmptyString(terminal?.token)
  if (hostBase) config.hostBase = hostBase
  if (hostToken) config.hostToken = hostToken
  if (endpoint || token) config.terminal = { ...(endpoint ? { endpoint } : {}), ...(token ? { token } : {}) }
  return config
}

/**
 * Calls the app-defined `codesurf.runtime.getConfig` bridge command. Missing
 * support is non-fatal for browser/dev fallback paths, but intentional: the
 * shell will surface terminal/host availability during normal startup.
 */
export async function hydrateNativeRuntimeConfig(): Promise<NativeRuntimeConfig | null> {
  if (typeof window === 'undefined') return null
  const w = window as Window & {
    zero?: NativeBridge
    __CODESURF_HOST__?: string
    __CODESURF_HOST_TOKEN__?: string
    __CODESURF_TERMINAL_ENDPOINT__?: string
    __CODESURF_TERMINAL_TOKEN__?: string
  }
  if (typeof w.zero?.invoke !== 'function') return null

  try {
    const config = parseConfig(await w.zero.invoke('codesurf.runtime.getConfig', {}))
    if (!config) return null
    if (config.hostBase) w.__CODESURF_HOST__ = config.hostBase
    if (config.hostToken) w.__CODESURF_HOST_TOKEN__ = config.hostToken
    if (config.terminal?.endpoint) w.__CODESURF_TERMINAL_ENDPOINT__ = config.terminal.endpoint
    if (config.terminal?.token) w.__CODESURF_TERMINAL_TOKEN__ = config.terminal.token
    return config
  } catch {
    // Do not include bridge errors: a native implementation may embed a URL or
    // credential in an error message, and the fallback must remain safe.
    console.warn('[codesurf-platform] Native runtime configuration was unavailable')
    return null
  }
}
