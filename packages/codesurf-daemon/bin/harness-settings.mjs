// Whether a chat request should route through the worktree-backed harness
// backend. This is a DAEMON-side decision driven by the daemon's own settings
// (settings.json) or the CODESURF_HARNESS env override — the desktop/client
// sends the same chat request it always does and never needs to know.
//
// settings.json shape:
//   { "settings": { "harness": { "enabled": true, "providers": ["claude"] } } }
// - enabled:   master toggle (default off)
// - providers: optional allow-list (default: claude + codex)

export const HARNESS_DEFAULT_PROVIDERS = ['claude', 'codex']
const HARNESS_AVAILABLE_PROVIDERS = new Set(HARNESS_DEFAULT_PROVIDERS)

export function isHarnessEnabled({ settings, env, provider } = {}) {
  const p = String(provider ?? '').trim()
  if (!p || !HARNESS_AVAILABLE_PROVIDERS.has(p)) return false

  const envRaw = String(env ?? '').trim().toLowerCase()
  const envOn = envRaw === '1' || envRaw === 'true' || envRaw === 'on'

  const cfg = settings && typeof settings === 'object' ? settings.harness : null
  const enabled = envOn || cfg?.enabled === true
  if (!enabled) return false

  const providers = Array.isArray(cfg?.providers) && cfg.providers.length
    ? cfg.providers
    : HARNESS_DEFAULT_PROVIDERS
  return providers.includes(p)
}
