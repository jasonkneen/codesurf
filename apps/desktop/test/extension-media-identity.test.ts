import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ExtensionManifest } from '../src/shared/types.ts'
import {
  MAX_EXTENSION_IDENTITY_DEPTH,
  MAX_EXTENSION_IDENTITY_ENTRIES,
  MAX_EXTENSION_IDENTITY_FILE_BYTES,
  MAX_EXTENSION_IDENTITY_FILES,
  MAX_EXTENSION_IDENTITY_MANIFEST_BYTES,
  MAX_EXTENSION_IDENTITY_TOTAL_BYTES,
  captureExtensionMediaRoot,
  computeExtensionMediaAttestation,
  computeExtensionMediaIdentity,
  extensionIdentityOpenFlags,
} from '../src/main/extensions/media-identity.ts'
import {
  extensionMediaResourceKey,
  readAttestedExtensionResource,
} from '../src/main/extensions/media-resource-attestation.ts'
import { openCanonicalResource } from '../src/main/extensions/resource-path.ts'

const manifest: ExtensionManifest = {
  id: 'media-test',
  name: 'Media Test',
  version: '1.0.0',
  tier: 'safe',
  capabilities: [{ name: 'microphone' }],
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), prefix))
  await fs.writeFile(join(root, 'extension.json'), JSON.stringify(manifest))
  return fs.realpath(root)
}

async function makeSparseFile(path: string, size: number): Promise<void> {
  const handle = await fs.open(path, 'w')
  try {
    await handle.truncate(size)
  } finally {
    await handle.close()
  }
}

async function createFiles(root: string, count: number): Promise<void> {
  for (let offset = 0; offset < count; offset += 128) {
    await Promise.all(
      Array.from(
        { length: Math.min(128, count - offset) },
        (_, index) => fs.writeFile(
          join(root, `entry-${String(offset + index).padStart(5, '0')}`),
          '',
        ),
      ),
    )
  }
}

async function computeWithForbiddenAccessProbe(
  root: string,
  forbiddenRoots: string[],
): Promise<{ identity: string; opened: string[]; enumerated: string[] }> {
  const originalOpen = fs.open
  const originalOpendir = fs.opendir
  const opened: string[] = []
  const enumerated: string[] = []
  const isForbidden = (path: unknown): boolean => {
    const value = String(path)
    return forbiddenRoots.some(forbidden => value === forbidden || value.startsWith(`${forbidden}/`))
  }
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    if (isForbidden(args[0])) opened.push(String(args[0]))
    return originalOpen(...args)
  }) as typeof fs.open
  fs.opendir = (async (...args: Parameters<typeof fs.opendir>) => {
    if (isForbidden(args[0])) enumerated.push(String(args[0]))
    return originalOpendir(...args)
  }) as typeof fs.opendir
  try {
    return {
      identity: await computeExtensionMediaIdentity(root, manifest),
      opened,
      enumerated,
    }
  } finally {
    fs.open = originalOpen
    fs.opendir = originalOpendir
  }
}

