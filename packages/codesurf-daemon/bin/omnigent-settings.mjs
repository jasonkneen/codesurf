// Daemon-side Omnigent settings resolution. Mirrors codex-sdk-settings.mjs /
// harness-settings.mjs: a pure resolver the daemon entrypoint (codesurfd.mjs)
// calls to fold settings.json + env overrides into the chat request, so the
// runOmnigentJob closure reads ready-resolved values off `request.omnigent` and
// the desktop/CLI client never has to know about backend config.
//
// settings.json shape:
//   { "settings": { "omnigent": {
//       "enabled": true,
//       "baseUrl": "http://127.0.0.1:6767",
//       "apiKey": "",
//       "agentId": "",
//       "hostId": "",
//       "autoStart": true
//   } } }
//
// Omnigent is a FIRST-CLASS provider dispatched on request.provider (like
// opencode/hermes), not an opt-in execution backend (like codex-sdk/harness),
// so `enabled` defaults to true — it only exists so an operator can hard-disable
// the provider on a given daemon.

import { OMNIGENT_DEFAULT_BASE_URL } from './omnigent-provider.mjs'

function envFlag(value, fallback) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false
  return fallback
}

function envString(value) {
  const raw = String(value ?? '').trim()
  return raw || null
}

export function resolveOmnigentSettings({ settings, env = process.env } = {}) {
  const cfg = settings && typeof settings === 'object' && settings.omnigent && typeof settings.omnigent === 'object'
    ? settings.omnigent
    : {}

  const baseUrl = envString(env?.CODESURF_OMNIGENT_BASE_URL)
    ?? (typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim() ? cfg.baseUrl.trim() : OMNIGENT_DEFAULT_BASE_URL)

  const apiKey = envString(env?.CODESURF_OMNIGENT_API_KEY)
    ?? (typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '')

  const agentId = envString(env?.CODESURF_OMNIGENT_AGENT_ID)
    ?? (typeof cfg.agentId === 'string' ? cfg.agentId.trim() : '')

  // Optional runner host pin. Blank (default) means auto-pick the first online
  // host from /v1/hosts at session-create time (see resolveOmnigentHostId).
  const hostId = envString(env?.CODESURF_OMNIGENT_HOST_ID)
    ?? (typeof cfg.hostId === 'string' ? cfg.hostId.trim() : '')

  const autoStart = envFlag(env?.CODESURF_OMNIGENT_AUTO_START, cfg.autoStart !== false)

  const enabled = envFlag(
    env?.CODESURF_OMNIGENT_ENABLED ?? env?.CODESURF_OMNIGENT,
    cfg.enabled !== false,
  )

  return { enabled, baseUrl, apiKey, agentId, hostId, autoStart }
}
