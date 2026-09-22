import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { build, type Plugin } from 'esbuild'
import {
  ExtensionMediaReadBudget,
  MAX_EXTENSION_MEDIA_INFLIGHT_READS,
  MAX_SINGLE_EXTENSION_MEDIA_INFLIGHT_READS,
  readAttestedExtensionResource,
} from '../src/main/extensions/media-resource-attestation.ts'
import {
  captureExtensionMediaRoot,
  computeExtensionMediaAttestation,
} from '../src/main/extensions/media-identity.ts'
import { openCanonicalResource } from '../src/main/extensions/resource-path.ts'

type OpenedResource = Extract<
  Awaited<ReturnType<typeof openCanonicalResource>>,
  { ok: true }
>

async function loadProtocolModule(
  state: { handler?: (request: { url: string }) => Promise<Response> },
) {
  const bundleDir = await mkdtemp(join(tmpdir(), 'codesurf-budget-protocol-'))
  const outfile = join(bundleDir, 'protocol.cjs')
  Object.assign(globalThis, { __codesurfBudgetProtocolState: state })
  const electronStub: Plugin = {
    name: 'electron-stub',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({
        path: 'electron',
        namespace: 'electron-stub',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
        contents: `
          const state = globalThis.__codesurfBudgetProtocolState
          export const protocol = {
            registerSchemesAsPrivileged() {},
            handle(_scheme, handler) { state.handler = handler },
          }
        `,
        loader: 'js',
      }))
    },
  }
  await build({
    absWorkingDir: process.cwd(),
    entryPoints: ['src/main/extensions/protocol.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    plugins: [electronStub],
    logLevel: 'silent',
  })
  return import(`${pathToFileURL(outfile).href}?test=${Date.now()}-${Math.random()}`)
}

test('media read budget distinguishes per-extension and global pressure', () => {
  const budget = new ExtensionMediaReadBudget()
  const leases: Array<() => void> = []
  for (let index = 0; index < MAX_SINGLE_EXTENSION_MEDIA_INFLIGHT_READS; index += 1) {
    const lease = budget.acquire('extension-a', 1)
    assert.equal(lease.ok, true)
    if (lease.ok) leases.push(lease.release)
  }
  assert.deepEqual(
    budget.acquire('extension-a', 1),
    { ok: false, reason: 'extension-busy' },
  )
  for (
    let index = MAX_SINGLE_EXTENSION_MEDIA_INFLIGHT_READS;
    index < MAX_EXTENSION_MEDIA_INFLIGHT_READS;
    index += 1
  ) {
    const lease = budget.acquire('extension-b', 1)
    assert.equal(lease.ok, true)
    if (lease.ok) leases.push(lease.release)
  }
  assert.deepEqual(
    budget.acquire('extension-c', 1),
    { ok: false, reason: 'global-busy' },
  )
  leases.pop()?.()
  const recovered = budget.acquire('extension-c', 1)
  assert.equal(recovered.ok, true)
  if (recovered.ok) recovered.release()
  for (const release of leases) release()
  assert.deepEqual(budget.snapshot(), { reads: 0, bytes: 0, extensions: 0 })
})

test('attested reads release leases on success, hash mismatch, and post-read stat failure', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-budget-release-'))
  const root = join(temp, 'extension')
  const entry = join(root, 'entry.txt')
  await mkdir(root)
  const manifest = {
    id: 'budget-release',
    name: 'Budget Release',
    version: '1.0.0',
    tier: 'safe' as const,
    capabilities: [{ name: 'microphone' }],
    _path: root,
    _enabled: true,
  }
  await writeFile(join(root, 'extension.json'), JSON.stringify(manifest))
  await writeFile(entry, 'trusted')
  const rootBinding = await captureExtensionMediaRoot(root)
  const attestation = await computeExtensionMediaAttestation(root, manifest, rootBinding)
  const expected = attestation.resources.get('entry.txt')!

  const read = async (
    resourceExpectation = expected,
    mutateHandle?: (opened: OpenedResource) => void,
  ) => {
    const opened = await openCanonicalResource(root, entry)
    assert.equal(opened.ok, true)
    if (!opened.ok) throw new Error('resource did not open')
    mutateHandle?.(opened)
    const budget = new ExtensionMediaReadBudget()
    const result = await readAttestedExtensionResource(
      opened,
      rootBinding,
      'entry.txt',
      resourceExpectation,
      budget,
    )
    assert.deepEqual(budget.snapshot(), { reads: 0, bytes: 0, extensions: 0 })
    return result
  }

  assert.equal((await read()).ok, true)
  assert.deepEqual(
    await read({ ...expected, digest: `sha256:${'0'.repeat(64)}` }),
    { ok: false, reason: 'changed' },
  )
  const postStatFailure = await read(expected, (opened) => {
    const { handle } = opened
    const originalStat = handle.stat.bind(handle)
    let calls = 0
    handle.stat = async () => {
      calls += 1
      if (calls === 2) throw new Error('post-read stat failed')
      return originalStat()
    }
  })
  assert.deepEqual(postStatFailure, { ok: false, reason: 'changed' })
})

