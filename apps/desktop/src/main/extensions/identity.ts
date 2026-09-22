import { isAbsolute, relative, resolve } from 'node:path'

export const MAX_EXTENSION_ID_LENGTH = 128

const EXTENSION_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/
const EXTENSION_ID_REQUIREMENTS =
  `must be 1-${MAX_EXTENSION_ID_LENGTH} lowercase ASCII characters, ` +
  'use only letters, digits, ".", "_", or "-", and have no empty or punctuation-ended segments'

export type ExtensionIdValidation =
  | { ok: true; id: string }
  | { ok: false; error: string }

/** Validate an extension id without normalizing attacker-controlled input. */
export function validateExtensionId(value: unknown): ExtensionIdValidation {
  if (typeof value !== 'string') {
    return { ok: false, error: EXTENSION_ID_REQUIREMENTS }
  }
  if (value.length === 0 || value.length > MAX_EXTENSION_ID_LENGTH) {
    return { ok: false, error: EXTENSION_ID_REQUIREMENTS }
  }
  if (!EXTENSION_ID_PATTERN.test(value)) {
    return { ok: false, error: EXTENSION_ID_REQUIREMENTS }
  }
  return { ok: true, id: value }
}

export function isValidExtensionId(value: unknown): value is string {
  return validateExtensionId(value).ok
}

export function assertValidExtensionId(value: unknown, context = 'extension'): string {
  const result = validateExtensionId(value)
  if (!result.ok) {
    throw new Error(`Invalid extension id in ${context}: ${result.error}`)
  }
  return result.id
}

/**
 * Resolve one extension's settings file with identity validation and a separate
 * containment assertion. The caller remains responsible for registry lookup.
 */
export function resolveExtensionSettingsPath(settingsRoot: string, extId: unknown): string {
  const validId = assertValidExtensionId(extId, 'settings request')
  const root = resolve(settingsRoot)
  const candidate = resolve(root, `${validId}.json`)
  const rel = relative(root, candidate)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Extension settings path escapes the settings directory')
  }
  return candidate
}