test('captures bounded per-resource digests with the overall install identity', async () => {
  const root = await makeRoot('codesurf-media-attestation-')
  try {
    const content = Buffer.from('trusted-resource')
    await fs.mkdir(join(root, 'assets'))
    await fs.writeFile(join(root, 'assets', 'entry.bin'), content)
    const attestation = await computeExtensionMediaAttestation(root, manifest)
    assert.equal(
      attestation.identity,
      await computeExtensionMediaIdentity(root, manifest),
    )
    assert.equal(
      attestation.resources.get('assets/entry.bin')?.digest,
      `sha256:${createHash('sha256').update(content).digest('hex')}`,
    )
    assert.equal(attestation.resources.get('assets/entry.bin')?.size, content.byteLength)
    assert.equal(attestation.resources.has('extension.json'), true)
    assert.equal(Object.isFrozen(attestation), true)
    assert.equal(Object.isFrozen(attestation.resources), true)
    assert.equal('set' in attestation.resources, false)
    assert.equal(
      Object.isFrozen(attestation.resources.get('assets/entry.bin')),
      true,
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('serves only attested retained-handle bytes and rejects later path or inode changes', async () => {
  const root = await makeRoot('codesurf-media-resource-read-')
  const target = join(root, 'entry.bin')
  const moved = join(root, 'entry-original.bin')
  try {
    await fs.writeFile(target, 'trusted')
    const binding = await captureExtensionMediaRoot(root)
    const attestation = await computeExtensionMediaAttestation(root, manifest, binding)
    const key = extensionMediaResourceKey(binding, target)
    assert.equal(key, 'entry.bin')
    const expected = attestation.resources.get(key!)
    assert.ok(expected)

    const valid = await openCanonicalResource(root, target)
    assert.equal(valid.ok, true)
    if (valid.ok) {
      const read = await readAttestedExtensionResource(valid, binding, key!, expected)
      assert.equal(read.ok, true)
      if (read.ok) assert.equal(read.bytes.toString('utf8'), 'trusted')
      await assert.rejects(valid.handle.stat())
    }

    const sameInode = await openCanonicalResource(root, target)
    assert.equal(sameInode.ok, true)
    if (sameInode.ok) {
      await fs.writeFile(target, 'changed')
      assert.deepEqual(
        await readAttestedExtensionResource(sameInode, binding, key!, expected),
        { ok: false, reason: 'changed' },
      )
    }

    await fs.writeFile(target, 'trusted')
    const refreshedBinding = await captureExtensionMediaRoot(root)
    const refreshed = await computeExtensionMediaAttestation(root, manifest, refreshedBinding)
    const refreshedExpected = refreshed.resources.get(key!)
    assert.ok(refreshedExpected)
    const replaced = await openCanonicalResource(root, target)
    assert.equal(replaced.ok, true)
    if (replaced.ok) {
      await fs.rename(target, moved)
      await fs.writeFile(target, 'replacement')
      assert.deepEqual(
        await readAttestedExtensionResource(
          replaced,
          refreshedBinding,
          key!,
          refreshedExpected,
        ),
        { ok: false, reason: 'changed' },
      )
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('external file, directory, and home symlinks are records, never content roots', { concurrency: false }, async () => {
  const root = await makeRoot('codesurf-media-links-')
  const external = await fs.mkdtemp(join(tmpdir(), 'codesurf-media-external-'))
  try {
    const externalFile = join(external, 'secret.txt')
    const externalDirectory = join(external, 'tree')
    await fs.writeFile(externalFile, 'secret-v1')
    await fs.mkdir(externalDirectory)
    await fs.writeFile(join(externalDirectory, 'nested.txt'), 'nested-v1')
    await fs.writeFile(join(root, 'internal.txt'), 'internal-v1')
    await fs.symlink(externalFile, join(root, 'external-file'))
    await fs.symlink(externalDirectory, join(root, 'external-directory'))
    await fs.symlink(homedir(), join(root, 'home'))

    const forbiddenRoots = [
      await fs.realpath(external),
      await fs.realpath(homedir()),
    ]
    const beforeProbe = await computeWithForbiddenAccessProbe(root, forbiddenRoots)
    assert.deepEqual(beforeProbe.opened, [])
    assert.deepEqual(beforeProbe.enumerated, [])
    await fs.writeFile(externalFile, 'secret-v2')
    await fs.writeFile(join(externalDirectory, 'nested.txt'), 'nested-v2')
    const afterProbe = await computeWithForbiddenAccessProbe(root, forbiddenRoots)
    assert.deepEqual(afterProbe.opened, [])
    assert.deepEqual(afterProbe.enumerated, [])
    assert.equal(
      afterProbe.identity,
      beforeProbe.identity,
      'content outside the canonical root must not influence identity',
    )

    await fs.writeFile(join(root, 'internal.txt'), 'internal-v2')
    const afterInternalMutation = await computeExtensionMediaIdentity(root, manifest)
    assert.notEqual(afterInternalMutation, beforeProbe.identity)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(external, { recursive: true, force: true })
  }
})

test('rejects aggregate and manifest byte, depth, and node budget overflow', async () => {
  const aggregateRoot = await makeRoot('codesurf-media-aggregate-')
  try {
    for (let index = 0; index < 4; index += 1) {
      await makeSparseFile(
        join(aggregateRoot, `large-${index}.bin`),
        MAX_EXTENSION_IDENTITY_FILE_BYTES,
      )
    }
    await assert.rejects(
      computeExtensionMediaIdentity(aggregateRoot, manifest),
      new RegExp(`aggregate media identity byte budget \\(${MAX_EXTENSION_IDENTITY_TOTAL_BYTES}\\)`),
    )

    const oversizedManifest = {
      ...manifest,
      name: 'x'.repeat(MAX_EXTENSION_IDENTITY_MANIFEST_BYTES + 1),
    }
    await assert.rejects(
      computeExtensionMediaIdentity(aggregateRoot, oversizedManifest),
      /manifest exceeds media identity byte budget/,
    )

    const deeplyNested: Record<string, unknown> = {}
    let cursor = deeplyNested
    for (let depth = 0; depth < 40; depth += 1) {
      const child: Record<string, unknown> = {}
      cursor.child = child
      cursor = child
    }
    await assert.rejects(
      computeExtensionMediaIdentity(
        aggregateRoot,
        { ...manifest, contributes: deeplyNested } as ExtensionManifest,
      ),
      /manifest exceeds media identity complexity budget/,
    )

    await assert.rejects(
      computeExtensionMediaIdentity(
        aggregateRoot,
        {
          ...manifest,
          contributes: { nodes: Array.from({ length: 9000 }, () => null) },
        } as unknown as ExtensionManifest,
      ),
      /manifest exceeds media identity complexity budget/,
    )
  } finally {
    await fs.rm(aggregateRoot, { recursive: true, force: true })
  }
})

test('no-O_NOFOLLOW platforms retain read-only handle flags for post-open validation', () => {
  assert.equal(extensionIdentityOpenFlags(null), constants.O_RDONLY)
  assert.equal(
    extensionIdentityOpenFlags(0x100),
    constants.O_RDONLY | 0x100,
  )
})

test('rejects a lexical extension-root symlink and a root replaced after preflight', async () => {
  const root = await makeRoot('codesurf-media-root-binding-')
  const rootLink = `${root}-link`
  const originalRoot = `${root}-original`
  try {
    await fs.symlink(root, rootLink)
    await assert.rejects(
      computeExtensionMediaIdentity(rootLink, manifest),
      /Extension root must be a regular directory/,
    )

    const binding = await captureExtensionMediaRoot(root)
    await fs.rename(root, originalRoot)
    await fs.mkdir(root)
    await fs.writeFile(join(root, 'extension.json'), JSON.stringify(manifest))
    await assert.rejects(
      computeExtensionMediaIdentity(root, manifest, binding),
      /Extension root changed before computing media identity/,
    )
  } finally {
    await fs.rm(rootLink, { force: true })
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(originalRoot, { recursive: true, force: true })
  }
})

test('rejects per-file, entry, file-count, and depth budget overflow', async () => {
  const hugeRoot = await makeRoot('codesurf-media-huge-')
  const wideRoot = await makeRoot('codesurf-media-wide-')
  const filesRoot = await makeRoot('codesurf-media-files-')
  const deepRoot = await makeRoot('codesurf-media-deep-')
  try {
    await makeSparseFile(
      join(hugeRoot, 'huge.bin'),
      MAX_EXTENSION_IDENTITY_FILE_BYTES + 1,
    )
    await assert.rejects(
      computeExtensionMediaIdentity(hugeRoot, manifest),
      /file exceeds media identity byte budget/,
    )

    await createFiles(wideRoot, MAX_EXTENSION_IDENTITY_ENTRIES + 1)
    await assert.rejects(
      computeExtensionMediaIdentity(wideRoot, manifest),
      /media identity entry budget/,
    )

    await createFiles(filesRoot, MAX_EXTENSION_IDENTITY_FILES + 1)
    await assert.rejects(
      computeExtensionMediaIdentity(filesRoot, manifest),
      /media identity file budget/,
    )

    let directory = deepRoot
    for (let depth = 0; depth <= MAX_EXTENSION_IDENTITY_DEPTH; depth += 1) {
      directory = join(directory, `d${depth}`)
      await fs.mkdir(directory)
    }
    await assert.rejects(
      computeExtensionMediaIdentity(deepRoot, manifest),
      /media identity depth budget/,
    )
  } finally {
    await Promise.all([
      fs.rm(hugeRoot, { recursive: true, force: true }),
      fs.rm(wideRoot, { recursive: true, force: true }),
      fs.rm(filesRoot, { recursive: true, force: true }),
      fs.rm(deepRoot, { recursive: true, force: true }),
    ])
  }
})

test('detects a path swap after opening without reading the replacement', { concurrency: false }, async () => {
  const root = await makeRoot('codesurf-media-swap-')
  const external = await fs.mkdtemp(join(tmpdir(), 'codesurf-media-swap-external-'))
  const target = join(root, 'target.txt')
  const originalOpen = fs.open
  let releaseOpen!: () => void
  let openedTarget!: () => void
  const targetOpened = new Promise<void>(resolve => { openedTarget = resolve })
  const release = new Promise<void>(resolve => { releaseOpen = resolve })
  try {
    await fs.writeFile(target, 'inside')
    await fs.writeFile(join(external, 'outside.txt'), 'outside-secret')
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === target) {
        openedTarget()
        await release
      }
      return handle
    }) as typeof fs.open

    const identity = computeExtensionMediaIdentity(root, manifest)
    await targetOpened
    await fs.rename(target, join(root, 'target-original.txt'))
    await fs.symlink(join(external, 'outside.txt'), target)
    releaseOpen()
    await assert.rejects(identity, /(?:path|file) (?:changed|escapes)/)
  } finally {
    fs.open = originalOpen
    releaseOpen?.()
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(external, { recursive: true, force: true })
  }
})

test('directory swap is rejected before any external child file is opened', { concurrency: false }, async () => {
  const root = await makeRoot('codesurf-media-directory-swap-')
  const external = await fs.mkdtemp(join(tmpdir(), 'codesurf-media-directory-external-'))
  const directory = join(root, 'child')
  const originalOpendir = fs.opendir
  const originalOpen = fs.open
  let releaseOpendir!: () => void
  let openingDirectory!: () => void
  let openedExternalFile = false
  const opendirStarted = new Promise<void>(resolve => { openingDirectory = resolve })
  const release = new Promise<void>(resolve => { releaseOpendir = resolve })
  try {
    await fs.mkdir(directory)
    await fs.writeFile(join(directory, 'inside.txt'), 'inside')
    await fs.writeFile(join(external, 'outside.txt'), 'outside-secret')
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).startsWith(`${external}/`)) openedExternalFile = true
      return originalOpen(...args)
    }) as typeof fs.open
    fs.opendir = (async (...args: Parameters<typeof fs.opendir>) => {
      if (String(args[0]) === directory) {
        openingDirectory()
        await release
      }
      return originalOpendir(...args)
    }) as typeof fs.opendir

    const identity = computeExtensionMediaIdentity(root, manifest)
    await opendirStarted
    await fs.rename(directory, join(root, 'child-original'))
    await fs.symlink(external, directory)
    releaseOpendir()
    await assert.rejects(identity, /path (?:changed|escapes)/)
    assert.equal(openedExternalFile, false)
  } finally {
    fs.opendir = originalOpendir
    fs.open = originalOpen
    releaseOpendir?.()
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(external, { recursive: true, force: true })
  }
})

test('detects same-inode mutation during a handle-based read', { concurrency: false }, async () => {
  const root = await makeRoot('codesurf-media-mutation-')
  const target = join(root, 'target.bin')
  const originalOpen = fs.open
  let releaseRead!: () => void
  let firstRead!: () => void
  const readStarted = new Promise<void>(resolve => { firstRead = resolve })
  const release = new Promise<void>(resolve => { releaseRead = resolve })
  try {
    await makeSparseFile(target, 4 * 1024 * 1024)
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === target) {
        const originalRead = handle.read.bind(handle)
        let intercepted = false
        handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
          const result = await originalRead(...readArgs)
          if (!intercepted) {
            intercepted = true
            firstRead()
            await release
          }
          return result
        }) as typeof handle.read
      }
      return handle
    }) as typeof fs.open

    const identity = computeExtensionMediaIdentity(root, manifest)
    await readStarted
    const mutator = await originalOpen(target, 'r+')
    try {
      await mutator.write(Buffer.from([1]), 0, 1, 0)
      await mutator.sync()
    } finally {
      await mutator.close()
    }
    releaseRead()
    await assert.rejects(identity, /file changed during media identity read/)
  } finally {
    fs.open = originalOpen
    releaseRead?.()
    await fs.rm(root, { recursive: true, force: true })
  }
})
