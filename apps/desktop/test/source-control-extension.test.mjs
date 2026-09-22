import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const EXT_DIR = join(ROOT_DIR, 'bundled-extensions', 'source-control')
const sourceControl = require(join(EXT_DIR, 'main.js'))

function git(dir, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'CodeSurf Test',
        GIT_AUTHOR_EMAIL: 'codesurf@example.com',
        GIT_COMMITTER_NAME: 'CodeSurf Test',
        GIT_COMMITTER_EMAIL: 'codesurf@example.com',
      },
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        rejectPromise(error)
        return
      }
      resolvePromise({ stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

async function initGit(dir) {
  try {
    await git(dir, ['init', '-b', 'main'])
  } catch {
    await git(dir, ['init'])
    await git(dir, ['checkout', '-b', 'main']).catch(() => {})
  }
  await git(dir, ['config', 'user.name', 'CodeSurf Test'])
  await git(dir, ['config', 'user.email', 'codesurf@example.com'])
}

async function createFixtureRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'codesurf-source-control-'))
  await initGit(dir)
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'README.md'), '# fixture\n')
  await writeFile(join(dir, 'src', 'main.ts'), 'export const value = 1\n')
  await git(dir, ['add', '.'])
  await git(dir, ['commit', '-m', 'base commit'])

  await git(dir, ['checkout', '-b', 'feature/review-workbench'])
  await writeFile(join(dir, 'src', 'main.ts'), 'import { review } from "./review"\nexport const value = review(2)\n')
  await writeFile(join(dir, 'src', 'review.ts'), 'export function review(value: number) { return value * 2 }\n')
  await git(dir, ['add', '.'])
  await git(dir, ['commit', '-m', 'add review feature'])

  await writeFile(join(dir, 'README.md'), '# fixture\n\nDirty local note.\n')
  return dir
}

function runNode(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', rejectPromise)
    child.once('close', code => resolvePromise({ code: code ?? 1, stdout, stderr }))
  })
}

test('source-control is bundled as a porcelain panel with MCP review tools', async () => {
  const manifest = JSON.parse(await readFile(join(EXT_DIR, 'extension.json'), 'utf8'))

  assert.equal(manifest.id, 'source-control')
  assert.equal(manifest.name, 'Source Control')
  assert.equal(manifest.main, 'main.js')
  assert.equal(manifest.ui.mode, 'native')

  const tile = manifest.contributes.tiles.find(entry => entry.type === 'source-control-panel')
  assert.ok(tile, 'expected source-control-panel tile contribution')
  assert.equal(tile.entry, 'tile/index.html')
  assert.equal(tile.label, 'Source Control')

  assert.ok(manifest.contributes.context.produces.includes('ctx:git:branch'))
  assert.ok(manifest.contributes.context.produces.includes('ctx:git:state'))
  assert.ok(manifest.contributes.context.produces.includes('ctx:git:branch_compare'))
  assert.ok(manifest.contributes.context.produces.includes('ctx:git:changed_file_graph'))
  assert.ok(manifest.contributes.context.produces.includes('ctx:git:review_handoff'))
  assert.ok(manifest.contributes.context.consumes.includes('ctx:workspace'))

  const actionNames = manifest.contributes.actions.map(action => action.name)
  for (const name of [
    'getStatus', 'getBranches', 'getLog', 'getStashes',
    'stageFile', 'unstageFile', 'stageAll', 'commit',
    'getGitState', 'compareBranches', 'getFileDiff', 'generateReviewHandoff',
  ]) {
    assert.ok(actionNames.includes(name), `expected action ${name}`)
  }

  const mcpNames = manifest.contributes.mcpTools.map(tool => tool.name).sort()
  assert.deepEqual(mcpNames, ['branch_compare', 'changed_file_graph', 'file_diff', 'git_state', 'review_handoff'])
})

