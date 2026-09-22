import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  AGENT_ADAPTER_DEFINITIONS,
  AGENT_ADAPTER_IDS,
  getAgentAdapterDefinition,
  getAgentAdapterDefinitions,
  summarizeAgentAdapterAvailability,
} from '../src/main/agents/agent-adapter-registry.ts'

function capabilityIds(adapterId: string): string[] {
  const adapter = getAgentAdapterDefinition(adapterId)
  assert.ok(adapter, `missing adapter: ${adapterId}`)
  return adapter.capabilities.filter(capability => capability.enabled).map(capability => capability.id)
}

describe('agent adapter registry', () => {
  test('contains first-party and external coding agent lanes', () => {
    for (const id of [
      'claude',
      'codex',
      'opencode',
      'openclaw',
      'hermes',
      'cursor-agent',
      'gemini',
      'cline',
      'amp',
      'kilo',
    ]) {
      expect(AGENT_ADAPTER_IDS).toContain(id)
      assert.ok(getAgentAdapterDefinition(id), `expected adapter definition for ${id}`)
    }
  })

  test('keeps adapter metadata complete enough for registry-driven setup UI', () => {
    for (const adapter of getAgentAdapterDefinitions()) {
      assert.ok(adapter.id, 'adapter id is required')
      assert.ok(adapter.displayName, `display name is required for ${adapter.id}`)
      assert.ok(adapter.executionShape, `execution shape is required for ${adapter.id}`)
      assert.ok(adapter.binaryCandidates.length > 0, `binary candidates are required for ${adapter.id}`)
      assert.ok(adapter.versionArgs.length > 0, `version args are required for ${adapter.id}`)
      assert.ok(adapter.helpArgs.length > 0, `help args are required for ${adapter.id}`)
      assert.ok(adapter.capabilities.length > 0, `capabilities are required for ${adapter.id}`)
    }
  })

  test('declares the capability shape needed by multi-agent lanes', () => {
    expect(capabilityIds('cursor-agent')).toContain('headlessRun')
    expect(capabilityIds('cursor-agent')).toContain('streamJson')
    expect(capabilityIds('cursor-agent')).toContain('resume')
    expect(capabilityIds('gemini')).toContain('approvalMode')
    expect(capabilityIds('cline')).toContain('acp')
    expect(capabilityIds('amp')).toContain('mcp')
    expect(capabilityIds('kilo')).toContain('sessionImport')
    expect(capabilityIds('kilo')).toContain('acp')
  })

  test('does not use the Cursor GUI command for the headless Cursor Agent adapter', () => {
    const cursor = getAgentAdapterDefinition('cursor-agent')
    assert.ok(cursor)
    expect(cursor.binaryCandidates).toEqual(['cursor-agent'])
    expect(cursor.headlessCommandName).toBe('cursor-agent')
  })

  test('summarizes missing binaries as setup-needed instead of throwing', () => {
    const kilo = getAgentAdapterDefinition('kilo')
    assert.ok(kilo)

    const missing = summarizeAgentAdapterAvailability(kilo, {
      path: null,
      version: null,
      detectedAt: '2026-04-24T00:00:00.000Z',
      confirmed: false,
    })

    expect(missing.status).toBe('missing')
    expect(missing.canRun).toBe(false)
    expect(missing.setupHint).toContain('npm install -g @kilocode/cli')
  })

  test('agent path detection includes the expanded adapter key list', () => {
    const source = readFileSync(`${process.cwd()}/src/main/agent-paths.ts`, 'utf8')

    for (const id of ['cursor-agent', 'gemini', 'cline', 'amp', 'kilo']) {
      expect(source).toContain(id)
    }
    expect(source).toContain('AGENT_KEYS')
    expect(source).toContain('registry never makes existing installs crash')
  })

  test('exports one canonical definition per adapter id', () => {
    expect(AGENT_ADAPTER_DEFINITIONS.length).toBe(AGENT_ADAPTER_IDS.length)
    expect(new Set(AGENT_ADAPTER_IDS).size).toBe(AGENT_ADAPTER_IDS.length)
  })
})
