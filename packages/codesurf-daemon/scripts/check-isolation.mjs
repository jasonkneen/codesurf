import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
const SOURCE_ROOTS = ['bin', 'dist', 'scripts', 'src', 'test', 'vendor']
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'])
const PACKED_ROOTS = new Set(['bin', 'dist', 'vendor'])
const violations = []

function packageName(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

function importSpecifiers(source) {
  const matches = [
    ...source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ]
  return matches.map(match => match[1])
}

async function walk(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue
    const path = join(current, entry.name)
    if (entry.isDirectory()) files.push(...await walk(root, path))
    else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) files.push(path)
  }
  return files
}

function isInsidePackage(path) {
  const rel = relative(PACKAGE_ROOT, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)
}

function resolveRelativeImport(importer, specifier) {
  const target = resolve(dirname(importer), specifier)
  const candidates = [target]
  if (specifier.endsWith('.js')) candidates.push(`${target.slice(0, -3)}.ts`)
  if (specifier.endsWith('.mjs')) {
    candidates.push(`${target.slice(0, -4)}.mts`, `${target}.d.mts`)
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return target
}

function packedByManifest(path) {
  const rel = relative(PACKAGE_ROOT, path)
  const [root] = rel.split(sep)
  return PACKED_ROOTS.has(root)
}

const files = (await Promise.all(
  SOURCE_ROOTS
    .map(root => join(PACKAGE_ROOT, root))
    .filter(existsSync)
    .map(root => walk(root)),
)).flat()
const dependencies = new Set(Object.keys(MANIFEST.dependencies ?? {}))
const developmentDependencies = new Set([
  ...dependencies,
  ...Object.keys(MANIFEST.devDependencies ?? {}),
])
const importsByFile = new Map()

for (const file of files) {
  const rel = relative(PACKAGE_ROOT, file)
  const source = await readFile(file, 'utf8')
  const specifiers = importSpecifiers(source)
  importsByFile.set(file, specifiers)

  if (/(?:\.\.\/){2,}(?:src|test|scripts)\//.test(source)) {
    violations.push(`${rel}: references a root src/, test/, or scripts/ path`)
  }

  for (const specifier of specifiers) {
    if (specifier.startsWith('.')) {
      const target = resolveRelativeImport(file, specifier)
      if (!isInsidePackage(target)) {
        violations.push(`${rel}: import ${specifier} escapes the package root`)
      } else if (!existsSync(target)) {
        violations.push(`${rel}: import ${specifier} does not resolve inside the package`)
      }
      continue
    }
    if (specifier.startsWith('node:') || specifier.startsWith('#')) continue

    const declared = rel.startsWith(`test${sep}`) || rel.startsWith(`scripts${sep}`)
      ? developmentDependencies
      : dependencies
    const dependency = packageName(specifier)
    if (dependency === MANIFEST.name) continue
    if (!declared.has(dependency)) {
      violations.push(`${rel}: bare import ${specifier} is not declared in package.json`)
    }
  }
}

const entrypoints = new Set()
for (const target of Object.values(MANIFEST.bin ?? {})) entrypoints.add(target)
for (const target of Object.values(MANIFEST.exports ?? {})) {
  if (typeof target === 'string') entrypoints.add(target)
  else if (target && typeof target === 'object') {
    if (typeof target.import === 'string') entrypoints.add(target.import)
    else if (typeof target.default === 'string') entrypoints.add(target.default)
  }
}

const pending = [...entrypoints]
const visited = new Set()
while (pending.length > 0) {
  const specifier = pending.pop()
  const target = resolve(PACKAGE_ROOT, specifier)
  if (visited.has(target)) continue
  visited.add(target)

  if (!isInsidePackage(target) || !existsSync(target)) {
    violations.push(`package.json: entrypoint ${specifier} is missing or outside the package`)
    continue
  }
  if (target.endsWith('package.json')) continue
  if (!packedByManifest(target)) {
    violations.push(`package.json: entrypoint ${specifier} is excluded by files`)
  }

  for (const childSpecifier of importsByFile.get(target) ?? []) {
    if (!childSpecifier.startsWith('.')) continue
    const child = resolveRelativeImport(target, childSpecifier)
    if (!isInsidePackage(child)) {
      violations.push(`${relative(PACKAGE_ROOT, target)}: packed closure escapes via ${childSpecifier}`)
      continue
    }
    if (!packedByManifest(child)) {
      violations.push(`${relative(PACKAGE_ROOT, target)}: packed closure reaches unpacked ${relative(PACKAGE_ROOT, child)}`)
    }
    pending.push(`./${relative(PACKAGE_ROOT, child).split(sep).join('/')}`)
  }
}

if (violations.length > 0) {
  console.error(`@codesurf/daemon isolation violations:\n${[...new Set(violations)].sort().map(item => `- ${item}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`@codesurf/daemon isolation OK (${files.length} files, ${visited.size} packed entrypoints)`)
}
