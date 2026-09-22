import { test, expect } from '@playwright/test'
import { closeCodeSurfElectron, launchCodeSurfElectron } from './helpers/launch-electron'
import { waitForElectronBridge } from './helpers/wait-bridge'

test.describe('CodeSurf Electron smoke', () => {
  test('launches, exposes preload bridge, and renders the shell', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      await waitForElectronBridge(page, 'workspace.list')

      const workspaces = await page.evaluate(async () => {
        const bridge = (window as Window & { electron: { workspace: { list: () => Promise<unknown[]> } } }).electron
        return bridge.workspace.list()
      })

      expect(Array.isArray(workspaces)).toBe(true)

      await expect(page.locator('#root')).toBeVisible()
      await expect(page.locator('#root')).not.toContainText('Loading…', { timeout: 45_000 })
      await expect(page).toHaveTitle(/CodeSurf/i)
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })
})