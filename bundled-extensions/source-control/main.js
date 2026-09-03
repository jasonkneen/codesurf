'use strict'

const fs = require('fs/promises')
const path = require('path')
const { execFile } = require('child_process')

const MAX_BUFFER = 12 * 1024 * 1024
const GIT_TIMEOUT_MS = 30000
const DEFAULT_LOG_LIMIT = 80
const DEFAULT_DIFF_LIMIT = 80000
const MAX_GRAPH_COFANOUT = 140

let bus = null

function isAbsoluteWorkspacePath(value) {
  return typeof value === 'string' && value.trim().length > 1 && path.isAbsolute(value)
}

async function assertDirectory(workspacePath) {
  if (!isAbsoluteWorkspacePath(workspacePath)) throw new Error('Expected an absolute workspacePath')
  const stat = await fs.stat(workspacePath).catch(() => null)
  if (!stat || !stat.isDirectory()) throw new Error('workspacePath does not exist or is not a directory')
}

function runGit(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args.map(String), {
      cwd,
      maxBuffer: options.maxBuffer || MAX_BUFFER,
      timeout: options.timeout || GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

async function tryGit(cwd, args, fallback = '') {
  try {
    return (await runGit(cwd, args)).stdout
  } catch {
    return fallback
  }
}

async function resolveGitRoot(workspacePath) {
  await assertDirectory(workspacePath)
  const { stdout } = await runGit(workspacePath, ['rev-parse', '--show-toplevel'])
  return stdout.trim()
}

/**
 * Normalize a user/agent-supplied git ref.
 *
 * The leading-dash rejection is a security control, not tidiness. Refs are
 * interpolated into a single positional argv entry (`${base}...${head}`) and
 * handed to `git diff`, which still parses options there. execFile blocks
 * SHELL injection but not ARGUMENT injection, so `baseRef =
 * "--output=/path/to/file"` made git create/truncate that file. This is
 * reachable by a model, not just a user: `baseRef` is a required agent-supplied
 * field on the branch_compare MCP tool.
 *
 * Callers additionally pass '--end-of-options' before revision arguments.
 */
function normalizeRef(value, fallback) {
  const ref = String(value || '').trim()
  if (!ref) return fallback
  if (ref.startsWith('-')) throw new Error('Invalid ref: must not start with "-"')
  if (/[\0\n\r]/.test(ref)) throw new Error('Invalid ref: control characters are not allowed')
  return ref
}

/**
 * Validate a stash ref. Same argument-injection reasoning as normalizeRef:
 * this reaches `git stash apply/drop`, so an option-shaped value must not get
 * through. Accepts the only form the UI emits (`stash@{N}`) plus a bare index.
 * Returns '' when absent, meaning "let git use its default".
 */
function normalizeStashRef(value) {
  const ref = String(value == null ? '' : value).trim()
  if (!ref) return ''
  if (!/^(?:stash@\{\d+\}|\d+)$/.test(ref)) throw new Error('Invalid stash ref')
  return /^\d+$/.test(ref) ? `stash@{${ref}}` : ref
}

/** Is this repo-relative path tracked by git? Used to route discard. */
async function isTrackedPath(root, relPath) {
  try {
    await runGit(root, ['ls-files', '--error-unmatch', '--', relPath])
    return true
  } catch {
    return false
  }
}

function normalizeRepoPath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/')
  const normalized = path.posix.normalize(raw.replace(/^\.\//, ''))
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..' || path.isAbsolute(normalized)) {
    throw new Error('Path must stay inside the workspace')
  }
  return normalized
}

function truncate(value, limit = DEFAULT_DIFF_LIMIT) {
  const text = String(value || '')
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n\n… truncated ${text.length - limit} characters …`
}

function statusName(code) {
  return {
    M: 'modified',
    A: 'added',
    D: 'deleted',
    R: 'renamed',
    C: 'copied',
    U: 'unmerged',
    '?': 'untracked',
    '!': 'ignored',
  }[code] || code || 'unknown'
}

/**
 * Parse `git status --porcelain=v1 -b -uall -z` output.
 *
 * -z is required, not cosmetic. Without it git C-quotes any "unusual" pathname
 * (default core.quotePath=true quotes every byte >= 0x80 plus " and \), so
 * `café.txt` arrives as the literal 12-char string `"caf\303\251.txt"`. That
 * string then round-trips back into `git add -- '"caf\303\251.txt"'`, which
 * matches nothing — every stage/unstage/discard silently failed for non-ASCII
 * filenames. With -z, records are NUL-terminated and paths are never quoted.
 *
 * Record grammar under -z:
 *   `## <branch info>\0`            (header, present because of -b)
 *   `XY <path>\0`                   (ordinary entry)
 *   `XY <newpath>\0<oldpath>\0`     (rename/copy — origin is its OWN record)
 *
 * Note the rename form differs from the newline format's `old -> new`; the
 * origin path follows as a separate field, which is why this walks an index
 * rather than mapping over lines.
 */
function parseStatusPorcelain(stdout) {
  const records = String(stdout || '').split('\0')
  if (records.length && records[records.length - 1] === '') records.pop()
  const header = records.find(record => record.startsWith('## ')) || ''
  const changes = []

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (!record || record.startsWith('## ')) continue
    const x = record[0]
    const y = record[1]
    const filePath = record.slice(3)
    // Rename/copy entries carry their origin path in the following record.
    let oldPath
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const origin = records[i + 1]
      if (typeof origin === 'string' && origin !== '' && !origin.startsWith('## ')) {
        oldPath = origin
        i += 1
      }
    }
    changes.push({
      path: filePath,
      ...(oldPath ? { oldPath } : {}),
      index: x,
      workingTree: y,
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' ',
      status: x === '?' ? 'untracked' : statusName(y !== ' ' ? y : x),
      stagedStatus: x !== ' ' && x !== '?' ? statusName(x) : null,
      unstagedStatus: y !== ' ' ? statusName(y) : null,
    })
  }

  return {
    header,
    changes,
    staged: changes.filter(change => change.staged),
    unstaged: changes.filter(change => change.unstaged || change.index === '?'),
    dirty: changes.length > 0,
  }
}

function parseBranches(stdout) {
  return stdout.split('\n').filter(Boolean).map(line => {
    const [name, head, upstream, date] = line.split('\x1f')
    return {
      name,
      current: head === '*',
      upstream: upstream || null,
      lastCommitRelative: date || null,
      remote: name.startsWith('remotes/') || name.startsWith('origin/') || name.startsWith('upstream/'),
    }
  }).filter(branch => branch.name && !branch.name.endsWith('/HEAD'))
}

function parseLog(stdout) {
  return stdout.split('\n').filter(Boolean).map(line => {
    const [hash, short, author, relativeDate, subject, refs, parents] = line.split('\x1f')
    return {
      hash,
      short,
      author,
      relativeDate,
      subject,
      refs: refs ? refs.split(',').map(ref => ref.trim()).filter(Boolean) : [],
      parents: parents ? parents.split(' ').filter(Boolean) : [],
    }
  })
}

function normalizeRenamePath(value) {
  const raw = String(value || '')
  const braceMatch = raw.match(/^(.*)\{(.+) => (.+)\}(.*)$/)
  if (braceMatch) return `${braceMatch[1]}${braceMatch[3]}${braceMatch[4]}`
  return raw.replace(/.* => /, '')
}

function parseNameStatus(stdout) {
  return stdout.split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t')
    const rawStatus = parts[0] || ''
    const status = rawStatus[0]
    if (status === 'R' || status === 'C') {
      return {
        path: parts[2] || parts[1] || '',
        oldPath: parts[1] || undefined,
        status: statusName(status),
        statusCode: status,
      }
    }
    return {
      path: parts[1] || '',
      status: statusName(status),
      statusCode: status,
    }
  }).filter(file => file.path)
}

