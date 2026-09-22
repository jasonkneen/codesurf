import { BrowserWindow, dialog, shell, systemPreferences, type WebContents } from 'electron'
import type { MediaAccessKind } from './permissionBoundaryTypes.ts'
import { planOsMediaAccess } from './mediaAccessPlan.ts'

export type { MediaAccessKind }
export { parseMediaAccessKind, planOsMediaAccess } from './mediaAccessPlan.ts'

const SETTINGS_URL: Record<MediaAccessKind, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
}

export async function requestOsMediaAccess(
  kind: MediaAccessKind,
  sender?: WebContents | null,
): Promise<{ granted: boolean; status: string; openedSettings?: boolean }> {
  if (process.platform !== 'darwin') {
    return { granted: true, status: 'granted' }
  }

  let status = systemPreferences.getMediaAccessStatus(kind)
  const plan = planOsMediaAccess(status)
  if (plan === 'grant') return { granted: true, status }

  if (plan === 'ask') {
    try {
      const granted = await systemPreferences.askForMediaAccess(kind)
      status = systemPreferences.getMediaAccessStatus(kind)
      return { granted, status }
    } catch (error) {
      console.warn(`[Permissions] askForMediaAccess(${kind}) failed:`, error)
      status = systemPreferences.getMediaAccessStatus(kind)
    }
  }

  const owner = sender && !sender.isDestroyed() ? BrowserWindow.fromWebContents(sender) : null
  const noun = kind === 'camera' ? 'camera' : 'microphone'
  const settingsLabel = kind === 'camera' ? 'Camera' : 'Microphone'
  const options = {
    type: 'info' as const,
    title: `${settingsLabel} access`,
    message: `CodeSurf needs the ${noun}`,
    detail: `macOS is blocking the ${noun}. Enable CodeSurf in System Settings → Privacy & Security → ${settingsLabel}, then try again.`,
    buttons: ['Open System Settings', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }
  const result = owner && !owner.isDestroyed()
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options)
  if (result.response === 0) {
    await shell.openExternal(SETTINGS_URL[kind])
    return { granted: false, status, openedSettings: true }
  }
  return { granted: false, status }
}
