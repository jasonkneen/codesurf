import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildInstructionPrompt, loadInstructionContext } from '../bin/instruction-context.mjs'
import {
  MAX_CONTEXT_FILE_BYTES,
  MAX_IMPORT_DEPTH,
  MAX_IMPORT_TRAVERSAL_ATTEMPTS,
  MAX_INSTRUCTION_SECTIONS,
} from '../bin/context-budget.mjs'
import { loadMemoryContext } from '../bin/memory-loader.mjs'

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-instruction-context-'))
  const homeDir = join(root, 'home')
  const workspaceDir = join(root, 'workspace')
  await mkdir(join(homeDir, '.codesurf'), { recursive: true })
  await mkdir(join(workspaceDir, '.codesurf'), { recursive: true })
  return { root, homeDir, workspaceDir }
}

async function loadWithCanonicalParity(options) {
  const legacy = await loadInstructionContext(options)
  const canonical = await loadMemoryContext(options)
  const expected = {
    sections: canonical.includedSections,
    budget: canonical.budget,
    ...(canonical.notices ? { notices: canonical.notices } : {}),
  }

  assert.deepEqual(legacy, expected)
  assert.strictEqual(legacy.sections, legacy.budget.fragments)
  return legacy
}

function assertPromptIsDeterministicAndPure(context) {
  const beforePrompt = structuredClone(context)
  const prompt = buildInstructionPrompt(context)

  assert.equal(buildInstructionPrompt(context), prompt)
  assert.deepEqual(context, beforePrompt)
  return prompt
}

async function captureRejection(operation) {
  try {
    await operation()
  } catch (error) {
    assert.ok(error instanceof Error)
    return error
  }

  assert.fail('Expected operation to reject')
}

async function assertCanonicalRejectionParity(options, expectedPattern) {
  const adapterError = await captureRejection(() => loadInstructionContext(options))
  const canonicalError = await captureRejection(() => loadMemoryContext(options))

  assert.equal(adapterError.name, canonicalError.name)
  assert.equal(adapterError.message, canonicalError.message)
  assert.match(adapterError.message, expectedPattern)
}

test('legacy manually constructed instruction context keeps a deterministic canonical prompt contract', () => {
  const content = 'Preserve the public instruction context contract'
  const section = {
    scope: 'workspace',
    bucket: 'remote-safe',
    displayPath: 'AGENTS.md',
    path: '/workspace/AGENTS.md',
    source: '/workspace/AGENTS.md',
    precedence: 0,
    content,
    originalBytes: Buffer.byteLength(content, 'utf8'),
    includedBytes: Buffer.byteLength(content, 'utf8'),
    truncated: false,
    truncationReason: null,
  }
  const context = {
    sections: [section],
    budget: {
      fragments: [section],
      omitted: [],
      originalSectionCount: 1,
      includedSectionCount: 1,
      omittedSectionCount: 0,
      omittedByCount: 0,
      omittedByAggregate: 0,
      truncatedByAggregate: 0,
      includedBytes: Buffer.byteLength(content, 'utf8'),
      reservedBytes: 0,
      maxSections: MAX_INSTRUCTION_SECTIONS,
      maxBytes: 128 * 1024,
    },
  }

  assert.equal(
    assertPromptIsDeterministicAndPure(context),
    [
      '## Workspace Instructions',
      'Follow these layered instructions in addition to the user request. If they conflict, later sections override earlier ones.',
      '',
      '### Workspace Instructions [remote-safe] (AGENTS.md)',
      content,
    ].join('\n'),
  )
})

