import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { normalizeToolName } from '../src/shared/tool-normalization.ts'

describe('tool name normalization', () => {
  test('normalizes provider and MCP read variants to one display/group key', () => {
    const variants = [
      'Read',
      'read_file',
      'Codex: Read_file',
      'mcp__codesurf__read_file',
    ].map(name => normalizeToolName(name))

    assert.deepEqual(variants.map(v => v.displayName), [
      'Read file',
      'Read file',
      'Read file',
      'Read file',
    ])
    assert.deepEqual(new Set(variants.map(v => v.groupKey)), new Set(['read_file']))
    assert.equal(variants[2].provider, 'codex')
    assert.equal(variants[3].namespace, 'codesurf')
  })

  test('normalizes plan, edit, command, and context names', () => {
    assert.deepEqual(
      [
        normalizeToolName('TodoWrite').displayName,
        normalizeToolName('update_plan').displayName,
        normalizeToolName('Edited 2 files').displayName,
        normalizeToolName('exec_command').displayName,
        normalizeToolName('Workspace Instructions').displayName,
      ],
      [
        'Update plan',
        'Update plan',
        'Edit file',
        'Run command',
        'Load instructions',
      ],
    )
  })
})
