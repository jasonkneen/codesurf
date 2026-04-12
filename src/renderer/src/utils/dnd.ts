export function getDroppedPaths(dataTransfer: DataTransfer | null): string[] {
  if (!dataTransfer) return []

  const seen = new Set<string>()
  const paths: string[] = []

  const add = (value: string | null | undefined) => {
    const path = String(value ?? '').trim()
    if (!path || seen.has(path)) return
    seen.add(path)
    paths.push(path)
  }

  // Electron 32+ removed the non-standard File.path field. Use the preload-exposed
  // webUtils.getPathForFile() to recover the filesystem path of OS-dropped files.
  const getPath = (window as unknown as { electron?: { getPathForFile?: (f: File) => string } }).electron?.getPathForFile
  for (const file of Array.from(dataTransfer.files ?? [])) {
    // Fallback: old-style .path if it still exists (older Electron, or polyfill)
    const legacyPath = (file as File & { path?: string }).path
    if (legacyPath) {
      add(legacyPath)
      continue
    }
    if (getPath) {
      const resolved = getPath(file)
      if (resolved) add(resolved)
    }
  }

  const uriList = dataTransfer.getData('text/uri-list')
  if (uriList) {
    uriList
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .forEach(line => {
        if (line.startsWith('file://')) {
          try {
            add(decodeURIComponent(line.replace(/^file:\/\//, '')))
          } catch {
            add(line.replace(/^file:\/\//, ''))
          }
        } else {
          add(line)
        }
      })
  }

  if (paths.length > 0) return paths

  const plain = dataTransfer.getData('text/plain')
  if (plain) {
    plain
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .forEach(add)
  }

  return paths
}

export function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i.test(path)
}

// Binary media files that should render chromeless by default — no tile titlebar,
// no browser navbar. User can toggle controls back via right-click.
export function isMediaFile(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|mp4|mov|m4v|webm|ogv|avi|mkv|mp3|wav|m4a|aac|ogg|flac|pdf)$/i.test(path)
}

export function toFileUrl(path: string): string {
  return `file://${encodeURI(path).replace(/#/g, '%23')}`
}

export function shellEscapePath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}