function parseNumstat(stdout) {
  const map = new Map()
  for (const line of stdout.split('\n').filter(Boolean)) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const additions = parts[0] === '-' ? 0 : Number(parts[0]) || 0
    const deletions = parts[1] === '-' ? 0 : Number(parts[1]) || 0
    const filePath = normalizeRenamePath(parts.slice(2).join('\t'))
    map.set(filePath, { additions, deletions })
  }
  return map
}

async function getCurrentBranch(root) {
  const branch = (await tryGit(root, ['branch', '--show-current'])).trim()
  if (branch) return branch
  return (await tryGit(root, ['rev-parse', '--short', 'HEAD'], 'detached')).trim() || 'detached'
}

async function getDefaultBaseRef(root) {
  const upstream = (await tryGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim()
  if (upstream) return upstream
  const originHead = (await tryGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim().replace(/^origin\//, 'origin/')
  if (originHead) return originHead
  const hasMain = (await tryGit(root, ['rev-parse', '--verify', '--quiet', 'main'], '')).trim()
  if (hasMain) return 'main'
  const hasMaster = (await tryGit(root, ['rev-parse', '--verify', '--quiet', 'master'], '')).trim()
  if (hasMaster) return 'master'
  const hasParent = (await tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD~1'], '')).trim()
  return hasParent ? 'HEAD~1' : 'HEAD'
}

async function getAheadBehind(root, baseRef, headRef) {
  const stdout = await tryGit(root, ['rev-list', '--left-right', '--count', '--end-of-options', `${baseRef}...${headRef}`], '0\t0')
  const [behind, ahead] = stdout.trim().split(/\s+/).map(value => Number(value) || 0)
  return { ahead, behind }
}

async function getStatus(root) {
  // -z: NUL-terminated records, never C-quoted. See parseStatusPorcelain.
  const stdout = await tryGit(root, ['status', '--porcelain=v1', '-b', '-uall', '-z'], '')
  return parseStatusPorcelain(stdout)
}

async function getBranches(root) {
  const stdout = await tryGit(root, ['branch', '-a', '--format=%(refname:short)%x1f%(HEAD)%x1f%(upstream:short)%x1f%(committerdate:relative)'], '')
  return parseBranches(stdout)
}

async function getRecentLog(root, max = DEFAULT_LOG_LIMIT) {
  const limit = Math.max(1, Math.min(200, Number(max) || DEFAULT_LOG_LIMIT))
  const stdout = await tryGit(root, ['log', '--all', `--max-count=${limit}`, '--topo-order', '--format=%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1f%D%x1f%P'], '')
  return parseLog(stdout)
}

async function getRangeCommits(root, baseRef, headRef, max = DEFAULT_LOG_LIMIT) {
  const limit = Math.max(1, Math.min(200, Number(max) || DEFAULT_LOG_LIMIT))
  const stdout = await tryGit(root, ['log', `--max-count=${limit}`, '--topo-order', '--format=%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1f%D%x1f%P', '--end-of-options', `${baseRef}..${headRef}`], '')
  return parseLog(stdout)
}

async function getCommitTouchedFiles(root, baseRef, headRef) {
  const stdout = await tryGit(root, ['log', '--name-only', '--format=commit:%H', '--end-of-options', `${baseRef}..${headRef}`], '')
  const commits = []
  let current = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('commit:')) {
      if (current) commits.push(current)
      current = { hash: line.slice('commit:'.length), files: [] }
      continue
    }
    const trimmed = line.trim()
    if (trimmed && current) current.files.push(trimmed)
  }
  if (current) commits.push(current)
  return commits
}

async function getChangedFiles(root, baseRef, headRef) {
  const [nameStatusOut, numstatOut] = await Promise.all([
    tryGit(root, ['diff', '--name-status', '--find-renames', '--end-of-options', `${baseRef}...${headRef}`], ''),
    tryGit(root, ['diff', '--numstat', '--find-renames', '--end-of-options', `${baseRef}...${headRef}`], ''),
  ])
  const stats = parseNumstat(numstatOut)
  return parseNameStatus(nameStatusOut).map(file => ({
    ...file,
    additions: (stats.get(file.path) || {}).additions || 0,
    deletions: (stats.get(file.path) || {}).deletions || 0,
    directory: file.path.includes('/') ? file.path.split('/')[0] : '.',
  }))
}

function buildChangedFileGraph(files, commitTouches = []) {
  const nodes = []
  const edges = []
  const nodeIds = new Set()
  const addNode = node => {
    if (nodeIds.has(node.id)) return
    nodeIds.add(node.id)
    nodes.push(node)
  }

  for (const file of files) {
    const dir = file.directory || '.'
    const dirId = `dir:${dir}`
    const fileId = `file:${file.path}`
    addNode({ id: dirId, type: 'directory', label: dir, path: dir })
    addNode({
      id: fileId,
      type: 'file',
      label: path.posix.basename(file.path),
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    })
    edges.push({ from: dirId, to: fileId, type: 'contains' })
  }

  const cochange = new Map()
  for (const commit of commitTouches) {
    const touched = Array.from(new Set((commit.files || []).filter(file => files.some(changed => changed.path === file)))).sort()
    for (let i = 0; i < touched.length; i += 1) {
      for (let j = i + 1; j < touched.length; j += 1) {
        const key = `${touched[i]}\x1f${touched[j]}`
        cochange.set(key, (cochange.get(key) || 0) + 1)
      }
    }
  }

  Array.from(cochange.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_GRAPH_COFANOUT)
    .forEach(([key, weight]) => {
      const [from, to] = key.split('\x1f')
      edges.push({ from: `file:${from}`, to: `file:${to}`, type: 'cochange', weight })
    })

  const centralFiles = files
    .map(file => {
      const edgeCount = edges.filter(edge => edge.from === `file:${file.path}` || edge.to === `file:${file.path}`).length
      return { path: file.path, edgeCount, additions: file.additions, deletions: file.deletions, status: file.status }
    })
    .sort((a, b) => b.edgeCount - a.edgeCount || (b.additions + b.deletions) - (a.additions + a.deletions))
    .slice(0, 20)

  const directories = Array.from(new Set(files.map(file => file.directory || '.')))
    .map(dir => ({ path: dir, fileCount: files.filter(file => (file.directory || '.') === dir).length }))
    .sort((a, b) => b.fileCount - a.fileCount || a.path.localeCompare(b.path))

  return { nodes, edges, centralFiles, directories }
}

async function compareBranches(workspacePath, options = {}) {
  const root = await resolveGitRoot(workspacePath)
  const currentBranch = await getCurrentBranch(root)
  const defaultBaseRef = await getDefaultBaseRef(root)
  const baseRef = normalizeRef(options.baseRef, defaultBaseRef)
  const headRef = normalizeRef(options.headRef, 'HEAD')
  const [mergeBase, aheadBehind, files, commits, commitTouches] = await Promise.all([
    tryGit(root, ['merge-base', '--end-of-options', baseRef, headRef], ''),
    getAheadBehind(root, baseRef, headRef),
    getChangedFiles(root, baseRef, headRef),
    getRangeCommits(root, baseRef, headRef, options.maxCommits),
    getCommitTouchedFiles(root, baseRef, headRef),
  ])
  const graph = buildChangedFileGraph(files, commitTouches)
  const summary = {
    baseRef,
    headRef,
    currentBranch,
    mergeBase: mergeBase.trim(),
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    fileCount: files.length,
    commitCount: commits.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  }
  return { workspacePath: root, summary, files, commits, graph }
}

async function getGitState(workspacePath, options = {}) {
  const root = await resolveGitRoot(workspacePath)
  const currentBranch = await getCurrentBranch(root)
  const defaultBaseRef = await getDefaultBaseRef(root)
  const baseRef = normalizeRef(options.baseRef, defaultBaseRef)
  const headRef = normalizeRef(options.headRef, 'HEAD')
  const [status, branches, recentCommits, compare] = await Promise.all([
    getStatus(root),
    getBranches(root),
    getRecentLog(root, options.maxCommits),
    compareBranches(root, { baseRef, headRef, maxCommits: options.maxCommits }),
  ])
  const state = {
    workspacePath: root,
    currentBranch,
    defaultBaseRef,
    baseRef,
    headRef,
    status,
    branches,
    recentCommits,
    compare,
    generatedAt: Date.now(),
  }
  publishGitState(state)
  return state
}

async function getChangedFileGraph(workspacePath, options = {}) {
  const compare = await compareBranches(workspacePath, options)
  publishChangedFileGraph(compare.workspacePath, compare.graph, compare.summary)
  return { workspacePath: compare.workspacePath, summary: compare.summary, graph: compare.graph, files: compare.files }
}

async function getFileDiff(workspacePath, options = {}) {
  const root = await resolveGitRoot(workspacePath)
  const relPath = normalizeRepoPath(options.path)
  const baseRef = normalizeRef(options.baseRef, await getDefaultBaseRef(root))
  const headRef = normalizeRef(options.headRef, 'HEAD')
  const stdout = await tryGit(root, ['diff', '--end-of-options', `${baseRef}...${headRef}`, '--', relPath], '')
  return { path: relPath, baseRef, headRef, diff: truncate(stdout, Number(options.maxChars) || DEFAULT_DIFF_LIMIT) }
}

function formatChangedFileGraphMarkdown(graph) {
  const lines = ['## Changed-file graph']
  if (!graph.nodes.length) {
    lines.push('- No changed-file graph nodes.')
    return lines.join('\n')
  }
  if (graph.directories.length) {
    lines.push('', 'Top directories:')
    graph.directories.slice(0, 12).forEach(dir => lines.push(`- ${dir.path}: ${dir.fileCount} changed file${dir.fileCount === 1 ? '' : 's'}`))
  }
  if (graph.centralFiles.length) {
    lines.push('', 'Central changed files:')
    graph.centralFiles.slice(0, 12).forEach(file => lines.push(`- ${file.path}: ${file.edgeCount} graph edges, +${file.additions}/-${file.deletions}`))
  }
  const cochangeEdges = graph.edges.filter(edge => edge.type === 'cochange')
  if (cochangeEdges.length) {
    lines.push('', 'Co-changed pairs:')
    cochangeEdges.slice(0, 12).forEach(edge => lines.push(`- ${edge.from.replace(/^file:/, '')} ↔ ${edge.to.replace(/^file:/, '')} (${edge.weight})`))
  }
  return lines.join('\n')
}

function formatReviewHandoffMarkdown(state) {
  const compare = state.compare
  const status = state.status
  const lines = []
  lines.push('# Git Review Handoff')
  lines.push('')
  lines.push(`Workspace: ${state.workspacePath}`)
  lines.push(`Current branch: ${state.currentBranch}`)
  lines.push(`Compare: ${compare.summary.baseRef}...${compare.summary.headRef}`)
  lines.push(`Generated: ${new Date(state.generatedAt).toLocaleString()}`)
  lines.push('')
  lines.push('## Branch summary')
  lines.push(`- Ahead: ${compare.summary.ahead}`)
  lines.push(`- Behind: ${compare.summary.behind}`)
  lines.push(`- Commits in range: ${compare.summary.commitCount}`)
  lines.push(`- Changed files in range: ${compare.summary.fileCount}`)
  lines.push(`- Diff size: +${compare.summary.additions}/-${compare.summary.deletions}`)
  lines.push(`- Working tree dirty: ${status.dirty ? 'yes' : 'no'}`)
  if (status.changes.length) {
    lines.push('')
    lines.push('## Working tree changes')
    status.changes.slice(0, 40).forEach(change => lines.push(`- ${change.path}: ${change.status}${change.staged ? ' (staged)' : ''}${change.unstaged ? ' (unstaged)' : ''}`))
  }
  if (compare.commits.length) {
    lines.push('')
    lines.push('## Commits to review')
    compare.commits.slice(0, 50).forEach(commit => lines.push(`- ${commit.short} ${commit.subject} — ${commit.author}, ${commit.relativeDate}`))
  }
  if (compare.files.length) {
    lines.push('')
    lines.push('## Changed files')
    compare.files.slice(0, 80).forEach(file => lines.push(`- ${file.statusCode} ${file.path} (+${file.additions}/-${file.deletions})`))
  }
  lines.push('')
  lines.push(formatChangedFileGraphMarkdown(compare.graph))
  lines.push('')
  lines.push('## Suggested review flow')
  lines.push('- Inspect central changed files first.')
  lines.push('- Run the Test Loop workbench for the affected package/test profiles.')
  lines.push('- Use Context Map pins for long-lived architectural context discovered during review.')
  lines.push('- Keep branch compare read-only unless the user explicitly asks for git mutations.')
  return lines.join('\n').trim()
}

async function generateReviewHandoff(workspacePath, options = {}) {
  const state = await getGitState(workspacePath, options)
  const markdown = formatReviewHandoffMarkdown(state)
  const handoff = {
    workspacePath: state.workspacePath,
    baseRef: state.baseRef,
    headRef: state.headRef,
    generatedAt: state.generatedAt,
    markdown,
    summary: state.compare.summary,
    graph: state.compare.graph,
  }
  publishReviewHandoff(handoff)
  return handoff
}

function slugify(value) {
  return String(value || 'ref').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'ref'
}

async function writeReviewHandoff(workspacePath, options = {}) {
  const handoff = await generateReviewHandoff(workspacePath, options)
  const dir = path.join(handoff.workspacePath, '.codesurf', 'reviews')
  await fs.mkdir(dir, { recursive: true })
  const stamp = new Date(handoff.generatedAt).toISOString().replace(/[:.]/g, '-')
  const filePath = path.join(dir, `${stamp}-${slugify(handoff.baseRef)}-${slugify(handoff.headRef)}.md`)
  await fs.writeFile(filePath, `${handoff.markdown}\n`, 'utf8')
  return { ...handoff, filePath }
}

function publishGitState(state) {
  if (!bus) return
  bus.publish('ctx:git:state', 'git.state.updated', {
    workspacePath: state.workspacePath,
    currentBranch: state.currentBranch,
    baseRef: state.baseRef,
    headRef: state.headRef,
    status: state.status,
    compareSummary: state.compare.summary,
    generatedAt: state.generatedAt,
  })
  bus.publish('ctx:git:branch_compare', 'git.branch_compare.updated', {
    workspacePath: state.workspacePath,
    summary: state.compare.summary,
    files: state.compare.files,
    commits: state.compare.commits,
  })
  publishChangedFileGraph(state.workspacePath, state.compare.graph, state.compare.summary)
}

function publishChangedFileGraph(workspacePath, graph, summary) {
  if (!bus) return
  bus.publish('ctx:git:changed_file_graph', 'git.changed_file_graph.updated', { workspacePath, summary, graph })
}

function publishReviewHandoff(handoff) {
  if (!bus) return
  bus.publish('ctx:git:review_handoff', 'git.review_handoff.updated', handoff)
}

function mcpJson(value) {
  return JSON.stringify(value, null, 2)
}

function parseInvokePayload(first, second) {
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    return { ...first, ...(second && typeof second === 'object' ? second : {}) }
  }
  if (typeof first === 'string') {
    const trimmed = first.trim()
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object') {
          return { ...parsed, ...(second && typeof second === 'object' ? second : {}) }
        }
      } catch {
        // fall through to workspacePath / empty payload
      }
    }
    if (isAbsoluteWorkspacePath(first)) {
      return { workspacePath: first, ...(second && typeof second === 'object' ? second : {}) }
    }
  }
  return second && typeof second === 'object' ? { ...second } : {}
}

