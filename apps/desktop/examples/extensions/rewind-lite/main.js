const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)
const CODESURF_HOME = path.join(os.homedir(), '.codesurf')

function isSafeWorkspacePath(workspacePath) {
  return typeof workspacePath === 'string'
    && workspacePath.trim().length > 1
    && path.isAbsolute(workspacePath)
}

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function runGit(workspacePath, args) {
  try {
    const result = await execFileAsync('git', ['-C', workspacePath].concat(args), {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    })
    return (result.stdout || '').trim()
  } catch {
    return ''
  }
}

async function getGitSummary(workspacePath, commitLimit) {
  const branch = await runGit(workspacePath, ['branch', '--show-current'])
  const statusRaw = await runGit(workspacePath, ['status', '--short'])
  const commitsRaw = await runGit(workspacePath, ['log', '-n', String(commitLimit || 5), '--pretty=format:%h %s'])
  const dirtyFiles = statusRaw
    ? statusRaw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    : []
  const commits = commitsRaw
    ? commitsRaw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    : []

  return {
    isRepo: Boolean(branch || statusRaw || commitsRaw),
    branch: branch || null,
    dirtyCount: dirtyFiles.length,
    dirtyFiles,
    commits,
  }
}

async function getCanvasSummary(workspaceId) {
  if (!workspaceId) {
    return {
      storagePath: null,
      tileCount: 0,
      tileTypes: [],
      groupCount: 0,
    }
  }

  const canvasPath = path.join(CODESURF_HOME, 'workspaces', String(workspaceId), '.codesurf', 'canvas-state.json')
  const state = await readJson(canvasPath)
  const tiles = Array.isArray(state && state.tiles) ? state.tiles : []
  const tileCounts = new Map()
  let groupCount = 0

  tiles.forEach(tile => {
    const type = tile && typeof tile.type === 'string' ? tile.type : 'unknown'
    tileCounts.set(type, (tileCounts.get(type) || 0) + 1)
    if (tile && (tile.type === 'group' || tile.groupId)) groupCount += 1
  })

  return {
    storagePath: canvasPath,
    tileCount: tiles.length,
    tileTypes: Array.from(tileCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count })),
    groupCount,
  }
}

async function getProjectSummary(workspacePath) {
  const packageJsonPath = path.join(workspacePath, 'package.json')
  const packageJson = await readJson(packageJsonPath)
  const readmeExists = await exists(path.join(workspacePath, 'README.md'))
  const entries = await fs.readdir(workspacePath, { withFileTypes: true }).catch(() => [])
  const topLevel = entries
    .map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'dir' : 'file' }))
    .filter(entry => !entry.name.startsWith('.'))
    .slice(0, 12)

  return {
    packageJsonPath,
    packageName: packageJson && typeof packageJson.name === 'string' ? packageJson.name : null,
    packageVersion: packageJson && typeof packageJson.version === 'string' ? packageJson.version : null,
    scriptCount: packageJson && packageJson.scripts && typeof packageJson.scripts === 'object'
      ? Object.keys(packageJson.scripts).length
      : 0,
    hasReadme: readmeExists,
    topLevel,
  }
}

function formatDigest(snapshot) {
  const lines = []
  lines.push('# Rewind Lite')
  lines.push('')
  lines.push(`Workspace: ${snapshot.workspaceName}`)
  lines.push(`Path: ${snapshot.workspacePath}`)
  if (snapshot.project.packageName) {
    lines.push(`Package: ${snapshot.project.packageName}${snapshot.project.packageVersion ? ' v' + snapshot.project.packageVersion : ''}`)
  }
  if (snapshot.git.isRepo) {
    lines.push(`Branch: ${snapshot.git.branch || 'detached'}`)
    lines.push(`Dirty files: ${snapshot.git.dirtyCount}`)
  } else {
    lines.push('Git: not detected')
  }
  lines.push(`Canvas tiles: ${snapshot.canvas.tileCount}`)
  lines.push('')

  if (snapshot.git.dirtyFiles.length > 0) {
    lines.push('## Dirty Files')
    snapshot.git.dirtyFiles.slice(0, 8).forEach(line => lines.push('- ' + line))
    lines.push('')
  }

  if (snapshot.git.commits.length > 0) {
    lines.push('## Recent Commits')
    snapshot.git.commits.forEach(line => lines.push('- ' + line))
    lines.push('')
  }

  if (snapshot.canvas.tileTypes.length > 0) {
    lines.push('## Canvas Shape')
    snapshot.canvas.tileTypes.slice(0, 8).forEach(item => lines.push(`- ${item.type}: ${item.count}`))
    lines.push('')
  }

  if (snapshot.project.topLevel.length > 0) {
    lines.push('## Top Level')
    snapshot.project.topLevel.forEach(item => lines.push(`- ${item.kind === 'dir' ? '[dir]' : '[file]'} ${item.name}`))
    lines.push('')
  }

  lines.push(`Generated: ${new Date(snapshot.generatedAt).toLocaleString()}`)
  return lines.join('\n').trim()
}

async function buildSnapshot(workspacePath, workspaceId, options) {
  if (!isSafeWorkspacePath(workspacePath)) {
    throw new Error('Expected an absolute workspacePath')
  }
  const stat = await fs.stat(workspacePath).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    throw new Error('Workspace path does not exist')
  }

  const commitLimit = Math.max(1, Math.min(12, Number(options && options.commitLimit) || 5))
  const [project, git, canvas] = await Promise.all([
    getProjectSummary(workspacePath),
    getGitSummary(workspacePath, commitLimit),
    getCanvasSummary(workspaceId),
  ])

  return {
    workspacePath,
    workspaceId: workspaceId || '',
    workspaceName: path.basename(workspacePath),
    commitLimit,
    project,
    git,
    canvas,
    generatedAt: Date.now(),
  }
}

module.exports = {
  activate(ctx) {
    ctx.log('Rewind Lite activated')

    ctx.ipc.handle('snapshot', async (workspacePath, workspaceId, options) => {
      const snapshot = await buildSnapshot(workspacePath, workspaceId, options || {})
      return {
        snapshot,
        digest: formatDigest(snapshot),
      }
    })

    ctx.ipc.handle('digest', async (workspacePath, workspaceId, options) => {
      const snapshot = await buildSnapshot(workspacePath, workspaceId, options || {})
      return formatDigest(snapshot)
    })

    ctx.mcp.registerTool({
      name: 'rewind_lite_digest',
      description: 'Generate a concise rewind digest for a CodeSurf workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          workspacePath: { type: 'string' },
          workspaceId: { type: 'string' },
          commitLimit: { type: 'number' },
        },
        required: ['workspacePath'],
      },
      handler: async (args) => {
        const snapshot = await buildSnapshot(args.workspacePath, args.workspaceId, args)
        return formatDigest(snapshot)
      },
    })

    return () => {
      ctx.log('Rewind Lite deactivated')
    }
  },
}
