import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createHarness,
  FakeFrame,
  FakeSession,
  mainFrameDetails,
  requestPermission,
} from './helpers/permission-boundary-harness.ts'

describe('permission boundary', () => {
  test('registered windows still deny remote origins and subframes', () => {
    const harness = createHarness()
    const { session, contents, window } = harness.makeWindow()
    harness.boundary.registerAppWindow(window)

    assert.equal(
      session.checkHandler?.(
        contents,
        'media',
        'https://attacker.example',
        {
          ...mainFrameDetails('https://attacker.example/'),
          mediaType: 'audio',
        },
      ),
      false,
    )
    assert.equal(
      session.checkHandler?.(
        contents,
        'media',
        new URL(harness.appUrl).origin,
        {
          ...mainFrameDetails(harness.appUrl),
          isMainFrame: false,
          mediaType: 'audio',
        },
      ),
      false,
    )
  })

  test('allows only declared and explicitly consented codesurf-ext child media principals', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    harness.setExtension('livekit-rooms', {
      name: 'LiveKit Rooms',
      declaredMedia: ['microphone', 'camera'],
      declaredMediaReasons: {
        microphone: 'Speak in the room',
        camera: 'Share video in the room',
      },
    })
    const extensionUrl = 'codesurf-ext://livekit-rooms'
    const origin = `${extensionUrl}/`
    const details = {
      isMainFrame: false,
      mediaTypes: ['audio' as const],
      requestingUrl: `${extensionUrl}/tiles/room/index.html`,
      securityOrigin: origin,
    }
    const child = new FakeFrame(details.requestingUrl, extensionUrl, 100)
    child.parent = trusted.contents.mainFrame
    child.top = trusted.contents.mainFrame
    harness.attachFrame(trusted.contents, child)

    assert.equal(
      trusted.session.checkHandler?.(
        trusted.contents,
        'media',
        origin,
        { ...details, mediaType: 'audio' },
      ),
      false,
      'a declaration is not consent or a runtime grant',
    )
    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'media', details),
      true,
    )
    assert.deepEqual(harness.extensionConsentPrompts, ['livekit-rooms:microphone'])
    assert.deepEqual(harness.extensionConsentReasons, ['Speak in the room'])
    assert.deepEqual(harness.mediaPrompts, ['microphone'])
    assert.equal(
      trusted.session.checkHandler?.(
        trusted.contents,
        'media',
        origin,
        { ...details, mediaType: 'audio' },
      ),
      true,
    )
    assert.equal(
      trusted.session.checkHandler?.(
        trusted.contents,
        'media',
        origin,
        { ...details, mediaType: 'video' },
      ),
      false,
      'a microphone grant must not grant camera',
    )
  })

  test('uses the reason declared for the exact requested capability kind', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    harness.setExtension('media-extension', {
      declaredMedia: ['microphone', 'camera'],
      declaredMediaReasons: {
        microphone: 'Speak with teammates',
        camera: 'Appear on video',
      },
    })
    const extensionUrl = 'codesurf-ext://media-extension'
    const child = new FakeFrame(`${extensionUrl}/index.html`, extensionUrl, 105)
    child.parent = trusted.contents.mainFrame
    child.top = trusted.contents.mainFrame
    harness.attachFrame(trusted.contents, child)

    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'media', {
        isMainFrame: false,
        mediaTypes: ['video'],
        requestingUrl: child.url,
        securityOrigin: `${extensionUrl}/`,
      }),
      true,
    )
    assert.deepEqual(harness.extensionConsentPrompts, ['media-extension:camera'])
    assert.deepEqual(harness.extensionConsentReasons, ['Appear on video'])
  })

  test('denies unknown, disabled, undeclared, cross-origin, internal, and generic child frames', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    harness.setExtension('disabled-extension', {
      enabled: false,
      declaredMedia: ['microphone'],
    })
    harness.setExtension('undeclared-extension')
    harness.setExtension('spoofed-extension', {
      declaredMedia: ['microphone'],
    })
    harness.setExtensionConsent('spoofed-extension', ['microphone'])
    const childDetails = (id: string, securityOrigin = `codesurf-ext://${id}/`) => ({
      isMainFrame: false,
      mediaTypes: ['audio' as const],
      requestingUrl: `codesurf-ext://${id}/index.html`,
      securityOrigin,
    })
    assert.equal(
      await requestPermission(
        trusted.session,
        trusted.contents,
        'media',
        childDetails('spoofed-extension'),
      ),
      false,
      'request metadata alone cannot invent a child-frame principal',
    )

    for (const [index, details] of [
      childDetails('unknown-extension'),
      childDetails('disabled-extension'),
      childDetails('undeclared-extension'),
      childDetails('disabled-extension', 'codesurf-ext://other-extension/'),
      childDetails('__runext_internal'),
      {
        isMainFrame: false,
        mediaTypes: ['audio' as const],
        requestingUrl: 'https://chat.example/index.html',
        securityOrigin: 'https://chat.example',
      },
    ].entries()) {
      const parsed = new URL(details.requestingUrl)
      const child = new FakeFrame(
        details.requestingUrl,
        `${parsed.protocol}//${parsed.host}`,
        110 + index,
      )
      child.parent = trusted.contents.mainFrame
      child.top = trusted.contents.mainFrame
      harness.attachFrame(trusted.contents, child)
      assert.equal(
        await requestPermission(trusted.session, trusted.contents, 'media', details),
        false,
        details.requestingUrl,
      )
    }
    assert.deepEqual(harness.extensionConsentPrompts, [])
    assert.deepEqual(harness.mediaPrompts, [])
  })

  test('rechecks extension state and clears principal grants on navigation and revocation', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    harness.setExtension('media-extension', { declaredMedia: ['microphone'] })
    harness.setExtensionConsent('media-extension', ['microphone'])
    const extensionUrl = 'codesurf-ext://media-extension'
    const origin = `${extensionUrl}/`
    const request = {
      isMainFrame: false,
      mediaTypes: ['audio' as const],
      requestingUrl: `${extensionUrl}/index.html`,
      securityOrigin: origin,
    }
    const child = new FakeFrame(request.requestingUrl, extensionUrl, 120)
    child.parent = trusted.contents.mainFrame
    child.top = trusted.contents.mainFrame
    harness.attachFrame(trusted.contents, child)
    const check = () => trusted.session.checkHandler?.(
      trusted.contents,
      'media',
      origin,
      { ...request, mediaType: 'audio' },
    )

    assert.equal(await requestPermission(trusted.session, trusted.contents, 'media', request), true)
    assert.equal(check(), true)
    harness.navigate(trusted.contents)
    assert.equal(check(), false)

    assert.equal(await requestPermission(trusted.session, trusted.contents, 'media', request), true)
    harness.boundary.clearExtensionGrants('media-extension')
    assert.equal(check(), false)

    assert.equal(await requestPermission(trusted.session, trusted.contents, 'media', request), true)
    harness.setExtension('media-extension', {
      enabled: false,
      declaredMedia: ['microphone'],
    })
    assert.equal(check(), false)
  })

  test('same-URL reload invalidates a pending extension consent prompt', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    harness.setExtension('media-extension', { declaredMedia: ['microphone'] })
    const extensionUrl = 'codesurf-ext://media-extension'
    const details = {
      isMainFrame: false,
      mediaTypes: ['audio' as const],
      requestingUrl: `${extensionUrl}/index.html`,
      securityOrigin: `${extensionUrl}/`,
    }
    const child = new FakeFrame(details.requestingUrl, extensionUrl, 121)
    child.parent = trusted.contents.mainFrame
    child.top = trusted.contents.mainFrame
    harness.attachFrame(trusted.contents, child)

    let releaseConsent: ((allowed: boolean) => void) | undefined
    let markPromptStarted: (() => void) | undefined
    const promptStarted = new Promise<void>(resolve => { markPromptStarted = resolve })
    harness.setExtensionConsentRequester(async () => {
      markPromptStarted?.()
      return await new Promise<boolean>(resolve => { releaseConsent = resolve })
    })

    const pending = requestPermission(trusted.session, trusted.contents, 'media', details)
    await promptStarted
    harness.navigate(trusted.contents, child)
    releaseConsent?.(true)

    assert.equal(await pending, false)
    assert.deepEqual(harness.mediaPrompts, [])
    assert.equal(
      trusted.session.checkHandler?.(
        trusted.contents,
        'media',
        details.securityOrigin,
        { ...details, mediaType: 'audio' },
      ),
      false,
      'the completed prompt must not recreate a runtime grant after reload',
    )
  })

  test('same-URL reload invalidates a pending OS media prompt', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    harness.setExtension('media-extension', { declaredMedia: ['microphone'] })
    harness.setExtensionConsent('media-extension', ['microphone'])
    const extensionUrl = 'codesurf-ext://media-extension'
    const details = {
      isMainFrame: false,
      mediaTypes: ['audio' as const],
      requestingUrl: `${extensionUrl}/index.html`,
      securityOrigin: `${extensionUrl}/`,
    }
    const child = new FakeFrame(details.requestingUrl, extensionUrl, 122)
    child.parent = trusted.contents.mainFrame
    child.top = trusted.contents.mainFrame
    harness.attachFrame(trusted.contents, child)

    let releasePrompt: ((allowed: boolean) => void) | undefined
    let markPromptStarted: (() => void) | undefined
    const promptStarted = new Promise<void>(resolve => { markPromptStarted = resolve })
    harness.setMediaRequester(async () => {
      markPromptStarted?.()
      return await new Promise<boolean>(resolve => { releasePrompt = resolve })
    })

    const pending = requestPermission(trusted.session, trusted.contents, 'media', details)
    await promptStarted
    harness.navigate(trusted.contents, child)
    releasePrompt?.(true)

    assert.equal(await pending, false)
    assert.deepEqual(harness.mediaPrompts, ['microphone'])
    assert.equal(
      trusted.session.checkHandler?.(
        trusted.contents,
        'media',
        details.securityOrigin,
        { ...details, mediaType: 'audio' },
      ),
      false,
      'the completed OS prompt must not recreate a runtime grant after reload',
    )
  })

  test('an extension replacement cannot inherit consent or a runtime grant', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    const oldIdentity = `sha256:${'a'.repeat(64)}`
    const replacementIdentity = `sha256:${'b'.repeat(64)}`
    harness.setExtension('media-extension', {
      identity: oldIdentity,
      declaredMedia: ['microphone'],
    })
    harness.setExtensionConsent('media-extension', ['microphone'])
    const extensionUrl = 'codesurf-ext://media-extension'
    const details = {
      isMainFrame: false,
      mediaTypes: ['audio' as const],
      requestingUrl: `${extensionUrl}/index.html`,
      securityOrigin: `${extensionUrl}/`,
    }
    const child = new FakeFrame(details.requestingUrl, extensionUrl, 123)
    child.parent = trusted.contents.mainFrame
    child.top = trusted.contents.mainFrame
    harness.attachFrame(trusted.contents, child)
    const check = () => trusted.session.checkHandler?.(
      trusted.contents,
      'media',
      details.securityOrigin,
      { ...details, mediaType: 'audio' },
    )

    assert.equal(await requestPermission(trusted.session, trusted.contents, 'media', details), true)
    assert.equal(check(), true)
    harness.setExtension('media-extension', {
      identity: replacementIdentity,
      declaredMedia: ['microphone'],
    })
    assert.equal(check(), false)

    assert.equal(await requestPermission(trusted.session, trusted.contents, 'media', details), true)
    assert.deepEqual(
      harness.extensionConsentPrompts,
      ['media-extension:microphone'],
      'the replacement identity must receive fresh explicit consent',
    )
    assert.equal(check(), true)
  })

  test('denies null, destroyed, unregistered, and every non-window content type', () => {
    const harness = createHarness()
    const unregistered = harness.makeWindow()
    harness.boundary.installSession(unregistered.session)
    const details = {
      ...mainFrameDetails(harness.appUrl),
      mediaType: 'audio' as const,
    }
    const origin = new URL(harness.appUrl).origin

    assert.equal(unregistered.session.checkHandler?.(null, 'media', origin, details), false)
    assert.equal(
      unregistered.session.checkHandler?.(unregistered.contents, 'media', origin, details),
      false,
    )

    for (const type of ['webview', 'browserView', 'backgroundPage', 'offscreen', 'remote']) {
      const guest = harness.makeWindow(harness.appUrl, type)
      harness.boundary.installSession(guest.session)
      harness.boundary.registerAppWindow(guest.window)
      assert.equal(guest.session.checkHandler?.(guest.contents, 'media', origin, details), false, type)
    }

    const destroyed = harness.makeWindow()
    harness.boundary.registerAppWindow(destroyed.window)
    destroyed.contents.destroy()
    assert.equal(destroyed.session.checkHandler?.(destroyed.contents, 'media', origin, details), false)
  })

  test('allows only exact active renderer locations', () => {
    const development = createHarness()
    const devWindow = development.makeWindow()
    development.boundary.registerAppWindow(devWindow.window)
    assert.equal(
      devWindow.session.checkHandler?.(
        devWindow.contents,
        'clipboard-sanitized-write',
        new URL(development.appUrl).origin,
        {
          ...mainFrameDetails(`${development.appUrl}?workspace=one#tile`),
          mediaType: 'video',
        },
      ),
      true,
    )
    assert.equal(
      devWindow.session.checkHandler?.(
        devWindow.contents,
        'clipboard-sanitized-write',
        new URL(development.appUrl).origin,
        mainFrameDetails(`${development.appUrl}workspace/one`),
      ),
      false,
    )
    assert.equal(
      devWindow.session.checkHandler?.(
        devWindow.contents,
        'geolocation',
        new URL(development.appUrl).origin,
        {
          ...mainFrameDetails(development.appUrl),
          mediaType: 'video',
        },
      ),
      false,
    )

    const production = createHarness({ production: true })
    const prodWindow = production.makeWindow()
    production.boundary.registerAppWindow(prodWindow.window)
    assert.equal(
      prodWindow.session.checkHandler?.(
        prodWindow.contents,
        'clipboard-sanitized-write',
        'file://',
        {
          ...mainFrameDetails(`${production.productionUrl}?miniChat=1`),
          mediaType: 'audio',
        },
      ),
      true,
    )
    assert.equal(
      prodWindow.session.checkHandler?.(
        prodWindow.contents,
        'media',
        'file://',
        {
          ...mainFrameDetails('file:///Applications/CodeSurf.app/renderer/other.html'),
          mediaType: 'audio',
        },
      ),
      false,
    )
  })

  test('accepts Electron 41 file-origin serialization only with the exact app file', async () => {
    const harness = createHarness({ production: true })
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    const electronCheckDetails = {
      embeddingOrigin: harness.productionUrl,
      isMainFrame: true,
      mediaType: 'audio' as const,
      requestingUrl: '',
    }

    assert.equal(
      trusted.session.checkHandler?.(
        trusted.contents,
        'media',
        '',
        electronCheckDetails,
      ),
      false,
    )
    assert.equal(
      trusted.session.checkHandler?.(
        trusted.contents,
        'clipboard-sanitized-write',
        '',
        electronCheckDetails,
      ),
      true,
    )
    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'media', {
        isMainFrame: true,
        mediaTypes: ['audio'],
        requestingUrl: harness.productionUrl,
        securityOrigin: 'file:///',
      }),
      true,
    )
    assert.equal(
      trusted.session.checkHandler?.(
        trusted.contents,
        'media',
        '',
        electronCheckDetails,
      ),
      true,
    )
    assert.equal(
      trusted.session.checkHandler?.(
        trusted.contents,
        'clipboard-sanitized-write',
        '',
        {
          ...electronCheckDetails,
          embeddingOrigin: 'file:///tmp/attacker.html',
        },
      ),
      false,
    )
  })

  test('prompts only for requested media kinds and requires every OS grant', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    const details = mainFrameDetails(harness.appUrl)

    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'media', {
        ...details,
        mediaTypes: ['audio'],
      }),
      true,
    )
    assert.deepEqual(harness.mediaPrompts, ['microphone'])

    harness.mediaPrompts.length = 0
    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'media', {
        ...details,
        mediaTypes: ['video'],
      }),
      true,
    )
    assert.deepEqual(harness.mediaPrompts, ['camera'])

    harness.mediaPrompts.length = 0
    harness.setMediaResults({ microphone: true, camera: false })
    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'media', {
        ...details,
        mediaTypes: ['audio', 'video', 'audio'],
      }),
      false,
    )
    assert.deepEqual(harness.mediaPrompts, ['microphone', 'camera'])
  })

  test('media checks require scoped grants and grants disappear with their contents', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    const origin = new URL(harness.appUrl).origin
    const check = (mediaType: 'audio' | 'video') => trusted.session.checkHandler?.(
      trusted.contents,
      'media',
      origin,
      {
        ...mainFrameDetails(harness.appUrl),
        mediaType,
      },
    )

    assert.equal(check('audio'), false)
    assert.equal(check('video'), false)
    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'media', {
        ...mainFrameDetails(harness.appUrl),
        mediaTypes: ['audio'],
      }),
      true,
    )
    assert.equal(check('audio'), true)
    assert.equal(check('video'), false)

    trusted.contents.destroy()
    assert.equal(check('audio'), false)
  })

  test('allows sanitized clipboard writes only for trusted main frames', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    const origin = new URL(harness.appUrl).origin
    const details = mainFrameDetails(harness.appUrl)

    assert.equal(
      trusted.session.checkHandler?.(
        trusted.contents,
        'clipboard-sanitized-write',
        origin,
        details,
      ),
      true,
    )
    assert.equal(
      await requestPermission(
        trusted.session,
        trusted.contents,
        'clipboard-sanitized-write',
        details,
      ),
      true,
    )
    assert.equal(
      trusted.session.checkHandler?.(
        trusted.contents,
        'clipboard-read',
        origin,
        details,
      ),
      false,
    )
    assert.equal(
      trusted.session.checkHandler?.(
        trusted.contents,
        'clipboard-sanitized-write',
        origin,
        { ...details, isMainFrame: false },
      ),
      false,
    )

    const guest = harness.makeWindow('https://attacker.example/', 'webview')
    harness.boundary.installSession(guest.session)
    assert.equal(
      guest.session.checkHandler?.(
        guest.contents,
        'clipboard-sanitized-write',
        'https://attacker.example',
        {
          isMainFrame: true,
          requestingUrl: 'https://attacker.example/',
        },
      ),
      false,
    )
  })

  test('denies every unneeded app permission for trusted and guest contents', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    const origin = new URL(harness.appUrl).origin
    const details = mainFrameDetails(harness.appUrl)

    for (const permission of [
      'clipboard-read',
      'geolocation',
      'notifications',
      'fileSystem',
      'hid',
      'usb',
      'serial',
    ]) {
      assert.equal(
        trusted.session.checkHandler?.(trusted.contents, permission, origin, details),
        false,
        `${permission} check`,
      )
      assert.equal(
        await requestPermission(trusted.session, trusted.contents, permission, details),
        false,
        `${permission} request`,
      )
    }
  })

  test('denies malformed media requests, remote guests, and OS denial', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    const details = mainFrameDetails(harness.appUrl)

    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'media', {
        ...details,
      }),
      false,
    )
    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'media', {
        ...details,
        mediaTypes: ['screen' as 'audio'],
      }),
      false,
    )
    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'media', {
        ...details,
        isMainFrame: false,
        mediaTypes: ['audio'],
      }),
      false,
    )
    assert.deepEqual(harness.mediaPrompts, [])
    harness.setMediaResults({ microphone: false })
    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'media', {
        ...details,
        mediaTypes: ['audio'],
      }),
      false,
    )

    const guest = harness.makeWindow('https://attacker.example/', 'webview')
    harness.boundary.installSession(guest.session)
    assert.equal(
      await requestPermission(guest.session, guest.contents, 'media', {
        isMainFrame: true,
        requestingUrl: 'https://attacker.example/',
        securityOrigin: 'https://attacker.example',
        mediaTypes: ['audio'],
      }),
      false,
    )
    assert.equal(
      await requestPermission(guest.session, guest.contents, 'media', {
        isMainFrame: true,
        requestingUrl: 'https://attacker.example/',
        securityOrigin: 'https://attacker.example',
        mediaTypes: [],
      }),
      false,
    )
  })

  test('installs handlers idempotently on default and newly-created guest sessions', async () => {
    const harness = createHarness({ withDefaultSession: true })
    const dynamicGuestSession = new FakeSession()

    harness.boundary.installSession(dynamicGuestSession)
    harness.boundary.installSession(dynamicGuestSession)
    harness.sessionListeners[0]?.(dynamicGuestSession)
    assert.deepEqual(
      dynamicGuestSession.installCounts,
      { check: 1, request: 1, display: 1, device: 1 },
    )

    const guest = harness.makeWindow('https://attacker.example/', 'webview')
    harness.contentsListeners[0]?.(guest.contents)
    assert.deepEqual(
      guest.session.installCounts,
      { check: 1, request: 1, display: 1, device: 1 },
    )
    assert.equal(
      guest.session.checkHandler?.(
        guest.contents,
        'media',
        'https://attacker.example',
        {
          isMainFrame: true,
          requestingUrl: 'https://attacker.example/',
          securityOrigin: 'https://attacker.example',
          mediaType: 'audio',
        },
      ),
      false,
    )

    await harness.boundary.ready
    assert.deepEqual(
      harness.defaultSession?.installCounts,
      { check: 1, request: 1, display: 1, device: 1 },
    )
  })
})
