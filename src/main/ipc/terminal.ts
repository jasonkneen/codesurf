import { ipcMain } from 'electron'

// node-pty must be required (not imported) due to native module ESM issues
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pty = require('node-pty')

interface PtyInstance {
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  onData: (cb: (data: string) => void) => void
}

const terminals = new Map<string, PtyInstance>()

export function registerTerminalIPC(): void {
  ipcMain.handle('terminal:create', (event, tileId: string, workspaceDir: string, launchBin?: string, launchArgs?: string[]) => {
    // Kill any existing terminal with this id
    if (terminals.has(tileId)) {
      try { terminals.get(tileId)!.kill() } catch { /* ignore */ }
      terminals.delete(tileId)
    }

    // If a binary is specified, spawn it directly (no shell wrapper)
    const bin = launchBin || process.env.SHELL || '/bin/zsh'
    const args = launchBin ? (launchArgs ?? []) : []

    const term: PtyInstance = pty.spawn(bin, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: workspaceDir,
      env: { ...process.env, CARD_ID: tileId }
    })

    terminals.set(tileId, term)

    term.onData((data: string) => {
      try {
        if (!event.sender.isDestroyed()) {
          event.sender.send(`terminal:data:${tileId}`, data)
          event.sender.send(`terminal:active:${tileId}`)
        }
      } catch { /* renderer may have been destroyed */ }
    })

    return { cols: 80, rows: 24 }
  })

  ipcMain.handle('terminal:write', (_, tileId: string, data: string) => {
    terminals.get(tileId)?.write(data)
  })

  ipcMain.handle('terminal:resize', (_, tileId: string, cols: number, rows: number) => {
    if (cols > 0 && rows > 0) {
      terminals.get(tileId)?.resize(Math.floor(cols), Math.floor(rows))
    }
  })

  ipcMain.handle('terminal:destroy', (_, tileId: string) => {
    const term = terminals.get(tileId)
    if (term) {
      try { term.kill() } catch { /* ignore */ }
      terminals.delete(tileId)
    }
  })
}
