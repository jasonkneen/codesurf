export function isCodexSdkEnabled({ settings, env = process.env, provider } = {}) {
  if (String(provider ?? '').trim() !== 'codex') return false

  const providerOverride = String(env?.CODESURF_CODEX_PROVIDER ?? '').trim().toLowerCase()
  if (providerOverride === 'sdk') return true
  if (providerOverride === 'cli') return false

  const sdkOverride = String(env?.CODESURF_CODEX_SDK ?? '').trim().toLowerCase()
  if (sdkOverride === '1' || sdkOverride === 'true' || sdkOverride === 'on') return true
  if (sdkOverride === '0' || sdkOverride === 'false' || sdkOverride === 'off') return false

  const cfg = settings && typeof settings === 'object' ? settings.codex : null
  if (cfg && typeof cfg === 'object') {
    return cfg.executionProvider === 'sdk'
  }

  return false
}
