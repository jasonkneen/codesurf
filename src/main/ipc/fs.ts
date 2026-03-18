import { ipcMain, shell } from 'electron'
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { homedir } from 'os'

function resolveFsPath(rawPath: string): string {
  if (rawPath === '~') return homedir()
  if (rawPath.startsWith('~/.clawd-collab/')) {
    return join(homedir(), 'clawd-collab', rawPath.slice('~/.clawd-collab/'.length))
  }
  if (rawPath.startsWith('~\\.clawd-collab\\')) {
    return join(homedir(), 'clawd-collab', rawPath.slice('~\\.clawd-collab\\'.length))
  }
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) return join(homedir(), rawPath.slice(2))
  if (rawPath.startsWith('/clawd-collab/')) return join(homedir(), rawPath.slice(1))
  if (rawPath === '/clawd-collab') return join(homedir(), 'clawd-collab')
  return rawPath
}

export interface FsEntry {
  name: string
  path: string
  isDir: boolean
  ext: string
}

export function registerFsIPC(): void {
  ipcMain.handle('fs:readDir', async (_, dirPath: string) => {
    try {
      const resolvedDirPath = resolveFsPath(dirPath)
      const entries = await fs.readdir(resolvedDirPath, { withFileTypes: true })
      const result: FsEntry[] = entries.map(e => ({
        name: e.name,
        path: `${resolvedDirPath}/${e.name}`,
        isDir: e.isDirectory(),
        ext: e.isDirectory() ? '' : extname(e.name).toLowerCase()
      }))
      // Dirs first, then files, both alphabetical
      result.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return result
    } catch {
      return []
    }
  })

  ipcMain.handle('fs:readFile', async (_, filePath: string) => {
    return await fs.readFile(resolveFsPath(filePath), 'utf8')
  })

  ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string) => {
    await fs.writeFile(resolveFsPath(filePath), content, 'utf8')
  })

  ipcMain.handle('fs:createFile', async (_, filePath: string) => {
    await fs.writeFile(resolveFsPath(filePath), '', 'utf8')
  })

  ipcMain.handle('fs:createDir', async (_, dirPath: string) => {
    await fs.mkdir(resolveFsPath(dirPath), { recursive: true })
  })

  ipcMain.handle('fs:delete', async (_, fspath: string) => {
    await fs.rm(resolveFsPath(fspath), { recursive: true, force: true })
  })

  // Aliases used by renderer
  ipcMain.handle('fs:deleteFile', async (_, fspath: string) => {
    await fs.rm(resolveFsPath(fspath), { recursive: true, force: true })
  })

  ipcMain.handle('fs:rename', async (_, oldPath: string, newPath: string) => {
    await fs.rename(resolveFsPath(oldPath), resolveFsPath(newPath))
  })

  ipcMain.handle('fs:renameFile', async (_, oldPath: string, newPath: string) => {
    await fs.rename(resolveFsPath(oldPath), resolveFsPath(newPath))
  })

  ipcMain.handle('fs:basename', async (_, filePath: string) => {
    return basename(filePath)
  })

  ipcMain.handle('fs:revealInFinder', async (_, filePath: string) => {
    shell.showItemInFolder(resolveFsPath(filePath))
  })

  ipcMain.handle('fs:writeBrief', async (_, cardId: string, content: string) => {
    const { join } = await import('path')
    const { homedir } = await import('os')
    const briefDir = join(homedir(), 'clawd-collab', 'briefs')
    await fs.mkdir(briefDir, { recursive: true })
    const briefPath = join(briefDir, `${cardId}.md`)
    await fs.writeFile(briefPath, content, 'utf8')
    return briefPath
  })
}
