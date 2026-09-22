const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const DEFAULT_MAX_FILES = 1200
const HARD_MAX_FILES = 5000
const MAX_FILE_BYTES_FOR_IMPORTS = 256 * 1024
const APP_HOME = process.env.CODESURF_HOME || path.join(os.homedir(), '.codesurf')

const EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn',
  'node_modules', '.next', '.nuxt', '.turbo', '.cache', '.vite',
  'dist', 'build', 'out', 'coverage', '.nyc_output',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  'DerivedData', '.build', 'target', 'vendor',
])

const LANGUAGE_BY_EXT = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript React',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript React',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.json': 'JSON',
  '.md': 'Markdown',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
  '.java': 'Java',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.html': 'HTML',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.yml': 'YAML',
  '.yaml': 'YAML',
  '.toml': 'TOML',
  '.sql': 'SQL',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.zsh': 'Shell',
}

const IMPORT_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']

const repoMaps = new Map()
let bus = null

function isSafeWorkspacePath(workspacePath) {
  return typeof workspacePath === 'string'
    && workspacePath.trim().length > 1
    && path.isAbsolute(workspacePath)
}

async function assertWorkspace(workspacePath) {
  if (!isSafeWorkspacePath(workspacePath)) throw new Error('Expected an absolute workspacePath')
  const stat = await fs.stat(workspacePath).catch(() => null)
  if (!stat || !stat.isDirectory()) throw new Error('Workspace path does not exist')
}

function workspaceKey(workspacePath) {
  return crypto.createHash('sha1').update(path.resolve(workspacePath)).digest('hex')
}

function workspaceStoreDir(workspacePath) {
  return path.join(APP_HOME, 'code-index', workspaceKey(workspacePath))
}

function normalizeRelativePath(value) {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('Expected a path')
  const normalized = raw.replace(/\\/g, '/')
  const withoutPrefix = normalized.replace(/^\.\//, '')
  const collapsed = path.posix.normalize(withoutPrefix)
  if (!collapsed || collapsed === '.' || collapsed.startsWith('../') || collapsed === '..' || path.isAbsolute(collapsed)) {
    throw new Error('Path must stay inside the workspace')
  }
  return collapsed
}

function ensureInsideWorkspace(workspacePath, relPath) {
  const resolved = path.resolve(workspacePath, relPath)
  const root = path.resolve(workspacePath)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('Path escapes workspace')
  return resolved
}

function toRepoPath(workspacePath, absolutePath) {
  return path.relative(workspacePath, absolutePath).split(path.sep).join('/')
}

function languageForPath(filePath) {
  const base = path.basename(filePath).toLowerCase()
  if (base === 'dockerfile') return 'Dockerfile'
  if (base === 'makefile') return 'Makefile'
  return LANGUAGE_BY_EXT[path.extname(base)] || 'Other'
}

function shouldSkipDir(name) {
  return EXCLUDED_DIRS.has(name) || name.startsWith('.pnpm')
}

function classifyImportance(repoPath) {
  const lower = repoPath.toLowerCase()
  if (/^(package|bun\.lock|pnpm-lock|yarn\.lock|package-lock)\b/.test(lower)) return 95
  if (/^(agents|claude|readme|contributing|license)\.md$/.test(lower)) return 90
  if (/^(electron\.vite\.config|vite\.config|tsconfig|eslint\.config|tailwind\.config)/.test(lower)) return 82
  if (lower.includes('/ipc/') || lower.includes('/mcp') || lower.includes('/event-bus')) return 78
  if (lower.startsWith('src/main/') || lower.startsWith('src/preload/') || lower.startsWith('src/renderer/')) return 72
  if (lower.includes('/test/') || lower.startsWith('test/')) return 58
  return 0
}

async function walkWorkspace(workspacePath, options = {}) {
  const maxFiles = Math.max(1, Math.min(HARD_MAX_FILES, Number(options.maxFiles) || DEFAULT_MAX_FILES))
  const files = []
  const directories = new Map()
  const languageCounts = new Map()
  let skippedFiles = 0
  let truncated = false

  async function visit(absDir, relDir) {
    if (files.length >= maxFiles) {
      truncated = true
      return
    }

    let entries = []
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))
    const dirInfo = directories.get(relDir || '.') || { path: relDir || '.', fileCount: 0, dirCount: 0, size: 0 }
    directories.set(relDir || '.', dirInfo)

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const childAbs = path.join(absDir, entry.name)
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue
        dirInfo.dirCount += 1
        await visit(childAbs, childRel)
        continue
      }

      if (!entry.isFile()) continue
      if (files.length >= maxFiles) {
        skippedFiles += 1
        truncated = true
        continue
      }

      const stat = await fs.stat(childAbs).catch(() => null)
      if (!stat || !stat.isFile()) continue
      const language = languageForPath(childRel)
      const fileInfo = {
        path: childRel,
        name: entry.name,
        dir: relDir || '.',
        ext: path.extname(entry.name).toLowerCase(),
        language,
        size: stat.size,
        mtimeMs: Math.floor(stat.mtimeMs),
        importance: classifyImportance(childRel),
      }
      files.push(fileInfo)
      dirInfo.fileCount += 1
      dirInfo.size += stat.size
      languageCounts.set(language, (languageCounts.get(language) || 0) + 1)
    }
  }

  await visit(workspacePath, '')
  return {
    files,
    directories: Array.from(directories.values()).sort((a, b) => a.path.localeCompare(b.path)),
    languageCounts: Object.fromEntries(Array.from(languageCounts.entries()).sort((a, b) => b[1] - a[1])),
    skippedFiles,
    truncated,
    maxFiles,
  }
}

