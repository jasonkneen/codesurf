export const SENSITIVE_MEDIA_CAPABILITIES = [
  'microphone',
  'camera',
  'display-capture',
] as const

export type SensitiveMediaCapability = typeof SENSITIVE_MEDIA_CAPABILITIES[number]

export interface DeclaredSensitiveMedia {
  readonly capabilities: SensitiveMediaCapability[]
  readonly reasons: Readonly<
    Partial<Record<SensitiveMediaCapability, string>>
  >
}

export const EXTENSION_MEDIA_DIALOG_TEXT_BYTES = Object.freeze({
  detail: 512,
  extensionId: 128,
  extensionName: 96,
  message: 192,
  reason: 256,
  sourceLabel: 96,
})

export interface SafeExtensionMediaAttribution {
  readonly id: string
  readonly name: string
  readonly reason?: string
}

export interface DisplaySourceDialogInput {
  readonly id?: unknown
  readonly name?: unknown
}

export interface SafeDisplaySourceDialogChoice<TSource extends DisplaySourceDialogInput> {
  readonly label: string
  readonly source: TSource
}

const textEncoder = new TextEncoder()
const UNSAFE_CONTROL = /\p{Cc}/gu
const UNSAFE_BIDI_FORMATTING = /\p{Bidi_Control}/gu

function truncateUtf8(value: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return ''
  if (textEncoder.encode(value).byteLength <= maxBytes) return value
  const ellipsis = '…'
  const ellipsisBytes = textEncoder.encode(ellipsis).byteLength
  const contentBudget = Math.max(0, maxBytes - ellipsisBytes)
  let result = ''
  let used = 0
  for (const character of value) {
    const bytes = textEncoder.encode(character).byteLength
    if (used + bytes > contentBudget) break
    result += character
    used += bytes
  }
  return maxBytes >= ellipsisBytes ? `${result.trimEnd()}${ellipsis}` : result
}

export function sanitizeExtensionMediaDialogText(
  value: unknown,
  fallback: string,
  maxBytes: number,
): string {
  const normalize = (candidate: unknown): string => {
    if (typeof candidate !== 'string') return ''
    return candidate
      .replace(UNSAFE_CONTROL, ' ')
      .replace(UNSAFE_BIDI_FORMATTING, '')
      .replace(/\s+/gu, ' ')
      .trim()
  }
  const normalized = normalize(value) || normalize(fallback)
  return truncateUtf8(normalized, maxBytes)
}

export function getSafeDisplaySourceDialogChoices<
  TSource extends DisplaySourceDialogInput,
>(
  sources: readonly TSource[],
  maxChoices: number,
): SafeDisplaySourceDialogChoice<TSource>[] {
  const choiceLimit = Number.isSafeInteger(maxChoices) && maxChoices > 0
    ? maxChoices
    : 0
  return sources.slice(0, choiceLimit).map((source, index) => {
    const sourceKind = typeof source.id === 'string'
      ? source.id.split(':', 1)[0]?.toLowerCase()
      : undefined
    const type = sourceKind === 'screen'
      ? 'Screen'
      : sourceKind === 'window'
        ? 'Window'
        : 'Source'
    const prefix = `[${type} ${index + 1}]`
    const name = sanitizeExtensionMediaDialogText(
      source.name,
      'Unnamed source',
      EXTENSION_MEDIA_DIALOG_TEXT_BYTES.sourceLabel,
    )
    return {
      label: sanitizeExtensionMediaDialogText(
        `${prefix} ${name}`,
        `${prefix} Unnamed source`,
        EXTENSION_MEDIA_DIALOG_TEXT_BYTES.sourceLabel,
      ),
      source,
    }
  })
}

export function getSafeExtensionMediaAttribution(
  extensionId: unknown,
  extensionName: unknown,
  reason?: unknown,
): SafeExtensionMediaAttribution {
  const id = sanitizeExtensionMediaDialogText(
    extensionId,
    'unknown-extension',
    EXTENSION_MEDIA_DIALOG_TEXT_BYTES.extensionId,
  )
  const name = sanitizeExtensionMediaDialogText(
    extensionName,
    id,
    EXTENSION_MEDIA_DIALOG_TEXT_BYTES.extensionName,
  )
  const safeReason = sanitizeExtensionMediaDialogText(
    reason,
    '',
    EXTENSION_MEDIA_DIALOG_TEXT_BYTES.reason,
  )
  return {
    id,
    name,
    ...(safeReason ? { reason: safeReason } : {}),
  }
}

export function isExtensionMediaIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

export function isSensitiveMediaCapability(value: unknown): value is SensitiveMediaCapability {
  return typeof value === 'string'
    && SENSITIVE_MEDIA_CAPABILITIES.includes(value as SensitiveMediaCapability)
}

export function getDeclaredSensitiveMediaCapabilities(
  capabilities: readonly {
    readonly name: string
    readonly reason?: string
  }[] | undefined,
): SensitiveMediaCapability[] {
  return getDeclaredSensitiveMediaDeclaration(capabilities).capabilities
}

export function getDeclaredSensitiveMediaDeclaration(
  capabilities: readonly {
    readonly name: string
    readonly reason?: string
  }[] | undefined,
): DeclaredSensitiveMedia {
  const declared = new Set<SensitiveMediaCapability>()
  const reasons: Partial<Record<SensitiveMediaCapability, string>> = {}
  for (const capability of capabilities ?? []) {
    if (!isSensitiveMediaCapability(capability.name) || declared.has(capability.name)) {
      continue
    }
    declared.add(capability.name)
    if (typeof capability.reason === 'string') {
      reasons[capability.name] = capability.reason
    }
  }
  return {
    capabilities: SENSITIVE_MEDIA_CAPABILITIES.filter(capability => {
      return declared.has(capability)
    }),
    reasons: Object.freeze(reasons),
  }
}

export function getExtensionIframeAllow(
  capabilities: readonly SensitiveMediaCapability[] | undefined,
): string {
  const declared = new Set(capabilities ?? [])
  return [
    'autoplay',
    ...SENSITIVE_MEDIA_CAPABILITIES.filter(capability => declared.has(capability)),
  ].join('; ')
}
