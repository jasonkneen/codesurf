import type { TileState } from '../../../shared/types'

const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'rs', 'go', 'cpp', 'c', 'java', 'css', 'html', 'sh', 'bash', 'yaml', 'yml', 'toml', 'xml'])
const NOTE_EXTENSIONS = new Set(['md', 'txt', 'markdown', 'mdx'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'heif'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'ogv', 'avi', 'mkv'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'])
const BROWSER_DOCUMENT_EXTENSIONS = new Set(['pdf'])
const GENERIC_DOCUMENT_EXTENSIONS = new Set(['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'pages', 'numbers', 'key', 'rtf'])

export function extToType(filePath: string): TileState['type'] {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  if (NOTE_EXTENSIONS.has(ext)) return 'note'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext)) return 'media'
  if (BROWSER_DOCUMENT_EXTENSIONS.has(ext)) return 'browser'
  if (GENERIC_DOCUMENT_EXTENSIONS.has(ext)) return 'file'
  if (!filePath.includes('.')) return 'code'
  return 'file'
}

export async function resolveFileTileType(filePath: string): Promise<TileState['type']> {
  const byExtension = extToType(filePath)
  if (byExtension !== 'file') return byExtension

  try {
    const isText = await window.electron.fs.isProbablyTextFile(filePath)
    return isText ? 'code' : 'file'
  } catch {
    return byExtension
  }
}