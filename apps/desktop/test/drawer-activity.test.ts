import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { validateActivityUpsertInput } from '../src/main/activity-validation.ts'
import {
  buildActivityUpsert,
  createActivityHealthReporter,
  persistToActivityStore,
  projectActivityMetadata,
} from '../src/renderer/src/components/tile-chrome/drawerActivity.ts'

describe('drawer activity projection', () => {
  test('projects real producer shapes into bounded scalar-only activity input', () => {
    const input = buildActivityUpsert('t'.repeat(400), {
      type: 'tool',
      id: 'fallback',
      payload: {
        tool_id: 42,
        name: 'Read\u0000 file',
        input: {
          path: `README-${'x'.repeat(500)}.md`,
          secret: { nested: true },
        },
        output: 'never persisted',
        ignored: undefined,
        error: false,
        elapsed: 12.5,
      },
    })

    assert.ok(input)
    assert.equal(input.id, '42')
    assert.equal(input.tileId.length, 256)
    assert.equal(input.title, 'Read file')
    assert.equal(input.detail?.length, 200)
    assert.deepEqual(input.metadata, {
      event_type: 'tool',
      has_error: false,
      name: 'Read file',
      tool_id: 42,
      elapsed: 12.5,
    })
    assert.doesNotThrow(() => validateActivityUpsertInput(input))
  })

  test('bounds projected metadata independently of arbitrary payload size', () => {
    const metadata = projectActivityMetadata('progress', {
      action: 'x'.repeat(10_000),
      status: 'running',
      source: 'agent',
      ignored: { deeply: ['nested'] },
    })
    assert.ok(Buffer.byteLength(JSON.stringify(metadata), 'utf8') <= 2048)
    assert.equal(Object.hasOwn(metadata, 'ignored'), false)
    assert.equal(typeof metadata.action, 'string')
  })

  test('rate-limits sanitized health signals without forwarding failure details', () => {
    let now = 100
    const signals: unknown[] = []
    const report = createActivityHealthReporter({
      intervalMs: 50,
      now: () => now,
      emit: signal => signals.push(signal),
    })
    report('write_failed')
    now += 10
    report('write_failed')
    now += 50
    report('write_failed')

    assert.deepEqual(signals, [
      {
        source: 'renderer',
        operation: 'upsert',
        code: 'write_failed',
        occurredAt: 100,
      },
      {
        source: 'renderer',
        operation: 'upsert',
        code: 'write_failed',
        occurredAt: 160,
      },
    ])
  })

  test('catches rejected persistence promises and emits only a sanitized browser signal', async () => {
    const previousWindow = globalThis.window
    const previousCustomEvent = globalThis.CustomEvent
    const signals: Array<{ type: string, detail: unknown }> = []
    class TestCustomEvent {
      readonly type: string
      readonly detail: unknown

      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type
        this.detail = init?.detail
      }
    }
    const calls: unknown[] = []
    Object.assign(globalThis, {
      CustomEvent: TestCustomEvent,
      window: {
        __CODESURF_CAPABILITIES__: { activity: true },
        electron: {
          activity: {
            upsert: async (_workspaceId: string, input: unknown) => {
              calls.push(input)
              throw new Error('/private/path must not escape')
            },
          },
        },
        dispatchEvent(event: { type: string, detail: unknown }) {
          signals.push(event)
          return true
        },
      },
    })

    try {
      persistToActivityStore('workspace-1', 'tile-1', {
        type: 'task',
        id: 'event-1',
        payload: { title: 'Review', extra: { unsafe: true } },
      })
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(calls.length, 1)
      assert.equal(signals.length, 1)
      assert.equal(signals[0].type, 'codesurf:activity-health')
      assert.deepEqual(signals[0].detail, {
        source: 'renderer',
        operation: 'upsert',
        code: 'write_failed',
        occurredAt: (signals[0].detail as { occurredAt: number }).occurredAt,
      })
      assert.equal(JSON.stringify(signals).includes('/private/path'), false)
    } finally {
      Object.assign(globalThis, {
        window: previousWindow,
        CustomEvent: previousCustomEvent,
      })
    }
  })
})
