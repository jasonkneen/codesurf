import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { profilePath } from './profiles'

export interface BookmarkNode {
  id: string
  name: string
  url?: string
  children?: BookmarkNode[]
  dateAdded?: number
}

function parseNode(node: any): BookmarkNode {
  const result: BookmarkNode = {
    id: node.id ?? '',
    name: node.name ?? '',
  }
  if (node.type === 'url' && node.url) {
    result.url = node.url
  }
  if (node.date_added) {
    // Chrome epoch microseconds → Unix ms
    result.dateAdded = Math.floor((Number(BigInt(node.date_added) / 1000n - 11644473600000n)))
  }
  if (node.children && Array.isArray(node.children)) {
    result.children = node.children.map(parseNode)
  }
  return result
}

export function getBookmarks(profileDir: string): BookmarkNode[] {
  const file = join(profilePath(profileDir), 'Bookmarks')
  if (!existsSync(file)) return []

  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    const roots = data?.roots
    if (!roots) return []

    const result: BookmarkNode[] = []
    if (roots.bookmark_bar) result.push(parseNode(roots.bookmark_bar))
    if (roots.other) result.push(parseNode(roots.other))
    if (roots.synced) result.push(parseNode(roots.synced))
    return result
  } catch {
    return []
  }
}
