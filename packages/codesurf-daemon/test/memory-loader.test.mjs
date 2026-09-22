import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildMemoryPrompt, describeMemoryContextForTool, loadMemoryContext } from '../bin/memory-loader.mjs'
import {
  MAX_AGGREGATE_INSTRUCTION_BYTES,
  MAX_CONTEXT_FILE_BYTES,
  MAX_IMPORT_CANONICAL_VALIDATION_ATTEMPTS,
  MAX_IMPORT_DEPTH,
  MAX_IMPORT_TRAVERSAL_ATTEMPTS,
  MAX_INSTRUCTION_SECTIONS,
  MAX_ROOT_TRAVERSAL_ATTEMPTS,
} from '../bin/context-budget.mjs'
import {
  makeDaemonTestTempDir as makeTestTempDir,
  spawnDaemon,
} from './helpers/spawn-daemon.mjs'

async function startDaemon() {
  return await spawnDaemon({
    homePrefix: 'codesurfd-memory-loader-',
    appVersion: 'memory-loader-test',
  })
}

test('daemon memory loader returns layered AGENTS context, imports, buckets, and cloud-safe prompt selection', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceDir = join(daemon.homeDir, 'project-root')
  const nestedProjectDir = join(workspaceDir, 'packages', 'app')
  await mkdir(join(daemon.homeDir, '.codesurf', 'imports'), { recursive: true })
  await mkdir(join(workspaceDir, '.codesurf'), { recursive: true })
  await mkdir(join(workspaceDir, 'rules'), { recursive: true })
  await mkdir(join(nestedProjectDir, '.codesurf'), { recursive: true })

  await writeFile(join(daemon.homeDir, '.codesurf', 'AGENTS.md'), 'User instruction layer', 'utf8')
  await writeFile(join(workspaceDir, 'AGENTS.md'), 'Workspace instruction layer\n@import ./rules/root-extra.md', 'utf8')
  await writeFile(join(workspaceDir, 'rules', 'root-extra.md'), 'Imported workspace rule', 'utf8')
  await writeFile(join(workspaceDir, '.codesurf', 'AGENTS.md'), 'Workspace local instruction layer', 'utf8')
  await writeFile(join(nestedProjectDir, 'AGENTS.md'), 'Nested workspace instruction layer', 'utf8')
  await writeFile(join(nestedProjectDir, '.codesurf', 'AGENTS.md'), 'Nested workspace local instruction layer', 'utf8')

  let response = await daemon.request('/workspace/create-with-path', {
    body: {
      name: 'Memory Workspace',
      projectPath: workspaceDir,
    },
  })
  assert.equal(response.status, 200)
  const workspaceId = response.payload.id

  response = await daemon.request('/workspace/add-project-folder', {
    body: {
      workspaceId,
      folderPath: nestedProjectDir,
    },
  })
  assert.equal(response.status, 200)

  response = await daemon.request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=local`)
  assert.equal(response.status, 200)
  assert.deepEqual(
    response.payload.sections.map(section => ({
      scope: section.scope,
      bucket: section.bucket,
      displayPath: section.displayPath,
      importedFrom: section.importedFrom ?? null,
      content: section.content,
    })),
    [
      { scope: 'user', bucket: 'local-only', displayPath: '~/.codesurf/AGENTS.md', importedFrom: null, content: 'User instruction layer' },
      { scope: 'workspace', bucket: 'remote-safe', displayPath: 'AGENTS.md', importedFrom: null, content: 'Workspace instruction layer' },
      { scope: 'workspace', bucket: 'remote-safe', displayPath: 'rules/root-extra.md', importedFrom: 'AGENTS.md', content: 'Imported workspace rule' },
      { scope: 'workspace-local', bucket: 'local-only', displayPath: '.codesurf/AGENTS.md', importedFrom: null, content: 'Workspace local instruction layer' },
      { scope: 'nested-workspace', bucket: 'remote-safe', displayPath: 'packages/app/AGENTS.md', importedFrom: null, content: 'Nested workspace instruction layer' },
      { scope: 'nested-workspace-local', bucket: 'local-only', displayPath: 'packages/app/.codesurf/AGENTS.md', importedFrom: null, content: 'Nested workspace local instruction layer' },
    ],
  )
  assert.deepEqual(response.payload.includedBuckets, ['local-only', 'remote-safe'])
  assert.match(response.payload.prompt, /User instruction layer[\s\S]*Workspace instruction layer[\s\S]*Imported workspace rule[\s\S]*Workspace local instruction layer[\s\S]*Nested workspace instruction layer[\s\S]*Nested workspace local instruction layer/)

  response = await daemon.request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=cloud`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload.includedBuckets, ['remote-safe'])
  assert.match(response.payload.prompt, /Workspace instruction layer[\s\S]*Imported workspace rule[\s\S]*Nested workspace instruction layer/)
  assert.doesNotMatch(response.payload.prompt, /User instruction layer|Workspace local instruction layer|Nested workspace local instruction layer/)
})