function extractImportsFromText(text) {
  const imports = []
  const patterns = [
    /import\s+(?:type\s+)?(?:[^'";]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /export\s+(?:[^'";]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(text))) imports.push(match[1])
  }
  return imports
}

function resolveImport(fromPath, specifier, fileSet) {
  if (!specifier || !specifier.startsWith('.')) return null
  const baseDir = path.posix.dirname(fromPath)
  const targetBase = path.posix.normalize(path.posix.join(baseDir, specifier))
  for (const ext of IMPORT_EXTENSIONS) {
    const candidate = targetBase + ext
    if (fileSet.has(candidate)) return candidate
  }
  return null
}

async function buildDependencyEdges(workspacePath, files) {
  const fileSet = new Set(files.map(file => file.path))
  const edges = []
  for (const file of files) {
    if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(file.ext)) continue
    if (file.size > MAX_FILE_BYTES_FOR_IMPORTS) continue
    const abs = path.join(workspacePath, file.path)
    const text = await fs.readFile(abs, 'utf8').catch(() => '')
    if (!text) continue
    const seen = new Set()
    for (const specifier of extractImportsFromText(text)) {
      const resolved = resolveImport(file.path, specifier, fileSet)
      if (!resolved || seen.has(resolved)) continue
      seen.add(resolved)
      edges.push({ from: file.path, to: resolved, kind: 'import' })
    }
  }
  return edges.slice(0, 1200)
}

function buildGraphStats(files, edges) {
  const degree = new Map()
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1)
  }
  return {
    nodeCount: files.length,
    edgeCount: edges.length,
    centralFiles: Array.from(degree.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([pathName, count]) => ({ path: pathName, edgeCount: count })),
  }
}

function topDirectories(files) {
  const counts = new Map()
  for (const file of files) {
    const first = file.path.includes('/') ? file.path.split('/')[0] : '.'
    counts.set(first, (counts.get(first) || 0) + 1)
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([pathName, fileCount]) => ({ path: pathName, fileCount }))
}

async function readPins(workspacePath) {
  const pinsPath = path.join(workspaceStoreDir(workspacePath), 'pins.json')
  try {
    const raw = await fs.readFile(pinsPath, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.pins) ? parsed.pins : []
  } catch {
    return []
  }
}

async function writePins(workspacePath, pins) {
  const dir = workspaceStoreDir(workspacePath)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'pins.json'), JSON.stringify({ version: 1, pins }, null, 2), 'utf8')
}

async function scanWorkspace(workspacePath, options = {}) {
  await assertWorkspace(workspacePath)
  const root = path.resolve(workspacePath)
  const walked = await walkWorkspace(root, options)
  const edges = await buildDependencyEdges(root, walked.files)
  const pins = await readPins(root)
  const importantFiles = walked.files
    .filter(file => file.importance > 0)
    .sort((a, b) => b.importance - a.importance || a.path.localeCompare(b.path))
    .slice(0, 24)

  const repoMap = {
    workspacePath: root,
    workspaceName: path.basename(root),
    scannedAt: Date.now(),
    summary: {
      fileCount: walked.files.length,
      dirCount: walked.directories.length,
      edgeCount: edges.length,
      languages: walked.languageCounts,
      truncated: walked.truncated,
      skippedFiles: walked.skippedFiles,
      maxFiles: walked.maxFiles,
    },
    topDirectories: topDirectories(walked.files),
    importantFiles,
    files: walked.files,
    edges,
    graph: buildGraphStats(walked.files, edges),
    pins,
  }
  repoMap.markdown = formatRepoMapMarkdown(repoMap)
  repoMaps.set(root, repoMap)
  publishContext(root, repoMap)
  return repoMap
}

