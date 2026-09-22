export function buildIsolatedWebPreviewEnv(
  baseEnv: NodeJS.ProcessEnv,
  values: {
    homeDir: string
    codesurfHome: string
    hostUrl: string
    hostPort: number
    hostToken: string
    previewPort: number
    runtimeConfigPort: number
    terminalPort: number
    terminalToken: string
  },
): NodeJS.ProcessEnv {
  const env = { ...baseEnv }
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase()
    if (
      normalized.startsWith('CODESURF_') ||
      normalized === 'HOME' ||
      normalized === 'USERPROFILE'
    ) {
      delete env[key]
    }
  }
  return {
    ...env,
    HOME: values.homeDir,
    USERPROFILE: values.homeDir,
    CODESURF_HOME: values.codesurfHome,
    CODESURF_WEB_HOST_URL: values.hostUrl,
    CODESURF_WEB_HOST_PORT: String(values.hostPort),
    CODESURF_WEB_HOST_TOKEN: values.hostToken,
    CODESURF_WEB_PREVIEW_PORT: String(values.previewPort),
    CODESURF_WEB_PREVIEW_RUNTIME_PORT: String(values.runtimeConfigPort),
    CODESURF_WEB_PREVIEW_TERMINAL_PORT: String(values.terminalPort),
    CODESURF_TERMINAL_TOKEN: values.terminalToken,
  }
}
