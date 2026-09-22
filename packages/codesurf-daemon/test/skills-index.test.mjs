import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildSkillSelectionPrompt, createSkillsIndex } from '../bin/skills-index.mjs'
import {
  MAX_CONTEXT_FILE_BYTES,
  MAX_SELECTED_SKILLS,
  MAX_SKILL_DESCRIPTION_BYTES,
  MAX_SKILLS_PROMPT_BYTES,
} from '../bin/context-budget.mjs'
import {
  makeDaemonTestTempDir as makeTestTempDir,
  spawnDaemon,
} from './helpers/spawn-daemon.mjs'

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function execPython(script, args, input = '') {
  const bins = ['python3', 'python']
  let lastError = null
  for (const bin of bins) {
    try {
      execFileSync(bin, ['-c', script, ...args], {
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('No python interpreter available')
}

function createSkillArchive(zipPath, topFolder, skillMd) {
  execPython(
    [
      'import sys, zipfile',
      'zip_path = sys.argv[1]',
      'top_folder = sys.argv[2]',
      'skill_md = sys.stdin.read()',
      'with zipfile.ZipFile(zip_path, "w") as zf:',
      '    zf.writestr(f"{top_folder}/SKILL.md", skill_md)',
      '    zf.writestr(f"{top_folder}/notes.txt", "archive note\\n")',
    ].join('\n'),
    [zipPath, topFolder],
    skillMd,
  )
}

async function startDaemon() {
  return await spawnDaemon({
    homePrefix: 'codesurfd-skills-index-',
    appVersion: 'skills-index-test',
  })
}

test('buildSkillSelectionPrompt summarizes selected workspace, global, and command entries', () => {
  const result = buildSkillSelectionPrompt({
    skills: [
      {
        id: 'workspace:lint-fix',
        name: 'lint-fix',
        description: 'Fix lint failures before commit.',
        scope: 'workspace',
        kind: 'skill',
        displayPath: '.codesurf/skills/lint-fix/SKILL.md',
      },
      {
        id: 'global:release-notes',
        name: 'release-notes',
        description: 'Write concise release notes.',
        scope: 'global',
        kind: 'skill',
        displayPath: '~/.codesurf/skills/release-notes/SKILL.md',
      },
      {
        id: 'command:/compact',
        name: '/compact',
        description: 'Compact conversation.',
        scope: 'command',
        kind: 'command',
        displayPath: 'builtin:/compact',
      },
    ],
    selection: {
      enabledIds: ['workspace:lint-fix', 'command:/compact', 'missing-skill', 'global:release-notes'],
      disabledIds: [],
    },
  })

  assert.deepEqual(result.unresolvedIds, ['missing-skill'])
  assert.equal(result.summary, 'Included 3 skills: lint-fix, /compact, release-notes')
  assert.match(result.prompt, /^## Included Skills/m)
  assert.match(result.prompt, /@lint-fix \[workspace\] — Fix lint failures before commit\./)
  assert.match(result.prompt, /@\/compact \[command\] — Compact conversation\./)
  assert.match(result.prompt, /@release-notes \[global\] — Write concise release notes\./)
})

test('selected skills cap count and UTF-8 description bytes with visible omission markers', () => {
  const skills = Array.from({ length: 30 }, (_, index) => ({
    id: `skill-${index}`,
    name: `skill-${index}`,
    description: index === 0
      ? 'é'.repeat(MAX_SKILL_DESCRIPTION_BYTES)
      : `Description ${index}.`,
    scope: 'workspace',
    kind: 'skill',
    displayPath: `.codesurf/skills/skill-${index}/SKILL.md`,
  }))
  const result = buildSkillSelectionPrompt({
    skills,
    selection: {
      enabledIds: skills.map(skill => skill.id),
      disabledIds: [],
    },
  })

  assert.equal(result.resolved.length, MAX_SELECTED_SKILLS)
  assert.equal(result.omittedCount, 30 - MAX_SELECTED_SKILLS)
  assert.equal(result.omittedIds[0], `skill-${MAX_SELECTED_SKILLS}`)
  assert.match(result.summary, /omitted 6 selected skills/)
  assert.match(result.prompt, /maximum selected skills/)
  assert.doesNotMatch(result.prompt, /@skill-29 /)
  assert.match(result.resolved[0].description, /maximum skill description bytes/)
  assert.match(result.summary, /1 skill description truncated by maximum skill description bytes/)
  assert.match(result.summary, /omitted 6 selected skills by maximum selected skills/)
  assert.ok(Buffer.byteLength(result.resolved[0].description, 'utf8') <= MAX_SKILL_DESCRIPTION_BYTES)
  assert.equal(result.metadata[0].truncated, true)
  assert.ok(Buffer.byteLength(result.prompt, 'utf8') <= MAX_SKILLS_PROMPT_BYTES)
})

test('skill selection summary reports aggregate prompt truncation', () => {
  const hugeName = 'n'.repeat(MAX_SKILLS_PROMPT_BYTES)
  const result = buildSkillSelectionPrompt({
    skills: [{
      id: 'huge-summary-skill',
      name: hugeName,
      description: 'é'.repeat(MAX_SKILL_DESCRIPTION_BYTES),
      scope: 'workspace',
      kind: 'skill',
      displayPath: '.codesurf/skills/huge-summary-skill/SKILL.md',
    }],
    selection: {
      enabledIds: ['huge-summary-skill'],
      disabledIds: [],
    },
  })

  assert.equal(result.promptMetadata.truncated, true)
  assert.match(result.summary, /^Included 1 skill \(1 skill description truncated/)
  assert.match(result.summary, /aggregate skill prompt truncated by maximum skills prompt bytes/)
})

test('skill list and detail reads share the bounded context-file contract', async t => {
  const homeDir = await makeTestTempDir('skills-index-byte-budget-')
  const workspaceDir = join(homeDir, 'project')
  const skillDir = join(workspaceDir, '.codesurf', 'skills', 'large-skill')
  await mkdir(skillDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const skillPath = join(skillDir, 'SKILL.md')
  await writeFile(
    skillPath,
    `---\nname: Large Skill\ndescription: Large but bounded.\n---\n${'é'.repeat(MAX_CONTEXT_FILE_BYTES)}`,
    'utf8',
  )
  const index = createSkillsIndex({ homeDir, userHomeDir: homeDir })
  const listed = await index.listSkills({ workspaceDir })
  const listedSkill = listed.skills.find(skill => skill.id === `discovered-${skillPath}`)
  assert.ok(listedSkill)
  assert.equal(listedSkill.contextMetadata.truncated, true)
  assert.ok(listedSkill.contextMetadata.includedBytes <= MAX_CONTEXT_FILE_BYTES)
  assert.equal(Object.prototype.hasOwnProperty.call(listedSkill, 'content'), false)

  const detailed = await index.getSkill({
    workspaceDir,
    skillId: `discovered-${skillPath}`,
  })
  assert.ok(detailed)
  assert.equal(detailed.contextMetadata.truncated, true)
  assert.ok(Buffer.byteLength(detailed.content, 'utf8') <= MAX_CONTEXT_FILE_BYTES)
  assert.match(detailed.content, /maximum context file bytes/)
  assert.doesNotMatch(detailed.content, /\uFFFD/)
})

test('oversized saved-skill metadata is reported visibly without a full-file read', async t => {
  const homeDir = await makeTestTempDir('skills-index-saved-budget-')
  const workspaceDir = join(homeDir, 'project')
  const savedSkillsFile = join(workspaceDir, '.codesurf', 'customisation', 'skills.json')
  await writeJson(savedSkillsFile, [{
    id: 'custom:oversized',
    name: 'Oversized',
    description: 'Saved skill with oversized metadata.',
    content: 'x'.repeat(MAX_CONTEXT_FILE_BYTES),
  }])
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const index = createSkillsIndex({ homeDir, userHomeDir: homeDir })
  const result = await index.listSkills({ workspaceDir })
  assert.ok(result.skippedLocations.some(entry =>
    entry.path === savedSkillsFile && entry.code === 'CONTEXT_FILE_LIMIT',
  ))
  assert.equal(result.skills.some(skill => skill.id === 'custom:oversized'), false)
})

test('daemon skills list/get/install merge global and workspace roots with inspectable selection summaries', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceDir = join(daemon.homeDir, 'project-skills')
  const globalSkillDir = join(daemon.homeDir, 'skills', 'global-helper')
  const workspaceSkillDir = join(workspaceDir, '.codesurf', 'skills', 'workspace-helper')
  const compatCommandDir = join(workspaceDir, '.claude', 'commands')
  const customSkillsFile = join(workspaceDir, '.codesurf', 'customisation', 'skills.json')
  const tileSkillsFile = join(workspaceDir, '.codesurf', 'chat-skills', 'skills.json')

  const globalSkillMdPath = join(globalSkillDir, 'SKILL.md')
  const workspaceSkillMdPath = join(workspaceSkillDir, 'SKILL.md')
  const compatCommandPath = join(compatCommandDir, 'review.md')

  const globalSkillMd = [
    '---',
    'name: Global Helper',
    'description: Shared repo helper.',
    '---',
    'Use this for shared checks.',
    '',
  ].join('\n')
  const workspaceSkillMd = [
    '---',
    'name: Workspace Helper',
    'description: Workspace-specific workflow.',
    '---',
    'Use this for workspace-only steps.',
    '',
  ].join('\n')
  const compatCommandMd = [
    '---',
    'name: review',
    'description: Review the current branch.',
    '---',
    'Run a branch review checklist.',
    '',
  ].join('\n')

  await mkdir(globalSkillDir, { recursive: true })
  await mkdir(workspaceSkillDir, { recursive: true })
  await mkdir(compatCommandDir, { recursive: true })
  await writeFile(globalSkillMdPath, globalSkillMd, 'utf8')
  await writeFile(workspaceSkillMdPath, workspaceSkillMd, 'utf8')
  await writeFile(compatCommandPath, compatCommandMd, 'utf8')
  await writeJson(customSkillsFile, [
    {
      id: 'custom:workspace-playbook',
      name: 'Workspace Playbook',
      description: 'Saved workspace playbook.',
      content: 'Document local release steps.',
    },
  ])
  await writeJson(tileSkillsFile, {
    enabled: [
      `discovered-${globalSkillMdPath}`,
      `discovered-${workspaceSkillMdPath}`,
      `discovered-${compatCommandPath}`,
      'custom:workspace-playbook',
      'command:/compact',
    ],
    disabled: ['command:/help'],
  })

  let response = await daemon.request('/workspace/create-with-path', {
    body: {
      name: 'Skill Workspace',
      projectPath: workspaceDir,
    },
  })
  assert.equal(response.status, 200)
  const workspaceId = response.payload.id

  response = await daemon.request(`/skills/list?workspaceId=${encodeURIComponent(workspaceId)}&cardId=chat-skills`)
  assert.equal(response.status, 200)
  assert.ok(Array.isArray(response.payload.roots))
  assert.ok(Array.isArray(response.payload.skills))
  assert.ok(response.payload.roots.some(root => root.path === join(daemon.homeDir, 'skills') && root.scope === 'global'))
  assert.ok(response.payload.roots.some(root => root.path === join(workspaceDir, '.codesurf', 'skills') && root.scope === 'workspace'))
  assert.ok(response.payload.roots.some(root => root.path === join(workspaceDir, '.claude', 'commands') && root.kind === 'claude-commands'))
  assert.ok(response.payload.skills.every(skill => !Object.prototype.hasOwnProperty.call(skill, 'content')))
  assert.ok(response.payload.skills.some(skill => skill.name === 'Global Helper'))
  assert.ok(response.payload.skills.some(skill => skill.name === 'Workspace Helper'))
  assert.ok(response.payload.skills.some(skill => skill.name === 'Workspace Playbook'))
  assert.ok(response.payload.skills.some(skill => skill.id === 'command:/compact'))
  assert.equal(response.payload.selection.summary, 'Included 5 skills: Global Helper, Workspace Helper, review, Workspace Playbook +1 more')
  assert.match(response.payload.selection.prompt, /## Included Skills/)
  assert.match(response.payload.selection.prompt, /@Global Helper \[global\] — Shared repo helper\./)
  assert.match(response.payload.selection.prompt, /@Workspace Helper \[workspace\] — Workspace-specific workflow\./)
  assert.match(response.payload.selection.prompt, /@review \[workspace\] — Review the current branch\./)
  assert.match(response.payload.selection.prompt, /@Workspace Playbook \[workspace\] — Saved workspace playbook\./)
  assert.match(response.payload.selection.prompt, /@\/compact \[command\] — Compact conversation/)

  response = await daemon.request(`/skills/get?workspaceId=${encodeURIComponent(workspaceId)}&skillId=${encodeURIComponent(`discovered-${workspaceSkillMdPath}`)}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.name, 'Workspace Helper')
  assert.equal(response.payload.content, workspaceSkillMd)
  assert.equal(response.payload.scope, 'workspace')

  const archivePath = join(daemon.homeDir, 'archive-helper.skill')
  const archiveSkillMd = [
    '---',
    'name: Archive Helper',
    'description: Installed from archive.',
    '---',
    'Use this after install.',
    '',
  ].join('\n')
  createSkillArchive(archivePath, 'archive-helper', archiveSkillMd)

  response = await daemon.request('/skills/install', {
    body: {
      workspaceId,
      scope: 'workspace',
      zipPath: archivePath,
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(response.payload.skill.name, 'Archive Helper')
  assert.equal(response.payload.installedPath, join(workspaceDir, '.codesurf', 'skills', 'archive-helper'))

  response = await daemon.request(`/skills/get?workspaceId=${encodeURIComponent(workspaceId)}&skillId=${encodeURIComponent(`discovered-${join(workspaceDir, '.codesurf', 'skills', 'archive-helper', 'SKILL.md')}`)}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.content, archiveSkillMd)
})

test('listSkills skips unreadable custom skill directories without failing', async t => {
  const homeDir = await makeTestTempDir('skills-index-unreadable-')
  const workspaceDir = join(homeDir, 'project')
  const blockedDir = join(workspaceDir, 'codesurf', 'skills')
  const goodSkillDir = join(workspaceDir, '.codesurf', 'skills', 'good-skill')
  const locationsFile = join(workspaceDir, '.codesurf', 'customisation', 'locations-skills.json')
  t.after(async () => {
    try {
      chmodSync(blockedDir, 0o755)
    } catch {
      // The fixture may not have reached chmod before an earlier failure.
    }
    await rm(homeDir, { recursive: true, force: true })
  })

  await mkdir(blockedDir, { recursive: true })
  await writeFile(join(blockedDir, 'SKILL.md'), '---\nname: Blocked Skill\ndescription: hidden\n---\n', 'utf8')
  await mkdir(goodSkillDir, { recursive: true })
  await writeFile(join(goodSkillDir, 'SKILL.md'), '---\nname: Good Skill\ndescription: Works\n---\n', 'utf8')
  await writeJson(locationsFile, '$WORKSPACE/codesurf/skills')

  try {
    chmodSync(blockedDir, 0o000)
  } catch {
    // Some platforms disallow chmod 000; ENOTDIR coverage below still guards scan failures.
  }

  const index = createSkillsIndex({ homeDir, userHomeDir: homeDir })
  const result = await index.listSkills({ workspaceDir })

  assert.ok(result.skills.some(skill => skill.name === 'Good Skill'))
  assert.ok(result.skills.some(skill => skill.name === '/compact'))
  if (result.skippedLocations.length > 0) {
    assert.ok(result.skippedLocations.some(entry => entry.path.includes('codesurf/skills')))
  }
})

test('listSkills treats a skill location file path as unreadable and continues', async t => {
  const homeDir = await makeTestTempDir('skills-index-enotdir-')
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })
  const workspaceDir = join(homeDir, 'project')
  const blockedFile = join(workspaceDir, 'codesurf', 'skills')
  const locationsFile = join(workspaceDir, '.codesurf', 'customisation', 'locations-skills.json')

  await mkdir(join(workspaceDir, 'codesurf'), { recursive: true })
  await writeFile(blockedFile, 'not a directory\n', 'utf8')
  await writeJson(locationsFile, '$WORKSPACE/codesurf/skills')

  const index = createSkillsIndex({ homeDir, userHomeDir: homeDir })
  const result = await index.listSkills({ workspaceDir })

  assert.ok(Array.isArray(result.skills))
  assert.equal(result.skippedLocations.length, 1)
  assert.equal(result.skippedLocations[0]?.code, 'ENOTDIR')
  assert.ok(result.skills.some(skill => skill.name === '/compact'))
})
