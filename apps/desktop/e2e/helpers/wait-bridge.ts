import type { Page } from '@playwright/test'

export async function waitForElectronBridge(
  page: Page,
  probe: string,
  timeout = 45_000,
): Promise<void> {
  await page.waitForFunction((path) => {
    const parts = path.split('.')
    let cursor: unknown = (window as Window & { electron?: unknown }).electron
    for (const part of parts) {
      if (!cursor || typeof cursor !== 'object') return false
      cursor = (cursor as Record<string, unknown>)[part]
    }
    return typeof cursor === 'function'
  }, probe, { timeout })
}