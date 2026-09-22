import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dismissAgentSetupIfPresent } from './helpers/dismiss-setup'
import { closeCodeSurfElectron, launchCodeSurfElectron } from './helpers/launch-electron'
import { waitForElectronBridge } from './helpers/wait-bridge'

test.describe('Chat IPC surface', () => {
  test('preload exposes chat APIs with structured defaults', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      await waitForElectronBridge(page, 'chat.loadSessionHistory')

      const chatProbe = await page.evaluate(async () => {
        const bridge = (window as Window & {
          electron: {
            chat: {
              opencodeModels: () => Promise<unknown>
              csagentModels: () => Promise<unknown>
              loadSessionHistory: (payload: { limit?: number }) => Promise<unknown>
            }
          }
        }).electron

        const [models, csagentModels, history] = await Promise.all([
          bridge.chat.opencodeModels(),
          bridge.chat.csagentModels(),
          bridge.chat.loadSessionHistory({ limit: 1 }),
        ])

        return {
          modelsPayloadOk: models !== null && typeof models === 'object' && Array.isArray((models as { models?: unknown[] }).models),
          csagentModelsPayloadOk: csagentModels !== null && typeof csagentModels === 'object' && Array.isArray((csagentModels as { models?: unknown[] }).models),
          historyIsObject: history !== null && typeof history === 'object',
        }
      })

      expect(chatProbe.modelsPayloadOk).toBe(true)
      expect(chatProbe.csagentModelsPayloadOk).toBe(true)
      expect(chatProbe.historyIsObject).toBe(true)
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })

  test('selects Codex, sends a provider turn, and expands the rendered tool chip', async () => {
    const launch = await launchCodeSurfElectron({
      seedSettings: {
        execution: {
          mode: 'runtime-only',
          hostId: null,
        },
      },
      agentScripts: {
        codex: `#!/usr/bin/env node
const events = [
  { type: 'thread.started', thread_id: 'e2e-codex-thread' },
  {
    type: 'item.completed',
    item: {
      type: 'command_execution',
      command: 'printf E2E_TOOL_COMMAND',
      aggregated_output: 'E2E_TOOL_OUTPUT',
    },
  },
  {
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: 'E2E assistant reply',
    },
  },
]
for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n')
`,
      },
    })

    try {
      const { page, homeDir } = launch
      const projectPath = join(homeDir, 'project')
      await mkdir(projectPath, { recursive: true })
      await waitForElectronBridge(page, 'canvas.save')
      await page.evaluate(async ({ path }) => {
        const workspace = await window.electron.workspace.createWithPath(
          'e2e-chat-provider-turn',
          path,
        )
        await window.electron.canvas.save(workspace.id, {
          tiles: [{
            id: 'e2e-chat-tile',
            type: 'chat',
            label: 'E2E Chat',
            x: 40,
            y: 30,
            width: 820,
            height: 640,
            zIndex: 1,
          }],
          groups: [],
          viewport: { tx: 0, ty: 0, zoom: 1 },
          nextZIndex: 2,
        })
        await window.electron.workspace.setActive(workspace.id)
      }, { path: projectPath })

      await page.reload()
      await waitForElectronBridge(page, 'chat.send')
      await dismissAgentSetupIfPresent(page)

      const chatTile = page.locator('[data-tile-id="e2e-chat-tile"]')
      const composer = chatTile.locator(
        'textarea[placeholder="Message the agent, or use /commands and /skills"]',
      )
      await expect(composer).toBeVisible({ timeout: 45_000 })

      await chatTile.getByTitle(/Choose the CLI agent/).click()
      await page.getByText('Codex', { exact: true }).last().click()

      const prompt = 'E2E visible provider turn'
      await composer.fill(prompt)
      await chatTile.getByTitle('Send message').click()

      await expect(chatTile.getByText(prompt, { exact: true })).toBeVisible()
      await expect(chatTile.getByText('E2E assistant reply', { exact: true })).toBeVisible({
        timeout: 30_000,
      })

      const toolChip = chatTile.locator('[data-tool-block-kind="tool"]').filter({
        hasText: /command/i,
      })
      const toolGroup = chatTile.getByText(/^\d+ tools$/i).last()
      await expect(toolChip.or(toolGroup).first()).toBeVisible()
      if (!(await toolChip.isVisible())) {
        await expect(toolGroup).toBeVisible()
        await toolGroup.click()
      }
      await expect(toolChip).toBeVisible()
      await expect(chatTile.getByText('E2E_TOOL_OUTPUT', { exact: true })).toHaveCount(0)
      await toolChip.locator('button').first().click()
      await expect(chatTile.getByText('printf E2E_TOOL_COMMAND', { exact: true })).toBeVisible()
      await expect(chatTile.getByText('E2E_TOOL_OUTPUT', { exact: true })).toBeVisible()
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })
})