function workspaceFromPayload(payload, fallback) {
  if (isAbsoluteWorkspacePath(payload.workspacePath)) return payload.workspacePath
  if (isAbsoluteWorkspacePath(fallback)) return fallback
  throw new Error('Expected an absolute workspacePath')
}

async function getPorcelainStatus(workspacePath) {
  const root = await resolveGitRoot(workspacePath)
  const [status, branch] = await Promise.all([getStatus(root), getCurrentBranch(root)])
  return {
    branch,
    staged: status.staged.map(change => ({
      path: change.path,
      status: change.stagedStatus || change.status,
    })),
    unstaged: status.unstaged.map(change => ({
      path: change.path,
      status: change.unstagedStatus || change.status,
    })),
  }
}

async function getPorcelainBranches(workspacePath) {
  const root = await resolveGitRoot(workspacePath)
  const branches = await getBranches(root)
  const current = (branches.find(branch => branch.current) || {}).name || await getCurrentBranch(root)
  return { branches: branches.map(branch => branch.name), current }
}

async function getPorcelainLog(workspacePath, max) {
  const root = await resolveGitRoot(workspacePath)
  const commits = await getRecentLog(root, max)
  return {
    commits: commits.map(commit => ({
      hash: commit.hash,
      short: commit.short,
      author: commit.author,
      date: commit.relativeDate,
      subject: commit.subject,
      refs: commit.refs,
      parents: commit.parents,
    })),
  }
}

