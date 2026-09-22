import { expect, test } from '@playwright/test'
import { launchBuiltWebPreview, type LaunchedWebPreview } from './helpers/launch-web-preview'

test.describe('CodeSurf built-web smoke', () => {
  let preview: LaunchedWebPreview

  test.beforeAll(async () => {
    preview = await launchBuiltWebPreview()
  })

  test.afterAll(async () => {
    await preview?.close()
  })

  test('installs the runtime bridge and persists daemon-backed workspace canvas state', async ({
    page,
  }) => {
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    page.on('pageerror', (error) => {
      pageErrors.push(error.stack ?? error.message)
    })
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    const onboarding = page.getByRole('dialog', { name: 'Welcome to CodeSurf' })
    const runtimeConfigResponse = page.waitForResponse(
      (response) =>
        response.url() === `${preview.url}codesurf-runtime-config.js` && response.status() === 200,
    )

    await page.goto(preview.url, { waitUntil: 'domcontentloaded' })
    const configResponse = await runtimeConfigResponse
    expect(configResponse.headers()['cache-control']).toContain('no-store')
    expect(configResponse.headers()['content-type']).toContain('application/javascript')

    await page.waitForFunction(() => {
      const runtime = window as typeof window & {
        __CODESURF_PLATFORM__?: string
        electron?: {
          workspace?: { create?: unknown }
          canvas?: { save?: unknown }
        }
      }
      return (
        runtime.__CODESURF_PLATFORM__ === 'web' &&
        typeof runtime.electron?.workspace?.create === 'function' &&
        typeof runtime.electron?.canvas?.save === 'function'
      )
    })
    await expect(page.locator('#root')).toBeVisible()
    await expect(page.locator('#root')).not.toContainText('Loading…', { timeout: 45_000 })
    await expect(page.locator('#root')).not.toContainText(
      'CodeSurf encountered an unexpected error. Check the console for details.',
    )
    await expect(page.locator('#root')).not.toContainText('Renderer failed to start')
    await expect(page.locator('[data-canvas-surface="true"]')).toBeVisible({ timeout: 45_000 })
    await expect(onboarding).toBeVisible()
    await onboarding.getByRole('button', { name: 'Get started' }).click()
    await expect(onboarding).toBeHidden()

    const firstPass = await page.evaluate(async () => {
      const runtime = window as typeof window & {
        __CODESURF_PLATFORM__?: string
        __CODESURF_HOST__?: string
        __CODESURF_HOST_TOKEN__?: string
        __CODESURF_CAPABILITIES__?: Record<string, boolean>
        electron: {
          workspace: {
            list: () => Promise<Array<{ id: string }>>
            create: (name: string) => Promise<{ id: string }>
            setActive: (id: string) => Promise<void>
          }
          canvas: {
            save: (workspaceId: string, state: unknown) => Promise<void>
            load: (workspaceId: string) => Promise<unknown>
          }
          system: {
            daemonStatus: () => Promise<{ running: boolean }>
          }
        }
      }
      const marker = `web-smoke-${crypto.randomUUID()}`
      const target = await runtime.electron.workspace.create(`${marker}-target`)
      // Keep the target out of the mounted App's autosave path until its
      // authoritative fixture state is written, then select it for reload.
      const guard = await runtime.electron.workspace.create(`${marker}-guard`)
      const canvasState = {
        tiles: [{ id: marker, type: 'note', x: 120, y: 80, width: 320, height: 200 }],
        viewport: { tx: 31, ty: 47, zoom: 1.25 },
        nextZIndex: 2,
      }
      await runtime.electron.canvas.save(target.id, canvasState)
      await runtime.electron.workspace.setActive(target.id)

      const listed = await runtime.electron.workspace.list()
      const loaded = (await runtime.electron.canvas.load(target.id)) as typeof canvasState | null
      const daemon = await runtime.electron.system.daemonStatus()
      return {
        platform: runtime.__CODESURF_PLATFORM__,
        host: runtime.__CODESURF_HOST__,
        hostTokenLength: runtime.__CODESURF_HOST_TOKEN__?.length ?? 0,
        workspaceCapability: runtime.__CODESURF_CAPABILITIES__?.workspace,
        canvasCapability: runtime.__CODESURF_CAPABILITIES__?.canvas,
        targetId: target.id,
        guardId: guard.id,
        marker,
        listedIds: listed.map((workspace) => workspace.id),
        loaded,
        daemonRunning: daemon.running,
      }
    })

    expect(firstPass.platform).toBe('web')
    expect(firstPass.host).toBe(preview.hostUrl)
    expect(firstPass.hostTokenLength).toBeGreaterThanOrEqual(32)
    expect(firstPass.workspaceCapability).toBe(true)
    expect(firstPass.canvasCapability).toBe(true)
    expect(firstPass.listedIds).toEqual(
      expect.arrayContaining([firstPass.targetId, firstPass.guardId]),
    )
    expect(firstPass.loaded).toEqual(
      expect.objectContaining({
        tiles: [expect.objectContaining({ id: firstPass.marker, type: 'note' })],
        viewport: { tx: 31, ty: 47, zoom: 1.25 },
      }),
    )
    expect(firstPass.daemonRunning).toBe(true)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () =>
        typeof (window as typeof window & { electron?: { workspace?: { list?: unknown } } })
          .electron?.workspace?.list === 'function',
    )
    await expect(page.locator('#root')).not.toContainText(
      'CodeSurf encountered an unexpected error. Check the console for details.',
    )
    await expect(page.locator('#root')).not.toContainText('Renderer failed to start')
    await expect(page.locator('[data-canvas-surface="true"]')).toBeVisible({ timeout: 45_000 })
    const restoredTile = page.locator(`[data-tile-id="${firstPass.marker}"]`)
    await expect(restoredTile).toBeVisible({ timeout: 45_000 })
    const renderedNote = restoredTile.locator('textarea[placeholder="Type a note..."]')
    await renderedNote.click()
    await expect(renderedNote).toBeFocused()
    await renderedNote.fill('Rendered through the built-web React surface')
    await expect(renderedNote).toHaveValue('Rendered through the built-web React surface')
    await expect(onboarding).toBeHidden()

    const afterReload = await page.evaluate(
      async ({ targetId, marker }) => {
        const bridge = (
          window as typeof window & {
            electron: {
              workspace: {
                list: () => Promise<Array<{ id: string }>>
              }
              canvas: {
                load: (workspaceId: string) => Promise<{
                  tiles?: Array<{ id: string; type: string }>
                  viewport?: { tx: number; ty: number; zoom: number }
                } | null>
              }
            }
          }
        ).electron
        const listed = await bridge.workspace.list()
        const loaded = await bridge.canvas.load(targetId)
        return {
          listedIds: listed.map((workspace) => workspace.id),
          hasMarkerTile:
            loaded?.tiles?.some((tile) => tile.id === marker && tile.type === 'note') ?? false,
          viewport: loaded?.viewport ?? null,
        }
      },
      {
        targetId: firstPass.targetId,
        marker: firstPass.marker,
      },
    )

    expect(afterReload.listedIds).toEqual(
      expect.arrayContaining([firstPass.targetId, firstPass.guardId]),
    )
    expect(afterReload.hasMarkerTile).toBe(true)
    expect(afterReload.viewport).toEqual({ tx: 31, ty: 47, zoom: 1.25 })
    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
  })
})
