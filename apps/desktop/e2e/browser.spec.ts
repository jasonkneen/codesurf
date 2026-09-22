import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dismissAgentSetupIfPresent } from './helpers/dismiss-setup'
import { closeCodeSurfElectron, launchCodeSurfElectron } from './helpers/launch-electron'
import { waitForElectronBridge } from './helpers/wait-bridge'

const FIXTURE_HTML_PATH = join(__dirname, 'fixtures/browser-tile.html')
const TILE_ID = 'e2e-browser-behavior'

type NavigationSnapshot = {
  url: string | null
  title: string | null
  canGoBack: boolean | null
  canGoForward: boolean | null
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return (server.address() as AddressInfo).port
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

test.describe('BrowserTile production Electron behavior', () => {
  test('navigates a real guest, records evidence, and restores the last URL', async () => {
    const fixtureHtml = await readFile(FIXTURE_HTML_PATH, 'utf8')
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? '/')
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
      })
      response.end(fixtureHtml)
    })
    const port = await listen(server)
    const startUrl = `http://127.0.0.1:${port}/start`
    const nextUrl = `http://127.0.0.1:${port}/next`
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      await waitForElectronBridge(page, 'canvas.save')

      const workspaceId = await page.evaluate(async ({ tileId, url }) => {
        const workspace = await window.electron.workspace.create('e2e-browser-behavior')
        await window.electron.canvas.save(workspace.id, {
          tiles: [{
            id: tileId,
            type: 'browser',
            label: 'Browser behavior fixture',
            filePath: url,
            x: 80,
            y: 70,
            width: 960,
            height: 650,
            zIndex: 1,
          }],
          groups: [],
          viewport: { tx: 0, ty: 0, zoom: 1 },
          nextZIndex: 2,
        })
        await window.electron.workspace.setActive(workspace.id)
        return workspace.id
      }, { tileId: TILE_ID, url: startUrl })

      await page.reload()
      await waitForElectronBridge(page, 'canvas.load')
      await dismissAgentSetupIfPresent(page)

      const tile = page.locator(`[data-tile-id="${TILE_ID}"]`)
      const address = tile.locator('input[aria-label="Address"]')
      await expect(tile).toBeVisible({ timeout: 45_000 })
      await expect(address).toHaveValue(startUrl)
      await expect.poll(() => requests.filter(path => path === '/start').length).toBeGreaterThan(0)

      const navigation = async (): Promise<NavigationSnapshot> => page.evaluate(
        async ({ workspaceId: id, tileId }) => {
          const entry = await window.electron.tileContext?.get(id, tileId, 'ctx:browser:navigation')
          const value = entry && typeof entry === 'object' && 'value' in entry
            ? (entry as { value?: unknown }).value
            : null
          const state = value && typeof value === 'object'
            ? value as Record<string, unknown>
            : {}
          return {
            url: typeof state.currentUrl === 'string' ? state.currentUrl : null,
            title: typeof state.title === 'string' ? state.title : null,
            canGoBack: typeof state.canGoBack === 'boolean' ? state.canGoBack : null,
            canGoForward: typeof state.canGoForward === 'boolean' ? state.canGoForward : null,
          }
        },
        { workspaceId, tileId: TILE_ID },
      )

      await expect.poll(navigation).toEqual({
        url: startUrl,
        title: 'CodeSurf Browser Fixture Start',
        canGoBack: false,
        canGoForward: false,
      })

      await address.fill(nextUrl)
      await address.press('Enter')
      await expect.poll(() => requests.filter(path => path === '/next').length).toBeGreaterThan(0)
      await expect.poll(navigation).toEqual({
        url: nextUrl,
        title: 'CodeSurf Browser Fixture Next',
        canGoBack: true,
        canGoForward: false,
      })

      const back = tile.getByRole('button', { name: 'Back' })
      const forward = tile.getByRole('button', { name: 'Forward' })
      await expect(back).toBeEnabled()
      await back.click()
      await expect.poll(navigation).toEqual({
        url: startUrl,
        title: 'CodeSurf Browser Fixture Start',
        canGoBack: false,
        canGoForward: true,
      })
      await expect(forward).toBeEnabled()
      await forward.click()
      await expect.poll(navigation).toEqual({
        url: nextUrl,
        title: 'CodeSurf Browser Fixture Next',
        canGoBack: true,
        canGoForward: false,
      })

      await tile.getByRole('button', { name: 'Browser evidence' }).click()
      const drawer = tile.getByLabel('Evidence drawer', { exact: true })
      await expect(drawer).toBeVisible()
      await expect(drawer).toContainText('codesurf-browser-fixture-warning:next')
      await drawer.getByRole('button', { name: 'Lifecycle' }).click()
      await expect(drawer).toContainText('Frame finished loading')
      await drawer.getByRole('button', { name: 'Capture snapshot' }).click()
      await expect(drawer).toContainText('Snapshot captured')

      await expect.poll(async () => page.evaluate(async ({ tileId, nextUrl }) => {
        const history = await window.electron.bus.history(`tile:${tileId}`, 100)
        const event = [...history].reverse().find(candidate => (
          candidate.type === 'browser.evidence.snapshot'
          && candidate.payload?.reason === 'user-capture'
        ))
        const snapshot = event?.payload?.snapshot as {
          page?: { url?: string; title?: string }
          events?: Array<{ kind?: string; message?: string; severity?: string }>
        } | undefined
        return Boolean(
          snapshot?.page?.url === nextUrl
          && snapshot.page.title === 'CodeSurf Browser Fixture Next'
          && snapshot.events?.some(item => (
            item.kind === 'console'
            && item.severity === 'warning'
            && item.message === 'codesurf-browser-fixture-warning:next'
          ))
          && snapshot.events?.some(item => (
            item.kind === 'lifecycle'
            && item.message === 'Frame finished loading'
          )),
        )
      }, { tileId: TILE_ID, nextUrl })).toBe(true)

      await expect.poll(async () => page.evaluate(async ({ id, tileId, nextUrl }) => {
        const state = await window.electron.canvas.loadTileState(id, tileId) as {
          addressBar?: unknown
          currentUrl?: unknown
        } | null
        return state?.addressBar === nextUrl && state.currentUrl === nextUrl
      }, { id: workspaceId, tileId: TILE_ID, nextUrl })).toBe(true)

      const nextRequestsBeforeReload = requests.filter(path => path === '/next').length
      await page.reload()
      await waitForElectronBridge(page, 'canvas.load')
      await dismissAgentSetupIfPresent(page)

      const restoredTile = page.locator(`[data-tile-id="${TILE_ID}"]`)
      const restoredAddress = restoredTile.locator('input[aria-label="Address"]')
      await expect(restoredTile).toBeVisible({ timeout: 45_000 })
      await expect(restoredAddress).toHaveValue(nextUrl)
      await expect.poll(
        () => requests.filter(path => path === '/next').length,
      ).toBeGreaterThan(nextRequestsBeforeReload)
      await expect.poll(navigation).toEqual({
        url: nextUrl,
        title: 'CodeSurf Browser Fixture Next',
        canGoBack: false,
        canGoForward: false,
      })
    } finally {
      await closeCodeSurfElectron(launch)
      await closeServer(server)
    }
  })
})