test('daemon local execution loads layered user and workspace instruction files in precedence order', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  await writeFile(join(fixture.homeDir, '.codesurf', 'AGENTS.md'), 'User instruction layer', 'utf8')
  await writeFile(join(fixture.workspaceDir, 'AGENTS.md'), 'Workspace instruction layer', 'utf8')
  await writeFile(join(fixture.workspaceDir, '.codesurf', 'AGENTS.md'), 'Workspace local instruction layer', 'utf8')

  const context = await loadWithCanonicalParity({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'local',
  })

  assert.deepEqual(
    context.sections.map(section => ({ scope: section.scope, displayPath: section.displayPath, content: section.content })),
    [
      { scope: 'user', displayPath: '~/.codesurf/AGENTS.md', content: 'User instruction layer' },
      { scope: 'workspace', displayPath: 'AGENTS.md', content: 'Workspace instruction layer' },
      { scope: 'workspace-local', displayPath: '.codesurf/AGENTS.md', content: 'Workspace local instruction layer' },
    ],
  )

  const prompt = assertPromptIsDeterministicAndPure(context)
  assert.deepEqual(Object.keys(context).sort(), ['budget', 'sections'])
  assert.match(prompt, /^## Workspace Instructions/)
  assert.match(prompt, /### User Instructions \[local-only\] \(~\/\.codesurf\/AGENTS\.md\)/)
  assert.match(prompt, /### Workspace Instructions \[remote-safe\] \(AGENTS\.md\)/)
  assert.match(prompt, /### Workspace Local Instructions \[local-only\] \(\.codesurf\/AGENTS\.md\)/)
  assert.match(prompt, /User instruction layer[\s\S]*Workspace instruction layer[\s\S]*Workspace local instruction layer/)
  assert.match(prompt, /later sections override earlier ones/i)
})

test('daemon instruction adapter follows recursive imports in deterministic precedence order', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  await mkdir(join(fixture.workspaceDir, 'rules'), { recursive: true })
  await writeFile(
    join(fixture.workspaceDir, 'AGENTS.md'),
    'Workspace root instruction\n@import ./rules/one.md',
    'utf8',
  )
  await writeFile(
    join(fixture.workspaceDir, 'rules', 'one.md'),
    'First imported instruction\n@import ./two.md',
    'utf8',
  )
  await writeFile(join(fixture.workspaceDir, 'rules', 'two.md'), 'Second imported instruction', 'utf8')

  const context = await loadWithCanonicalParity({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'local',
  })

  assert.deepEqual(
    context.sections.map(section => ({
      displayPath: section.displayPath,
      importedFrom: section.importedFrom,
      content: section.content,
    })),
    [
      {
        displayPath: 'AGENTS.md',
        importedFrom: null,
        content: 'Workspace root instruction',
      },
      {
        displayPath: 'rules/one.md',
        importedFrom: 'AGENTS.md',
        content: 'First imported instruction',
      },
      {
        displayPath: 'rules/two.md',
        importedFrom: 'rules/one.md',
        content: 'Second imported instruction',
      },
    ],
  )
  assert.match(
    buildInstructionPrompt(context),
    /Workspace root instruction[\s\S]*First imported instruction[\s\S]*Second imported instruction/,
  )
})

test('daemon instruction adapter exposes the canonical primary workspace candidate set', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  await mkdir(join(fixture.workspaceDir, '.claude'), { recursive: true })
  await writeFile(join(fixture.workspaceDir, '.codesurf', 'DREAMING.md'), 'Private dreaming context', 'utf8')
  await writeFile(join(fixture.workspaceDir, 'CLAUDE.md'), 'Remote-safe Claude context', 'utf8')
  await writeFile(join(fixture.workspaceDir, '.claude', 'CLAUDE.md'), 'Private Claude context', 'utf8')

  const local = await loadWithCanonicalParity({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'local',
  })
  assert.deepEqual(
    local.sections.map(section => ({
      displayPath: section.displayPath,
      bucket: section.bucket,
    })),
    [
      { displayPath: '.codesurf/DREAMING.md', bucket: 'local-only' },
      { displayPath: 'CLAUDE.md', bucket: 'remote-safe' },
      { displayPath: '.claude/CLAUDE.md', bucket: 'local-only' },
    ],
  )

  const cloud = await loadWithCanonicalParity({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'cloud',
  })
  assert.deepEqual(
    cloud.sections.map(section => ({
      displayPath: section.displayPath,
      bucket: section.bucket,
    })),
    [
      { displayPath: 'CLAUDE.md', bucket: 'remote-safe' },
    ],
  )
})

test('daemon instruction adapter ignores missing roots and imports without fabricating omissions', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  let context = await loadWithCanonicalParity({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'local',
  })
  assert.deepEqual(context.sections, [])
  assert.deepEqual(context.budget.omissions, [])
  assert.equal(buildInstructionPrompt(context), undefined)

  await writeFile(
    join(fixture.workspaceDir, 'AGENTS.md'),
    'Available workspace instruction\n@import ./missing-rules.md',
    'utf8',
  )
  context = await loadWithCanonicalParity({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'local',
  })

  assert.deepEqual(context.sections.map(section => section.content), ['Available workspace instruction'])
  assert.deepEqual(context.budget.omissions, [])
  assert.equal(context.notices, undefined)
})