test('daemon memory loader includes CLAUDE.md layers with the same bucket rules as AGENTS', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceDir = join(daemon.homeDir, 'project-claude-memory')
  await mkdir(join(daemon.homeDir, '.claude'), { recursive: true })
  await mkdir(join(workspaceDir, '.claude'), { recursive: true })

  await writeFile(join(daemon.homeDir, '.claude', 'CLAUDE.md'), 'User Claude layer', 'utf8')
  await writeFile(join(workspaceDir, 'CLAUDE.md'), 'Workspace Claude layer', 'utf8')
  await writeFile(join(workspaceDir, '.claude', 'CLAUDE.md'), 'Workspace Claude local layer', 'utf8')

  let response = await daemon.request('/workspace/create-with-path', {
    body: {
      name: 'Claude Memory Workspace',
      projectPath: workspaceDir,
    },
  })
  assert.equal(response.status, 200)
  const workspaceId = response.payload.id

  response = await daemon.request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=local`)
  assert.equal(response.status, 200)
  assert.deepEqual(
    response.payload.sections.map(section => ({
      scope: section.scope,
      bucket: section.bucket,
      displayPath: section.displayPath,
      content: section.content,
    })),
    [
      { scope: 'user', bucket: 'local-only', displayPath: '~/.claude/CLAUDE.md', content: 'User Claude layer' },
      { scope: 'workspace', bucket: 'remote-safe', displayPath: 'CLAUDE.md', content: 'Workspace Claude layer' },
      { scope: 'workspace-local', bucket: 'local-only', displayPath: '.claude/CLAUDE.md', content: 'Workspace Claude local layer' },
    ],
  )
  assert.match(response.payload.prompt, /User Claude layer[\s\S]*Workspace Claude layer[\s\S]*Workspace Claude local layer/)

  response = await daemon.request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=cloud`)
  assert.equal(response.status, 200)
  assert.match(response.payload.prompt, /Workspace Claude layer/)
  assert.doesNotMatch(response.payload.prompt, /User Claude layer|Workspace Claude local layer/)
})

