#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const DEFAULT_TOTAL_LIMIT = 800
export const DEFAULT_PRODUCTION_LIMIT = 500

const NON_PRODUCTION_PREFIXES = [
  '.github/',
  'docs/',
  'e2e/',
  'plans/',
  'test/',
  'tests/',
]

export function isProductionPath(filePath) {
  const normalized = String(filePath).replaceAll('\\', '/')
  if (NON_PRODUCTION_PREFIXES.some(prefix => normalized.startsWith(prefix))) return false
  if (/(^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(normalized)) return false
  if (/\.(?:md|mdx|snap)$/i.test(normalized)) return false
  if (/(^|\/)(?:package-lock|npm-shrinkwrap|bun\.lock|pnpm-lock|yarn\.lock)(?:\.json|\.yaml|\.yml)?$/i.test(normalized)) {
    return false
  }
  return true
}

export function parseNumstat(output) {
  const files = []
  for (const line of String(output).split(/\r?\n/)) {
    if (!line) continue
    const [addedRaw, deletedRaw, ...pathParts] = line.split('\t')
    const filePath = pathParts.join('\t')
    if (!filePath) continue
    const binary = addedRaw === '-' || deletedRaw === '-'
    const added = binary ? 0 : Number.parseInt(addedRaw, 10)
    const deleted = binary ? 0 : Number.parseInt(deletedRaw, 10)
    if ((!binary && (!Number.isFinite(added) || !Number.isFinite(deleted)))) continue
    files.push({
      path: filePath,
      added,
      deleted,
      changed: added + deleted,
      binary,
      production: isProductionPath(filePath),
    })
  }
  return files
}

export function summarizeChange(files, limits = {}) {
  const totalLimit = limits.totalLimit ?? DEFAULT_TOTAL_LIMIT
  const productionLimit = limits.productionLimit ?? DEFAULT_PRODUCTION_LIMIT
  const total = files.reduce((sum, file) => sum + file.changed, 0)
  const production = files.reduce(
    (sum, file) => sum + (file.production ? file.changed : 0),
    0,
  )
  return {
    total,
    production,
    totalLimit,
    productionLimit,
    overTotal: total > totalLimit,
    overProduction: production > productionLimit,
  }
}

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function hasCommit(ref) {
  try {
    git(['rev-parse', '--verify', `${ref}^{commit}`])
    return true
  } catch {
    return false
  }
}

function parseArgs(argv) {
  const result = {
    base: process.env.CODESURF_DIFF_BASE?.trim() || '',
    strict: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--strict') {
      result.strict = true
    } else if (arg === '--base') {
      result.base = argv[index + 1] || ''
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      result.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return result
}

function defaultBase() {
  if (process.env.GITHUB_BASE_REF?.trim()) {
    return `origin/${process.env.GITHUB_BASE_REF.trim()}`
  }
  return 'HEAD^'
}

function emitWarning(message) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.warn(`::warning title=Oversized change::${message}`)
  } else {
    console.warn(`WARNING: ${message}`)
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log('Usage: node scripts/check-change-size.mjs [--base <git-ref>] [--strict]')
    return 0
  }

  const base = options.base || defaultBase()
  if (!hasCommit(base)) {
    emitWarning(`Cannot resolve diff base "${base}"; change-size review was skipped.`)
    return options.strict ? 1 : 0
  }

  const files = parseNumstat(git(['diff', '--numstat', '--find-renames', `${base}...HEAD`]))
  const summary = summarizeChange(files)
  console.log(
    `Change size against ${base}: ${summary.production} production lines, `
      + `${summary.total} total lines across ${files.length} files.`,
  )

  const binaryCount = files.filter(file => file.binary).length
  if (binaryCount > 0) {
    console.log(`${binaryCount} binary file(s) are listed separately from line totals.`)
  }

  if (!summary.overTotal && !summary.overProduction) return 0

  const reasons = []
  if (summary.overProduction) {
    reasons.push(
      `${summary.production} production lines exceeds ${summary.productionLimit}`,
    )
  }
  if (summary.overTotal) {
    reasons.push(`${summary.total} total lines exceeds ${summary.totalLimit}`)
  }
  emitWarning(
    `${reasons.join('; ')}. Split the change into coherent review stages or document why it is mechanical.`,
  )

  const largest = [...files]
    .filter(file => file.changed > 0)
    .sort((left, right) => right.changed - left.changed)
    .slice(0, 10)
  for (const file of largest) {
    console.log(`  ${String(file.changed).padStart(6)}  ${file.path}`)
  }

  return options.strict ? 1 : 0
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
