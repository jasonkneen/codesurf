#!/usr/bin/env node
// One-shot installer for AI Elements + their shadcn primitive deps.
//
// Why custom: shadcn's CLI hardcodes `target` paths from registry items
// (e.g. `components/ai-elements/foo.tsx`) and resolves them relative to
// project root. This repo's renderer code lives under `src/renderer/src/`,
// so the CLI lands files in the wrong place. Driving the install ourselves
// rewrites every target to `src/renderer/src/components/ai-elements/...`
// before writing.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '..')
const REGISTRY_BASE = 'https://elements.ai-sdk.dev/api/registry'

// AI Elements components we want. Names verified to exist at the registry
// via `curl <REGISTRY_BASE>/<name>.json` returning 200.
const COMPONENTS = [
  'message',
  'conversation',
  'reasoning',
  'tool',
  'code-block',
  'task',
  'prompt-input',
  'suggestion',
  'sources',
  'image',
  'web-preview',
  'inline-citation',
  'chain-of-thought',
  'artifact',
]

// Shadcn primitives that AI Elements components depend on. The CLI would
// resolve these via `registryDependencies` -> shadcn registry; we fetch
// them the same way.
const SHADCN_BASE = 'https://ui.shadcn.com/r/styles/new-york-v4'

const fetched = new Map()
const allDeps = new Set()
const filesWritten = []

async function fetchJson(url) {
  if (fetched.has(url)) return fetched.get(url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Fetch ${url} failed: ${res.status}`)
  const json = await res.json()
  fetched.set(url, json)
  return json
}

function rewriteTarget(target) {
  // Registry items use a few shapes for `target` / `path`:
  //   components/ai-elements/<name>.tsx     (AI Elements components)
  //   components/ui/<name>.tsx              (shadcn primitives via target)
  //   registry/<style>/ui/<name>.tsx        (shadcn primitives via path)
  //   registry/<style>/ai-elements/<name>   (rare)
  //   <name>.tsx                            (bare path)
  // Normalize ALL of them under src/renderer/src/components/ai-elements,
  // with primitives in the nested `ui/` subdir so AI Elements imports
  // resolve to `@/components/ai-elements/ui/<name>`.
  const aiPrefixes = [
    'components/ai-elements/',
    /^registry\/[^/]+\/ai-elements\//,
  ]
  const uiPrefixes = [
    'components/ui/',
    /^registry\/[^/]+\/ui\//,
  ]
  for (const prefix of aiPrefixes) {
    if (typeof prefix === 'string' && target.startsWith(prefix)) {
      return 'src/renderer/src/components/ai-elements/' + target.slice(prefix.length)
    }
    if (prefix instanceof RegExp && prefix.test(target)) {
      return 'src/renderer/src/components/ai-elements/' + target.replace(prefix, '')
    }
  }
  for (const prefix of uiPrefixes) {
    if (typeof prefix === 'string' && target.startsWith(prefix)) {
      return 'src/renderer/src/components/ai-elements/ui/' + target.slice(prefix.length)
    }
    if (prefix instanceof RegExp && prefix.test(target)) {
      return 'src/renderer/src/components/ai-elements/ui/' + target.replace(prefix, '')
    }
  }
  return `src/renderer/src/components/ai-elements/${target}`
}

function rewriteContent(content) {
  // Registry source files import via several aliases depending on the
  // upstream registry's style. Normalize everything to our layout where
  // primitives live under `@/components/ai-elements/ui/...` and AI Elements
  // components live under `@/components/ai-elements/...`.
  return content
    .replace(/@\/registry\/[^/]+\/ui\//g, '@/components/ai-elements/ui/')
    .replace(/@\/registry\/[^/]+\/ai-elements\//g, '@/components/ai-elements/')
    .replace(/@\/components\/ui\//g, '@/components/ai-elements/ui/')
}

async function installItem(url) {
  const item = await fetchJson(url)
  for (const dep of item.dependencies ?? []) allDeps.add(dep)

  for (const file of item.files ?? []) {
    const targetRel = rewriteTarget(file.target ?? file.path)
    const fullPath = join(ROOT, targetRel)
    mkdirSync(dirname(fullPath), { recursive: true })
    const content = rewriteContent(file.content)
    writeFileSync(fullPath, content)
    filesWritten.push(targetRel)
  }

  // Resolve registry dependencies (shadcn primitives).
  for (const regDep of item.registryDependencies ?? []) {
    const depUrl = regDep.startsWith('http') ? regDep : `${SHADCN_BASE}/${regDep}.json`
    await installItem(depUrl)
  }
}

async function main() {
  for (const name of COMPONENTS) {
    console.log(`→ ${name}`)
    try {
      await installItem(`${REGISTRY_BASE}/${name}.json`)
    } catch (err) {
      console.warn(`  skipped: ${err.message}`)
    }
  }

  console.log(`\nWrote ${filesWritten.length} files. npm-installing ${allDeps.size} dependencies…`)
  if (allDeps.size > 0) {
    const list = [...allDeps].filter(d => d !== 'react' && d !== 'react-dom').join(' ')
    if (list) {
      execSync(`npm install --ignore-scripts ${list}`, { stdio: 'inherit', cwd: ROOT })
    }
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
