import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  ElectrobunProcessOutputBudget,
  type ElectrobunProcessOutputLimits,
} from '../electrobun/bun/process-output-limits.ts'

const permissive: ElectrobunProcessOutputLimits = {
  maxStdoutBytes: 1_000,
  maxStderrBytes: 1_000,
  maxLineBytes: 1_000,
  maxAggregateBytes: 2_000,
}

describe('Electrobun process output budgets', () => {
  test('enforces cumulative stdout and stderr byte limits', () => {
    const stdout = new ElectrobunProcessOutputBudget({ ...permissive, maxStdoutBytes: 4 })
    assert.equal(stdout.accept('stdout', Buffer.from('12')), null)
    assert.match(String(stdout.accept('stdout', Buffer.from('345'))), /stdout exceeded.*4-byte/i)

    const stderr = new ElectrobunProcessOutputBudget({ ...permissive, maxStderrBytes: 4 })
    assert.equal(stderr.accept('stderr', Buffer.from('1234')), null)
    assert.match(String(stderr.accept('stderr', Buffer.from('5'))), /stderr exceeded.*4-byte/i)
  })

  test('enforces aggregate bytes across both streams', () => {
    const budget = new ElectrobunProcessOutputBudget({ ...permissive, maxAggregateBytes: 6 })
    assert.equal(budget.accept('stdout', Buffer.from('1234')), null)
    assert.match(String(budget.accept('stderr', Buffer.from('567'))), /aggregate limit/i)
  })

  test('enforces per-line bytes cumulatively and resets only at newline', () => {
    const budget = new ElectrobunProcessOutputBudget({ ...permissive, maxLineBytes: 4 })
    assert.equal(budget.accept('stdout', Buffer.from('12')), null)
    assert.equal(budget.accept('stdout', Buffer.from('34\n1234')), null)
    assert.match(String(budget.accept('stdout', Buffer.from('5'))), /stdout line exceeded.*4-byte/i)
  })
})
