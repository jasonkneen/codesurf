import { randomUUID } from 'node:crypto'
import type { BusEvent, BusSubscription, ChannelInfo } from '../shared/types'

const MAX_HISTORY = 500

interface InternalSubscription {
  id: string
  channel: string
  subscriberId: string
  callback: (event: BusEvent) => void
  isWildcard: boolean
  prefix: string // for wildcard: everything before the '*'
}

class EventBus {
  private subscriptions = new Map<string, InternalSubscription>()
  private history = new Map<string, BusEvent[]>()
  private readCursors = new Map<string, number>() // key: `${channel}::${subscriberId}` → timestamp

  publish(event: Omit<BusEvent, 'id' | 'timestamp'>): BusEvent {
    const full: BusEvent = {
      ...event,
      id: randomUUID(),
      timestamp: Date.now(),
    }

    // Store in ring buffer
    let ring = this.history.get(full.channel)
    if (!ring) {
      ring = []
      this.history.set(full.channel, ring)
    }
    ring.push(full)
    if (ring.length > MAX_HISTORY) {
      ring.splice(0, ring.length - MAX_HISTORY)
    }

    // Deliver to matching subscribers
    for (const sub of this.subscriptions.values()) {
      if (this.matches(sub, full.channel)) {
        try {
          sub.callback(full)
        } catch {
          // subscriber callback threw — don't let it break the bus
        }
      }
    }

    return full
  }

  subscribe(
    channel: string,
    subscriberId: string,
    callback: (event: BusEvent) => void,
  ): BusSubscription {
    const id = randomUUID()
    const isWildcard = channel.includes('*')
    const prefix = isWildcard ? channel.slice(0, channel.indexOf('*')) : ''

    const internal: InternalSubscription = {
      id,
      channel,
      subscriberId,
      callback,
      isWildcard,
      prefix,
    }
    this.subscriptions.set(id, internal)

    return { id, channel, subscriberId }
  }

  unsubscribe(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId)
  }

  unsubscribeAll(subscriberId: string): void {
    for (const [id, sub] of this.subscriptions) {
      if (sub.subscriberId === subscriberId) {
        this.subscriptions.delete(id)
      }
    }
  }

  getChannelInfo(channel: string): ChannelInfo {
    const ring = this.history.get(channel) ?? []
    return {
      name: channel,
      channel,
      unread: ring.length,
      lastEvent: ring.length > 0 ? ring[ring.length - 1] : undefined,
    }
  }

  getHistory(channel: string, limit?: number): BusEvent[] {
    const ring = this.history.get(channel) ?? []
    if (limit == null || limit >= ring.length) return [...ring]
    return ring.slice(-limit)
  }

  markRead(channel: string, subscriberId: string): void {
    this.readCursors.set(`${channel}::${subscriberId}`, Date.now())
  }

  getUnreadCount(channel: string, subscriberId: string): number {
    const cursor = this.readCursors.get(`${channel}::${subscriberId}`)
    const ring = this.history.get(channel) ?? []
    if (cursor == null) return ring.length
    let count = 0
    for (let i = ring.length - 1; i >= 0; i--) {
      if (ring[i].timestamp <= cursor) break
      count++
    }
    return count
  }

  // Drop all history and read cursors for a channel. Returns count of bytes-ish freed (event count).
  dropChannel(channel: string): number {
    const ring = this.history.get(channel)
    const freed = ring?.length ?? 0
    this.history.delete(channel)
    // prune matching read cursors
    const prefix = `${channel}::`
    for (const key of this.readCursors.keys()) {
      if (key.startsWith(prefix)) this.readCursors.delete(key)
    }
    return freed
  }

  // Drop every channel whose name starts with `prefix`. Returns number of channels dropped.
  dropChannelsMatching(prefix: string): number {
    let dropped = 0
    for (const channel of [...this.history.keys()]) {
      if (channel.startsWith(prefix)) {
        this.dropChannel(channel)
        dropped++
      }
    }
    // also drop subscriptions pinned to those channels (non-wildcard only)
    for (const [id, sub] of this.subscriptions) {
      if (!sub.isWildcard && sub.channel.startsWith(prefix)) {
        this.subscriptions.delete(id)
      }
    }
    return dropped
  }

  getStats(): { channels: number; events: number; subscriptions: number; readCursors: number } {
    let events = 0
    for (const ring of this.history.values()) events += ring.length
    return {
      channels: this.history.size,
      events,
      subscriptions: this.subscriptions.size,
      readCursors: this.readCursors.size,
    }
  }

  // ── internal ──────────────────────────────────────────────────────────────

  private matches(sub: InternalSubscription, channel: string): boolean {
    if (!sub.isWildcard) return sub.channel === channel
    // wildcard: `*` matches everything, `tile:*` matches `tile:anything`
    return channel.startsWith(sub.prefix)
  }
}

export const bus = new EventBus()
export { EventBus }
