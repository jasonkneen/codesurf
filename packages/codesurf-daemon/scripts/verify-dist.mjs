#!/usr/bin/env node

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDist, packageDir } from './build-dist.mjs'

function listFiles(root, directory = root) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(root, path))
    else if (entry.isFile()) files.push(relative(root, path))
  }
  return files.sort()
}

export function compareDistTrees(expectedDir, actualDir) {
  const expectedFiles = listFiles(expectedDir)
  const actualFiles = listFiles(actualDir)
  if (expectedFiles.join('\n') !== actualFiles.join('\n')) {
    const expected = new Set(expectedFiles)
    const actual = new Set(actualFiles)
    const missing = expectedFiles.filter(path => !actual.has(path))
    const unexpected = actualFiles.filter(path => !expected.has(path))
    throw new Error(
      'Committed daemon dist file list is stale.'
      + `${missing.length ? `\nMissing: ${missing.join(', ')}` : ''}`
      + `${unexpected.length ? `\nUnexpected: ${unexpected.join(', ')}` : ''}`,
    )
  }

  for (const path of expectedFiles) {
    const expected = readFileSync(join(expectedDir, path))
    const actual = readFileSync(join(actualDir, path))
    if (!expected.equals(actual)) {
      throw new Error(`Committed daemon dist is stale: ${path} differs from a fresh build`)
    }
  }
}

export function verifyDist({
  committedDir = join(packageDir, 'dist'),
  build = buildDist,
} = {}) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'codesurf-daemon-dist-'))
  const freshDir = join(temporaryRoot, 'dist')
  try {
    build({ outDir: freshDir, clean: true, stdio: 'pipe' })
    compareDistTrees(freshDir, committedDir)
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    verifyDist()
    process.stdout.write('Committed daemon dist matches a fresh NodeNext build.\n')
  } catch (error) {
    console.error(error?.stack || error)
    process.exitCode = 1
  }
}
