#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import process from 'node:process'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function hasAll(names) {
  return names.every(name => Boolean(process.env[name]))
}

function hasAny(names) {
  return names.some(name => Boolean(process.env[name]))
}

function assertComplete(label, names) {
  if (hasAny(names) && !hasAll(names)) {
    const missing = names.filter(name => !process.env[name])
    fail(`${label} is incomplete. Missing: ${missing.join(', ')}`)
  }
}

if (process.platform !== 'darwin') {
  fail('macOS release builds must run on macOS so the app can be signed and notarized.')
}

const notaryCredentialSets = [
  ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
  ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
  ['APPLE_KEYCHAIN_PROFILE'],
]

assertComplete('App Store Connect API key notarization credentials', notaryCredentialSets[0])
assertComplete('Apple ID notarization credentials', notaryCredentialSets[1])

if (!notaryCredentialSets.some(hasAll)) {
  fail(
    'Missing notarization credentials. Set APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER, ' +
    'APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID, or APPLE_KEYCHAIN_PROFILE.',
  )
}

if (process.env.CSC_LINK) {
  if (!process.env.CSC_KEY_PASSWORD) {
    fail('CSC_LINK is set but CSC_KEY_PASSWORD is missing.')
  }
} else {
  const result = spawnSync('security', ['find-identity', '-p', 'codesigning', '-v'], {
    encoding: 'utf8',
  })

  if (result.status !== 0 || !/Developer ID Application:/.test(result.stdout)) {
    fail('Missing Developer ID Application signing identity. Set CSC_LINK/CSC_KEY_PASSWORD or install the certificate in this keychain.')
  }
}

const notarytool = spawnSync('xcrun', ['--find', 'notarytool'], { encoding: 'utf8' })
if (notarytool.status !== 0) {
  fail('xcrun notarytool is unavailable. Install Xcode command line tools with notarytool support.')
}

process.stdout.write('macOS release signing and notarization prerequisites look present.\n')