test('daemon cloud execution excludes host home instructions but keeps workspace instructions', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  await writeFile(join(fixture.homeDir, '.codesurf', 'AGENTS.md'), 'User instruction layer', 'utf8')
  await writeFile(join(fixture.workspaceDir, 'AGENTS.md'), 'Workspace instruction layer', 'utf8')

  const context = await loadWithCanonicalParity({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'cloud',
  })

  assert.deepEqual(
    context.sections.map(section => ({ scope: section.scope, displayPath: section.displayPath, content: section.content })),
    [
      { scope: 'workspace', displayPath: 'AGENTS.md', content: 'Workspace instruction layer' },
    ],
  )

  const prompt = buildInstructionPrompt(context)
  assert.match(prompt, /Workspace instruction layer/)
  assert.doesNotMatch(prompt, /User instruction layer/)
})

test('daemon instruction adapter classifies a public symlink alias into .codesurf before cloud filtering', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  await writeFile(join(fixture.workspaceDir, '.codesurf', 'secret.md'), 'Local alias instruction', 'utf8')
  await symlink('.codesurf', join(fixture.workspaceDir, 'public-alias'))
  await writeFile(
    join(fixture.workspaceDir, 'AGENTS.md'),
    'Remote-safe workspace instruction\n@import ./public-alias/secret.md',
    'utf8',
  )

  const local = await loadWithCanonicalParity({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'local',
  })
  assert.deepEqual(
    local.sections.map(section => ({
      displayPath: section.displayPath,
      bucket: section.bucket,
      content: section.content,
    })),
    [
      {
        displayPath: 'AGENTS.md',
        bucket: 'remote-safe',
        content: 'Remote-safe workspace instruction',
      },
      {
        displayPath: '.codesurf/secret.md',
        bucket: 'local-only',
        content: 'Local alias instruction',
      },
    ],
  )

  const cloud = await loadWithCanonicalParity({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'cloud',
  })
  assert.deepEqual(
    cloud.sections.map(section => ({
      displayPath: section.displayPath,
      bucket: section.bucket,
      content: section.content,
    })),
    [
      {
        displayPath: 'AGENTS.md',
        bucket: 'remote-safe',
        content: 'Remote-safe workspace instruction',
      },
    ],
  )
  assert.doesNotMatch(JSON.stringify(cloud), /Local alias instruction|public-alias|\.codesurf\/secret\.md/)
})

test('instruction prompt is omitted when no non-empty instruction files exist', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  await writeFile(join(fixture.workspaceDir, 'AGENTS.md'), '   \n\n', 'utf8')

  const context = await loadInstructionContext({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'local',
  })

  assert.deepEqual(context.sections, [])
  assert.equal(buildInstructionPrompt(context), undefined)
})

