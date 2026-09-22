const SKIP_LEAF_NAMES = new Set(['homedir', 'platform'])

export function collectBridgePaths(root: unknown, prefix = ''): string[] {
  if (!root || typeof root !== 'object') return []

  const paths: string[] = []
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    if (SKIP_LEAF_NAMES.has(key)) continue
    const next = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'function') {
      paths.push(next)
      continue
    }
    if (value && typeof value === 'object') {
      paths.push(...collectBridgePaths(value, next))
    }
  }
  return paths.sort()
}

function indentDepth(line: string): number {
  const match = line.match(/^(\s*)/)
  if (!match) return -1
  return Math.max(0, Math.floor(match[1].length / 2) - 1)
}

function extractExposeBlock(source: string): string | null {
  const marker = source.indexOf('contextBridge.exposeInMainWorld')
  if (marker < 0) return null

  // The bridge object may be inline in the call, or held in a named const so
  // the exposure itself can sit behind a frame guard — resolve the const.
  const identifierArg = source
    .slice(marker, marker + 200)
    .match(/exposeInMainWorld\(\s*['"][^'"]+['"]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/)

  let blockStart: number
  if (identifierArg) {
    const escapedName = identifierArg[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const constMatch = new RegExp(`\\bconst\\s+${escapedName}\\s*=\\s*\\{`).exec(source)
    if (!constMatch) return null
    blockStart = constMatch.index + constMatch[0].length - 1
  } else {
    blockStart = source.indexOf('{', marker)
  }
  if (blockStart < 0) return null

  let depth = 0
  for (let i = blockStart; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(blockStart + 1, i)
    }
  }
  return null
}

export function extractPreloadBridgePaths(source: string): string[] {
  const block = extractExposeBlock(source)
  if (!block) return []

  const paths: string[] = []
  const stack: string[] = []

  for (const line of block.split('\n')) {
    // Namespace opens use a trailing `{` on its own line — not inline TS object types.
    const open = line.match(/^\s+(\w+):\s*\{\s*,?\s*$/)
    const leaf = line.match(/^\s+(\w+):\s*(?:\(|async)/)
    const closesNamespace = /^\s+\},?\s*$/.test(line)

    if (open) {
      const depth = indentDepth(line)
      stack.length = depth
      stack.push(open[1])
      continue
    }

    if (leaf) {
      const depth = indentDepth(line)
      const parts = stack.slice(0, depth + 1).filter(Boolean)
      parts.push(leaf[1])
      paths.push(parts.join('.'))
      continue
    }

    if (closesNamespace) {
      const depth = indentDepth(line)
      if (stack.length > depth) stack.length = depth
    }
  }

  return [...new Set(paths)].sort()
}