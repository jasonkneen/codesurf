function api() {
  return window.electron.fs
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  ext: string
}

export function readDir(path: string, workspaceId?: string): Promise<DirEntry[]> {
  return api().readDir(path, workspaceId)
}

export function readFile(path: string, workspaceId?: string): Promise<string> {
  return api().readFile(path, workspaceId)
}

export function writeFile(path: string, content: string, workspaceId?: string): Promise<void> {
  return api().writeFile(path, content, workspaceId)
}

export function createFile(path: string, workspaceId?: string): Promise<void> {
  return api().createFile(path, workspaceId)
}

export function createDir(path: string, workspaceId?: string): Promise<void> {
  return api().createDir(path, workspaceId)
}

export function deleteFile(path: string, workspaceId?: string): Promise<void> {
  return api().deleteFile(path, workspaceId)
}

export function renameFile(oldPath: string, newPath: string, workspaceId?: string): Promise<void> {
  return api().renameFile(oldPath, newPath, workspaceId)
}

export function watch(dirPath: string, callback: () => void, workspaceId?: string): () => void {
  return api().watch(dirPath, callback, workspaceId)
}

export function revealInFinder(path: string, workspaceId?: string): Promise<void> {
  const reveal = api().revealInFinder
  if (!reveal) return Promise.resolve()
  return reveal(path, workspaceId)
}

export function stat(path: string, workspaceId?: string): Promise<unknown | null> {
  return api().stat(path, workspaceId)
}

export function isProbablyTextFile(path: string, workspaceId?: string): Promise<boolean> {
  return api().isProbablyTextFile(path, workspaceId)
}

export function copyIntoDir(sourcePath: string, destDir: string, workspaceId?: string): Promise<unknown> {
  return api().copyIntoDir(sourcePath, destDir, workspaceId)
}
