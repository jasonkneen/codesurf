import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EventBus } from '../src/main/event-bus.ts'
import type { BusEvent } from '../src/shared/types.ts'

function makeEvent(overrides: Partial<Omit<BusEvent, 'id' | 'timestamp'>> = {}): Omit<BusEvent, 'id' | 'timestamp'> {
  return {
    channel: 'test:channel',
    type: 'data',
    source: 'test',
    payload: {},
    ...overrides,
  }
}

describe('EventBus — publish/subscribe', () => {
  it('delivers an event to a matching subscriber', () => {
    const bus = new EventBus()
    const received: BusEvent[] = []
    bus.subscribe('test:channel', 'sub-1', (e) => received.push(e))

    const published = bus.publish(makeEvent())

    assert.equal(received.length, 1)
    assert.equal(received[0].id, published.id)
    assert.equal(received[0].channel, 'test:channel')
    assert.equal(typeof received[0].timestamp, 'number')
  })

  it('does not deliver to a subscriber on a different channel', () => {
    const bus = new EventBus()
    const received: BusEvent[] = []
    bus.subscribe('other:channel', 'sub-1', (e) => received.push(e))

    bus.publish(makeEvent({ channel: 'test:channel' }))

    assert.equal(received.length, 0)
  })

  it('delivers to multiple subscribers on the same channel', () => {
    const bus = new EventBus()
    const a: BusEvent[] = []
    const b: BusEvent[] = []
    bus.subscribe('ch', 'sub-a', (e) => a.push(e))
    bus.subscribe('ch', 'sub-b', (e) => b.push(e))

    bus.publish(makeEvent({ channel: 'ch' }))

    assert.equal(a.length, 1)
    assert.equal(b.length, 1)
  })
})

describe('EventBus — wildcard prefix matching', () => {
  it('matches tile:* to tile:created', () => {
    const bus = new EventBus()
    const received: BusEvent[] = []
    bus.subscribe('tile:*', 'sub-1', (e) => received.push(e))

    bus.publish(makeEvent({ channel: 'tile:created' }))
    bus.publish(makeEvent({ channel: 'tile:deleted' }))

    assert.equal(received.length, 2)
    assert.equal(received[0].channel, 'tile:created')
    assert.equal(received[1].channel, 'tile:deleted')
  })

  it('does not match tile:* to a non-tile channel', () => {
    const bus = new EventBus()
    const received: BusEvent[] = []
    bus.subscribe('tile:*', 'sub-1', (e) => received.push(e))

    bus.publish(makeEvent({ channel: 'workspace:global' }))

    assert.equal(received.length, 0)
  })

  it('matches deeper prefixes like agent:status:*', () => {
    const bus = new EventBus()
    const received: BusEvent[] = []
    bus.subscribe('agent:status:*', 'sub-1', (e) => received.push(e))

    bus.publish(makeEvent({ channel: 'agent:status:online' }))
    bus.publish(makeEvent({ channel: 'agent:status:offline' }))
    bus.publish(makeEvent({ channel: 'agent:action:run' }))

    assert.equal(received.length, 2)
  })
})

describe('EventBus — global wildcard (*)', () => {
  it('matches every channel', () => {
    const bus = new EventBus()
    const received: BusEvent[] = []
    bus.subscribe('*', 'sub-1', (e) => received.push(e))

    bus.publish(makeEvent({ channel: 'tile:created' }))
    bus.publish(makeEvent({ channel: 'workspace:global' }))
    bus.publish(makeEvent({ channel: 'agent:xyz' }))

    assert.equal(received.length, 3)
  })
})

describe('EventBus — ring-buffer history', () => {
  it('retains only the last 500 events per channel', () => {
    const bus = new EventBus()

    for (let i = 0; i < 501; i++) {
      bus.publish(makeEvent({ channel: 'ch', payload: { i } }))
    }

    const history = bus.getHistory('ch')
    assert.equal(history.length, 500)
    // The first event (i=0) should have been evicted; oldest retained is i=1
    assert.equal(history[0].payload.i, 1)
    assert.equal(history[499].payload.i, 500)
  })

  it('returns all events when under the limit', () => {
    const bus = new EventBus()

    for (let i = 0; i < 10; i++) {
      bus.publish(makeEvent({ channel: 'ch', payload: { i } }))
    }

    assert.equal(bus.getHistory('ch').length, 10)
  })

  it('respects the limit parameter on getHistory', () => {
    const bus = new EventBus()

    for (let i = 0; i < 20; i++) {
      bus.publish(makeEvent({ channel: 'ch', payload: { i } }))
    }

    const last5 = bus.getHistory('ch', 5)
    assert.equal(last5.length, 5)
    assert.equal(last5[0].payload.i, 15)
    assert.equal(last5[4].payload.i, 19)
  })
})

describe('EventBus — subscriber error isolation', () => {
  it('continues delivering to other subscribers when one throws', () => {
    const bus = new EventBus()
    const received: BusEvent[] = []

    bus.subscribe('ch', 'bad-sub', () => {
      throw new Error('subscriber exploded')
    })
    bus.subscribe('ch', 'good-sub', (e) => received.push(e))

    // Should not throw
    bus.publish(makeEvent({ channel: 'ch' }))

    assert.equal(received.length, 1)
  })
})

