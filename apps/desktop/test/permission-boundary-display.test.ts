import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { DisplayMediaRequest } from '../src/main/security/permissionBoundaryCore.ts'
import {
  EXTENSION_MEDIA_DIALOG_TEXT_BYTES,
  getSafeDisplaySourceDialogChoices,
} from '../src/shared/extension-sensitive-media.ts'
import {
  createHarness,
  FakeFrame,
  mainFrameDetails,
  requestDisplay,
  requestPermission,
} from './helpers/permission-boundary-harness.ts'

describe('permission boundary display capture', () => {
  test('supports a direct declared codesurf-ext child only after consent preflight', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    harness.setExtension('sharing-extension', {
      name: 'Sharing Extension',
      declaredMedia: ['display-capture'],
    })
    const extensionUrl = 'codesurf-ext://sharing-extension'
    const securityOrigin = `${extensionUrl}/`
    const child = new FakeFrame(`${extensionUrl}/index.html`, extensionUrl, 44)
    child.parent = trusted.contents.mainFrame
    child.top = trusted.contents.mainFrame
    harness.attachFrame(trusted.contents, child)
    const displayRequest: DisplayMediaRequest = {
      frame: child,
      securityOrigin,
      videoRequested: true,
      audioRequested: false,
      userGesture: true,
    }

    assert.deepEqual(await requestDisplay(trusted.session, displayRequest), {})
    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'media', {
        isMainFrame: false,
        mediaTypes: [],
        requestingUrl: child.url,
        securityOrigin,
      }),
      true,
    )
    assert.deepEqual(
      harness.extensionConsentPrompts,
      ['sharing-extension:display-capture'],
    )
    assert.deepEqual(
      await requestDisplay(trusted.session, { ...displayRequest, userGesture: false }),
      {},
      'preflight alone must not return a stream',
    )
    assert.equal(harness.selectionCount(), 0)
    assert.deepEqual(
      await requestDisplay(trusted.session, displayRequest),
      { video: harness.sources[1] },
    )
    const selection = harness.displaySelections.at(-1)
    assert.equal(selection?.requester.kind, 'extension')
    if (selection?.requester.kind === 'extension') {
      assert.equal(selection.requester.extension.id, 'sharing-extension')
      assert.equal(
        selection.requester.extension.identity,
        harness.extensions.get('sharing-extension')?.identity,
      )
    }
  })

  test('attributes host and extension display selectors to the requesting principal', async () => {
    const host = createHarness()
    const hostWindow = host.makeWindow()
    host.boundary.registerAppWindow(hostWindow.window)
    assert.equal(
      await requestPermission(hostWindow.session, hostWindow.contents, 'media', {
        ...mainFrameDetails(host.appUrl),
        mediaTypes: [],
      }),
      true,
    )
    assert.deepEqual(
      await requestDisplay(hostWindow.session, {
        frame: hostWindow.contents.mainFrame,
        securityOrigin: new URL(host.appUrl).origin,
        videoRequested: true,
        audioRequested: false,
        userGesture: true,
      }),
      { video: host.sources[1] },
    )
    assert.deepEqual(host.displaySelections.at(-1)?.requester, { kind: 'host' })

    const extension = createHarness()
    const extensionWindow = extension.makeWindow()
    extension.boundary.registerAppWindow(extensionWindow.window)
    extension.setExtension('presenter', {
      name: 'Presenter',
      declaredMedia: ['display-capture'],
      declaredMediaReasons: {
        'display-capture': 'Present a selected project window',
      },
    })
    const extensionUrl = 'codesurf-ext://presenter'
    const child = new FakeFrame(`${extensionUrl}/index.html`, extensionUrl, 48)
    child.parent = extensionWindow.contents.mainFrame
    child.top = extensionWindow.contents.mainFrame
    extension.attachFrame(extensionWindow.contents, child)
    assert.equal(
      await requestPermission(
        extensionWindow.session,
        extensionWindow.contents,
        'display-capture',
        {
          isMainFrame: false,
          requestingUrl: child.url,
          securityOrigin: `${extensionUrl}/`,
        },
      ),
      true,
    )
    assert.deepEqual(
      await requestDisplay(extensionWindow.session, {
        frame: child,
        securityOrigin: `${extensionUrl}/`,
        videoRequested: true,
        audioRequested: false,
        userGesture: true,
      }),
      { video: extension.sources[1] },
    )
    const extensionRequester = extension.displaySelections.at(-1)?.requester
    assert.equal(extensionRequester?.kind, 'extension')
    if (extensionRequester?.kind === 'extension') {
      assert.equal(extensionRequester.extension.name, 'Presenter')
      assert.equal(
        extensionRequester.extension.declaredMediaReasons['display-capture'],
        'Present a selected project window',
      )
    }
  })

  test('makes hostile duplicate source labels unique while preserving selection indexes', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    const hostileNames = [
      'Cancel',
      'Cancel',
      '',
      '\u0000\u0007\t',
      '\u202eCancel\u2066',
      'Duplicate',
      'Duplicate',
      `Very long ${'雪'.repeat(200)}`,
    ]
    const hostileSources = Array.from({ length: 24 }, (_, index) => ({
      id: `${index % 2 === 0 ? 'screen' : 'window'}:${index}:0`,
      name: hostileNames[index % hostileNames.length] ?? '',
    }))
    harness.setDisplaySources(hostileSources)
    harness.setDisplaySelectionIndex(17)

    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'display-capture', {
        ...mainFrameDetails(harness.appUrl),
      }),
      true,
    )
    assert.deepEqual(
      await requestDisplay(trusted.session, {
        frame: trusted.contents.mainFrame,
        securityOrigin: new URL(harness.appUrl).origin,
        videoRequested: true,
        audioRequested: false,
        userGesture: true,
      }),
      { video: hostileSources[17] },
    )

    const selection = harness.displaySelections.at(-1)
    assert.deepEqual(selection?.requester, { kind: 'host' })
    assert.equal(selection?.sources.length, hostileSources.length)
    const choices = getSafeDisplaySourceDialogChoices(selection?.sources ?? [], 20)
    const buttons = [...choices.map(choice => choice.label), 'Cancel']

    assert.equal(choices.length, 20)
    assert.equal(new Set(buttons).size, buttons.length)
    assert.equal(buttons.filter(button => button === 'Cancel').length, 1)
    assert.strictEqual(choices[17]?.source, hostileSources[17])
    for (const [index, choice] of choices.entries()) {
      const type = index % 2 === 0 ? 'Screen' : 'Window'
      assert.match(choice.label, new RegExp(`^\\[${type} ${index + 1}\\] `, 'u'))
      assert.equal(/[\p{Cc}\p{Bidi_Control}]/u.test(choice.label), false)
      assert.ok(
        Buffer.byteLength(choice.label, 'utf8')
          <= EXTENSION_MEDIA_DIALOG_TEXT_BYTES.sourceLabel,
      )
    }
  })

  test('fails closed when the extension principal changes while its chooser is open', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    harness.setExtension('sharing-extension', {
      declaredMedia: ['display-capture'],
    })
    harness.setExtensionConsent('sharing-extension', ['display-capture'])
    const extensionUrl = 'codesurf-ext://sharing-extension'
    const child = new FakeFrame(`${extensionUrl}/index.html`, extensionUrl, 49)
    child.parent = trusted.contents.mainFrame
    child.top = trusted.contents.mainFrame
    harness.attachFrame(trusted.contents, child)
    const details = {
      isMainFrame: false,
      requestingUrl: child.url,
      securityOrigin: `${extensionUrl}/`,
    }
    assert.equal(
      await requestPermission(
        trusted.session,
        trusted.contents,
        'display-capture',
        details,
      ),
      true,
    )

    let resolveSelection: ((source: typeof harness.sources[number]) => void) | undefined
    let markSelectionStarted: (() => void) | undefined
    const selectionStarted = new Promise<void>(resolve => {
      markSelectionStarted = resolve
    })
    harness.setDisplaySelector(async () => {
      markSelectionStarted?.()
      return await new Promise(resolve => {
        resolveSelection = resolve
      })
    })
    const pending = requestDisplay(trusted.session, {
      frame: child,
      securityOrigin: `${extensionUrl}/`,
      videoRequested: true,
      audioRequested: false,
      userGesture: true,
    })
    await selectionStarted
    harness.navigate(trusted.contents, child)
    resolveSelection?.(harness.sources[1])

    assert.deepEqual(await pending, {})
  })

  test('terminates only exact direct extension media frames across trusted windows', async () => {
    const harness = createHarness()
    const first = harness.makeWindow()
    const second = harness.makeWindow()
    const unregistered = harness.makeWindow()
    harness.boundary.registerAppWindow(first.window)
    harness.boundary.registerAppWindow(second.window)
    const extensionOrigin = 'codesurf-ext://sharing-extension'

    const matching = new FakeFrame(
      `${extensionOrigin}/one.html`,
      extensionOrigin,
      60,
    )
    matching.parent = first.contents.mainFrame
    matching.top = first.contents.mainFrame
    harness.attachFrame(first.contents, matching)

    const fallback = new FakeFrame(
      `${extensionOrigin}/two.html`,
      extensionOrigin,
      61,
    )
    fallback.parent = second.contents.mainFrame
    fallback.top = second.contents.mainFrame
    fallback.reloadResult = false
    harness.attachFrame(second.contents, fallback)

    const otherExtension = new FakeFrame(
      'codesurf-ext://other-extension/index.html',
      'codesurf-ext://other-extension',
      62,
    )
    otherExtension.parent = first.contents.mainFrame
    otherExtension.top = first.contents.mainFrame
    harness.attachFrame(first.contents, otherExtension)

    const spoofedOrigin = new FakeFrame(
      `${extensionOrigin}/spoofed.html`,
      'codesurf-ext://other-extension',
      63,
    )
    spoofedOrigin.parent = first.contents.mainFrame
    spoofedOrigin.top = first.contents.mainFrame
    harness.attachFrame(first.contents, spoofedOrigin)

    const spoofedUrl = new FakeFrame(
      'codesurf-ext://other-extension/spoofed.html',
      extensionOrigin,
      64,
    )
    spoofedUrl.parent = first.contents.mainFrame
    spoofedUrl.top = first.contents.mainFrame
    harness.attachFrame(first.contents, spoofedUrl)

    const nested = new FakeFrame(
      `${extensionOrigin}/nested.html`,
      extensionOrigin,
      65,
    )
    nested.parent = matching
    nested.top = first.contents.mainFrame
    harness.attachFrame(first.contents, nested)

    const outsideTrustedWindow = new FakeFrame(
      `${extensionOrigin}/unregistered.html`,
      extensionOrigin,
      66,
    )
    outsideTrustedWindow.parent = unregistered.contents.mainFrame
    outsideTrustedWindow.top = unregistered.contents.mainFrame
    harness.attachFrame(unregistered.contents, outsideTrustedWindow)

    await harness.boundary.terminateExtensionMediaFrames('sharing-extension')

    assert.equal(matching.reloadCount, 1)
    assert.equal(fallback.reloadCount, 1)
    assert.deepEqual(
      fallback.executedScripts,
      ['window.location.replace("about:blank")'],
    )
    for (const unrelated of [
      otherExtension,
      spoofedOrigin,
      spoofedUrl,
      nested,
      outsideTrustedWindow,
      first.contents.mainFrame,
      second.contents.mainFrame,
    ]) {
      assert.equal(unrelated.reloadCount, 0)
      assert.deepEqual(unrelated.executedScripts, [])
    }

    await harness.boundary.terminateExtensionMediaFrames('../sharing-extension')
    assert.equal(matching.reloadCount, 1, 'invalid extension ids must not match frames')
  })

  test('denies invalid extension display identity and revokes grants on navigation or disable', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    harness.setExtension('sharing-extension', {
      declaredMedia: ['display-capture'],
    })
    harness.setExtensionConsent('sharing-extension', ['display-capture'])
    const extensionUrl = 'codesurf-ext://sharing-extension'
    const securityOrigin = `${extensionUrl}/`
    const child = new FakeFrame(`${extensionUrl}/index.html`, extensionUrl, 45)
    child.parent = trusted.contents.mainFrame
    child.top = trusted.contents.mainFrame
    harness.attachFrame(trusted.contents, child)
    const request: DisplayMediaRequest = {
      frame: child,
      securityOrigin,
      videoRequested: true,
      audioRequested: false,
      userGesture: true,
    }
    const preflight = () => requestPermission(
      trusted.session,
      trusted.contents,
      'media',
      {
        isMainFrame: false,
        mediaTypes: [],
        requestingUrl: child.url,
        securityOrigin,
      },
    )

    assert.equal(await preflight(), true)
    assert.deepEqual(
      await requestDisplay(trusted.session, {
        ...request,
        securityOrigin: 'codesurf-ext://other-extension/',
      }),
      {},
    )
    const nested = new FakeFrame(child.url, extensionUrl, 46)
    nested.parent = child
    nested.top = trusted.contents.mainFrame
    harness.attachFrame(trusted.contents, nested)
    assert.deepEqual(await requestDisplay(trusted.session, { ...request, frame: nested }), {})
    const internal = new FakeFrame(
      'codesurf-ext://__runext_internal/index.html',
      'codesurf-ext://__runext_internal',
      47,
    )
    internal.parent = trusted.contents.mainFrame
    internal.top = trusted.contents.mainFrame
    harness.attachFrame(trusted.contents, internal)
    assert.deepEqual(await requestDisplay(trusted.session, { ...request, frame: internal }), {})

    harness.navigate(trusted.contents)
    assert.deepEqual(await requestDisplay(trusted.session, request), {})
    assert.equal(await preflight(), true)
    harness.setExtension('sharing-extension', {
      enabled: false,
      declaredMedia: ['display-capture'],
    })
    assert.deepEqual(await requestDisplay(trusted.session, request), {})
  })

  test('requires a trusted top frame, exact origin, and user gesture', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    const validRequest: DisplayMediaRequest = {
      frame: trusted.contents.mainFrame,
      securityOrigin: new URL(harness.appUrl).origin,
      videoRequested: true,
      audioRequested: false,
      userGesture: true,
    }
    assert.deepEqual(
      await requestDisplay(trusted.session, validRequest),
      {},
      'display capture must not bypass its permission preflight',
    )
    assert.equal(
      trusted.session.checkHandler?.(
        trusted.contents,
        'display-capture',
        new URL(harness.appUrl).origin,
        mainFrameDetails(harness.appUrl),
      ),
      false,
    )
    assert.equal(
      await requestPermission(
        trusted.session,
        trusted.contents,
        'display-capture',
        mainFrameDetails(harness.appUrl),
      ),
      true,
    )
    assert.equal(
      await requestPermission(
        trusted.session,
        trusted.contents,
        'media',
        {
          ...mainFrameDetails(harness.appUrl),
          mediaTypes: [],
        },
      ),
      true,
    )
    assert.equal(
      trusted.session.checkHandler?.(
        trusted.contents,
        'display-capture',
        new URL(harness.appUrl).origin,
        mainFrameDetails(harness.appUrl),
      ),
      true,
    )

    assert.deepEqual(
      await requestDisplay(trusted.session, { ...validRequest, frame: null }),
      {},
    )
    assert.deepEqual(
      await requestDisplay(trusted.session, { ...validRequest, userGesture: false }),
      {},
    )
    assert.deepEqual(
      await requestDisplay(trusted.session, {
        ...validRequest,
        securityOrigin: 'https://attacker.example',
      }),
      {},
    )
    assert.equal(harness.selectionCount(), 0)

    const child = new FakeFrame(
      harness.appUrl,
      new URL(harness.appUrl).origin,
      44,
    )
    child.parent = trusted.contents.mainFrame
    child.top = trusted.contents.mainFrame
    assert.deepEqual(
      await requestDisplay(trusted.session, { ...validRequest, frame: child }),
      {},
    )
  })

  test('requires explicit selection and never adds unrequested audio', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    const request: DisplayMediaRequest = {
      frame: trusted.contents.mainFrame,
      securityOrigin: new URL(harness.appUrl).origin,
      videoRequested: true,
      audioRequested: false,
      userGesture: true,
    }
    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'media', {
        ...mainFrameDetails(harness.appUrl),
        mediaTypes: [],
      }),
      true,
    )

    harness.setSelectedSource(undefined)
    assert.deepEqual(await requestDisplay(trusted.session, request), {})

    harness.setSelectedSource(harness.sources[1])
    assert.deepEqual(
      await requestDisplay(trusted.session, request),
      { video: harness.sources[1] },
    )

    const production = createHarness({ production: true })
    const productionWindow = production.makeWindow()
    production.boundary.registerAppWindow(productionWindow.window)
    assert.equal(
      await requestPermission(
        productionWindow.session,
        productionWindow.contents,
        'media',
        {
          ...mainFrameDetails(production.productionUrl),
          mediaTypes: [],
        },
      ),
      true,
    )
    assert.deepEqual(
      await requestDisplay(productionWindow.session, {
        ...request,
        frame: productionWindow.contents.mainFrame,
        securityOrigin: 'file:///',
      }),
      { video: production.sources[1] },
    )
  })

  test('grants loopback only when requested and supported', async () => {
    const windows = createHarness({ platform: 'win32' })
    const trusted = windows.makeWindow()
    windows.boundary.registerAppWindow(trusted.window)
    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'media', {
        ...mainFrameDetails(windows.appUrl),
        mediaTypes: [],
      }),
      true,
    )
    const request: DisplayMediaRequest = {
      frame: trusted.contents.mainFrame,
      securityOrigin: new URL(windows.appUrl).origin,
      videoRequested: true,
      audioRequested: true,
      userGesture: true,
    }
    assert.deepEqual(
      await requestDisplay(trusted.session, request),
      { video: windows.sources[1], audio: 'loopback' },
    )

    const mac = createHarness({ platform: 'darwin' })
    const macWindow = mac.makeWindow()
    mac.boundary.registerAppWindow(macWindow.window)
    assert.equal(
      await requestPermission(macWindow.session, macWindow.contents, 'media', {
        ...mainFrameDetails(mac.appUrl),
        mediaTypes: [],
      }),
      true,
    )
    assert.deepEqual(
      await requestDisplay(macWindow.session, {
        ...request,
        frame: macWindow.contents.mainFrame,
        securityOrigin: new URL(mac.appUrl).origin,
      }),
      {},
    )
  })
})