async function getRepoMap(workspacePath, options = {}) {
  await assertWorkspace(workspacePath)
  const root = path.resolve(workspacePath)
  const existing = repoMaps.get(root)
  if (existing) return existing
  return scanWorkspace(root, options)
}

function searchInMap(repoMap, query, limit = 25) {
  const q = String(query || '').trim().toLowerCase()
  const capped = Math.max(1, Math.min(100, Number(limit) || 25))
  if (!q) return []
  return repoMap.files
    .map(file => {
      const pathLower = file.path.toLowerCase()
      const nameLower = file.name.toLowerCase()
      let score = 0
      if (pathLower === q) score += 100
      if (nameLower === q) score += 80
      if (pathLower.includes(q)) score += 40
      if (nameLower.includes(q)) score += 25
      score += Math.min(20, file.importance / 5)
      return { ...file, score }
    })
    .filter(file => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, capped)
}

async function searchFiles(workspacePath, query, limit) {
  const repoMap = await getRepoMap(workspacePath)
  return searchInMap(repoMap, query, limit)
}

async function pinContext(workspacePath, pin) {
  await assertWorkspace(workspacePath)
  const root = path.resolve(workspacePath)
  const relPath = normalizeRelativePath(pin && pin.path)
  ensureInsideWorkspace(root, relPath)
  const pins = await readPins(root)
  const existing = pins.find(entry => entry.path === relPath)
  const nextPin = {
    path: relPath,
    label: String((pin && pin.label) || path.basename(relPath)).trim(),
    note: String((pin && pin.note) || '').trim(),
    pinnedAt: existing ? existing.pinnedAt : Date.now(),
    updatedAt: Date.now(),
  }
  const next = pins.filter(entry => entry.path !== relPath).concat(nextPin).sort((a, b) => a.path.localeCompare(b.path))
  await writePins(root, next)
  const repoMap = repoMaps.get(root)
  if (repoMap) {
    repoMap.pins = next
    repoMap.markdown = formatRepoMapMarkdown(repoMap)
  }
  publishPins(root, next)
  return nextPin
}

async function unpinContext(workspacePath, relPath) {
  await assertWorkspace(workspacePath)
  const root = path.resolve(workspacePath)
  const normalized = normalizeRelativePath(relPath)
  const pins = await readPins(root)
  const next = pins.filter(entry => entry.path !== normalized)
  await writePins(root, next)
  const repoMap = repoMaps.get(root)
  if (repoMap) {
    repoMap.pins = next
    repoMap.markdown = formatRepoMapMarkdown(repoMap)
  }
  publishPins(root, next)
  return { removed: pins.length !== next.length, pins: next }
}

async function listPins(workspacePath) {
  await assertWorkspace(workspacePath)
  return readPins(path.resolve(workspacePath))
}

function publishContext(workspacePath, repoMap) {
  if (!bus) return
  bus.publish('ctx:code-index:repo_map', 'code_index.repo_map.updated', {
    workspacePath,
    summary: repoMap.summary,
    topDirectories: repoMap.topDirectories,
    importantFiles: repoMap.importantFiles,
    graph: repoMap.graph,
    pins: repoMap.pins,
    markdown: repoMap.markdown,
  })
  publishPins(workspacePath, repoMap.pins)
}

function publishPins(workspacePath, pins) {
  if (!bus) return
  bus.publish('ctx:code-index:pins', 'code_index.pins.updated', { workspacePath, pins })
}

function formatRepoMapMarkdown(repoMap) {
  const lines = []
  lines.push('# Context Map')
  lines.push('')
  lines.push(`Workspace: ${repoMap.workspaceName}`)
  lines.push(`Path: ${repoMap.workspacePath}`)
  lines.push(`Files: ${repoMap.summary.fileCount}${repoMap.summary.truncated ? ` (truncated at ${repoMap.summary.maxFiles})` : ''}`)
  lines.push(`Dependency edges: ${repoMap.summary.edgeCount}`)
  lines.push('')

  const languages = Object.entries(repoMap.summary.languages || {}).slice(0, 10)
  if (languages.length) {
    lines.push('## Languages')
    languages.forEach(([language, count]) => lines.push(`- ${language}: ${count}`))
    lines.push('')
  }

  if (repoMap.topDirectories.length) {
    lines.push('## Top Directories')
    repoMap.topDirectories.forEach(item => lines.push(`- ${item.path}: ${item.fileCount} files`))
    lines.push('')
  }

  if (repoMap.importantFiles.length) {
    lines.push('## Important Files')
    repoMap.importantFiles.slice(0, 16).forEach(file => lines.push(`- ${file.path} (${file.language})`))
    lines.push('')
  }

  if (repoMap.graph.centralFiles.length) {
    lines.push('## Central Files')
    repoMap.graph.centralFiles.slice(0, 12).forEach(file => lines.push(`- ${file.path}: ${file.edgeCount} edges`))
    lines.push('')
  }

  if (repoMap.pins.length) {
    lines.push('## Context Pins')
    repoMap.pins.forEach(pin => lines.push(`- ${pin.path}${pin.note ? ` — ${pin.note}` : ''}`))
    lines.push('')
  }

  lines.push(`Generated: ${new Date(repoMap.scannedAt).toLocaleString()}`)
  return lines.join('\n').trim()
}

