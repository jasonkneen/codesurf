import { test, expect } from '@playwright/test'
import { closeCodeSurfElectron, launchCodeSurfElectron } from './helpers/launch-electron'
import { waitForElectronBridge } from './helpers/wait-bridge'

test.describe('Security hardening probes', () => {
  test('MCP push rejects requests without bearer auth', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      await waitForElectronBridge(page, 'mcp.getPort')

      const probe = await page.evaluate(async () => {
        const port = await window.electron.mcp?.getPort?.()
        if (typeof port !== 'number' || port <= 0) {
          return { port, status: null, body: '' }
        }

        const res = await fetch(`http://127.0.0.1:${port}/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ card_id: 'e2e', event: 'card_update', data: { note: 'probe' } }),
        })

        return { port, status: res.status, body: await res.text() }
      })

      expect(
        probe.port,
        `MCP server failed to start: mcp.getPort() returned ${String(probe.port)} instead of a positive port`,
      ).toBeGreaterThan(0)
      expect(probe.status).toBe(401)
      expect(JSON.parse(probe.body)).toEqual({ error: 'Unauthorized' })
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })

  test('fs IPC blocks sensitive paths when workspace scoping is enabled', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      await waitForElectronBridge(page, 'settings.set')

      const probe = await page.evaluate(async () => {
        const settings = await window.electron.settings.get()
        await window.electron.settings.set({
          ...settings,
          security: {
            ...settings.security,
            restrictFsToWorkspaceRoots: true,
          },
        })

        try {
          await window.electron.fs.readFile('/etc/passwd')
          return { blocked: false, message: '' }
        } catch (error) {
          return {
            blocked: true,
            message: error instanceof Error ? error.message : String(error),
          }
        }
      })

      expect(probe.blocked).toBe(true)
      expect(probe.message).toMatch(/outside allowed workspace roots|no workspace project folders configured/i)
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })

  test('legacy install migrates to workspace scoping on startup', async () => {
    const launch = await launchCodeSurfElectron({
      seedSettings: {
        onboardingComplete: true,
        security: {
          restrictFsToWorkspaceRoots: false,
        },
      },
    })

    try {
      const { page } = launch
      await waitForElectronBridge(page, 'settings.get')

      const probe = await page.evaluate(async () => {
        const settings = await window.electron.settings.get()
        try {
          await window.electron.fs.readFile('/etc/passwd')
          return {
            migrated: settings.security?.restrictFsToWorkspaceRoots === true
              && settings.security?.fsScopingMigrated === true,
            blocked: false,
            message: '',
          }
        } catch (error) {
          return {
            migrated: settings.security?.restrictFsToWorkspaceRoots === true
              && settings.security?.fsScopingMigrated === true,
            blocked: true,
            message: error instanceof Error ? error.message : String(error),
          }
        }
      })

      expect(probe.migrated).toBe(true)
      expect(probe.blocked).toBe(true)
      expect(probe.message).toMatch(/outside allowed workspace roots|no workspace project folders configured/i)
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })

  test('fresh install blocks sensitive paths before user changes settings', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      await waitForElectronBridge(page, 'fs.readFile')

      const probe = await page.evaluate(async () => {
        try {
          await window.electron.fs.readFile('/etc/passwd')
          return { blocked: false, message: '' }
        } catch (error) {
          return {
            blocked: true,
            message: error instanceof Error ? error.message : String(error),
          }
        }
      })

      expect(probe.blocked).toBe(true)
      expect(probe.message).toMatch(/outside allowed workspace roots|no workspace project folders configured/i)
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })
})
