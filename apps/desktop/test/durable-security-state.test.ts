import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  normalizeDirectorySyncError,
  SecurityStateCommitError,
  writeSecurityJsonAtomic,
} from '../src/main/security/durableSecurityState.ts'
import { ExtensionMediaConsentStore } from '../src/main/security/extensionMediaConsent.ts'

test('security-state replacement preserves the prior file when rename fails', {
  concurrency: false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codesurf-durable-security-'))
  const filePath = join(directory, 'state.json')
  const canonicalFilePath = join(await fs.realpath(directory), 'state.json')
  await fs.writeFile(filePath, '{"stable":true}\n', { mode: 0o600 })
  const originalRename = fs.rename
  fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === canonicalFilePath) throw new Error('simulated atomic rename failure')
    return originalRename(...args)
  }) as typeof fs.rename
  try {
    await assert.rejects(
      writeSecurityJsonAtomic(filePath, { stable: false }),
      error => {
        assert.ok(error instanceof SecurityStateCommitError)
        assert.equal(error.commitStatus, 'unknown')
        assert.match(error.message, /simulated atomic rename failure/)
        return true
      },
    )
  } finally {
    fs.rename = originalRename
  }
  assert.equal(await fs.readFile(filePath, 'utf8'), '{"stable":true}\n')
  assert.deepEqual(
    (await fs.readdir(directory)).filter(name => name.endsWith('.tmp')),
    [],
  )
})

test('security-state replacement rejects user-controlled symlink ancestors and targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codesurf-durable-symlink-'))
  const realParent = join(directory, 'real-parent')
  const linkedParent = join(directory, 'linked-parent')
  await fs.mkdir(realParent)
  await fs.symlink(realParent, linkedParent)
  await assert.rejects(
    writeSecurityJsonAtomic(join(linkedParent, 'state.json'), { unsafe: true }),
    /symbolic link|not canonical/,
  )

  const external = join(directory, 'external.json')
  const target = join(realParent, 'target.json')
  await fs.writeFile(external, '{"stable":true}\n')
  await fs.symlink(external, target)
  await assert.rejects(
    writeSecurityJsonAtomic(target, { stable: false }),
    /target is not a regular file/,
  )
  assert.equal(await fs.readFile(external, 'utf8'), '{"stable":true}\n')
})

test('Windows directory-sync limitations are explicit fail-closed errors', () => {
  const unsupported = Object.assign(new Error('operation not permitted'), {
    code: 'EPERM',
  })
  assert.match(
    normalizeDirectorySyncError('win32', unsupported).message,
    /directory sync is unsupported on this Windows filesystem \(EPERM\)/,
  )
  assert.equal(normalizeDirectorySyncError('darwin', unsupported), unsupported)
})

test('security-state replacement syncs the parent directory after rename', {
  concurrency: false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codesurf-durable-parent-'))
  const filePath = join(directory, 'state.json')
  const canonicalDirectory = await fs.realpath(directory)
  const originalOpen = fs.open
  let parentSyncs = 0
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args)
    if (String(args[0]) === canonicalDirectory) {
      const originalSync = handle.sync.bind(handle)
      handle.sync = async () => {
        parentSyncs += 1
        return originalSync()
      }
    }
    return handle
  }) as typeof fs.open
  try {
    await writeSecurityJsonAtomic(filePath, { durable: true })
  } finally {
    fs.open = originalOpen
  }
  assert.equal(parentSyncs, 1)
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), {
    durable: true,
  })
})

test('failed consent persistence never grants the in-memory decision', {
  concurrency: false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codesurf-consent-failure-'))
  const filePath = join(directory, 'consent.json')
  const canonicalFilePath = join(await fs.realpath(directory), 'consent.json')
  const identity = `sha256:${'a'.repeat(64)}`
  const store = new ExtensionMediaConsentStore({ filePath })
  await store.ready
  const originalRename = fs.rename
  fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === canonicalFilePath) throw new Error('simulated consent failure')
    return originalRename(...args)
  }) as typeof fs.rename
  try {
    await assert.rejects(
      store.setDecision('media-extension', identity, 'camera', 'allow'),
      /simulated consent failure/,
    )
  } finally {
    fs.rename = originalRename
  }
  assert.equal(
    store.getDecision('media-extension', identity, 'camera'),
    undefined,
  )
  const restarted = new ExtensionMediaConsentStore({ filePath })
  await restarted.ready
  assert.equal(
    restarted.getDecision('media-extension', identity, 'camera'),
    undefined,
  )
})

test('consent loading rejects linked files without exposing their decisions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codesurf-consent-link-'))
  const external = join(directory, 'external.json')
  const filePath = join(directory, 'consent.json')
  const identity = `sha256:${'b'.repeat(64)}`
  await fs.writeFile(external, JSON.stringify({
    version: 2,
    decisions: [{
      extensionId: 'media-extension',
      extensionIdentity: identity,
      grants: { camera: 'allow' },
    }],
  }))
  await fs.symlink(external, filePath)

  const store = new ExtensionMediaConsentStore({ filePath })
  await assert.rejects(store.ready, /Invalid security-state file/)
  assert.equal(
    store.getDecision('media-extension', identity, 'camera'),
    undefined,
  )
})

test('a failed consent normalization never publishes loaded authority', {
  concurrency: false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codesurf-consent-load-'))
  const filePath = join(directory, 'consent.json')
  const canonicalFilePath = join(await fs.realpath(directory), 'consent.json')
  const identity = `sha256:${'c'.repeat(64)}`
  await fs.writeFile(filePath, JSON.stringify({
    version: 2,
    decisions: [{
      extensionId: 'media-extension',
      extensionIdentity: identity,
      grants: { camera: 'allow' },
    }],
  }))
  const originalRename = fs.rename
  fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === canonicalFilePath) {
      throw new Error('simulated consent normalization failure')
    }
    return originalRename(...args)
  }) as typeof fs.rename
  const store = new ExtensionMediaConsentStore({ filePath })
  try {
    await assert.rejects(store.ready, /simulated consent normalization failure/)
  } finally {
    fs.rename = originalRename
  }
  assert.equal(
    store.getDecision('media-extension', identity, 'camera'),
    undefined,
  )
})
