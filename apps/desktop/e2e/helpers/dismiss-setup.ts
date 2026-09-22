import type { Page } from '@playwright/test'

export async function dismissAgentSetupIfPresent(page: Page): Promise<void> {
  const setupSettled = await page.evaluate(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const needsSetup = await window.electron.agentPaths?.needsSetup?.()
      if (!needsSetup) return true
      await window.electron.agentPaths?.confirmAll?.()
    }
    return !(await window.electron.agentPaths?.needsSetup?.())
  })
  if (!setupSettled) {
    throw new Error('Agent setup state did not settle after confirmation')
  }

  await page.evaluate(async () => {
    const settings = await window.electron.settings.get()
    if (!settings.onboardingComplete) {
      await window.electron.settings.set({
        ...settings,
        onboardingComplete: true,
      })
    }
  })

  const looksGood = page.getByRole('button', { name: 'Looks good' })
  const lateSetupAppeared = await looksGood
    .waitFor({ state: 'visible', timeout: 500 })
    .then(() => true, () => false)
  if (lateSetupAppeared) {
    await looksGood.click()
  }
  await looksGood.waitFor({ state: 'hidden', timeout: 5_000 })

  const getStarted = page.getByRole('button', { name: /Get started/i })
  if (await getStarted.isVisible().catch(() => false)) {
    await getStarted.click()
  }
}
