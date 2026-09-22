export { detectPlatform, isElectronHost, isDaemonBackedHost, type CodesurfPlatform } from './detect'
export {
  defaultCapabilitiesFor,
  hasCapability,
  normalizeCapabilities,
  readInstalledCapabilities,
  PLATFORM_CAPABILITY_KEYS,
  type PlatformCapabilities,
  type PlatformCapabilityKey,
} from './capabilities'
export { resolveHostBase, resolveHostToken, createHostHeaders, hostUrl } from './hostConfig'
export { installHostBridge, type InstallResult } from './installHostBridge'
export { createDaemonBackedElectronApi } from './daemonBridge'
export { hydrateNativeRuntimeConfig, type NativeRuntimeConfig } from './nativeRuntimeConfig'
export {
  createTerminalTransport,
  isTerminalTransportAvailable,
  resolveTerminalEndpoint,
  resolveTerminalToken,
  terminalSessionsUrl,
  TerminalTransport,
  TerminalUnavailableError,
} from './terminalTransport'
export { pickProjectFolderPath, type PickFolderResult } from './pickFolder'
export { registerCodesurfPwa, applyPwaUpdate, isPwaDisplayMode } from './pwa'
