import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { compareDistTrees } from '../scripts/verify-dist.mjs'

const DAEMON_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const COMPILED_EXPORTS = new Map([
  ['.', 'index'],
  ['./manager', 'manager'],
  ['./client', 'client'],
  ['./sse', 'sse'],
  ['./chat-cli', 'chat-cli'],
  ['./chat-session-store', 'chat-session-store'],
  ['./chat-policy', 'chat-policy'],
  ['./paths', 'paths'],
  ['./context-budget', 'context-budget'],
  ['./process-tree', 'process-tree'],
  ['./secure-file-reader', 'secure-file-reader'],
  ['./context-composer', 'context-composer'],
  ['./prompt-conventions', 'prompt-conventions'],
  ['./peer-context-policy', 'peer-context-policy'],
  ['./peer-authority-policy', 'peer-authority-policy'],
  ['./peer-context-serialization', 'peer-context-serialization'],
  ['./node-tools', 'node-tools'],
  ['./package-layout', 'package-layout'],
])

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function walkFiles(root, relative = '') {
  const entries = await readdir(join(root, relative), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const child = join(relative, entry.name)
    if (entry.isDirectory()) files.push(...await walkFiles(root, child))
    else if (entry.isFile()) files.push(child)
  }
  return files.sort()
}

test('public JavaScript API exports resolve only to compiled dist with declarations', async () => {
  const manifest = await readJson(join(DAEMON_DIR, 'package.json'))

  assert.equal(manifest.main, './dist/index.js')
  assert.equal(manifest.types, './dist/index.d.ts')
  for (const [subpath, stem] of COMPILED_EXPORTS) {
    assert.deepEqual(manifest.exports?.[subpath], {
      types: `./dist/${stem}.d.ts`,
      import: `./dist/${stem}.js`,
      default: `./dist/${stem}.js`,
    })
  }

  assert.deepEqual(
    Object.keys(manifest.exports ?? {}).filter(subpath => subpath.startsWith('./bin/')),
    [],
    'authored bin modules stay package-private; consumers use the compiled API',
  )
  assert.deepEqual(manifest.bin, { codesurfd: './bin/codesurfd.mjs' })
})

test('daemon tarballs include compiled output and never include source TypeScript', async () => {
  const manifest = await readJson(join(DAEMON_DIR, 'package.json'))
  assert.deepEqual(manifest.files, ['bin/', 'dist/', 'vendor/', 'README.md'])
  assert.equal(existsSync(join(DAEMON_DIR, 'src', 'index.js')), false)

  const distFiles = await walkFiles(join(DAEMON_DIR, 'dist'))
  assert.ok(distFiles.length > 0, 'compiled dist must be committed')
  assert.equal(
    distFiles.some(path => extname(path) === '.ts' && !path.endsWith('.d.ts')),
    false,
    'dist must not contain raw TypeScript',
  )
  for (const [, stem] of COMPILED_EXPORTS) {
    assert.ok(distFiles.includes(`${stem}.js`), `${stem}.js must be compiled`)
    assert.ok(distFiles.includes(`${stem}.d.ts`), `${stem}.d.ts must be generated`)
  }
})

test('daemon compiler and scripts enforce a deterministic NodeNext dist', async () => {
  const [manifest, tsconfig] = await Promise.all([
    readJson(join(DAEMON_DIR, 'package.json')),
    readJson(join(DAEMON_DIR, 'tsconfig.json')),
  ])

  assert.equal(tsconfig.compilerOptions?.module, 'NodeNext')
  assert.equal(tsconfig.compilerOptions?.moduleResolution, 'NodeNext')
  assert.equal(tsconfig.compilerOptions?.rootDir, 'src')
  assert.equal(tsconfig.compilerOptions?.outDir, 'dist')
  assert.equal(tsconfig.compilerOptions?.declaration, true)
  assert.equal(tsconfig.compilerOptions?.noEmit, false)
  assert.match(manifest.scripts?.build ?? '', /build-dist/)
  assert.match(manifest.scripts?.typecheck ?? '', /\btsc\b/)
  assert.match(manifest.scripts?.['verify:dist'] ?? '', /verify-dist/)
  assert.match(manifest.scripts?.prepack ?? '', /verify:dist/)
})

