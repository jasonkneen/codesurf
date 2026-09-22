import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dismissAgentSetupIfPresent } from './helpers/dismiss-setup'
import {
  closeCodeSurfElectron,
  launchCodeSurfElectron,
  quitCodeSurfElectron,
} from './helpers/launch-electron'
import { waitForElectronBridge } from './helpers/wait-bridge'

test.describe('Canvas IPC surface', () => {
  test('preload exposes canvas APIs and returns structured load results', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      await waitForElectronBridge(page, 'canvas.load')

      const canvasProbe = await page.evaluate(async () => {
        const bridge = (window as Window & {
          electron: {
            workspace: { list: () => Promise<Array<{ id: string; path?: string }>> }
            canvas: { load: (workspaceId: string) => Promise<unknown> }
          }
        }).electron

        const workspaces = await bridge.workspace.list()
        const workspaceId = workspaces[0]?.id ?? 'e2e-empty-workspace'
        const loaded = await bridge.canvas.load(workspaceId)

        return {
          workspaceCount: workspaces.length,
          workspaceId,
          loadedIsNullOrObject: loaded === null || (typeof loaded === 'object' && loaded !== null),
        }
      })

      expect(canvasProbe.workspaceCount).toBeGreaterThanOrEqual(0)
      expect(canvasProbe.loadedIsNullOrObject).toBe(true)
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })

  test('canvas save and reload round-trips tile state', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      await waitForElectronBridge(page, 'canvas.save')

      const roundTrip = await page.evaluate(async () => {
        const bridge = (window as Window & {
          electron: {
            workspace: {
              list: () => Promise<Array<{ id: string }>>
              create: (name: string) => Promise<{ id: string }>
            }
            canvas: {
              load: (workspaceId: string) => Promise<{ tiles?: Array<{ id: string; type: string }> } | null>
              save: (workspaceId: string, state: unknown) => Promise<unknown>
            }
          }
        }).electron

        const workspaces = await bridge.workspace.list()
        let workspaceId = workspaces[0]?.id
        if (!workspaceId) {
          const created = await bridge.workspace.create('e2e-canvas-roundtrip')
          workspaceId = created.id
        }

        const tileId = 'e2e-tile-1'
        const payload = {
          tiles: [{ id: tileId, type: 'note', x: 120, y: 80, width: 320, height: 200 }],
          viewport: { tx: 0, ty: 0, zoom: 1 },
          nextZIndex: 2,
        }

        await bridge.canvas.save(workspaceId, payload)
        const reloaded = await bridge.canvas.load(workspaceId)
        const tiles = Array.isArray(reloaded?.tiles) ? reloaded.tiles : []

        return {
          workspaceId,
          savedTileCount: payload.tiles.length,
          reloadedTileCount: tiles.length,
          hasSavedTile: tiles.some(tile => tile.id === tileId && tile.type === 'note'),
        }
      })

      expect(roundTrip.savedTileCount).toBeGreaterThan(0)
      expect(roundTrip.reloadedTileCount).toBeGreaterThanOrEqual(roundTrip.savedTileCount)
      expect(roundTrip.hasSavedTile).toBe(true)
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })

  test('command shell creates a note tile on the canvas', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      await waitForElectronBridge(page, 'workspace.setActive')

      await page.evaluate(async () => {
        const bridge = (window as Window & {
          electron: {
            workspace: {
              list: () => Promise<Array<{ id: string }>>
              create: (name: string) => Promise<{ id: string }>
              setActive: (id: string) => Promise<unknown>
            }
          }
        }).electron

        const workspaces = await bridge.workspace.list()
        let id = workspaces[0]?.id
        if (!id) {
          id = (await bridge.workspace.create('e2e-shell-tile')).id
        }
        await bridge.workspace.setActive(id)
      })

      await page.reload()
      await waitForElectronBridge(page, 'canvas.load')
      await dismissAgentSetupIfPresent(page)
      await page.waitForSelector('[data-canvas-surface="true"]', { timeout: 45_000 })
      // The surface mounts before the async workspace hydration commits. Give
      // that initial load a chance to settle so it cannot replace the tile
      // created by the command-shell event below.
      await page.waitForTimeout(750)

      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('codesurf:new-tile', { detail: { type: 'note' } }))
      })
      const noteEditor = page.locator('textarea[placeholder="Type a note..."]')
      await expect(noteEditor).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-tile-chrome="true"]').filter({ has: noteEditor })).toBeVisible()
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })

  test('production Electron resolves dynamically loaded tile bodies from file assets', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      const failedAssetRequests: string[] = []
      const loadedTileChunks = new Set<string>()
      let noteChunkAttempts = 0
      await page.route(/\/assets\/NoteTile-[^/]+\.js(?:\?.*)?$/, async route => {
        noteChunkAttempts += 1
        if (noteChunkAttempts === 1) {
          await route.abort('failed')
          return
        }
        await route.continue()
      })
      page.on('requestfailed', request => {
        if (request.url().includes('/assets/')) failedAssetRequests.push(request.url())
      })
      page.on('response', response => {
        const match = response.url().match(
          /\/assets\/(NoteTile|TerminalTile|BrowserTile|CodeTile)-[^/]+\.js(?:\?.*)?$/,
        )
        if (match && response.ok()) loadedTileChunks.add(match[1])
      })

      await waitForElectronBridge(page, 'workspace.setActive')
      await page.evaluate(async () => {
        const workspaces = await window.electron.workspace.list()
        const workspace = workspaces[0] ?? await window.electron.workspace.create('e2e-lazy-tile-bodies')
        await window.electron.workspace.setActive(workspace.id)
      })

      await page.reload()
      await waitForElectronBridge(page, 'canvas.load')
      await dismissAgentSetupIfPresent(page)
      await page.waitForSelector('[data-canvas-surface="true"]', { timeout: 45_000 })
      await page.waitForTimeout(750)

      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('codesurf:new-tile', { detail: { type: 'terminal' } }))
      })
      const terminalTitle = page.getByText('Terminal', { exact: true }).first()
      await expect(terminalTitle).toBeVisible()
      const terminalChrome = terminalTitle.locator(
        'xpath=ancestor::*[@data-tile-chrome="true"][1]',
      )
      const terminalChromeHandle = await terminalChrome.elementHandle()
      expect(terminalChromeHandle).not.toBeNull()

      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('codesurf:new-tile', { detail: { type: 'note' } }))
      })
      const retryTile = page.locator('[data-loadable-tile-retry="true"]').last()
      await expect(retryTile).toBeVisible()
      await expect(terminalChrome).toBeVisible()
      await retryTile.click()
      await expect(page.locator('textarea[placeholder="Type a note..."]')).toBeVisible()
      await expect(terminalChrome).toBeVisible()
      expect(await terminalChromeHandle!.evaluate(element => element.isConnected)).toBe(true)

      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('codesurf:new-tile', { detail: { type: 'code' } }))
      })
      await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 45_000 })

      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('codesurf:new-tile', { detail: { type: 'browser' } }))
      })
      await expect(page.locator('input[aria-label="Address"]')).toBeVisible()

      expect([...loadedTileChunks].sort()).toEqual([
        'BrowserTile',
        'CodeTile',
        'NoteTile',
        'TerminalTile',
      ])
      expect(noteChunkAttempts).toBe(2)
      expect(failedAssetRequests).toHaveLength(1)
      expect(failedAssetRequests[0]).toMatch(/\/assets\/NoteTile-[^/]+\.js$/)
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })

  test('canvas viewport save and reload round-trips pan and zoom', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      await waitForElectronBridge(page, 'canvas.save')

      const viewportRoundTrip = await page.evaluate(async () => {
        const bridge = (window as Window & {
          electron: {
            workspace: {
              list: () => Promise<Array<{ id: string }>>
              create: (name: string) => Promise<{ id: string }>
            }
            canvas: {
              load: (workspaceId: string) => Promise<{ viewport?: { tx: number; ty: number; zoom: number }; tiles?: unknown[] } | null>
              save: (workspaceId: string, state: unknown) => Promise<unknown>
            }
          }
        }).electron

        const workspaces = await bridge.workspace.list()
        let workspaceId = workspaces[0]?.id
        if (!workspaceId) {
          const createdWorkspace = await bridge.workspace.create('e2e-viewport')
          workspaceId = createdWorkspace.id
        }

        const viewport = { tx: 140, ty: 96, zoom: 1.35 }
        const payload = {
          tiles: [],
          viewport,
          nextZIndex: 1,
        }

        await bridge.canvas.save(workspaceId, payload)
        const reloaded = await bridge.canvas.load(workspaceId)
        const reloadedViewport = reloaded?.viewport ?? { tx: 0, ty: 0, zoom: 1 }

        return { saved: viewport, reloaded: reloadedViewport }
      })

      expect(viewportRoundTrip.reloaded).toEqual(viewportRoundTrip.saved)
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })

  test('quitting the app inside the debounce window persists a rendered canvas mutation', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page, homeDir } = launch
      await waitForElectronBridge(page, 'window.onPersistenceRequest')

      const workspaceId = await page.evaluate(async () => {
        const workspaces = await window.electron.workspace.list()
        const workspace = workspaces[0] ?? await window.electron.workspace.create('e2e-close-flush')
        await window.electron.canvas.save(workspace.id, {
          tiles: [],
          groups: [],
          viewport: { tx: 0, ty: 0, zoom: 1 },
          nextZIndex: 1,
        })
        await window.electron.workspace.setActive(workspace.id)
        return workspace.id
      })

      await page.reload()
      await waitForElectronBridge(page, 'window.onPersistenceRequest')
      await dismissAgentSetupIfPresent(page)
      const canvas = page.locator('[data-canvas-surface="true"]')
      await canvas.waitFor({ state: 'visible', timeout: 45_000 })
      // Drain any initialization save that was scheduled before fake timers
      // are installed, so it cannot consume the later mutation callback.
      await page.waitForTimeout(750)
      const canvasBounds = await canvas.boundingBox()
      expect(canvasBounds).not.toBeNull()

      const canvasPath = join(
        homeDir,
        '.codesurf',
        'workspaces',
        workspaceId,
        '.codesurf',
        'canvas-state.json',
      )
      const baseline = JSON.parse(await readFile(canvasPath, 'utf8')) as {
        tiles?: Array<{ type?: string }>
      }
      expect(baseline.tiles?.some(tile => tile.type === 'terminal')).toBe(false)
      expect(await page.evaluate(
        () => document.body.innerText.includes('Loading block'),
      )).toBe(false)

      // Freeze the renderer clock before a real rendered-surface mutation.
      // This makes it impossible for the 500 ms debounce timer to win a race
      // with the assertion or the subsequent app.quit request.
      const pausedAt = Date.now()
      await page.clock.install({ time: pausedAt })
      await page.clock.pauseAt(pausedAt)
      await page.mouse.dblclick(
        canvasBounds!.x + Math.min(620, canvasBounds!.width - 20),
        canvasBounds!.y + Math.min(420, canvasBounds!.height - 20),
      )
      await expect.poll(async () => page.evaluate(
        () => (
          document.body.innerText.includes('TERMINAL')
          || document.body.innerText.includes('Loading block')
        ),
      )).toBe(true)

      const beforeQuit = JSON.parse(await readFile(canvasPath, 'utf8')) as {
        tiles?: Array<{ type?: string }>
      }
      expect(beforeQuit.tiles?.some(tile => tile.type === 'terminal')).toBe(false)

      await quitCodeSurfElectron(launch)

      const saved = JSON.parse(await readFile(canvasPath, 'utf8')) as {
        tiles?: Array<{ type?: string }>
      }
      expect(saved.tiles?.some(tile => tile.type === 'terminal')).toBe(true)
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })

  test('real pointer gestures focus, drag, resize, and persist a tile', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      await waitForElectronBridge(page, 'canvas.save')

      const workspaceId = await page.evaluate(async () => {
        const workspace = await window.electron.workspace.create('e2e-pointer-tile')
        await window.electron.canvas.save(workspace.id, {
          tiles: [
            {
              id: 'e2e-pointer-a',
              type: 'note',
              label: 'Pointer A',
              x: 100,
              y: 90,
              width: 300,
              height: 210,
              zIndex: 1,
            },
            {
              id: 'e2e-pointer-b',
              type: 'note',
              label: 'Pointer B',
              x: 500,
              y: 120,
              width: 300,
              height: 210,
              zIndex: 2,
            },
          ],
          groups: [],
          viewport: { tx: 0, ty: 0, zoom: 1 },
          nextZIndex: 3,
        })
        await window.electron.workspace.setActive(workspace.id)
        return workspace.id
      })

      await page.reload()
      await waitForElectronBridge(page, 'canvas.load')
      await dismissAgentSetupIfPresent(page)

      const tileA = page.locator('[data-tile-id="e2e-pointer-a"]')
      const tileB = page.locator('[data-tile-id="e2e-pointer-b"]')
      await expect(tileA).toBeVisible({ timeout: 45_000 })
      await expect(tileB).toBeVisible()

      const initialBox = await tileA.boundingBox()
      const otherZIndex = await tileB.evaluate(element => Number(getComputedStyle(element).zIndex))
      expect(initialBox).not.toBeNull()

      const titlebar = tileA.locator('[data-tile-titlebar="true"]')
      const titlebarBox = await titlebar.boundingBox()
      expect(titlebarBox).not.toBeNull()
      const dragStart = {
        x: titlebarBox!.x + titlebarBox!.width / 2,
        y: titlebarBox!.y + titlebarBox!.height / 2,
      }
      await page.mouse.move(dragStart.x, dragStart.y)
      await page.mouse.down()
      await page.mouse.move(dragStart.x + 96, dragStart.y + 64, { steps: 8 })
      await page.mouse.up()

      await expect.poll(async () => (await tileA.boundingBox())?.x ?? 0).toBeGreaterThan(initialBox!.x + 60)
      await expect.poll(async () => (await tileA.boundingBox())?.y ?? 0).toBeGreaterThan(initialBox!.y + 35)
      await expect.poll(
        async () => tileA.evaluate(element => Number(getComputedStyle(element).zIndex)),
      ).toBeGreaterThan(otherZIndex)

      const movedBox = await tileA.boundingBox()
      const resizeHandle = tileA.locator('[data-resize-dir="se"]')
      const resizeBox = await resizeHandle.boundingBox()
      expect(movedBox).not.toBeNull()
      expect(resizeBox).not.toBeNull()
      const resizeStart = {
        // Stay inside the tile-facing quadrant. The link-discovery sensors
        // intentionally begin at the outer edge of the same corner.
        x: resizeBox!.x + 2,
        y: resizeBox!.y + 2,
      }
      const resizeHitTarget = await page.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y)
        return {
          resizeDir: element?.getAttribute('data-resize-dir'),
          tileChrome: element?.getAttribute('data-tile-chrome'),
          tileId: element?.getAttribute('data-tile-id'),
          tag: element?.tagName,
        }
      }, resizeStart)
      expect(resizeHitTarget).toEqual({
        resizeDir: 'se',
        tileChrome: null,
        tileId: null,
        tag: 'DIV',
      })
      await page.mouse.move(resizeStart.x, resizeStart.y)
      await page.mouse.down()
      await page.mouse.move(resizeStart.x + 80, resizeStart.y + 48, { steps: 8 })
      await page.mouse.up()

      await expect.poll(async () => (await tileA.boundingBox())?.width ?? 0).toBeGreaterThan(movedBox!.width + 50)
      await expect.poll(async () => (await tileA.boundingBox())?.height ?? 0).toBeGreaterThan(movedBox!.height + 25)

      await expect.poll(async () => page.evaluate(async ({ id }) => {
        const state = await window.electron.canvas.load(id)
        const tile = state?.tiles?.find(candidate => candidate.id === 'e2e-pointer-a')
        return Boolean(
          tile
          && tile.x >= 180
          && tile.y >= 140
          && tile.width >= 360
          && tile.height >= 240,
        )
      }, { id: workspaceId })).toBe(true)
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })

  test('real pointer group drag moves every rendered member and persists the result', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      await waitForElectronBridge(page, 'canvas.save')

      const workspaceId = await page.evaluate(async () => {
        const workspace = await window.electron.workspace.create('e2e-pointer-group')
        await window.electron.canvas.save(workspace.id, {
          tiles: [
            {
              id: 'e2e-group-a',
              type: 'note',
              label: 'Group A',
              groupId: 'e2e-group',
              x: 120,
              y: 120,
              width: 260,
              height: 180,
              zIndex: 1,
            },
            {
              id: 'e2e-group-b',
              type: 'note',
              label: 'Group B',
              groupId: 'e2e-group',
              x: 460,
              y: 120,
              width: 260,
              height: 180,
              zIndex: 2,
            },
          ],
          groups: [{ id: 'e2e-group', label: 'Pointer Group' }],
          viewport: { tx: 0, ty: 0, zoom: 1 },
          nextZIndex: 3,
        })
        await window.electron.workspace.setActive(workspace.id)
        return workspace.id
      })

      await page.reload()
      await waitForElectronBridge(page, 'canvas.load')
      await dismissAgentSetupIfPresent(page)

      const tileA = page.locator('[data-tile-id="e2e-group-a"]')
      const tileB = page.locator('[data-tile-id="e2e-group-b"]')
      const frame = page.locator('[data-canvas-group-id="e2e-group"]')
      await expect(tileA).toBeVisible({ timeout: 45_000 })
      await expect(tileB).toBeVisible()
      await expect(frame).toBeVisible()

      const beforeA = await tileA.boundingBox()
      const beforeB = await tileB.boundingBox()
      expect(beforeA).not.toBeNull()
      expect(beforeB).not.toBeNull()

      const moveHandle = frame.locator('[data-group-move-handle="true"]')
      await expect(moveHandle).toBeVisible()
      const moveHandleBox = await moveHandle.boundingBox()
      expect(moveHandleBox).not.toBeNull()
      const dragStart = {
        x: moveHandleBox!.x + moveHandleBox!.width / 2,
        y: moveHandleBox!.y + moveHandleBox!.height / 2,
      }

      await page.mouse.move(dragStart.x, dragStart.y)
      await page.mouse.down()
      await page.mouse.move(dragStart.x + 72, dragStart.y + 56, { steps: 8 })
      await page.mouse.up()

      await expect.poll(async () => (await tileA.boundingBox())?.x ?? 0).toBeGreaterThan(beforeA!.x + 45)
      await expect.poll(async () => (await tileA.boundingBox())?.y ?? 0).toBeGreaterThan(beforeA!.y + 30)
      await expect.poll(async () => (await tileB.boundingBox())?.x ?? 0).toBeGreaterThan(beforeB!.x + 45)
      await expect.poll(async () => (await tileB.boundingBox())?.y ?? 0).toBeGreaterThan(beforeB!.y + 30)

      await expect.poll(async () => page.evaluate(async ({ id }) => {
        const state = await window.electron.canvas.load(id)
        const a = state?.tiles?.find(candidate => candidate.id === 'e2e-group-a')
        const b = state?.tiles?.find(candidate => candidate.id === 'e2e-group-b')
        return Boolean(
          a
          && b
          && a.x >= 175
          && a.y >= 160
          && b.x >= 515
          && b.y >= 160,
        )
      }, { id: workspaceId })).toBe(true)
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })

})
