import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  ExtensionMediaConsentManager,
  ExtensionMediaConsentStore,
} from '../src/main/security/extensionMediaConsent.ts'
import {
  getDeclaredSensitiveMediaCapabilities,
  getExtensionIframeAllow,
} from '../src/shared/extension-sensitive-media.ts'
import {
  captureExtensionMediaRoot,
  computeExtensionMediaAttestation,
} from '../src/main/extensions/media-identity.ts'

describe('extension sensitive media consent', () => {
  const identityA = `sha256:${'a'.repeat(64)}`
  const identityB = `sha256:${'b'.repeat(64)}`

  test('persists exact extension and kind decisions atomically with mode 0600', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codesurf-media-consent-'))
    const filePath = join(directory, 'consent.json')
    const store = new ExtensionMediaConsentStore({ filePath })

    await store.setDecision('camera-tools', identityA, 'camera', 'allow')
    await store.setDecision('camera-tools', identityA, 'microphone', 'deny')

    const restarted = new ExtensionMediaConsentStore({ filePath })
    await restarted.ready
    assert.equal(restarted.getDecision('camera-tools', identityA, 'camera'), 'allow')
    assert.equal(restarted.getDecision('camera-tools', identityA, 'microphone'), 'deny')
    assert.equal(restarted.getDecision('camera-tools', identityB, 'camera'), undefined)
    assert.equal(restarted.getDecision('other-extension', identityA, 'camera'), undefined)
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600)
    assert.deepEqual(
      (await fs.readdir(directory)).filter(name => name.includes('.tmp')),
      [],
    )
  })

  test('migrates legacy id-only consent fail-closed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codesurf-media-legacy-'))
    const filePath = join(directory, 'consent.json')
    await fs.writeFile(filePath, JSON.stringify({
      version: 1,
      decisions: {
        '../attacker': { camera: 'allow' },
        valid: {
          camera: 'allow',
          geolocation: 'allow',
          microphone: 'maybe',
        },
      },
      grants: {
        grandfathered: ['camera', 'microphone'],
      },
    }))
    await fs.writeFile(
      join(directory, 'extension-security-state.json'),
      JSON.stringify({
        version: 1,
        disabledExtensionIds: [],
        enabledCatalogExtensionIds: [],
        grants: { grandfathered: ['camera'] },
      }),
    )

    const store = new ExtensionMediaConsentStore({ filePath })
    await store.ready
    assert.equal(store.getDecision('../attacker', identityA, 'camera'), undefined)
    assert.equal(store.getDecision('valid', identityA, 'camera'), undefined)
    assert.equal(store.getDecision('grandfathered', identityA, 'camera'), undefined)
    assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), {
      version: 2,
      decisions: [],
    })
  })

  test('rejects ambiguous duplicate identity records fail-closed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codesurf-media-duplicates-'))
    const filePath = join(directory, 'consent.json')
    await fs.writeFile(filePath, JSON.stringify({
      version: 2,
      decisions: [
        {
          extensionId: 'media-extension',
          extensionIdentity: identityA,
          grants: { camera: 'allow' },
        },
        {
          extensionId: 'media-extension',
          extensionIdentity: identityA,
          grants: { camera: 'deny' },
        },
      ],
    }))

    const store = new ExtensionMediaConsentStore({ filePath })
    await store.ready
    assert.equal(store.getDecision('media-extension', identityA, 'camera'), undefined)
    assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), {
      version: 2,
      decisions: [],
    })
  })

  test('deduplicates identical prompts, serializes distinct prompts, and persists denial on failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codesurf-media-prompts-'))
    const store = new ExtensionMediaConsentStore({
      filePath: join(directory, 'consent.json'),
    })
    const calls: string[] = []
    let activePrompts = 0
    let maximumActivePrompts = 0
    let releaseFirst: (() => void) | undefined
    const firstPrompt = new Promise<void>(resolve => { releaseFirst = resolve })
    const manager = new ExtensionMediaConsentManager(store, async request => {
      activePrompts += 1
      maximumActivePrompts = Math.max(maximumActivePrompts, activePrompts)
      calls.push(`${request.extensionId}:${request.kind}`)
      if (calls.length === 1) await firstPrompt
      activePrompts -= 1
      if (request.extensionId === 'broken-extension') throw new Error('dialog failed')
      return request.kind === 'camera'
    })
    await manager.ready

    const cameraA = manager.requestConsent({
      extensionId: 'media-extension',
      extensionIdentity: identityA,
      extensionName: 'Media Extension',
      kind: 'camera',
    })
    const cameraB = manager.requestConsent({
      extensionId: 'media-extension',
      extensionIdentity: identityA,
      extensionName: 'Media Extension',
      kind: 'camera',
    })
    const microphone = manager.requestConsent({
      extensionId: 'media-extension',
      extensionIdentity: identityA,
      extensionName: 'Media Extension',
      kind: 'microphone',
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, ['media-extension:camera'])
    releaseFirst?.()

    assert.deepEqual(await Promise.all([cameraA, cameraB, microphone]), [true, true, false])
    assert.equal(maximumActivePrompts, 1)
    assert.deepEqual(calls, [
      'media-extension:camera',
      'media-extension:microphone',
    ])
    assert.equal(
      await manager.requestConsent({
        extensionId: 'media-extension',
        extensionIdentity: identityA,
        extensionName: 'Media Extension',
        kind: 'camera',
      }),
      true,
    )
    assert.equal(calls.length, 2)

    assert.equal(
      await manager.requestConsent({
        extensionId: 'broken-extension',
        extensionIdentity: identityB,
        extensionName: 'Broken Extension',
        kind: 'camera',
      }),
      false,
    )
    assert.equal(store.getDecision('broken-extension', identityB, 'camera'), 'deny')
  })

  test('binds consent to install identity and revokes every identity for only one extension', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codesurf-media-revoke-'))
    const filePath = join(directory, 'consent.json')
    const store = new ExtensionMediaConsentStore({ filePath })
    await store.setDecision('one-extension', identityA, 'camera', 'allow')
    await store.setDecision('one-extension', identityA, 'microphone', 'deny')
    await store.setDecision('one-extension', identityB, 'camera', 'allow')
    await store.setDecision('two-extension', identityA, 'camera', 'allow')

    await store.revokeExtension('one-extension')
    const restarted = new ExtensionMediaConsentStore({ filePath })
    await restarted.ready
    assert.equal(restarted.getDecision('one-extension', identityA, 'camera'), undefined)
    assert.equal(restarted.getDecision('one-extension', identityB, 'camera'), undefined)
    assert.equal(restarted.getDecision('one-extension', identityA, 'microphone'), undefined)
    assert.equal(restarted.getDecision('two-extension', identityA, 'camera'), 'allow')
  })

  test('disable during an open prompt cannot resurrect consent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codesurf-media-prompt-revoke-'))
    const filePath = join(directory, 'consent.json')
    const store = new ExtensionMediaConsentStore({ filePath })
    let markPromptStarted: (() => void) | undefined
    let releasePrompt: (() => void) | undefined
    const promptStarted = new Promise<void>(resolve => { markPromptStarted = resolve })
    const promptBlocked = new Promise<void>(resolve => { releasePrompt = resolve })
    const manager = new ExtensionMediaConsentManager(store, async () => {
      markPromptStarted?.()
      await promptBlocked
      return true
    })
    const request = manager.requestConsent({
      extensionId: 'racy-extension',
      extensionIdentity: identityA,
      extensionName: 'Racy Extension',
      kind: 'camera',
    })
    await promptStarted

    const revoked = manager.revokeExtension('racy-extension')
    releasePrompt?.()
    assert.equal(await request, false)
    await revoked

    const restarted = new ExtensionMediaConsentStore({ filePath })
    await restarted.ready
    assert.equal(restarted.getDecision('racy-extension', identityA, 'camera'), undefined)
    assert.equal(manager.hasConsent('racy-extension', identityA, 'camera'), false)
  })

  test('consent becomes unavailable synchronously while durable revocation is pending', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codesurf-media-revoke-pending-'))
    const store = new ExtensionMediaConsentStore({
      filePath: join(directory, 'consent.json'),
    })
    await store.setDecision('racy-extension', identityA, 'camera', 'allow')
    const revokeFromStore = store.revokeExtension.bind(store)
    let releaseRevocation: (() => void) | undefined
    const revocationBlocked = new Promise<void>(resolve => {
      releaseRevocation = resolve
    })
    store.revokeExtension = async extensionId => {
      await revocationBlocked
      await revokeFromStore(extensionId)
    }
    const manager = new ExtensionMediaConsentManager(store, async () => true)

    const revocation = manager.revokeExtension('racy-extension')
    assert.equal(manager.hasConsent('racy-extension', identityA, 'camera'), false)
    assert.equal(
      await manager.requestConsent({
        extensionId: 'racy-extension',
        extensionIdentity: identityA,
        extensionName: 'Racy Extension',
        kind: 'camera',
      }),
      false,
    )
    releaseRevocation?.()
    await revocation
    assert.equal(manager.hasConsent('racy-extension', identityA, 'camera'), false)
  })

  test('a consent-store load failure rejects readiness and never prompts or grants', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codesurf-media-load-failure-'))
    const store = new ExtensionMediaConsentStore({ filePath: directory })
    let promptCalls = 0
    const manager = new ExtensionMediaConsentManager(store, async () => {
      promptCalls += 1
      return true
    })

    await assert.rejects(manager.ready)
    assert.equal(
      manager.hasConsent('media-extension', identityA, 'camera'),
      false,
    )
    await assert.rejects(
      manager.requestConsent({
        extensionId: 'media-extension',
        extensionIdentity: identityA,
        extensionName: 'Media Extension',
        kind: 'camera',
      }),
    )
    await assert.rejects(manager.revokeExtension('media-extension'))
    assert.equal(promptCalls, 0)
    assert.equal(
      manager.hasConsent('media-extension', identityA, 'camera'),
      false,
    )
  })

  test('derives iframe allow directives only from declared sensitive capabilities', () => {
    const declared = getDeclaredSensitiveMediaCapabilities([
      { name: 'network' },
      { name: 'camera' },
      { name: 'camera' },
      { name: 'microphone' },
    ])
    assert.deepEqual(declared, ['microphone', 'camera'])
    assert.equal(getExtensionIframeAllow(declared), 'autoplay; microphone; camera')
    assert.equal(getExtensionIframeAllow(undefined), 'autoplay')
  })

  test('LiveKit declares microphone and camera only, without display capture', async () => {
    const manifest = JSON.parse(await fs.readFile(
      join(process.cwd(), 'bundled-extensions/livekit-rooms/extension.json'),
      'utf8',
    )) as { capabilities?: Array<{ name?: string }> }
    assert.deepEqual(
      manifest.capabilities?.map(capability => capability.name),
      ['microphone', 'camera'],
    )
  })

  test('renderer surfaces do not retain blanket media iframe policies', async () => {
    const [extensionTile, pluginSurface, chatTile] = await Promise.all([
      fs.readFile(join(process.cwd(), 'src/renderer/src/components/ExtensionTile.tsx'), 'utf8'),
      fs.readFile(join(process.cwd(), 'src/renderer/src/components/PluginSurface.tsx'), 'utf8'),
      fs.readFile(join(process.cwd(), 'src/renderer/src/components/ChatTileWebview.tsx'), 'utf8'),
    ])
    assert.doesNotMatch(extensionTile, /allow="camera; microphone; display-capture/)
    assert.doesNotMatch(pluginSurface, /allow="camera; microphone; display-capture/)
    assert.doesNotMatch(chatTile, /allow="microphone"/)
    assert.match(
      extensionTile,
      /MCP-UI proxy frames deliberately receive no sensitive media policy/,
    )
  })

  test('LiveKit uses the pinned local client bundle and includes it in media attestation', async () => {
    const expectedDigest = 'a77a2f4c363e93099d7c135721c9ec81d6c5bacc691796dad799222e33cbfb31'
    for (const root of [
      join(process.cwd(), 'bundled-extensions/livekit-rooms'),
      join(process.cwd(), 'examples/extensions/livekit-rooms'),
    ]) {
      const mainHtml = await fs.readFile(join(root, 'tiles/index.html'), 'utf8')
      const roomHtml = await fs.readFile(join(root, 'tiles/room/index.html'), 'utf8')
      assert.match(mainHtml, /\.\.\/vendor\/livekit-client-2\.21\.0\/livekit-client\.umd\.js/)
      assert.match(roomHtml, /\.\.\/\.\.\/vendor\/livekit-client-2\.21\.0\/livekit-client\.umd\.js/)
      assert.doesNotMatch(`${mainHtml}\n${roomHtml}`, /jsdelivr|livekit-client@2/)

      const vendorKey = 'vendor/livekit-client-2.21.0/livekit-client.umd.js'
      const vendorBytes = await fs.readFile(join(root, vendorKey))
      assert.equal(createHash('sha256').update(vendorBytes).digest('hex'), expectedDigest)
      assert.match(
        await fs.readFile(
          join(root, 'vendor/livekit-client-2.21.0/PROVENANCE.md'),
          'utf8',
        ),
        new RegExp(expectedDigest),
      )
      assert.match(
        await fs.readFile(join(root, 'vendor/livekit-client-2.21.0/LICENSE'), 'utf8'),
        /Apache License/,
      )

      const manifest = JSON.parse(
        await fs.readFile(join(root, 'extension.json'), 'utf8'),
      )
      const rootBinding = await captureExtensionMediaRoot(root)
      const attestation = await computeExtensionMediaAttestation(
        root,
        manifest,
        rootBinding,
      )
      assert.equal(
        attestation.resources.get(vendorKey)?.digest,
        `sha256:${expectedDigest}`,
      )
    }
  })
})