describe('EventBus — unsubscribe cleanup', () => {
  it('stops delivering after unsubscribe', () => {
    const bus = new EventBus()
    const received: BusEvent[] = []
    const sub = bus.subscribe('ch', 'sub-1', (e) => received.push(e))

    bus.publish(makeEvent({ channel: 'ch' }))
    assert.equal(received.length, 1)

    bus.unsubscribe(sub.id)

    bus.publish(makeEvent({ channel: 'ch' }))
    assert.equal(received.length, 1)
  })

  it('unsubscribeAll removes every subscription for a subscriber', () => {
    const bus = new EventBus()
    const received: BusEvent[] = []

    bus.subscribe('ch-a', 'sub-1', (e) => received.push(e))
    bus.subscribe('ch-b', 'sub-1', (e) => received.push(e))

    bus.publish(makeEvent({ channel: 'ch-a' }))
    bus.publish(makeEvent({ channel: 'ch-b' }))
    assert.equal(received.length, 2)

    bus.unsubscribeAll('sub-1')

    bus.publish(makeEvent({ channel: 'ch-a' }))
    bus.publish(makeEvent({ channel: 'ch-b' }))
    assert.equal(received.length, 2) // no new deliveries
  })

  it('does not affect other subscribers when one unsubscribes', () => {
    const bus = new EventBus()
    const a: BusEvent[] = []
    const b: BusEvent[] = []
    const subA = bus.subscribe('ch', 'sub-a', (e) => a.push(e))
    bus.subscribe('ch', 'sub-b', (e) => b.push(e))

    bus.unsubscribe(subA.id)

    bus.publish(makeEvent({ channel: 'ch' }))
    assert.equal(a.length, 0)
    assert.equal(b.length, 1)
  })
})

describe('EventBus — read cursor tracking', () => {
  it('reports full history as unread when no cursor is set', () => {
    const bus = new EventBus()

    for (let i = 0; i < 5; i++) {
      bus.publish(makeEvent({ channel: 'ch' }))
    }

    assert.equal(bus.getUnreadCount('ch', 'sub-1'), 5)
  })

  it('reports zero unread after markRead', () => {
    const bus = new EventBus()

    for (let i = 0; i < 5; i++) {
      bus.publish(makeEvent({ channel: 'ch' }))
    }

    bus.markRead('ch', 'sub-1')

    assert.equal(bus.getUnreadCount('ch', 'sub-1'), 0)
  })

  it('counts only events published after markRead as unread', async () => {
    const bus = new EventBus()

    for (let i = 0; i < 3; i++) {
      bus.publish(makeEvent({ channel: 'ch' }))
    }

    bus.markRead('ch', 'sub-1')

    // Ensure subsequent publishes get a strictly later timestamp
    await new Promise((r) => setTimeout(r, 2))

    // Publish 2 more
    bus.publish(makeEvent({ channel: 'ch' }))
    bus.publish(makeEvent({ channel: 'ch' }))

    assert.equal(bus.getUnreadCount('ch', 'sub-1'), 2)
  })

  it('tracks cursors independently per subscriber', async () => {
    const bus = new EventBus()

    bus.publish(makeEvent({ channel: 'ch' }))
    bus.markRead('ch', 'sub-a')

    // Ensure subsequent publishes get a strictly later timestamp
    await new Promise((r) => setTimeout(r, 2))

    bus.publish(makeEvent({ channel: 'ch' }))
    bus.publish(makeEvent({ channel: 'ch' }))

    assert.equal(bus.getUnreadCount('ch', 'sub-a'), 2)
    assert.equal(bus.getUnreadCount('ch', 'sub-b'), 3) // never marked read
  })
})

describe('EventBus — channel eviction', () => {
  it('caps total channels, evicting the oldest when over the limit', async () => {
    const bus = new EventBus()
    // Publish to well over MAX_CHANNELS distinct channels.
    for (let i = 0; i < 1100; i++) {
      bus.publish(makeEvent({ channel: `burst:${i}` }))
    }

    // scheduleEviction runs on a microtask; drain it.
    await Promise.resolve()
    await Promise.resolve()

    const stats = bus.getStats()
    assert.ok(stats.channels <= 1000, `expected <= 1000 channels, got ${stats.channels}`)
  })

  it('never evicts a channel with a live subscriber', async () => {
    const bus = new EventBus()
    bus.subscribe('keep:me', 'sub-1', () => {})
    bus.publish(makeEvent({ channel: 'keep:me' }))

    for (let i = 0; i < 1100; i++) {
      bus.publish(makeEvent({ channel: `noise:${i}` }))
    }

    await Promise.resolve()
    await Promise.resolve()

    // The subscribed channel must still be present with its history.
    assert.equal(bus.getHistory('keep:me').length, 1)
  })

  it('never evicts channels matched by a live wildcard subscriber (tile:*)', async () => {
    const bus = new EventBus()
    bus.subscribe('tile:*', 'wildcard-sub', () => {})
    bus.publish(makeEvent({ channel: 'tile:alpha' }))
    bus.publish(makeEvent({ channel: 'tile:beta' }))

    for (let i = 0; i < 1100; i++) {
      bus.publish(makeEvent({ channel: `noise:${i}` }))
    }

    await Promise.resolve()
    await Promise.resolve()

    assert.equal(bus.getHistory('tile:alpha').length, 1)
    assert.equal(bus.getHistory('tile:beta').length, 1)
  })
})