test('protocol caps concurrent media reads with 429/503 and recovers', { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-budget-handler-'))
  const extensions = new Map<string, {
    manifest: {
      id: string
      name: string
      version: string
      tier: 'safe'
      capabilities: Array<{ name: string }>
      _path: string
      _enabled: boolean
    }
    mediaIdentity: string
    mediaAttestation: Awaited<ReturnType<typeof computeExtensionMediaAttestation>>
    installRootBinding: Awaited<ReturnType<typeof captureExtensionMediaRoot>>
  }>()
  const blockedPaths = new Set<string>()
  for (const id of ['budget-a', 'budget-b', 'budget-c']) {
    const root = join(temp, id)
    await mkdir(root)
    const manifest = {
      id,
      name: id,
      version: '1.0.0',
      tier: 'safe' as const,
      capabilities: [{ name: 'microphone' }],
      _path: root,
      _enabled: true,
    }
    await writeFile(join(root, 'extension.json'), JSON.stringify(manifest))
    await writeFile(join(root, 'entry.txt'), 'x')
    const installRootBinding = await captureExtensionMediaRoot(root)
    const mediaAttestation = await computeExtensionMediaAttestation(
      root,
      manifest,
      installRootBinding,
    )
    extensions.set(id, {
      manifest,
      mediaIdentity: mediaAttestation.identity,
      mediaAttestation,
      installRootBinding,
    })
    if (id !== 'budget-c') blockedPaths.add(await realpath(join(root, 'entry.txt')))
  }

  const invalidations: string[] = []
  const registry = {
    get: (id: string) => extensions.get(id),
    getCapabilityGate: () => ({ enforced: false, granted: [] }),
    invalidateExtensionMediaAttestation: async (id: string) => {
      invalidations.push(id)
      return true
    },
    isExtensionMediaAttestationCurrent: (
      id: string,
      expected: Awaited<ReturnType<typeof computeExtensionMediaAttestation>>,
    ) => extensions.get(id)?.mediaAttestation === expected,
  }
  const state: { handler?: (request: { url: string }) => Promise<Response> } = {}
  const { registerExtensionProtocol } = await loadProtocolModule(state)
  registerExtensionProtocol(registry)
  const handle = state.handler!

  const originalOpen = fs.open
  let started = 0
  let markAllStarted: (() => void) | undefined
  const allStarted = new Promise<void>(resolve => { markAllStarted = resolve })
  let releaseReads: (() => void) | undefined
  const readsBlocked = new Promise<void>(resolve => { releaseReads = resolve })
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const fileHandle = await originalOpen(...args)
    if (blockedPaths.has(String(args[0]))) {
      const originalRead = fileHandle.read.bind(fileHandle)
      let firstRead = true
      fileHandle.read = (async (...readArgs: Parameters<typeof fileHandle.read>) => {
        if (firstRead) {
          firstRead = false
          started += 1
          if (started === MAX_EXTENSION_MEDIA_INFLIGHT_READS) markAllStarted?.()
          await readsBlocked
        }
        return originalRead(...readArgs)
      }) as typeof fileHandle.read
    }
    return fileHandle
  }) as typeof fs.open

  try {
    const active = [
      ...Array.from({ length: MAX_SINGLE_EXTENSION_MEDIA_INFLIGHT_READS }, () => {
        return handle({ url: 'codesurf-ext://budget-a/entry.txt' })
      }),
      ...Array.from({ length: MAX_SINGLE_EXTENSION_MEDIA_INFLIGHT_READS }, () => {
        return handle({ url: 'codesurf-ext://budget-b/entry.txt' })
      }),
    ]
    await allStarted
    assert.equal(
      (await handle({ url: 'codesurf-ext://budget-a/entry.txt' })).status,
      429,
    )
    assert.equal(
      (await handle({ url: 'codesurf-ext://budget-c/entry.txt' })).status,
      503,
    )
    assert.deepEqual(invalidations, [])

    releaseReads?.()
    assert.deepEqual(
      (await Promise.all(active)).map(response => response.status),
      Array(MAX_EXTENSION_MEDIA_INFLIGHT_READS).fill(200),
    )
    assert.equal(
      (await handle({ url: 'codesurf-ext://budget-c/entry.txt' })).status,
      200,
    )
    assert.deepEqual(invalidations, [])
  } finally {
    releaseReads?.()
    fs.open = originalOpen
  }
})