async function getPorcelainStashes(workspacePath) {
  const root = await resolveGitRoot(workspacePath)
  const stdout = await tryGit(root, ['stash', 'list', '--format=%gd%x1f%gs'], '')
  return {
    stashes: stdout.split('\n').filter(Boolean).map(line => {
      const [ref, message] = line.split('\x1f')
      return { ref, message }
    }),
  }
}

async function getWorkingTreeDiff(workspacePath, filePath, staged) {
  const root = await resolveGitRoot(workspacePath)
  const rel = normalizeRepoPath(filePath)
  const args = staged ? ['diff', '--cached', '--', rel] : ['diff', '--', rel]
  return truncate(await tryGit(root, args, ''), DEFAULT_DIFF_LIMIT)
}

function jsonResult(value) {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

module.exports = {
  activate(ctx) {
    bus = ctx.bus
    ctx.log('Source Control activated')

    const fallbackWorkspace = () => ctx.workspacePath || ''

    const withWorkspace = (fn) => async (first, second) => {
      const payload = parseInvokePayload(first, second)
      const workspacePath = workspaceFromPayload(payload, fallbackWorkspace())
      return jsonResult(await fn(workspacePath, payload))
    }

    ctx.ipc.handle('getStatus', withWorkspace((workspacePath) => getPorcelainStatus(workspacePath)))
    ctx.ipc.handle('getBranches', withWorkspace((workspacePath) => getPorcelainBranches(workspacePath)))
    ctx.ipc.handle('getLog', withWorkspace((workspacePath, payload) => getPorcelainLog(workspacePath, payload.max)))
    ctx.ipc.handle('getStashes', withWorkspace((workspacePath) => getPorcelainStashes(workspacePath)))
    ctx.ipc.handle('stageFile', withWorkspace(async (workspacePath, payload) => {
      const root = await resolveGitRoot(workspacePath)
      await runGit(root, ['add', '--', normalizeRepoPath(payload.path)])
      return { ok: true }
    }))
    ctx.ipc.handle('unstageFile', withWorkspace(async (workspacePath, payload) => {
      const root = await resolveGitRoot(workspacePath)
      await runGit(root, ['reset', 'HEAD', '--', normalizeRepoPath(payload.path)])
      return { ok: true }
    }))
    ctx.ipc.handle('stageAll', withWorkspace(async (workspacePath) => {
      const root = await resolveGitRoot(workspacePath)
      await runGit(root, ['add', '-A'])
      return { ok: true }
    }))
    ctx.ipc.handle('unstageAll', withWorkspace(async (workspacePath) => {
      const root = await resolveGitRoot(workspacePath)
      await runGit(root, ['reset', 'HEAD'])
      return { ok: true }
    }))
    ctx.ipc.handle('commit', withWorkspace(async (workspacePath, payload) => {
      const message = String(payload.message || '').trim()
      if (!message) throw new Error('Commit message required')
      const root = await resolveGitRoot(workspacePath)
      const staged = (await runGit(root, ['diff', '--cached', '--name-only'])).stdout.trim()
      if (!staged) throw new Error('Nothing staged to commit. Stage files first.')
      await runGit(root, ['commit', '-m', message])
      return { ok: true }
    }))
    ctx.ipc.handle('checkoutBranch', withWorkspace(async (workspacePath, payload) => {
      const root = await resolveGitRoot(workspacePath)
      await runGit(root, ['checkout', String(payload.branch || '')])
      return { ok: true }
    }))
    ctx.ipc.handle('createBranch', withWorkspace(async (workspacePath, payload) => {
      const root = await resolveGitRoot(workspacePath)
      await runGit(root, ['checkout', '-b', String(payload.name || '')])
      return { ok: true }
    }))
    ctx.ipc.handle('deleteBranch', withWorkspace(async (workspacePath, payload) => {
      const root = await resolveGitRoot(workspacePath)
      await runGit(root, ['branch', '-d', String(payload.branch || '')])
      return { ok: true }
    }))
    ctx.ipc.handle('pull', withWorkspace(async (workspacePath) => {
      const root = await resolveGitRoot(workspacePath)
      const { stdout, stderr } = await runGit(root, ['pull'])
      return { output: `${stdout}${stderr}`.trim() }
    }))
    ctx.ipc.handle('push', withWorkspace(async (workspacePath) => {
      const root = await resolveGitRoot(workspacePath)
      const { stdout, stderr } = await runGit(root, ['push'])
      return { output: `${stdout}${stderr}`.trim() }
    }))
    ctx.ipc.handle('stash', withWorkspace(async (workspacePath, payload) => {
      const root = await resolveGitRoot(workspacePath)
      const args = ['stash', 'push']
      if (payload.message) args.push('-m', String(payload.message))
      await runGit(root, args)
      return { ok: true }
    }))
    ctx.ipc.handle('stashPop', withWorkspace(async (workspacePath, payload) => {
      const root = await resolveGitRoot(workspacePath)
      // `apply`, not `pop`: the button is labelled Apply and there is a
      // separate Drop button, so restoring must not also destroy the entry.
      // The ref is required for correctness — defaulting to stash@{0} meant
      // clicking Apply on stash@{2} silently consumed a different stash.
      const ref = normalizeStashRef(payload && payload.ref)
      await runGit(root, ref ? ['stash', 'apply', '--', ref] : ['stash', 'apply'])
      return { ok: true }
    }))
    ctx.ipc.handle('stashDrop', withWorkspace(async (workspacePath, payload) => {
      const root = await resolveGitRoot(workspacePath)
      const ref = normalizeStashRef(payload && payload.ref)
      await runGit(root, ref ? ['stash', 'drop', '--', ref] : ['stash', 'drop'])
      return { ok: true }
    }))
    ctx.ipc.handle('discard', withWorkspace(async (workspacePath, payload) => {
      const root = await resolveGitRoot(workspacePath)
      const relPath = normalizeRepoPath(payload.path)
      // Untracked files are listed in Changes too (getStatus uses -uall), but
      // `git checkout --` cannot match them and fails with "did not match any
      // file known to git". Delete those instead of surfacing a dead error.
      const tracked = await isTrackedPath(root, relPath)
      if (tracked) {
        await runGit(root, ['checkout', '--', relPath])
      } else {
        await runGit(root, ['clean', '-f', '--', relPath])
      }
      return { ok: true }
    }))

    ctx.ipc.handle('getGitState', async (workspacePath, options) => getGitState(String(workspacePath || ''), options || {}))
    ctx.ipc.handle('compareBranches', async (workspacePath, options) => compareBranches(String(workspacePath || ''), options || {}))
    ctx.ipc.handle('getChangedFileGraph', async (workspacePath, options) => getChangedFileGraph(String(workspacePath || ''), options || {}))
    ctx.ipc.handle('generateReviewHandoff', async (workspacePath, options) => generateReviewHandoff(String(workspacePath || ''), options || {}))
    ctx.ipc.handle('writeReviewHandoff', async (workspacePath, options) => writeReviewHandoff(String(workspacePath || ''), options || {}))
    ctx.ipc.handle('getFileDiff', async (first, second) => {
      const payload = parseInvokePayload(first, second)
      const workspacePath = workspaceFromPayload(payload, typeof first === 'string' && isAbsoluteWorkspacePath(first) ? first : fallbackWorkspace())
      if (payload.staged === true || payload.staged === false) {
        return jsonResult({ diff: await getWorkingTreeDiff(workspacePath, payload.path, payload.staged) })
      }
      return getFileDiff(workspacePath, payload)
    })

    ctx.mcp.registerTool({
      name: 'git_state',
      description: 'Return git status, recent history, branch compare, and changed-file graph.',
      inputSchema: {
        type: 'object',
        properties: {
          workspacePath: { type: 'string' },
          baseRef: { type: 'string' },
          headRef: { type: 'string' },
        },
        required: ['workspacePath'],
      },
      handler: async (args) => mcpJson(await getGitState(String(args.workspacePath || ''), args)),
    })

    ctx.mcp.registerTool({
      name: 'branch_compare',
      description: 'Compare two refs without switching branches.',
      inputSchema: {
        type: 'object',
        properties: {
          workspacePath: { type: 'string' },
          baseRef: { type: 'string' },
          headRef: { type: 'string' },
        },
        required: ['workspacePath', 'baseRef'],
      },
      handler: async (args) => mcpJson(await compareBranches(String(args.workspacePath || ''), args)),
    })

    ctx.mcp.registerTool({
      name: 'changed_file_graph',
      description: 'Return markdown summary of changed-file graph for a ref comparison.',
      inputSchema: {
        type: 'object',
        properties: {
          workspacePath: { type: 'string' },
          baseRef: { type: 'string' },
          headRef: { type: 'string' },
        },
        required: ['workspacePath', 'baseRef'],
      },
      handler: async (args) => {
        const graph = await getChangedFileGraph(String(args.workspacePath || ''), args)
        return formatChangedFileGraphMarkdown(graph.graph)
      },
    })

    ctx.mcp.registerTool({
      name: 'review_handoff',
      description: 'Return markdown review handoff for a branch/ref comparison.',
      inputSchema: {
        type: 'object',
        properties: {
          workspacePath: { type: 'string' },
          baseRef: { type: 'string' },
          headRef: { type: 'string' },
        },
        required: ['workspacePath'],
      },
      handler: async (args) => (await generateReviewHandoff(String(args.workspacePath || ''), args)).markdown,
    })

    ctx.mcp.registerTool({
      name: 'file_diff',
      description: 'Return bounded diff for one file between refs.',
      inputSchema: {
        type: 'object',
        properties: {
          workspacePath: { type: 'string' },
          path: { type: 'string' },
          baseRef: { type: 'string' },
          headRef: { type: 'string' },
        },
        required: ['workspacePath', 'path'],
      },
      handler: async (args) => (await getFileDiff(String(args.workspacePath || ''), args)).diff,
    })

    return () => { bus = null }
  },
  __testing: {
    buildChangedFileGraph,
    compareBranches,
    formatChangedFileGraphMarkdown,
    formatReviewHandoffMarkdown,
    generateReviewHandoff,
    getChangedFileGraph,
    getFileDiff,
    getGitState,
    getPorcelainStatus,
    isAbsoluteWorkspacePath,
    normalizeRepoPath,
    parseNameStatus,
    parseNumstat,
    parseStatusPorcelain,
    writeReviewHandoff,
  },
}