test('workspace instruction files must not follow symlinks outside the workspace root', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  const escapedPath = join(fixture.root, 'escaped-secret.txt')
  await writeFile(escapedPath, 'Do not leak this file', 'utf8')
  await symlink(escapedPath, join(fixture.workspaceDir, 'AGENTS.md'))

  await assertCanonicalRejectionParity(
    {
      homeDir: fixture.homeDir,
      workspaceDir: fixture.workspaceDir,
      executionTarget: 'local',
    },
    /outside the workspace root|symlink/i,
  )
})

test('workspace instruction files must not escape through symlinked parent directories', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  const escapedDir = join(fixture.root, 'escaped-dir')
  await mkdir(escapedDir, { recursive: true })
  await writeFile(join(escapedDir, 'AGENTS.md'), 'Leaked through parent symlink', 'utf8')
  await rm(join(fixture.workspaceDir, '.codesurf'), { recursive: true, force: true })
  await symlink(escapedDir, join(fixture.workspaceDir, '.codesurf'))

  await assertCanonicalRejectionParity(
    {
      homeDir: fixture.homeDir,
      workspaceDir: fixture.workspaceDir,
      executionTarget: 'local',
    },
    /outside the workspace root|symlink/i,
  )
})

test('instruction imports cannot escape the workspace through symlinks', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  const rulesDir = join(fixture.workspaceDir, 'rules')
  const escapedPath = join(fixture.root, 'escaped-import.md')
  await mkdir(rulesDir, { recursive: true })
  await writeFile(escapedPath, 'Do not import this file', 'utf8')
  await symlink(escapedPath, join(rulesDir, 'escaped.md'))
  await writeFile(
    join(fixture.workspaceDir, 'AGENTS.md'),
    'Workspace instruction\n@import ./rules/escaped.md',
    'utf8',
  )

  await assertCanonicalRejectionParity(
    {
      homeDir: fixture.homeDir,
      workspaceDir: fixture.workspaceDir,
      executionTarget: 'local',
    },
    /outside the workspace root/i,
  )
})

test('unexpected instruction file read errors are surfaced instead of silently ignored', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  await mkdir(join(fixture.workspaceDir, '.codesurf', 'AGENTS.md'), { recursive: true })

  await assertCanonicalRejectionParity(
    {
      homeDir: fixture.homeDir,
      workspaceDir: fixture.workspaceDir,
      executionTarget: 'local',
    },
    /AGENTS\.md|EISDIR/i,
  )
})

test('unexpected imported instruction read errors match the canonical loader', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  await mkdir(join(fixture.workspaceDir, 'rules', 'directory.md'), { recursive: true })
  await writeFile(
    join(fixture.workspaceDir, 'AGENTS.md'),
    'Workspace instruction\n@import ./rules/directory.md',
    'utf8',
  )

  await assertCanonicalRejectionParity(
    {
      homeDir: fixture.homeDir,
      workspaceDir: fixture.workspaceDir,
      executionTarget: 'local',
    },
    /directory\.md|EISDIR/i,
  )
})

test('instruction files at the byte limit stay identical and one-byte-over UTF-8 files are visibly truncated', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  const exact = 'é'.repeat(MAX_CONTEXT_FILE_BYTES / 2)
  await writeFile(join(fixture.workspaceDir, 'AGENTS.md'), exact, 'utf8')
  let context = await loadWithCanonicalParity({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'local',
  })

  assert.equal(context.sections[0].content, exact)
  assert.equal(context.sections[0].originalBytes, MAX_CONTEXT_FILE_BYTES)
  assert.equal(context.sections[0].includedBytes, MAX_CONTEXT_FILE_BYTES)
  assert.equal(context.sections[0].truncated, false)

  const oneByteOver = `${'a'.repeat(MAX_CONTEXT_FILE_BYTES - 1)}é`
  await writeFile(join(fixture.workspaceDir, 'AGENTS.md'), oneByteOver, 'utf8')
  context = await loadWithCanonicalParity({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'local',
  })

  assert.equal(context.sections[0].originalBytes, MAX_CONTEXT_FILE_BYTES + 1)
  assert.equal(context.sections[0].truncated, true)
  assert.match(context.sections[0].content, /maximum context file bytes/)
  assert.ok(Buffer.byteLength(context.sections[0].content, 'utf8') <= MAX_CONTEXT_FILE_BYTES)
  assert.doesNotMatch(context.sections[0].content, /\uFFFD/)
})

