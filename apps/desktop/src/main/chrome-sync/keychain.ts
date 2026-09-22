import { execFile } from 'child_process'

let cachedPassword: string | null = null

export function getChromeKeychainPassword(): Promise<string> {
  if (cachedPassword) return Promise.resolve(cachedPassword)

  if (process.platform !== 'darwin') {
    // On Windows/Linux, Chrome uses DPAPI/gnome-keyring respectively.
    // The macOS `security` command is not available.
    return Promise.reject(new Error('Chrome keychain access is only supported on macOS'))
  }

  return new Promise((resolve, reject) => {
    execFile('security', [
      'find-generic-password',
      '-s', 'Chrome Safe Storage',
      '-w',
    ], (err, stdout) => {
      if (err) {
        reject(new Error('Keychain access denied or Chrome Safe Storage not found'))
      } else {
        cachedPassword = stdout.trim()
        resolve(cachedPassword)
      }
    })
  })
}

export function clearCachedPassword(): void {
  cachedPassword = null
}