test('daemon owns its runtime native dependency and compiler-only dev dependencies', async () => {
  const manifest = await readJson(join(DAEMON_DIR, 'package.json'))
  assert.equal(manifest.dependencies?.['better-sqlite3'], '12.8.0')
  assert.match(manifest.devDependencies?.typescript ?? '', /^\d+\.\d+\.\d+$/)
  assert.match(manifest.devDependencies?.['@types/node'] ?? '', /^\d+\.\d+\.\d+$/)
  assert.equal(manifest.dependencies?.typescript, undefined)
  assert.equal(manifest.dependencies?.['@types/node'], undefined)
})

test('NodeNext source imports use explicit runtime relative specifiers', async () => {
  const sourceDir = join(DAEMON_DIR, 'src')
  const sourceFiles = (await readdir(sourceDir)).filter(name => name.endsWith('.ts'))

  for (const fileName of sourceFiles) {
    const source = await readFile(join(sourceDir, fileName), 'utf8')
    const relativeSpecifiers = [
      ...source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g),
      ...source.matchAll(/\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g),
    ].map(match => match[1])
    for (const specifier of relativeSpecifiers) {
      assert.match(specifier, /\.m?js$/, `${fileName} has non-runtime specifier ${specifier}`)
    }
  }
})

test('compiled JavaScript never refers back to raw TypeScript', async () => {
  const distFiles = await walkFiles(join(DAEMON_DIR, 'dist'))
  for (const relativePath of distFiles.filter(path => path.endsWith('.js'))) {
    const source = await readFile(join(DAEMON_DIR, 'dist', relativePath), 'utf8')
    assert.doesNotMatch(source, /(?:from|import\s*\()\s*['"][^'"]+\.ts['"]/)
  }
})

test('dist comparison rejects a byte-stale committed artifact', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'codesurf-daemon-stale-dist-'))
  const fresh = join(fixture, 'fresh')
  const committed = join(fixture, 'committed')
  t.after(async () => { await rm(fixture, { recursive: true, force: true }) })
  await Promise.all([mkdir(fresh), mkdir(committed)])
  await writeFile(join(fresh, 'index.js'), 'export const value = 1\n')
  await writeFile(join(committed, 'index.js'), 'export const value = 2\n')

  assert.throws(
    () => compareDistTrees(fresh, committed),
    /dist is stale: index\.js differs/,
  )
  await writeFile(join(committed, 'index.js'), 'export const value = 1\n')
  assert.doesNotThrow(() => compareDistTrees(fresh, committed))
})

test('normal npm pack fails closed on stale dist without mutating the real tree', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'codesurf-daemon-stale-pack-'))
  const fixturePackage = join(fixture, 'package')
  const packDir = join(fixture, 'pack')
  const cacheDir = join(fixture, 'npm-cache')
  const realDistBefore = await readFile(join(DAEMON_DIR, 'dist', 'index.js'))
  t.after(async () => { await rm(fixture, { recursive: true, force: true }) })
  await Promise.all([mkdir(fixturePackage), mkdir(packDir)])
  for (const entry of ['package.json', 'tsconfig.json', 'src', 'dist', 'scripts', 'bin', 'vendor']) {
    await cp(join(DAEMON_DIR, entry), join(fixturePackage, entry), { recursive: true })
  }
  await symlink(
    join(DAEMON_DIR, 'node_modules'),
    join(fixturePackage, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  const typescriptManifest = createRequire(join(DAEMON_DIR, 'package.json'))
    .resolve('typescript/package.json')
  await symlink(
    dirname(dirname(typescriptManifest)),
    join(fixture, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await writeFile(join(fixturePackage, 'dist', 'index.js'), 'export const stale = true\n')

  const packed = spawnSync(
    NPM_COMMAND,
    ['pack', '--pack-destination', packDir],
    {
      cwd: fixturePackage,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cacheDir },
    },
  )
  assert.notEqual(packed.status, 0, 'normal npm pack must reject stale committed output')
  assert.match(`${packed.stdout || ''}${packed.stderr || ''}`, /dist is stale/)
  assert.deepEqual(await readdir(packDir), [], 'failed prepack must not emit a tarball')
  assert.deepEqual(
    await readFile(join(DAEMON_DIR, 'dist', 'index.js')),
    realDistBefore,
    'negative control must not mutate the real committed dist',
  )
})