test('source-control compares branches and builds a changed-file graph without switching checkout', async () => {
  const dir = await createFixtureRepo()
  try {
    const beforeBranch = (await git(dir, ['branch', '--show-current'])).stdout.trim()
    const compare = await sourceControl.__testing.compareBranches(dir, { baseRef: 'main', headRef: 'HEAD' })
    const afterBranch = (await git(dir, ['branch', '--show-current'])).stdout.trim()

    assert.equal(beforeBranch, 'feature/review-workbench')
    assert.equal(afterBranch, beforeBranch)
    assert.equal(compare.summary.baseRef, 'main')
    assert.equal(compare.summary.headRef, 'HEAD')
    assert.equal(compare.summary.ahead, 1)
    assert.equal(compare.summary.fileCount, 2)
    assert.ok(compare.files.some(file => file.path === 'src/main.ts' && file.status === 'modified'))
    assert.ok(compare.files.some(file => file.path === 'src/review.ts' && file.status === 'added'))
    assert.ok(compare.graph.nodes.some(node => node.id === 'file:src/main.ts'))
    assert.ok(compare.graph.edges.some(edge => edge.type === 'contains' && edge.to === 'file:src/review.ts'))
    assert.ok(compare.graph.centralFiles.some(file => file.path === 'src/main.ts'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('source-control exposes git state, file diff, and review handoff markdown', async () => {
  const dir = await createFixtureRepo()
  try {
    const state = await sourceControl.__testing.getGitState(dir, { baseRef: 'main', headRef: 'HEAD' })
    assert.equal(state.currentBranch, 'feature/review-workbench')
    assert.equal(state.status.dirty, true)
    assert.ok(state.status.changes.some(change => change.path === 'README.md'))
    assert.equal(state.compare.summary.commitCount, 1)

    const diff = await sourceControl.__testing.getFileDiff(dir, { baseRef: 'main', headRef: 'HEAD', path: 'src/main.ts' })
    assert.match(diff.diff, /review\(2\)/)

    const handoff = await sourceControl.__testing.generateReviewHandoff(dir, { baseRef: 'main', headRef: 'HEAD' })
    assert.match(handoff.markdown, /^# Git Review Handoff/m)
    assert.match(handoff.markdown, /Changed-file graph/)
    assert.match(handoff.markdown, /src\/review\.ts/)

    const written = await sourceControl.__testing.writeReviewHandoff(dir, { baseRef: 'main', headRef: 'HEAD' })
    assert.match(written.filePath, /\.codesurf\/reviews\/.*main-HEAD\.md$/)
    assert.ok((await stat(written.filePath)).isFile())
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('source-control rejects path traversal for file diffs', async () => {
  const dir = await createFixtureRepo()
  try {
    await assert.rejects(
      () => sourceControl.__testing.getFileDiff(dir, { baseRef: 'main', headRef: 'HEAD', path: '../secret.txt' }),
      /Path must stay inside the workspace/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('source-control tile calls porcelain git APIs and publishes git context', async () => {
  const tileHtml = await readFile(join(EXT_DIR, 'tile', 'index.html'), 'utf8')
  assert.match(tileHtml, /invoke\('getStatus'/)
  assert.match(tileHtml, /invoke\('getBranches'/)
  assert.match(tileHtml, /invoke\('getLog'/)
  assert.match(tileHtml, /invoke\('getStashes'/)
  assert.match(tileHtml, /invoke\('commit'/)
  assert.match(tileHtml, /ctx:git:branch/)
  assert.match(tileHtml, /workspace\.getPath/)
})

test('source-control keeps a Git Review tile that calls host review APIs', async () => {
  const reviewHtml = await readFile(join(EXT_DIR, 'tile', 'review.html'), 'utf8')
  assert.match(reviewHtml, /ext\.invoke\('getGitState'/)
  assert.match(reviewHtml, /ext\.invoke\('generateReviewHandoff'/)
  assert.match(reviewHtml, /Git Review Workbench/)
})

test('source-control getStatus returns porcelain staged/unstaged for the tile', async () => {
  const dir = await createFixtureRepo()
  try {
    const status = await sourceControl.__testing.getPorcelainStatus(dir)
    assert.equal(status.branch, 'feature/review-workbench')
    assert.ok(status.unstaged.some(change => change.path === 'README.md'))
    assert.equal(status.staged.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Hostile-repository regression tests ──────────────────────────────────────
// Repository content (filenames, refs) is attacker-controlled: cloning a repo
// must not be able to attack the tile or the host. The suite previously used
// only ASCII fixtures (README.md, src/main.ts), which is why the three defects
// below shipped undetected.

const XSS_FILENAME = 'a onmouseover=alert(1) b"'
const UNICODE_FILENAME = 'caf\u00e9.txt'

/** The tile's escaper, mirrored from bundled-extensions/source-control/tile/index.html. */
function tileEsc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

test('porcelain paths survive non-ASCII and quote characters (no C-quoting)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codesurf-source-control-hostile-'))
  try {
    await initGit(dir)
    await writeFile(join(dir, 'seed.txt'), 'seed\n')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-m', 'seed'])

    await writeFile(join(dir, UNICODE_FILENAME), 'accented\n')
    await writeFile(join(dir, XSS_FILENAME), 'quoted\n')

    const status = await sourceControl.__testing.getPorcelainStatus(dir)
    const paths = status.unstaged.map(change => change.path)

    // Without `-z`, git emits "caf\303\251.txt" (a literal 12-char string) and
    // the round-trip back into `git add --` matches nothing.
    assert.ok(
      paths.includes(UNICODE_FILENAME),
      `expected exact bytes for the accented path, got ${JSON.stringify(paths)}`,
    )
    assert.ok(
      paths.includes(XSS_FILENAME),
      `expected exact bytes for the quoted path, got ${JSON.stringify(paths)}`,
    )
    for (const filePath of paths) {
      assert.ok(!/\\[0-7]{3}/.test(filePath), `path is still C-quoted: ${filePath}`)
    }

    // The path must round-trip: this is what stage/unstage/discard actually do.
    await git(dir, ['add', '--', UNICODE_FILENAME])
    const staged = await sourceControl.__testing.getPorcelainStatus(dir)
    assert.ok(staged.staged.some(change => change.path === UNICODE_FILENAME))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('renames parse under -z, where the origin path is a separate record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codesurf-source-control-rename-'))
  try {
    await initGit(dir)
    await writeFile(join(dir, UNICODE_FILENAME), 'accented\n')
    await writeFile(join(dir, 'plain.txt'), 'plain\n')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-m', 'seed'])

    // A destination containing a space would also defeat the old ' -> ' split.
    await git(dir, ['mv', UNICODE_FILENAME, 'caf\u00e9 moved.txt'])
    await git(dir, ['mv', 'plain.txt', 'renamed name.txt'])

    const status = await sourceControl.__testing.getPorcelainStatus(dir)
    const paths = status.staged.map(change => change.path)
    assert.ok(paths.includes('caf\u00e9 moved.txt'), JSON.stringify(paths))
    assert.ok(paths.includes('renamed name.txt'), JSON.stringify(paths))
    // The origin records must be consumed, not surfaced as phantom entries.
    assert.ok(!paths.includes(UNICODE_FILENAME), 'rename origin leaked as its own change')
    assert.ok(!paths.includes('plain.txt'), 'rename origin leaked as its own change')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tile escaper neutralises a filename that would break out of an attribute', () => {
  const escaped = tileEsc(XSS_FILENAME)
  assert.ok(!escaped.includes('"'), `unescaped quote survives: ${escaped}`)
  assert.equal(escaped, 'a onmouseover=alert(1) b&quot;')

  // The whole point: the value must stay inside its attribute.
  const markup = `<button data-path="${escaped}">x</button>`
  assert.equal(markup.split('"').length, 3, `attribute broken out of: ${markup}`)

  // textContent -> innerHTML (the old implementation) does NOT escape quotes.
  assert.ok(tileEsc('<script>').includes('&lt;'))
  assert.equal(tileEsc("it's"), 'it&#39;s')
})

test('option-shaped refs are rejected before reaching git (argument injection)', async () => {
  const dir = await createFixtureRepo()
  const marker = join(tmpdir(), `codesurf-refguard-${Date.now()}.txt`)
  try {
    // `git diff --output=<file>` creates/truncates that file. baseRef is a
    // required, agent-supplied field on the branch_compare MCP tool, so this
    // is reachable by a prompt-injected model, not just by a user.
    await assert.rejects(
      () => sourceControl.__testing.compareBranches(dir, { baseRef: `--output=${marker}`, headRef: 'HEAD' }),
      /Invalid ref/,
    )
    await assert.rejects(
      () => sourceControl.__testing.getFileDiff(dir, { path: 'README.md', baseRef: `--output=${marker}`, headRef: 'HEAD' }),
      /Invalid ref/,
    )
    await assert.rejects(
      () => sourceControl.__testing.compareBranches(dir, { baseRef: 'main', headRef: '--output=/tmp/x' }),
      /Invalid ref/,
    )

    await assert.rejects(() => stat(marker), { code: 'ENOENT' }, 'ref guard let git write outside the repo')

    // Legitimate refs must still work.
    const ok = await sourceControl.__testing.compareBranches(dir, { baseRef: 'main', headRef: 'HEAD' })
    assert.ok(ok.summary.fileCount >= 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(marker, { force: true })
  }
})

test('validate-extension accepts bundled source-control target', async () => {
  const result = await runNode(['scripts/validate-extension.mjs', 'bundled-extensions/source-control'])
  assert.equal(
    result.code,
    0,
    `validate-extension failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
  assert.match(result.stdout, /\[OK\] bundled-extensions\/source-control|\[OK\] source-control/)
  assert.match(result.stdout, /Summary: 1 passed, 0 failed/)
})
