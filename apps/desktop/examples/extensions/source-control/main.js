// Source Control — main.js (Node.js host process)
// Runs git commands in the current workspace directory.

const { execFile, exec } = require('child_process')
const { promisify } = require('util')
const path = require('path')

const execFileP = promisify(execFile)
const execP = promisify(exec)

let ctx = null
let workdir = null

// ── Git helpers ──────────────────────────────────────────────────────────────

function git(args, opts = {}) {
  return execFileP('git', args, {
    cwd: workdir,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30000,
    ...opts
  })
}

function gitRaw(cmd, opts = {}) {
  return execP(`git ${cmd}`, {
    cwd: workdir,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30000,
    ...opts
  })
}

// ── Status ───────────────────────────────────────────────────────────────────

async function getStatus() {
  const [statusOut, branchOut] = await Promise.all([
    git(['status', '--porcelain=v1', '-uall']),
    git(['branch', '--show-current'])
  ])

  const branch = branchOut.stdout.trim()
  const lines = statusOut.stdout.trim().split('\n').filter(Boolean)
  const staged = []
  const unstaged = []

  for (const line of lines) {
    const x = line[0]  // index status
    const y = line[1]  // worktree status
    const filepath = line.substring(3)

    if (x !== ' ' && x !== '?') {
      staged.push({ path: filepath, status: statusChar(x) })
    }
    if (y !== ' ') {
      unstaged.push({ path: filepath, status: y === '?' ? 'untracked' : statusChar(y) })
    }
  }

  return { branch, staged, unstaged }
}

function statusChar(c) {
  const map = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'unmerged', '?': 'untracked' }
  return map[c] || c
}

// ── Branches ─────────────────────────────────────────────────────────────────

async function getBranches() {
  const { stdout } = await git(['branch', '-a', '--format=%(refname:short)\t%(HEAD)'])
  const branches = []
  let current = ''
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    const [name, head] = line.split('\t')
    branches.push(name)
    if (head === '*') current = name
  }
  return { branches, current }
}

// ── Log / History ────────────────────────────────────────────────────────────

async function getLog(max = 80) {
  // Get log with ref decorations
  const { stdout } = await git([
    'log', '--all', `--max-count=${max}`,
    '--format=%H\x1f%h\x1f%an\x1f%ar\x1f%s\x1f%D\x1f%P',
    '--topo-order'
  ])

  const commits = []
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    const [hash, short, author, date, subject, refs, parents] = line.split('\x1f')
    const refList = refs ? refs.split(',').map(r => r.trim()).filter(Boolean) : []
    commits.push({
      hash, short, author, date, subject,
      refs: refList,
      parents: parents ? parents.split(' ').filter(Boolean) : []
    })
  }

  return commits
}

// ── Stash ────────────────────────────────────────────────────────────────────

async function getStashes() {
  try {
    const { stdout } = await git(['stash', 'list', '--format=%gd\x1f%gs'])
    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [ref, message] = line.split('\x1f')
      return { ref, message }
    })
  } catch { return [] }
}

// ── Diff ─────────────────────────────────────────────────────────────────────

