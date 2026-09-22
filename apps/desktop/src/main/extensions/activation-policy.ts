export type ExtensionTier = 'safe' | 'power'

export function isUntrustedPowerExtension(opts: {
  untrustedScope?: boolean
  tier: ExtensionTier
}): boolean {
  return opts.untrustedScope === true && opts.tier === 'power'
}

export function resolveExtensionDefaultEnabled(opts: {
  untrustedScope?: boolean
  defaultEnabledOption?: boolean
  tier: ExtensionTier
}): boolean {
  const untrustedPower = isUntrustedPowerExtension(opts)
  return opts.defaultEnabledOption !== false && !untrustedPower
}

export function resolveExtensionEnabled(opts: {
  untrustedScope?: boolean
  defaultEnabledOption?: boolean
  tier: ExtensionTier
  disabled: boolean
  enabledCatalogIds: Set<string>
  extensionId: string
  manifestEnabled?: boolean
}): boolean {
  if (opts.disabled) return false

  const defaultEnabled = resolveExtensionDefaultEnabled(opts)
  if (defaultEnabled) return opts.manifestEnabled !== false

  return opts.enabledCatalogIds.has(opts.extensionId)
}