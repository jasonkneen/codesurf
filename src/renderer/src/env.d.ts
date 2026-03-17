/// <reference types="vite/client" />

import type { Workspace } from '../../shared/types'

interface ElectronAPI {
  workspace: {
    list(): Promise<Workspace[]>
    create(name: string): Promise<Workspace>
    setActive(id: string): Promise<void>
    getActive(): Promise<Workspace | null>
    delete(id: string): Promise<void>
  }
  fs: {
    readDir(path: string): Promise<Array<{ name: string; path: string; isDir: boolean; ext: string }>>
    readFile(path: string): Promise<string>
    writeFile(path: string, content: string): Promise<void>
    createFile(path: string): Promise<void>
    createDir(path: string): Promise<void>
    delete(path: string): Promise<void>
    rename(oldPath: string, newPath: string): Promise<void>
    basename(path: string): Promise<string>
    revealInFinder(path: string): Promise<void>
    writeBrief(cardId: string, content: string): Promise<string>
  }
  canvas: {
    load(workspaceId: string): Promise<import('../../shared/types').CanvasState | null>
    save(workspaceId: string, state: import('../../shared/types').CanvasState): Promise<void>
  }
  terminal: {
    create(tileId: string, workspaceDir: string, launchBin?: string, launchArgs?: string[]): Promise<{ cols: number; rows: number }>
    write(tileId: string, data: string): Promise<void>
    resize(tileId: string, cols: number, rows: number): Promise<void>
    destroy(tileId: string): Promise<void>
    onData(tileId: string, cb: (data: string) => void): () => void
    onActive(tileId: string, cb: () => void): () => void
  }
  agents: {
    detect(): Promise<Array<{ id: string; label: string; cmd: string; path?: string; version?: string; available: boolean }>>
  }
  updater: {
    check(): Promise<void>
    download(): Promise<void>
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
  }
}
