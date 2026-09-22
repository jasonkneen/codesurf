import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveElectronExecutable } from './helpers/electron-path'

export default async function globalSetup(): Promise<void> {
  const mainEntry = join(__dirname, '../dist-electron/main/index.js')
  const rendererEntry = join(__dirname, '../dist-electron/renderer/index.html')
  const preloadEntry = join(__dirname, '../dist-electron/preload/index.js')

  const missing = [mainEntry, rendererEntry, preloadEntry].filter(path => !existsSync(path))
  if (missing.length > 0) {
    throw new Error(
      `E2E requires a full Electron build before running.\n`
      + `Missing:\n${missing.map(path => `  - ${path}`).join('\n')}\n`
      + `Run: npm run build`,
    )
  }

  resolveElectronExecutable(join(__dirname, '..'))
}
