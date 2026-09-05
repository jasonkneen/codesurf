import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'

const messaging = readFileSync(new URL('../src/renderer/src/hooks/useChatTileMessaging.ts', import.meta.url), 'utf8')
const card = readFileSync(new URL('../src/renderer/src/components/KanbanCard.tsx', import.meta.url), 'utf8')
const lifecycle = readFileSync(new URL('../src/renderer/src/components/browser/useBrowserWebviewLifecycle.ts', import.meta.url), 'utf8')

describe('M38 — Stop during the pre-send awaits must actually stop', () => {
  it('stamps each dispatch and bumps the generation on stop', () => {
    assert.ok(messaging.includes('const dispatchGenerationRef = useRef(0)'))
    assert.ok(messaging.includes('const dispatchGeneration = ++dispatchGenerationRef.current'))
    const stop = messaging.slice(messaging.indexOf('const stopStreaming = useCallback'))
    const body = stop.slice(0, stop.indexOf('}, ['))
    assert.ok(body.includes('dispatchGenerationRef.current += 1'), 'stop must invalidate in-flight dispatches')
  })

  it('cancels the job it just started rather than adopting it', () => {
    const guard = messaging.slice(messaging.indexOf('if (dispatchGeneration !== dispatchGenerationRef.current)'))
    const block = guard.slice(0, guard.indexOf('setJobId(nextJobId)'))
    assert.ok(block.includes('chat?.stop?.(workspaceId, tileId)'), 'the real job must be stopped')
    assert.ok(block.includes('return false'), 'and must not be adopted')
  })

  it('the check runs before setJobId', () => {
    const at = messaging.indexOf('if (dispatchGeneration !== dispatchGenerationRef.current)')
    const setAt = messaging.indexOf('setJobId(nextJobId)')
    assert.ok(at > -1 && setAt > at, 'stale dispatches must bail before adopting the job')
  })

  it('behaviour: a stop mid-await prevents adoption and cancels', () => {
    let generation = 0
    const stopped: string[] = []
    const dispatch = async (awaitMs: number, stopAt: number | null) => {
      const mine = ++generation
      if (stopAt !== null) setTimeout(() => { generation += 1 }, stopAt)
      await new Promise(r => setTimeout(r, awaitMs))
      const jobId = 'job-1'
      if (mine !== generation) { stopped.push(jobId); return false }
      return jobId
    }
    return dispatch(50, 10).then(result => {
      assert.equal(result, false, 'a stopped dispatch must not adopt its job')
      assert.deepEqual(stopped, ['job-1'], 'and must cancel it for real')
    })
  })

  it('behaviour: an undisturbed dispatch still adopts its job', async () => {
    let generation = 0
    const mine = ++generation
    await new Promise(r => setTimeout(r, 5))
    assert.equal(mine, generation, 'no stop, no invalidation')
  })
})

describe('M34 — unmount mid-create must not orphan a PTY', () => {
  it('cleanup chains off the create promise', () => {
    const fn = card.slice(card.indexOf('const createPromise'))
    const body = fn.slice(0, fn.indexOf('// eslint-disable'))
    assert.ok(body.includes('const createPromise'), 'the create promise must be retained')
    assert.ok(body.includes('.then(() => window.electron?.terminal?.destroy('),
      'destroy must wait for the session to exist')
    assert.equal(/cancelled = true\n\s*void window\.electron\?\.terminal\?\.destroy/.test(body), false,
      'the immediate no-op destroy must be gone')
  })

  it('behaviour: destroy runs after create settles', async () => {
    const events: string[] = []
    const createPromise = (async () => {
      await new Promise(r => setTimeout(r, 20))
      events.push('created')
    })()
    await createPromise.catch(() => {}).then(() => { events.push('destroyed') })
    assert.deepEqual(events, ['created', 'destroyed'], 'destroy must not land before the session exists')
  })
})

describe('M37 — one popup must open exactly one tile', () => {
  it('claims the URL so sibling listeners ignore it', () => {
    assert.ok(lifecycle.includes('claimPopupUrl'), 'a cross-instance claim is required')
    const fn = lifecycle.slice(lifecycle.indexOf('function claimPopupUrl'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    assert.ok(body.includes('lastClaimedPopup'), 'the claim must live at module scope')
  })

  it('behaviour: N listeners produce one open', () => {
    const WINDOW = 250
    let last = { url: '', at: 0 }
    let now = 1000
    const claim = (url: string) => {
      if (url === last.url && now - last.at < WINDOW) return true
      last = { url, at: now }
      return false
    }
    const opened: string[] = []
    // three mounted browser tiles, one broadcast
    for (let i = 0; i < 3; i += 1) if (!claim('https://example.com/popup')) opened.push('tile')
    assert.equal(opened.length, 1, 'exactly one tile opens')
  })

  it('behaviour: a later, genuine popup still opens', () => {
    const WINDOW = 250
    let last = { url: '', at: 0 }
    let now = 1000
    const claim = (url: string) => {
      if (url === last.url && now - last.at < WINDOW) return true
      last = { url, at: now }
      return false
    }
    assert.equal(claim('https://a.example'), false)
    now += 1000
    assert.equal(claim('https://a.example'), false, 'the same URL later is a new popup')
    assert.equal(claim('https://b.example'), false, 'a different URL is never suppressed')
  })
})