async function getFileDiff(filepath, staged) {
  try {
    const args = staged ? ['diff', '--cached', '--', filepath] : ['diff', '--', filepath]
    const { stdout } = await git(args)
    return stdout
  } catch { return '' }
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

function activate(context) {
  ctx = context
  workdir = ctx.workspacePath || process.cwd()

  ctx.ipc.handle('getStatus', async () => {
    const status = await getStatus()
    return JSON.stringify(status)
  })

  ctx.ipc.handle('getBranches', async () => {
    const data = await getBranches()
    return JSON.stringify(data)
  })

  ctx.ipc.handle('getLog', async (argsStr) => {
    const args = argsStr ? JSON.parse(argsStr) : {}
    const commits = await getLog(args.max || 80)
    return JSON.stringify({ commits })
  })

  ctx.ipc.handle('getStashes', async () => {
    const stashes = await getStashes()
    return JSON.stringify({ stashes })
  })

  ctx.ipc.handle('stageFile', async (argsStr) => {
    const { path: fp } = JSON.parse(argsStr)
    await git(['add', '--', fp])
    return JSON.stringify({ ok: true })
  })

  ctx.ipc.handle('unstageFile', async (argsStr) => {
    const { path: fp } = JSON.parse(argsStr)
    await git(['reset', 'HEAD', '--', fp])
    return JSON.stringify({ ok: true })
  })

  ctx.ipc.handle('stageAll', async () => {
    await git(['add', '-A'])
    return JSON.stringify({ ok: true })
  })

  ctx.ipc.handle('unstageAll', async () => {
    await git(['reset', 'HEAD'])
    return JSON.stringify({ ok: true })
  })

  ctx.ipc.handle('commit', async (argsStr) => {
    const { message } = JSON.parse(argsStr)
    if (!message) throw new Error('Commit message required')
    // Check if there are staged changes
    const { stdout: status } = await git(['diff', '--cached', '--name-only'])
    if (!status.trim()) {
      throw new Error('Nothing staged to commit. Stage files first.')
    }
    await git(['commit', '-m', message])
    return JSON.stringify({ ok: true })
  })

  ctx.ipc.handle('checkoutBranch', async (argsStr) => {
    const { branch } = JSON.parse(argsStr)
    await git(['checkout', branch])
    return JSON.stringify({ ok: true })
  })

  ctx.ipc.handle('createBranch', async (argsStr) => {
    const { name } = JSON.parse(argsStr)
    await git(['checkout', '-b', name])
    return JSON.stringify({ ok: true })
  })

  ctx.ipc.handle('deleteBranch', async (argsStr) => {
    const { branch } = JSON.parse(argsStr)
    await git(['branch', '-d', branch])
    return JSON.stringify({ ok: true })
  })

  ctx.ipc.handle('pull', async () => {
    const { stdout } = await git(['pull'])
    return JSON.stringify({ output: stdout.trim() })
  })

  ctx.ipc.handle('push', async () => {
    const { stdout, stderr } = await git(['push'])
    return JSON.stringify({ output: (stdout + stderr).trim() })
  })

  ctx.ipc.handle('stash', async (argsStr) => {
    const args = argsStr ? JSON.parse(argsStr) : {}
    const cmd = ['stash', 'push']
    if (args.message) cmd.push('-m', args.message)
    await git(cmd)
    return JSON.stringify({ ok: true })
  })

  ctx.ipc.handle('stashPop', async () => {
    await git(['stash', 'pop'])
    return JSON.stringify({ ok: true })
  })

  ctx.ipc.handle('stashDrop', async (argsStr) => {
    const { ref } = JSON.parse(argsStr)
    await git(['stash', 'drop', ref])
    return JSON.stringify({ ok: true })
  })

  ctx.ipc.handle('discard', async (argsStr) => {
    const { path: fp } = JSON.parse(argsStr)
    await git(['checkout', '--', fp])
    return JSON.stringify({ ok: true })
  })

  ctx.ipc.handle('getFileDiff', async (argsStr) => {
    const { path: fp, staged } = JSON.parse(argsStr)
    const diff = await getFileDiff(fp, staged)
    return JSON.stringify({ diff })
  })

  // MCP tools for AI agents
  if (ctx.mcp) {
    ctx.mcp.registerTool({
      name: 'git_status',
      description: 'Get current git status (branch, staged files, unstaged files)',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(await getStatus())
    })

    ctx.mcp.registerTool({
      name: 'git_log',
      description: 'Get git commit history',
      inputSchema: {
        type: 'object',
        properties: { max: { type: 'number', description: 'Max commits to return', default: 40 } }
      },
      handler: async (args) => JSON.stringify(await getLog(args.max || 40))
    })

    ctx.mcp.registerTool({
      name: 'git_branches',
      description: 'List all git branches',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(await getBranches())
    })

    ctx.mcp.registerTool({
      name: 'git_stash_list',
      description: 'List all stashes',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(await getStashes())
    })
  }

  return () => { /* cleanup */ }
}

module.exports = { activate }
