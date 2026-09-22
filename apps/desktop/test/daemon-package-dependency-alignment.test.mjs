import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'

const ROOT_DIR = resolve(import.meta.dirname, '..')
const SDK_DEPENDENCIES = [
  '@anthropic-ai/claude-agent-sdk',
  '@openai/codex-sdk',
]

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

test('daemon SDK pins match the monorepo root resolutions', async () => {
  const [rootLock, daemonPackage, daemonLock] = await Promise.all([
    readJson(join(ROOT_DIR, 'package-lock.json')),
    readJson(join(ROOT_DIR, 'packages', 'codesurf-daemon', 'package.json')),
    readJson(join(ROOT_DIR, 'packages', 'codesurf-daemon', 'package-lock.json')),
  ])

  for (const dependency of SDK_DEPENDENCIES) {
    const rootResolution = rootLock.packages?.[`node_modules/${dependency}`]?.version
    assert.ok(rootResolution, `${dependency} must have a root lock resolution`)
    assert.equal(
      daemonPackage.dependencies?.[dependency],
      rootResolution,
      `${dependency} daemon dependency must pin the monorepo root resolution`,
    )
    assert.equal(
      daemonLock.packages?.[`node_modules/${dependency}`]?.version,
      rootResolution,
      `${dependency} daemon and root lock resolutions must match`,
    )
  }
})
