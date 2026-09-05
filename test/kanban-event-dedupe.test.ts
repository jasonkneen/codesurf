import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'

/**
 * H8: main emits each kanban event over BOTH the SSE stream and the IPC
 * broadcast, and KanbanTile registers both listeners unconditionally. Since
 * card_complete is not idempotent, one MCP call moved the card two columns and
 * appended duplicate comments.
 */
const mainSrc = readFileSync(new URL('../src/main/mcp/tools/kanban.ts', import.meta.url), 'utf8')
const tileSrc = readFileSync(new URL('../src/renderer/src/components/KanbanTile.tsx', import.meta.url), 'utf8')

describe('kanban dual-transport emission', () => {
  it('routes every dual emission through the stamping helper', () => {
    // No site may call pushSSE and sendToRenderer as a bare adjacent pair again.
    const barePair = /pushSSE\([^\n]*\)\n\s*sendToRenderer\(/
    assert.equal(barePair.test(mainSrc), false, 'un-stamped dual emission reintroduced')
  })

  it('stamps a unique monotonic id on the shared payload', () => {
    assert.ok(mainSrc.includes('_eventId'), 'payload must carry a dedupe id')
    assert.ok(mainSrc.includes('++kanbanEventSeq'), 'id must be monotonic')
    const helper = mainSrc.slice(mainSrc.indexOf('function emitKanbanEvent'))
    const body = helper.slice(0, helper.indexOf('\n}\n'))
    assert.ok(body.includes('ctx.pushSSE('), 'helper emits over SSE')
    assert.ok(body.includes('ctx.sendToRenderer('), 'helper emits over IPC')
    assert.ok(
      body.indexOf('stamped') < body.indexOf('ctx.pushSSE('),
      'the id is stamped before either emission so both carry the same value',
    )
  })

  it('covers all five dual-emission call sites', () => {
    const calls = mainSrc.match(/emitKanbanEvent\(/g) ?? []
    // 5 call sites + 1 declaration
    assert.equal(calls.length, 6, `expected 5 emit sites, found ${calls.length - 1}`)
  })
})

describe('KanbanTile dedupe', () => {
  it('drops an event id it has already dispatched', () => {
    const fn = tileSrc.slice(tileSrc.indexOf('const dispatchKanbanEvent'))
    const body = fn.slice(0, fn.indexOf('}, [])'))
    assert.ok(body.includes('_eventId'), 'dispatch must read the dedupe id')
    assert.ok(body.includes('.has(eventId)'), 'dispatch must skip ids it has seen')
    assert.ok(body.includes('return'), 'a duplicate must short-circuit')
  })

  it('bounds the seen-id set so it cannot grow without limit', () => {
    const fn = tileSrc.slice(tileSrc.indexOf('const dispatchKanbanEvent'))
    const body = fn.slice(0, fn.indexOf('}, [])'))
    assert.ok(/size > \d+/.test(body), 'the seen set must be bounded')
  })
})

describe('dedupe behaviour', () => {
  // Mirror of the renderer logic, exercised directly.
  function makeDispatcher() {
    const seen = new Set<string>()
    const delivered: Array<{ event: string; data: any }> = []
    return {
      delivered,
      dispatch(event: string, data: any) {
        const id = data?._eventId
        if (typeof id === 'string') {
          if (seen.has(id)) return
          seen.add(id)
          if (seen.size > 512) return
        }
        delivered.push({ event, data })
      },
    }
  }

  it('delivers one card_complete when both transports fire', () => {
    const d = makeDispatcher()
    const payload = { cardId: 'c1', summary: 'done', _eventId: 'kanban-1' }
    d.dispatch('card_complete', payload) // SSE
    d.dispatch('card_complete', payload) // IPC
    assert.equal(d.delivered.length, 1, 'the card must advance exactly one column')
  })

  it('still delivers genuinely distinct events', () => {
    const d = makeDispatcher()
    d.dispatch('card_complete', { cardId: 'c1', _eventId: 'kanban-1' })
    d.dispatch('card_complete', { cardId: 'c1', _eventId: 'kanban-2' })
    assert.equal(d.delivered.length, 2, 'two real completions must both land')
  })

  it('passes through events with no id rather than dropping them', () => {
    const d = makeDispatcher()
    d.dispatch('card_update', { cardId: 'c1' })
    d.dispatch('card_update', { cardId: 'c1' })
    assert.equal(d.delivered.length, 2)
  })
})