function formatSearchMarkdown(query, results) {
  const lines = [`# Context Map Search`, '', `Query: ${query}`, '']
  if (!results.length) {
    lines.push('No matching files.')
  } else {
    results.forEach(file => lines.push(`- ${file.path} (${file.language}, score ${Math.round(file.score)})`))
  }
  return lines.join('\n')
}

module.exports = {
  activate(ctx) {
    bus = ctx.bus
    ctx.log('Context Map activated')

    ctx.ipc.handle('scanWorkspace', async (workspacePath, options) => scanWorkspace(String(workspacePath || ''), options || {}))
    ctx.ipc.handle('getRepoMap', async (workspacePath, options) => getRepoMap(String(workspacePath || ''), options || {}))
    ctx.ipc.handle('searchFiles', async (workspacePath, query, limit) => searchFiles(String(workspacePath || ''), String(query || ''), limit))
    ctx.ipc.handle('pinContext', async (workspacePath, pin) => pinContext(String(workspacePath || ''), pin || {}))
    ctx.ipc.handle('unpinContext', async (workspacePath, relPath) => unpinContext(String(workspacePath || ''), relPath))
    ctx.ipc.handle('listPins', async (workspacePath) => listPins(String(workspacePath || '')))

    ctx.mcp.registerTool({
      name: 'repo_map',
      description: 'Return a concise markdown Context Map for a workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          workspacePath: { type: 'string' },
          maxFiles: { type: 'number' },
        },
        required: ['workspacePath'],
      },
      handler: async (args) => (await scanWorkspace(String(args.workspacePath || ''), { maxFiles: args.maxFiles })).markdown,
    })

    ctx.mcp.registerTool({
      name: 'search_files',
      description: 'Search files from the Context Map cache.',
      inputSchema: {
        type: 'object',
        properties: {
          workspacePath: { type: 'string' },
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['workspacePath', 'query'],
      },
      handler: async (args) => formatSearchMarkdown(String(args.query || ''), await searchFiles(String(args.workspacePath || ''), String(args.query || ''), args.limit)),
    })

    ctx.mcp.registerTool({
      name: 'pins',
      description: 'List context pins for a workspace.',
      inputSchema: {
        type: 'object',
        properties: { workspacePath: { type: 'string' } },
        required: ['workspacePath'],
      },
      handler: async (args) => {
        const pins = await listPins(String(args.workspacePath || ''))
        return pins.length ? pins.map(pin => `- ${pin.path}${pin.note ? ` — ${pin.note}` : ''}`).join('\n') : 'No context pins.'
      },
    })

    ctx.mcp.registerTool({
      name: 'pin',
      description: 'Pin a workspace path as durable context.',
      inputSchema: {
        type: 'object',
        properties: {
          workspacePath: { type: 'string' },
          path: { type: 'string' },
          label: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['workspacePath', 'path'],
      },
      handler: async (args) => {
        const pin = await pinContext(String(args.workspacePath || ''), args)
        return `Pinned ${pin.path}`
      },
    })

    ctx.mcp.registerTool({
      name: 'unpin',
      description: 'Remove a context pin.',
      inputSchema: {
        type: 'object',
        properties: {
          workspacePath: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['workspacePath', 'path'],
      },
      handler: async (args) => {
        const result = await unpinContext(String(args.workspacePath || ''), String(args.path || ''))
        return result.removed ? `Unpinned ${args.path}` : `No pin found for ${args.path}`
      },
    })

    return () => { bus = null }
  },
  __testing: {
    classifyImportance,
    extractImportsFromText,
    formatRepoMapMarkdown,
    isSafeWorkspacePath,
    languageForPath,
    normalizeRelativePath,
    scanWorkspace,
    searchInMap,
    searchFiles,
    pinContext,
    unpinContext,
    listPins,
    workspaceKey,
  },
}
