import { withDefaultSettings, DEFAULT_SETTINGS, type AppSettings } from '../../../shared/types.ts'

export const SETTINGS_CACHE_KEY = 'codesurf:settings-cache'
export const WORKSPACE_TAB_STATE_KEY = 'codesurf:workspace-tabs:v1'

export type PersistedWorkspaceTabState = {
  openWorkspaceIds: string[]
  currentWorkspaceId: string | null
}

/**
 * Strip provider secrets before the settings snapshot is written to
 * localStorage.
 *
 * The main process deliberately moves these keys into the OS keychain on
 * `settings:set` and only re-fills them in the object handed to the renderer.
 * Caching that object verbatim would put the plaintext key back on disk in the
 * unencrypted LevelDB store under the user-data dir — readable by any
 * user-level process, with no keychain ACL prompt — and would expose it to any
 * renderer XSS on the web/PWA target. The cache exists to paint the shell
 * before `settings:get` resolves, and no pre-paint path needs a key.
 */
export function redactSettingsForCache(settings: AppSettings): AppSettings {
  const generationProviders = Object.fromEntries(
    Object.entries(settings.generationProviders ?? {}).map(([id, provider]) => [
      id,
      { ...provider, apiKey: '' },
    ]),
  )
  return {
    ...settings,
    generationProviders,
    omnigent: { ...settings.omnigent, apiKey: '' },
  }
}

export function writeCachedSettings(settings: AppSettings): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(redactSettingsForCache(settings)))
  } catch {
    // localStorage can be unavailable (private mode, quota); the cache is an
    // optimisation, so losing it is not an error.
  }
}

export function readCachedSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const raw = window.localStorage.getItem(SETTINGS_CACHE_KEY)
    return raw ? withDefaultSettings(JSON.parse(raw)) : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function readPersistedWorkspaceTabState(): PersistedWorkspaceTabState {
  if (typeof window === 'undefined') {
    return { openWorkspaceIds: [], currentWorkspaceId: null }
  }

  try {
    const raw = window.localStorage.getItem(WORKSPACE_TAB_STATE_KEY)
    if (!raw) return { openWorkspaceIds: [], currentWorkspaceId: null }
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspaceTabState>
    const openWorkspaceIds = Array.isArray(parsed.openWorkspaceIds)
      ? parsed.openWorkspaceIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
    const currentWorkspaceId = typeof parsed.currentWorkspaceId === 'string' && parsed.currentWorkspaceId.trim().length > 0
      ? parsed.currentWorkspaceId
      : null
    return {
      openWorkspaceIds: Array.from(new Set(openWorkspaceIds)),
      currentWorkspaceId,
    }
  } catch {
    return { openWorkspaceIds: [], currentWorkspaceId: null }
  }
}

export function persistWorkspaceTabState(state: PersistedWorkspaceTabState): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(WORKSPACE_TAB_STATE_KEY, JSON.stringify({
      openWorkspaceIds: Array.from(new Set(state.openWorkspaceIds.filter(id => typeof id === 'string' && id.trim().length > 0))),
      currentWorkspaceId: typeof state.currentWorkspaceId === 'string' && state.currentWorkspaceId.trim().length > 0
        ? state.currentWorkspaceId
        : null,
    }))
  } catch {
    // ignore localStorage failures
  }
}