test('daemon instruction adapter exposes canonical depth, item, and I/O quota omissions', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  const rulesDir = join(fixture.workspaceDir, 'rules')
  await mkdir(rulesDir, { recursive: true })
  await writeFile(
    join(fixture.workspaceDir, 'AGENTS.md'),
    'Depth root instruction\n@import ./rules/1.md',
    'utf8',
  )
  for (let depth = 1; depth <= MAX_IMPORT_DEPTH + 1; depth += 1) {
    const nextImport = depth <= MAX_IMPORT_DEPTH ? `\n@import ./${depth + 1}.md` : ''
    await writeFile(join(rulesDir, `${depth}.md`), `Depth instruction ${depth}${nextImport}`, 'utf8')
  }

  let context = await loadWithCanonicalParity({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'local',
  })
  assert.equal(context.budget.maxFileBytes, MAX_CONTEXT_FILE_BYTES)
  assert.equal(context.budget.maxImportDepth, MAX_IMPORT_DEPTH)
  assert.equal(context.budget.maxSections, MAX_INSTRUCTION_SECTIONS)
  assert.equal(context.budget.maxImportTraversalAttempts, MAX_IMPORT_TRAVERSAL_ATTEMPTS)
  assert.equal(context.budget.omittedByDepth, 1)
  assert.ok(context.budget.omissions.some(item =>
    item.displayPath === `rules/${MAX_IMPORT_DEPTH + 1}.md`
      && /maximum import depth/.test(item.truncationReason),
  ))
  assert.match(context.notices?.[0] ?? '', /omitted by maximum import depth/)
  const depthPrompt = assertPromptIsDeterministicAndPure(context)
  assert.doesNotMatch(depthPrompt, new RegExp(`Depth instruction ${MAX_IMPORT_DEPTH + 1}`))

  const itemImports = []
  const itemDir = join(fixture.workspaceDir, 'items')
  await mkdir(itemDir, { recursive: true })
  for (let index = 0; index <= MAX_INSTRUCTION_SECTIONS; index += 1) {
    itemImports.push(`@import ./items/${index}.md`)
    await writeFile(join(itemDir, `${index}.md`), `Item instruction ${index}`, 'utf8')
  }
  await writeFile(
    join(fixture.workspaceDir, 'AGENTS.md'),
    `Item quota root instruction\n${itemImports.join('\n')}`,
    'utf8',
  )
  context = await loadWithCanonicalParity({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'local',
  })
  assert.equal(context.sections.length, MAX_INSTRUCTION_SECTIONS)
  assert.ok(context.budget.omittedBySectionLimit > 0)
  assert.ok(context.budget.omissions.some(item =>
    /maximum included instruction sections/.test(item.truncationReason),
  ))
  assert.match(context.notices?.[0] ?? '', /maximum included instruction sections/)
  assert.match(assertPromptIsDeterministicAndPure(context), /maximum included instruction sections/)

  const missingImports = Array.from(
    { length: MAX_IMPORT_TRAVERSAL_ATTEMPTS + 1 },
    (_, index) => `@import ./missing/${index}.md`,
  )
  await writeFile(
    join(fixture.workspaceDir, 'AGENTS.md'),
    `I/O quota root instruction\n${missingImports.join('\n')}`,
    'utf8',
  )
  context = await loadWithCanonicalParity({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'local',
  })
  assert.equal(context.budget.omittedByTraversalAttempts, 1)
  assert.ok(context.budget.omissions.some(item =>
    /maximum import traversal attempts/.test(item.truncationReason),
  ))
  assert.match(context.notices?.[0] ?? '', /maximum import traversal attempts/)
  assert.match(assertPromptIsDeterministicAndPure(context), /maximum import traversal attempts/)
})