test('daemon memory loader formats expandable Workspace Instructions details from the exact injected prompt', () => {
  const context = {
    includedBuckets: ['remote-safe'],
    sections: [
      {
        scope: 'workspace',
        bucket: 'remote-safe',
        displayPath: 'AGENTS.md',
        content: 'Workspace rule A',
      },
      {
        scope: 'workspace',
        bucket: 'remote-safe',
        displayPath: 'CLAUDE.md',
        content: 'Workspace rule B',
      },
      {
        scope: 'workspace-local',
        bucket: 'local-only',
        displayPath: '.claude/CLAUDE.md',
        content: 'Keep this local-only rule out of cloud runs',
      },
    ],
  }
  const prompt = buildMemoryPrompt({
    sections: context.sections.filter(section => context.includedBuckets.includes(section.bucket)),
  })

  const details = describeMemoryContextForTool(context, prompt)

  assert.equal(details.summary, 'Loaded 2 instruction sections (remote-safe): AGENTS.md, CLAUDE.md')
  assert.match(details.input, /## Workspace Instructions/)
  assert.match(details.input, /### Workspace Instructions \[remote-safe\] \(AGENTS.md\)/)
  assert.match(details.input, /Workspace rule A/)
  assert.match(details.input, /### Workspace Instructions \[remote-safe\] \(CLAUDE.md\)/)
  assert.match(details.input, /Workspace rule B/)
  assert.doesNotMatch(details.input, /local-only rule/)
})

test('daemon memory loader keeps imported local-only files out of cloud prompts and avoids self-import duplication', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceDir = join(daemon.homeDir, 'project-import-buckets')
  await mkdir(join(workspaceDir, '.codesurf'), { recursive: true })
  await writeFile(
    join(workspaceDir, 'AGENTS.md'),
    'Workspace instruction layer\n@import ./.codesurf/local-extra.md\n@import ./AGENTS.md',
    'utf8',
  )
  await writeFile(join(workspaceDir, '.codesurf', 'local-extra.md'), 'Imported local-only rule\n@import ../AGENTS.md', 'utf8')

  let response = await daemon.request('/workspace/create-with-path', {
    body: {
      name: 'Import Bucket Workspace',
      projectPath: workspaceDir,
    },
  })
  assert.equal(response.status, 200)
  const workspaceId = response.payload.id

  response = await daemon.request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=local`)
  assert.equal(response.status, 200)
  assert.deepEqual(
    response.payload.sections.map(section => ({
      scope: section.scope,
      bucket: section.bucket,
      displayPath: section.displayPath,
      importedFrom: section.importedFrom ?? null,
      content: section.content,
    })),
    [
      { scope: 'workspace', bucket: 'remote-safe', displayPath: 'AGENTS.md', importedFrom: null, content: 'Workspace instruction layer' },
      { scope: 'workspace-local', bucket: 'local-only', displayPath: '.codesurf/local-extra.md', importedFrom: 'AGENTS.md', content: 'Imported local-only rule' },
    ],
  )
  assert.match(response.payload.prompt, /Workspace instruction layer[\s\S]*Imported local-only rule/)

  response = await daemon.request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=cloud`)
  assert.equal(response.status, 200)
  assert.match(response.payload.prompt, /Workspace instruction layer/)
  assert.doesNotMatch(response.payload.prompt, /Imported local-only rule/)
})

test('daemon memory loader rejects AGENTS imports that escape the workspace through symlinks', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceDir = join(daemon.homeDir, 'project-symlink-memory')
  const outsideDir = join(daemon.homeDir, 'outside-memory')
  await mkdir(join(workspaceDir, '.codesurf'), { recursive: true })
  await mkdir(outsideDir, { recursive: true })
  await writeFile(join(outsideDir, 'secret.md'), 'Nope', 'utf8')
  await symlink(outsideDir, join(workspaceDir, 'linked'))
  await writeFile(join(workspaceDir, 'AGENTS.md'), '@import ./linked/secret.md', 'utf8')

  let response = await daemon.request('/workspace/create-with-path', {
    body: {
      name: 'Symlink Memory Workspace',
      projectPath: workspaceDir,
    },
  })
  assert.equal(response.status, 200)
  const workspaceId = response.payload.id

  response = await daemon.request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=local`)
  assert.equal(response.status, 500)
  assert.match(response.payload.error, /outside the workspace root|symlink/i)
})

test('memory files use UTF-8 byte limits and mark the first byte over the per-file ceiling', async t => {
  const homeDir = await makeTestTempDir('memory-byte-budget-')
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const exact = 'é'.repeat(MAX_CONTEXT_FILE_BYTES / 2)
  await writeFile(join(workspaceDir, 'AGENTS.md'), exact, 'utf8')
  let context = await loadMemoryContext({
    homeDir,
    workspaceDir,
    projectPaths: [workspaceDir],
  })
  let section = context.sections.find(entry => entry.displayPath === 'AGENTS.md')
  assert.equal(section.content, exact)
  assert.equal(section.originalBytes, MAX_CONTEXT_FILE_BYTES)
  assert.equal(section.includedBytes, MAX_CONTEXT_FILE_BYTES)
  assert.equal(section.truncated, false)

  const oneByteOver = `${'a'.repeat(MAX_CONTEXT_FILE_BYTES - 1)}é`
  await writeFile(join(workspaceDir, 'AGENTS.md'), oneByteOver, 'utf8')
  context = await loadMemoryContext({
    homeDir,
    workspaceDir,
    projectPaths: [workspaceDir],
  })
  section = context.sections.find(entry => entry.displayPath === 'AGENTS.md')
  assert.equal(section.originalBytes, MAX_CONTEXT_FILE_BYTES + 1)
  assert.equal(section.truncated, true)
  assert.match(section.content, /maximum context file bytes/)
  assert.ok(Buffer.byteLength(section.content, 'utf8') <= MAX_CONTEXT_FILE_BYTES)
  assert.doesNotMatch(section.content, /\uFFFD/)
})

test('a nine-level import chain stops after depth eight with visible omission metadata', async t => {
  const homeDir = await makeTestTempDir('memory-import-depth-')
  const workspaceDir = join(homeDir, 'workspace')
  const rulesDir = join(workspaceDir, 'rules')
  await mkdir(rulesDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  await writeFile(join(workspaceDir, 'AGENTS.md'), '@import ./rules/1.md', 'utf8')
  for (let depth = 1; depth <= 9; depth += 1) {
    const next = depth < 9 ? `\n@import ./${depth + 1}.md` : ''
    await writeFile(join(rulesDir, `${depth}.md`), `depth-${depth}${next}`, 'utf8')
  }

  const context = await loadMemoryContext({
    homeDir,
    workspaceDir,
    projectPaths: [workspaceDir],
  })

  assert.match(context.prompt, /depth-8/)
  assert.doesNotMatch(context.prompt, /depth-9/)
  assert.equal(context.budget.maxImportDepth, MAX_IMPORT_DEPTH)
  assert.equal(context.budget.omittedByDepth, 1)
  assert.ok(context.budget.omissions.some(item => item.displayPath === 'rules/9.md' && /maximum import depth/.test(item.truncationReason)))
  assert.match(context.prompt, /import omitted by maximum import depth/)
  assert.match(context.contextBuckets.inspect.summary, /omitted by context budgets/)
})

test('more than 32 unique imports stays bounded and reports the import-count overflow', async t => {
  const homeDir = await makeTestTempDir('memory-import-count-')
  const workspaceDir = join(homeDir, 'workspace')
  const rulesDir = join(workspaceDir, 'rules')
  const outsideDir = join(homeDir, 'outside-rules')
  await mkdir(rulesDir, { recursive: true })
  await mkdir(outsideDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const imports = []
  for (let index = 0; index < 40; index += 1) {
    imports.push(`@import ./rules/${index}.md`)
    if (index < 8) {
      const outsidePath = join(outsideDir, `${index}.md`)
      await writeFile(outsidePath, `must-not-be-read-${index}`, 'utf8')
      await symlink(outsidePath, join(rulesDir, `${index}.md`))
    } else {
      await writeFile(join(rulesDir, `${index}.md`), `rule-${index}`, 'utf8')
    }
  }
  await writeFile(join(workspaceDir, 'AGENTS.md'), `root-rule\n${imports.join('\n')}`, 'utf8')

  const context = await loadMemoryContext({
    homeDir,
    workspaceDir,
    projectPaths: [workspaceDir],
  })

  assert.ok(context.includedSections.length <= MAX_INSTRUCTION_SECTIONS)
  assert.equal(context.sections.length, MAX_INSTRUCTION_SECTIONS)
  assert.ok(context.budget.omittedByImportCount > 0)
  assert.ok(context.budget.omittedBySectionLimit > 0)
  assert.match(context.prompt, /rule-39/)
  assert.doesNotMatch(context.prompt, /root-rule|must-not-be-read/)
  assert.match(context.prompt, /maximum included instruction sections/)
  assert.ok(context.budget.omissions.some(item =>
    item.source === 'memory-parent-section-limit'
    && /maximum included instruction sections/.test(item.truncationReason),
  ))
})

test('section limits count loaded content instead of nonexistent root candidates', async t => {
  const homeDir = await makeTestTempDir('memory-missing-root-budget-')
  const workspaceDir = join(homeDir, 'workspace')
  const blockedProjectDir = join(homeDir, 'aaa-blocked-project')
  const outsideDir = join(homeDir, 'outside-root-candidates')
  await mkdir(workspaceDir, { recursive: true })
  await mkdir(blockedProjectDir, { recursive: true })
  await mkdir(outsideDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  await writeFile(join(workspaceDir, 'AGENTS.md'), 'PRIMARY-WORKSPACE-RULE-SURVIVES', 'utf8')
  const blockedPath = join(outsideDir, 'blocked.md')
  await writeFile(blockedPath, 'ROOT-CANDIDATE-MUST-NOT-BE-OPENED', 'utf8')
  await symlink(blockedPath, join(blockedProjectDir, 'AGENTS.md'))
  const missingProjectPaths = Array.from(
    { length: MAX_ROOT_TRAVERSAL_ATTEMPTS * 8 },
    (_, index) => join(homeDir, 'missing', String(index), 'project'),
  )
  const context = await loadMemoryContext({
    homeDir,
    workspaceDir,
    projectPaths: [workspaceDir, blockedProjectDir, ...missingProjectPaths],
    executionTarget: 'cloud',
  })

  assert.match(context.prompt, /PRIMARY-WORKSPACE-RULE-SURVIVES/)
  assert.match(context.prompt, /maximum root traversal attempts/)
  assert.doesNotMatch(JSON.stringify(context), /ROOT-CANDIDATE-MUST-NOT-BE-OPENED/)
  assert.equal(context.budget.originalSectionCount, 1)
  assert.equal(context.budget.includedSectionCount, 1)
  assert.equal(context.budget.omittedSectionCount, 0)
  assert.equal(context.budget.omittedByImportCount, 0)
  assert.equal(context.budget.rootTraversalAttempts, MAX_ROOT_TRAVERSAL_ATTEMPTS)
  assert.equal(context.budget.primaryRootTraversalAttempts, 2)
  assert.equal(context.budget.omittedByRootTraversalAttempts, 1)
  assert.ok(context.budget.omissions.some(item =>
    item.source === 'memory-root-traversal'
    && /maximum root traversal attempts/.test(item.truncationReason),
  ))
})

test('raw section cap emits generic root overflow metadata without unwinding a 33rd section', async t => {
  const homeDir = await makeTestTempDir('memory-root-section-cap-')
  const workspaceDir = join(homeDir, 'primary-workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  await writeFile(join(workspaceDir, 'AGENTS.md'), 'LOWER-PRIMARY-RULE', 'utf8')
  const projectPaths = [workspaceDir]
  for (let index = 0; index < MAX_INSTRUCTION_SECTIONS; index += 1) {
    const projectDir = join(homeDir, 'nested', String(index), 'project')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'AGENTS.md'), `HIGHER-PROJECT-RULE-${index}`, 'utf8')
    projectPaths.push(projectDir)
  }

  const context = await loadMemoryContext({
    homeDir,
    workspaceDir,
    projectPaths,
    executionTarget: 'cloud',
  })

  assert.equal(context.sections.length, MAX_INSTRUCTION_SECTIONS)
  assert.equal(context.includedSections.length, MAX_INSTRUCTION_SECTIONS)
  assert.doesNotMatch(context.prompt, /LOWER-PRIMARY-RULE/)
  assert.match(context.prompt, /maximum included instruction sections/)
  assert.equal(context.budget.omittedBySectionLimit, 1)
  assert.ok(context.budget.omissions.some(item =>
    item.source === 'memory-root-section-limit'
    && /root branches not traversed/.test(item.truncationReason),
  ))
  assert.match(context.contextBuckets.inspect.summary, /omitted by context budgets/)
})

test('visible import I/O attempts are hard-capped without suppressing the root section', async t => {
  const homeDir = await makeTestTempDir('memory-import-traversal-budget-')
  const workspaceDir = join(homeDir, 'workspace')
  const rulesDir = join(workspaceDir, 'rules')
  const outsideDir = join(homeDir, 'outside')
  await mkdir(rulesDir, { recursive: true })
  await mkdir(outsideDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const blockedPath = join(outsideDir, 'blocked.md')
  await writeFile(blockedPath, 'MUST-NOT-BE-OPENED', 'utf8')
  await symlink(blockedPath, join(rulesDir, 'blocked.md'))
  const imports = ['@import ./rules/blocked.md']
  for (let index = 1; index <= MAX_IMPORT_TRAVERSAL_ATTEMPTS + 8; index += 1) {
    imports.push(`@import ./rules/${index}.md`)
    if (index % 2 === 0) {
      await writeFile(join(rulesDir, `${index}.md`), '', 'utf8')
    }
  }
  await writeFile(
    join(workspaceDir, 'AGENTS.md'),
    `ROOT-SECTION-SURVIVES-TRAVERSAL-CAP\n${imports.join('\n')}`,
    'utf8',
  )

  const context = await loadMemoryContext({
    homeDir,
    workspaceDir,
    projectPaths: [workspaceDir],
    executionTarget: 'cloud',
  })

  assert.match(context.prompt, /ROOT-SECTION-SURVIVES-TRAVERSAL-CAP/)
  assert.match(context.prompt, /maximum import traversal attempts/)
  assert.equal(context.budget.maxImportTraversalAttempts, MAX_IMPORT_TRAVERSAL_ATTEMPTS)
  assert.equal(context.budget.omittedByTraversalAttempts, 1)
  assert.ok(context.budget.omissions.some(item => /maximum import traversal attempts/.test(item.truncationReason)))
  assert.match(context.contextBuckets.inspect.summary, /omitted by context budgets/)
  assert.doesNotMatch(JSON.stringify(context), /MUST-NOT-BE-OPENED/)
})

test('aggregate allocation protects high-precedence workspace-local instructions', async t => {
  const homeDir = await makeTestTempDir('memory-precedence-budget-')
  const workspaceDir = join(homeDir, 'workspace')
  const userImportsDir = join(homeDir, '.codesurf', 'low')
  await mkdir(userImportsDir, { recursive: true })
  await mkdir(join(workspaceDir, '.codesurf'), { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const importLines = []
  for (let index = 0; index < 5; index += 1) {
    importLines.push(`@import ./low/${index}.md`)
    await writeFile(
      join(userImportsDir, `${index}.md`),
      `LOW-${index}-${'x'.repeat(MAX_CONTEXT_FILE_BYTES - 6)}`,
      'utf8',
    )
  }
  await writeFile(
    join(homeDir, '.codesurf', 'AGENTS.md'),
    `LOWEST-USER-RULE\n${importLines.join('\n')}`,
    'utf8',
  )
  await writeFile(
    join(workspaceDir, '.codesurf', 'AGENTS.md'),
    'HIGH-PRECEDENCE-WORKSPACE-LOCAL-RULE',
    'utf8',
  )

  const context = await loadMemoryContext({
    homeDir,
    workspaceDir,
    projectPaths: [workspaceDir],
    executionTarget: 'local',
  })

  assert.ok(context.budget.includedBytes <= MAX_AGGREGATE_INSTRUCTION_BYTES)
  assert.ok(Buffer.byteLength(context.prompt, 'utf8') <= MAX_AGGREGATE_INSTRUCTION_BYTES)
  assert.match(context.prompt, /HIGH-PRECEDENCE-WORKSPACE-LOCAL-RULE/)
  assert.ok(context.includedSections.some(section => section.displayPath === '.codesurf/AGENTS.md'))
  assert.ok(context.budget.omittedByAggregate > 0 || context.budget.truncatedByAggregate > 0)
})

test('cloud privacy filtering happens before aggregate allocation', async t => {
  const homeDir = await makeTestTempDir('memory-privacy-budget-')
  const workspaceDir = join(homeDir, 'workspace')
  const localRulesDir = join(workspaceDir, '.codesurf', 'local')
  await mkdir(localRulesDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  await writeFile(join(workspaceDir, 'AGENTS.md'), 'REMOTE-SAFE-RULE-SURVIVES', 'utf8')
  const imports = []
  for (let index = 0; index < 5; index += 1) {
    imports.push(`@import ./local/${index}.md`)
    await writeFile(
      join(localRulesDir, `${index}.md`),
      `LOCAL-ONLY-${index}-${'z'.repeat(MAX_CONTEXT_FILE_BYTES - 13)}`,
      'utf8',
    )
  }
  await writeFile(join(workspaceDir, '.codesurf', 'AGENTS.md'), imports.join('\n'), 'utf8')

  const context = await loadMemoryContext({
    homeDir,
    workspaceDir,
    projectPaths: [workspaceDir],
    executionTarget: 'cloud',
  })

  assert.deepEqual(context.includedBuckets, ['remote-safe'])
  assert.equal(context.budget.originalSectionCount, 1)
  assert.equal(context.budget.omittedByAggregate, 0)
  assert.match(context.prompt, /REMOTE-SAFE-RULE-SURVIVES/)
  assert.doesNotMatch(context.prompt, /LOCAL-ONLY/)
})

test('cloud filtering skips local-only imports before traversal and omission accounting', async t => {
  const homeDir = await makeTestTempDir('memory-cloud-import-privacy-')
  const workspaceDir = join(homeDir, 'workspace')
  const localRulesDir = join(workspaceDir, '.codesurf', 'local')
  await mkdir(localRulesDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const imports = []
  for (let index = 0; index < MAX_INSTRUCTION_SECTIONS + 8; index += 1) {
    imports.push(`@import ./.codesurf/local/${index}.md`)
    await writeFile(join(localRulesDir, `${index}.md`), `PRIVATE-LOCAL-${index}`, 'utf8')
  }
  imports.push('@import ./remote-safe.md')
  await writeFile(
    join(workspaceDir, 'AGENTS.md'),
    `ROOT-REMOTE-SAFE\n${imports.join('\n')}`,
    'utf8',
  )
  await writeFile(join(workspaceDir, 'remote-safe.md'), 'LAST-REMOTE-SAFE-IMPORT', 'utf8')

  const context = await loadMemoryContext({
    homeDir,
    workspaceDir,
    projectPaths: [workspaceDir],
    executionTarget: 'cloud',
  })

  assert.deepEqual(context.sections.map(section => section.displayPath), [
    'AGENTS.md',
    'remote-safe.md',
  ])
  assert.match(context.prompt, /ROOT-REMOTE-SAFE[\s\S]*LAST-REMOTE-SAFE-IMPORT/)
  assert.doesNotMatch(JSON.stringify(context), /PRIVATE-LOCAL|\.codesurf\/local/)
  assert.equal(context.budget.originalSectionCount, 2)
  assert.equal(context.budget.omittedByImportCount, 0)
  assert.equal(context.budget.omittedByDepth, 0)
  assert.doesNotMatch(context.contextBuckets.inspect.summary, /omitted by context budgets/)
})

test('cloud import privacy follows canonical paths through public symlink aliases', async t => {
  const homeDir = await makeTestTempDir('memory-cloud-canonical-privacy-')
  const workspaceDir = join(homeDir, 'workspace')
  const localDir = join(workspaceDir, '.codesurf')
  await mkdir(localDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  await writeFile(join(localDir, 'secret.md'), 'LOCAL-ONLY-ALIAS-SECRET', 'utf8')
  const aliasImports = []
  for (let index = 0; index <= MAX_IMPORT_TRAVERSAL_ATTEMPTS; index += 1) {
    const aliasName = index === 0 ? 'public-alias' : `public-alias-${index}`
    await symlink('.codesurf', join(workspaceDir, aliasName))
    aliasImports.push(`@import ./${aliasName}/secret.md`)
  }
  await writeFile(join(workspaceDir, 'remote-safe.md'), 'REMOTE-SAFE-AFTER-ALIASES', 'utf8')
  await writeFile(
    join(workspaceDir, 'AGENTS.md'),
    `REMOTE-ROOT-SURVIVES\n@import ./remote-safe.md\n${aliasImports.join('\n')}`,
    'utf8',
  )

  const cloud = await loadMemoryContext({
    homeDir,
    workspaceDir,
    projectPaths: [workspaceDir],
    executionTarget: 'cloud',
  })
  assert.deepEqual(cloud.sections.map(section => section.displayPath), ['AGENTS.md', 'remote-safe.md'])
  assert.match(cloud.prompt, /REMOTE-ROOT-SURVIVES[\s\S]*REMOTE-SAFE-AFTER-ALIASES/)
  assert.doesNotMatch(JSON.stringify(cloud), /LOCAL-ONLY-ALIAS-SECRET|public-alias|\.codesurf\/secret/)
  assert.equal(cloud.budget.omittedByImportCount, 0)
  assert.equal(cloud.budget.omittedByTraversalAttempts, 0)

  const local = await loadMemoryContext({
    homeDir,
    workspaceDir,
    projectPaths: [workspaceDir],
    executionTarget: 'local',
  })
  const imported = local.sections.find(section => section.content === 'LOCAL-ONLY-ALIAS-SECRET')
  assert.equal(imported?.bucket, 'local-only')
  assert.equal(imported?.displayPath, '.codesurf/secret.md')
  assert.match(local.prompt, /REMOTE-ROOT-SURVIVES[\s\S]*LOCAL-ONLY-ALIAS-SECRET/)
})

test('canonical import privacy validation has a non-refundable raw I/O cap', async t => {
  const homeDir = await makeTestTempDir('memory-canonical-validation-cap-')
  const workspaceDir = join(homeDir, 'workspace')
  const localDir = join(workspaceDir, '.codesurf')
  const outsideDir = join(homeDir, 'outside-canonical-cap')
  await mkdir(localDir, { recursive: true })
  await mkdir(outsideDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  await writeFile(join(localDir, 'secret.md'), 'PRIVATE-CANONICAL-CAP-CONTENT', 'utf8')
  const blockedPath = join(outsideDir, 'blocked.md')
  await writeFile(blockedPath, 'OUTSIDE-MUST-NOT-BE-VALIDATED', 'utf8')
  await symlink(blockedPath, join(workspaceDir, 'blocked-alias.md'))
  const imports = ['@import ./blocked-alias.md']
  for (let index = 0; index < MAX_IMPORT_CANONICAL_VALIDATION_ATTEMPTS + 8; index += 1) {
    const aliasName = `local-alias-${index}`
    await symlink('.codesurf', join(workspaceDir, aliasName))
    imports.push(`@import ./${aliasName}/secret.md`)
  }
  await writeFile(
    join(workspaceDir, 'AGENTS.md'),
    `ROOT-SURVIVES-CANONICAL-CAP\n${imports.join('\n')}`,
    'utf8',
  )

  const context = await loadMemoryContext({
    homeDir,
    workspaceDir,
    projectPaths: [workspaceDir],
    executionTarget: 'cloud',
  })

  assert.deepEqual(context.sections.map(section => section.displayPath), ['AGENTS.md'])
  assert.match(context.prompt, /ROOT-SURVIVES-CANONICAL-CAP/)
  assert.match(context.prompt, /maximum import canonical validation attempts/)
  assert.doesNotMatch(JSON.stringify(context), /PRIVATE-CANONICAL-CAP-CONTENT|OUTSIDE-MUST-NOT-BE-VALIDATED|blocked-alias|local-alias/)
  assert.equal(
    context.budget.importCanonicalValidationAttempts,
    MAX_IMPORT_CANONICAL_VALIDATION_ATTEMPTS,
  )
  assert.equal(context.budget.omittedByCanonicalValidationAttempts, 1)
  assert.ok(context.budget.omissions.some(item =>
    item.source === 'memory-import-canonical-validation'
    && /additional lower-precedence import paths not validated/.test(item.truncationReason),
  ))
  assert.match(context.contextBuckets.inspect.summary, /omitted by context budgets/)
})
