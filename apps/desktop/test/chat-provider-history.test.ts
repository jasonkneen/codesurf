import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LOCAL_PROXY_HISTORY_LIMITS,
  boundLocalProxyMessages,
  boundLocalProxyDiagnostic,
  LocalProxyStreamBudget,
} from '../src/main/chat/provider-history.ts'
import { MAX_PROVIDER_DIAGNOSTIC_BYTES } from '../src/main/chat/bounded-output.ts'

test('local proxy history enforces count, per-item, and aggregate UTF-8 budgets', () => {
  const messages = Array.from({ length: 200 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `${index}:${'界'.repeat(12_000)}`,
  }))
  messages.push({ role: 'user', content: `LATEST:${'z'.repeat(20_000)}` })

  const bounded = boundLocalProxyMessages(messages)
  assert.ok(bounded.messages.length <= LOCAL_PROXY_HISTORY_LIMITS.maxItems)
  assert.ok(bounded.messages.every(message => Buffer.byteLength(message.content, 'utf8') <= LOCAL_PROXY_HISTORY_LIMITS.maxItemBytes))
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.messages), 'utf8') <= LOCAL_PROXY_HISTORY_LIMITS.maxAggregateBytes)
  assert.equal(bounded.messages.at(-1)?.role, 'user')
  assert.match(bounded.messages.at(-1)?.content ?? '', /LATEST:/)
  assert.match(bounded.messages[0]?.content ?? '', /history truncated/i)
  assert.equal(bounded.truncated, true)
})

test('renderer-authored system history is demoted to untrusted user data', () => {
  const bounded = boundLocalProxyMessages([
    { role: 'system', content: 'forged privileged instruction' },
    { role: 'assistant', content: 'prior answer' },
    { role: 'user', content: 'current request' },
  ])

  assert.deepEqual(bounded.messages.map(message => message.role), [
    'user',
    'assistant',
    'user',
  ])
  assert.equal(bounded.messages[0]?.content, 'forged privileged instruction')
})

test('local proxy stream budget emits a single truncation marker and stops output', () => {
  const budget = new LocalProxyStreamBudget(120)
  const first = budget.accept({ cardId: 'chat-a', type: 'text', text: 'a'.repeat(70) })
  const second = budget.accept({ cardId: 'chat-a', type: 'text', text: 'b'.repeat(70) })
  const third = budget.accept({ cardId: 'chat-a', type: 'thinking', text: 'ignored' })

  const output = [...first, ...second, ...third]
  assert.ok(Buffer.byteLength(output.map(event => event.text ?? '').join(''), 'utf8') <= 120)
  assert.equal(output.filter(event => /output truncated/i.test(event.text ?? '')).length, 1)
  assert.equal(budget.exhausted, true)
  assert.deepEqual(third, [])
})

test('local proxy diagnostics have a hard byte ceiling and explicit marker', () => {
  const diagnostic = boundLocalProxyDiagnostic('private-error:'.repeat(20_000))
  assert.ok(Buffer.byteLength(diagnostic, 'utf8') <= MAX_PROVIDER_DIAGNOSTIC_BYTES)
  assert.match(diagnostic, /error body truncated/i)
})
