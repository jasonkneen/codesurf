export const POWER_EXTENSION_TRUST_DISCLOSURE = [
  'Non-bundled POWER plugins run in an isolated child process by default,',
  'but this is crash isolation, not a security sandbox.',
  'Plugin code retains ambient Node.js filesystem and process access.',
  'Capability grants limit CodeSurf APIs only.',
].join(' ')

export function getExtensionTrustDisclosure(
  tier: 'safe' | 'power',
): string | null {
  return tier === 'power' ? POWER_EXTENSION_TRUST_DISCLOSURE : null
}
