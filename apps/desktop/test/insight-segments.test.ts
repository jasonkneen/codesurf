import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { splitInsightSegments } from '../src/renderer/src/components/chat/insightSegments.ts'

const OPEN = '`★ Insight ─────────────────────────────────────`'
const CLOSE = '`─────────────────────────────────────────────────`'

describe('splitInsightSegments', () => {
  test('plain markdown with no insight yields a single md segment', () => {
    const segs = splitInsightSegments('just some text')
    assert.deepEqual(segs, [{ kind: 'md', text: 'just some text' }])
  })

  test('empty / whitespace-only input yields no segments', () => {
    assert.deepEqual(splitInsightSegments(''), [])
    assert.deepEqual(splitInsightSegments('   \n  '), [])
  })

  test('a closed insight is lifted out with surrounding markdown preserved', () => {
    const text = `before\n${OPEN}\n- point one\n- point two\n${CLOSE}\nafter`
    const segs = splitInsightSegments(text)
    assert.equal(segs.length, 3)
    assert.deepEqual(segs[0], { kind: 'md', text: 'before\n' })
    assert.equal(segs[1].kind, 'insight')
    assert.equal((segs[1] as { closed: boolean }).closed, true)
    assert.equal(segs[1].text, '- point one\n- point two')
    assert.deepEqual(segs[2], { kind: 'md', text: 'after' })
  })

  test('an unclosed insight (still streaming) is an open segment swallowing the rest', () => {
    const text = `${OPEN}\n- partial point`
    const segs = splitInsightSegments(text)
    assert.equal(segs.length, 1)
    assert.equal(segs[0].kind, 'insight')
    assert.equal((segs[0] as { closed: boolean }).closed, false)
    assert.equal(segs[0].text, '- partial point')
  })

  test('backtick-less marker lines (dropped during streaming) still match', () => {
    const openBare = '★ Insight ─────────────────────────────────────'
    const closeBare = '─────────────────────────────────────────────────'
    const segs = splitInsightSegments(`${openBare}\nbody\n${closeBare}`)
    assert.equal(segs.length, 1)
    assert.equal(segs[0].kind, 'insight')
    assert.equal((segs[0] as { closed: boolean }).closed, true)
    assert.equal(segs[0].text, 'body')
  })

  test('a regular markdown --- horizontal rule is NOT treated as an insight close', () => {
    // The open marker uses box-drawing rules; a plain `---` must not close it,
    // so an open insight followed by `---` stays open (swallows the rule).
    const text = `${OPEN}\nbody\n---\nmore`
    const segs = splitInsightSegments(text)
    assert.equal(segs[0].kind, 'insight')
    assert.equal((segs[0] as { closed: boolean }).closed, false)
    assert.match(segs[0].text, /body\n---\nmore/)
  })

  test('plain text with no box-drawing rules is never mistaken for an insight', () => {
    const segs = splitInsightSegments('a normal paragraph\n\nwith --- a dash rule')
    assert.equal(segs.length, 1)
    assert.equal(segs[0].kind, 'md')
  })
})
