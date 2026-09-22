/**
 * Resolve the Vercel Native SDK checkout path for desktop builds.
 * Order: NATIVE_SDK_PATH env → common sibling locations → fail with guidance.
 */
import { existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const candidates = [
  process.env.NATIVE_SDK_PATH,
  resolve(root, '../native'),
  resolve(root, '../../Documents/GitHub/native'),
  resolve(root, '../../../Documents/GitHub/native'),
  join(homedir(), 'Documents/GitHub/native'),
  join(homedir(), 'clawd/github/native'),
  '/Users/jkneen/Documents/GitHub/native',
].filter(Boolean)

export function resolveNativeSdkPath() {
  for (const candidate of candidates) {
    const abs = resolve(candidate)
    if (existsSync(join(abs, 'build.zig')) || existsSync(join(abs, 'src'))) {
      return abs
    }
  }
  return null
}

export function requireNativeSdkPath() {
  const path = resolveNativeSdkPath()
  if (!path) {
    console.error('[codesurf] Native SDK not found.')
    console.error('  Set NATIVE_SDK_PATH to your zero-native / native checkout, e.g.:')
    console.error('  export NATIVE_SDK_PATH=$HOME/Documents/GitHub/native')
    process.exit(1)
  }
  return path
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('resolve-native-sdk.mjs')) {
  const path = resolveNativeSdkPath()
  if (!path) {
    console.error('not found')
    process.exit(1)
  }
  console.log(path)
}
