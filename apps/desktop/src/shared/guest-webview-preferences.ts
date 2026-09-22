export function formatGuestWebviewTagPreferences(options?: {
  backgroundColor?: string
  devTools?: boolean
}): string {
  const parts = [
    'sandbox=yes',
    'contextIsolation=yes',
    'nodeIntegration=no',
    'nodeIntegrationInSubFrames=no',
    'webSecurity=yes',
    'allowRunningInsecureContent=no',
  ]
  if (options?.devTools) parts.push('devTools=yes')
  if (options?.backgroundColor) parts.push(`backgroundColor=${options.backgroundColor}`)
  return parts.join(', ')
}