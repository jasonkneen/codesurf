/**
 * Encrypted secrets store for API keys (Anthropic, OpenAI, Deepgram,
 * AssemblyAI, ElevenLabs, Cartesia, etc).
 *
 * Backed by Electron's `safeStorage`, which delegates to the OS keychain
 * (macOS Keychain, Windows DPAPI, libsecret on Linux). Keys are stored
 * ciphertext on disk; only the same OS user that wrote them can decrypt.
 *
 * File layout:  ~/.codesurf/secrets.json
 *   {
 *     "version": 1,
 *     "keys": { "<name>": "<base64-ciphertext>" }
 *   }
 *
 * On platforms where safeStorage is unavailable (rare — early-boot Linux
 * without a keyring daemon), we fall back to plain base64 in the same file
 * with a `plainKeys` field. Keys round-trip identically; only the on-disk
 * representation differs. This keeps the API stable for callers.
 */
import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'node:crypto'
import { CODESURF_HOME } from './paths'

const SECRETS_PATH = join(CODESURF_HOME, 'secrets.json')
const SECRETS_VERSION = 1

interface SecretsFile {
  version: number
  keys: Record<string, string>      // base64-encoded ciphertext
  plainKeys?: Record<string, string> // fallback when safeStorage is unavailable
}

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true })
}

function readFile(): SecretsFile {
  if (!existsSync(SECRETS_PATH)) {
    return { version: SECRETS_VERSION, keys: {} }
  }
  try {
    const raw = readFileSync(SECRETS_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Partial<SecretsFile>
    return {
      version: typeof parsed.version === 'number' ? parsed.version : SECRETS_VERSION,
      keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {},
      plainKeys: parsed.plainKeys && typeof parsed.plainKeys === 'object' ? parsed.plainKeys : undefined,
    }
  } catch {
    return { version: SECRETS_VERSION, keys: {} }
  }
}

function writeFileAtomic(file: SecretsFile): void {
  ensureDir(dirname(SECRETS_PATH))
  const tempPath = `${SECRETS_PATH}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tempPath, SECRETS_PATH)
}

function isSafeStorageReady(): boolean {
  try {
    return app.isReady() && safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** Whether secrets are being stored encrypted (vs. the plaintext fallback). */
export function isSecretsEncryptionAvailable(): boolean {
  return isSafeStorageReady()
}

let warnedPlaintextFallback = false

export function setSecret(name: string, value: string): void {
  const file = readFile()
  if (value === '') {
    delete file.keys[name]
    if (file.plainKeys) delete file.plainKeys[name]
  } else if (isSafeStorageReady()) {
    const ciphertext = safeStorage.encryptString(value).toString('base64')
    file.keys[name] = ciphertext
    if (file.plainKeys) delete file.plainKeys[name]
  } else {
    if (!warnedPlaintextFallback) {
      warnedPlaintextFallback = true
      console.warn(
        '[secrets] OS keychain (safeStorage) unavailable — API keys are being stored ' +
          'UNENCRYPTED (base64) in secrets.json. They are protected only by 0o600 file ' +
          'permissions. Resolve the keychain/keyring to restore encryption.',
      )
    }
    if (!file.plainKeys) file.plainKeys = {}
    file.plainKeys[name] = Buffer.from(value, 'utf8').toString('base64')
    delete file.keys[name]
  }
  writeFileAtomic(file)
}

export function getSecret(name: string): string | null {
  const file = readFile()
  if (file.keys[name] && isSafeStorageReady()) {
    try {
      const buf = Buffer.from(file.keys[name], 'base64')
      return safeStorage.decryptString(buf)
    } catch (err) {
      // Decryption failed on a key we DO have — this is key loss, not absence
      // (e.g. keychain changed). Surface it instead of masking as "no key".
      console.error(`[secrets] failed to decrypt stored key "${name}":`, err)
      return null
    }
  }
  if (file.plainKeys?.[name]) {
    try {
      return Buffer.from(file.plainKeys[name], 'base64').toString('utf8')
    } catch {
      return null
    }
  }
  return null
}

export function listSecretNames(): string[] {
  const file = readFile()
  return Array.from(new Set([
    ...Object.keys(file.keys ?? {}),
    ...Object.keys(file.plainKeys ?? {}),
  ])).sort()
}

export function deleteSecret(name: string): void {
  setSecret(name, '')
}

export function hasSecret(name: string): boolean {
  return getSecret(name) !== null
}
