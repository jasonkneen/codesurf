/**
 * Restore the callable CommonJS/default-export contract expected by inherited
 * minimatch 3/5/9 consumers while retaining brace-expansion 5.0.9's security
 * fixes and limits.
 *
 * Upstream provenance:
 *   package: brace-expansion@5.0.9
 *   source:  https://github.com/juliangruber/brace-expansion
 *   license: MIT
 *
 * Upstream v5 intentionally exposes `expand` as a named export. Electron
 * Builder 26.15.3 still contains minimatch versions that call the older default
 * export, while minimatch 10 calls the named export. The patch makes the same
 * upstream `expand` function available through both contracts; it does not
 * replace or fork expansion logic. Exact version and source markers are checked
 * so upstream drift fails installation loudly.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PATCHED_VERSION = '5.0.9'
const CJS_PATCH_MARKER = '// CODESURF_BRACE_EXPANSION_CALLABLE_COMPAT'
const ESM_PATCH_MARKER = '// CODESURF_BRACE_EXPANSION_DEFAULT_COMPAT'
const SOURCE_MAP_MARKER = '//# sourceMappingURL=index.js.map'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function insertBeforeSourceMap(source, patch, marker, label) {
  if (source.includes(marker)) return source
  const markerIndex = source.lastIndexOf(SOURCE_MAP_MARKER)
  if (markerIndex < 0 || !source.includes('function expand(')) {
    throw new Error(
      `[patch-brace-expansion-compat] ${label} source shape changed; refusing to patch`,
    )
  }
  return `${source.slice(0, markerIndex)}${patch}\n${source.slice(markerIndex)}`
}

export function patchBraceExpansion(packageDir = join(root, 'node_modules', 'brace-expansion')) {
  const manifestPath = join(packageDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.version !== PATCHED_VERSION || manifest.license !== 'MIT') {
    throw new Error(
      `[patch-brace-expansion-compat] expected upstream brace-expansion ${PATCHED_VERSION} (MIT), `
      + `found ${manifest.version ?? 'unknown'} (${manifest.license ?? 'unknown license'})`,
    )
  }

  const cjsPath = join(packageDir, 'dist', 'commonjs', 'index.js')
  const cjsPatch = [
    CJS_PATCH_MARKER,
    'expand.expand = expand;',
    'expand.EXPANSION_MAX = exports.EXPANSION_MAX;',
    'expand.EXPANSION_MAX_LENGTH = exports.EXPANSION_MAX_LENGTH;',
    'module.exports = expand;',
  ].join('\n')
  const cjsSource = readFileSync(cjsPath, 'utf8')
  const patchedCjsSource = insertBeforeSourceMap(
    cjsSource,
    cjsPatch,
    CJS_PATCH_MARKER,
    'CommonJS',
  )

  const esmPath = join(packageDir, 'dist', 'esm', 'index.js')
  const esmPatch = `${ESM_PATCH_MARKER}\nexport default expand;`
  const esmSource = readFileSync(esmPath, 'utf8')
  const patchedEsmSource = insertBeforeSourceMap(
    esmSource,
    esmPatch,
    ESM_PATCH_MARKER,
    'ES module',
  )

  // Validate every source before writing either one so a shape mismatch cannot
  // leave a partially patched package behind.
  writeFileSync(cjsPath, patchedCjsSource)
  writeFileSync(esmPath, patchedEsmSource)

  console.log(`[patch-brace-expansion-compat] patched upstream ${PATCHED_VERSION}`)
}

function installedBraceExpansionPackages() {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  const packageDirs = Object.entries(lock.packages ?? {})
    .filter(([path, entry]) =>
      (path === 'node_modules/brace-expansion' || path.endsWith('/node_modules/brace-expansion'))
      && entry.version === PATCHED_VERSION)
    .map(([path]) => join(root, path))

  if (packageDirs.length === 0) {
    throw new Error('[patch-brace-expansion-compat] no reviewed brace-expansion installations found')
  }
  return packageDirs
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  for (const packageDir of installedBraceExpansionPackages()) {
    patchBraceExpansion(packageDir)
  }
}
