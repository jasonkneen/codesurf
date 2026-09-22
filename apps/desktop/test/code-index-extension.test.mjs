import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const EXT_DIR = join(ROOT_DIR, 'bundled-extensions', 'code-index')
const STORE_DIR = join(tmpdir(), `codesurf-code-index-home-${process.pid}`)
mkdirSync(STORE_DIR, { recursive: true })
process.env.CODESURF_HOME = STORE_DIR
const codeIndex = require(join(EXT_DIR, 'main.js'))

async function createFixtureRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'codesurf-code-index-'))
  await mkdir(join(dir, 'src', 'components'), { recursive: true })
  await mkdir(join(dir, 'test'), { recursive: true })
  await mkdir(join(dir, 'node_modules', 'ignored'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }, null, 2))
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }, null, 2))
  await writeFile(join(dir, 'AGENTS.md'), '# fixture instructions\n')
  await writeFile(join(dir, 'src', 'main.ts'), "import { helper } from './util'\nimport Button from './components/Button'\nconsole.log(helper(), Button)\n")
  await writeFile(join(dir, 'src', 'util.ts'), 'export function helper() { return 42 }\n')
  await writeFile(join(dir, 'src', 'components', 'Button.tsx'), 'export default function Button() { return null }\n')
  await writeFile(join(dir, 'test', 'main.test.ts'), "import '../src/main'\n")
  await writeFile(join(dir, 'node_modules', 'ignored', 'ignored.ts'), 'export const ignored = true\n')
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

test('code-index is bundled as a host-backed Context Map tile with MCP tools', async () => {
  const manifest = JSON.parse(await readFile(join(EXT_DIR, 'extension.json'), 'utf8'))

  assert.equal(manifest.id, 'code-index')
  assert.equal(manifest.name, 'Context Map')
  assert.equal(manifest.tier, 'power')
  assert.equal(manifest.main, 'main.js')
  assert.equal(manifest.ui.mode, 'native')

  const tile = manifest.contributes.tiles.find(entry => entry.type === 'code-index-dashboard')
  assert.ok(tile, 'expected code-index-dashboard tile contribution')
  assert.equal(tile.entry, 'tile/index.html')
  assert.deepEqual(tile.defaultSize, { w: 760, h: 600 })

  assert.ok(manifest.contributes.context.produces.includes('ctx:code-index:repo_map'))
  assert.ok(manifest.contributes.context.produces.includes('ctx:code-index:pins'))
  assert.ok(manifest.contributes.context.consumes.includes('ctx:test-loop:last_run'))

  const actionNames = manifest.contributes.actions.map(action => action.name).sort()
  assert.deepEqual(actionNames, ['getRepoMap', 'listPins', 'pinContext', 'scanWorkspace', 'searchFiles', 'unpinContext'])

  const mcpNames = manifest.contributes.mcpTools.map(tool => tool.name).sort()
  assert.deepEqual(mcpNames, ['pin', 'pins', 'repo_map', 'search_files', 'unpin'])
})

test('code-index scans a repo into a lightweight dependency graph and markdown map', async () => {
  const dir = await createFixtureRepo()
  try {
    const map = await codeIndex.__testing.scanWorkspace(dir, { maxFiles: 80 })
    assert.equal(map.workspacePath, dir)
    assert.equal(map.summary.truncated, false)
    assert.ok(map.summary.fileCount >= 6)
    assert.equal(map.files.some(file => file.path.includes('node_modules')), false)
    assert.ok(map.importantFiles.some(file => file.path === 'package.json'))
    assert.ok(map.importantFiles.some(file => file.path === 'AGENTS.md'))
    assert.ok(map.edges.some(edge => edge.from === 'src/main.ts' && edge.to === 'src/util.ts'))
    assert.ok(map.edges.some(edge => edge.from === 'src/main.ts' && edge.to === 'src/components/Button.tsx'))
    assert.match(map.markdown, /^# Context Map/m)
    assert.match(map.markdown, /Important Files/)
    assert.match(map.markdown, /Central Files/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('code-index supports search and durable context pins', async () => {
  const dir = await createFixtureRepo()
  try {
    const map = await codeIndex.__testing.scanWorkspace(dir, { maxFiles: 80 })
    const results = codeIndex.__testing.searchInMap(map, 'button', 10)
    assert.equal(results[0].path, 'src/components/Button.tsx')

    const pin = await codeIndex.__testing.pinContext(dir, {
      path: 'src/main.ts',
      label: 'Entry point',
      note: 'Primary app entry',
    })
    assert.equal(pin.path, 'src/main.ts')
    assert.equal(pin.note, 'Primary app entry')

    const pins = await codeIndex.__testing.listPins(dir)
    assert.deepEqual(pins.map(entry => entry.path), ['src/main.ts'])

    const removed = await codeIndex.__testing.unpinContext(dir, 'src/main.ts')
    assert.equal(removed.removed, true)
    assert.deepEqual(await codeIndex.__testing.listPins(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('code-index tile calls scan/search/pin APIs and publishes context', async () => {
  const tileHtml = await readFile(join(EXT_DIR, 'tile', 'index.html'), 'utf8')
  assert.match(tileHtml, /ext\.invoke\('scanWorkspace'/)
  assert.match(tileHtml, /ext\.invoke\('searchFiles'/)
  assert.match(tileHtml, /ext\.invoke\('pinContext'/)
  assert.match(tileHtml, /ctx:code-index:repo_map/)
  assert.match(tileHtml, /ctx:code-index:pins/)
  assert.match(tileHtml, /Scan workspace/)
  assert.match(tileHtml, /Pin selected/)
})

test('validate-extension accepts bundled code-index target', async () => {
  const result = await runNode(['scripts/validate-extension.mjs', 'bundled-extensions/code-index'])
  assert.equal(
    result.code,
    0,
    `validate-extension failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
  assert.match(result.stdout, /\[OK\] bundled-extensions\/code-index|\[OK\] code-index/)
  assert.match(result.stdout, /Summary: 1 passed, 0 failed/)
})
