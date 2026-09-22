import { randomUUID } from 'node:crypto'
import type { BusEvent, BusSubscription, ChannelInfo } from '../shared/types'

const MAX_HISTORY = 500
/** Soft cap on total retained channels. When exceeded, the oldest channels
 *  (by most-recent-publish timestamp) are evicted. Prevents unbounded growth
 *  from publishers that mint unique channel names (e.g. per-tile activity). */
const MAX_CHANNELS = 1000
/** Channels whose last publish is older than this are considered dormant and
 *  are pruned during eviction sweeps (millis). */
const DORMANT_CHANNEL_TTL_MS = 1000 * 60 * 30 // 30 minutes

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
  private lastPublishAt = new Map<string, number>() // channel → timestamp of most recent publish
  private evictionScheduled = false

  publish(event: Omit<BusEvent, 'id' | 'timestamp'>): BusEvent {
    const full: BusEvent = {
      ...event,
      id: randomUUID(),
      timestamp: Date.now(),
    }

    this.lastPublishAt.set(full.channel, full.timestamp)
    this.scheduleEviction()

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
    this.lastPublishAt.delete(channel)
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
    // also drop subscriptions pinned to those channels:
    // - exact-channel subs whose channel starts with the dropped prefix
    // - wildcard subs whose own prefix starts with the dropped prefix
    //   (e.g. dropping 'tile:123:' also removes 'tile:123:*' subscriptions)
    for (const [id, sub] of this.subscriptions) {
      if (!sub.isWildcard && sub.channel.startsWith(prefix)) {
        this.subscriptions.delete(id)
      } else if (sub.isWildcard && sub.prefix.startsWith(prefix)) {
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

  /**
   * Coalesce eviction work onto a single microtask so a burst of publishes
   * (e.g. a loop publishing one event per tile) does one sweep, not N.
   * Runs after the current call stack unwinds, so delivery is never delayed.
   */
  private scheduleEviction(): void {
    if (this.evictionScheduled) return
    if (this.history.size <= MAX_CHANNELS) return
    this.evictionScheduled = true
    queueMicrotask(() => {
      this.evictionScheduled = false
      this.evictDormantChannels()
    })
  }

  /**
   * Drop channels that are dormant (no publish within DORMANT_CHANNEL_TTL_MS).
   * If still over the cap, drop the oldest by last-publish timestamp.
   * Never evicts a channel that still has live subscribers — a subscriber
   * implies intent to keep receiving, even if the publisher went quiet.
   */
  private evictDormantChannels(): void {
    if (this.history.size === 0) return
    const now = Date.now()
    const subscribedChannels = new Set<string>()
    const wildcardPrefixes: string[] = []
    let hasStarWildcard = false
    for (const sub of this.subscriptions.values()) {
      if (!sub.isWildcard) {
        subscribedChannels.add(sub.channel)
      } else if (sub.prefix === '' || sub.channel === '*') {
        // `*` matches every channel — protect all history.
        hasStarWildcard = true
      } else {
        wildcardPrefixes.push(sub.prefix)
      }
    }

    const isProtected = (channel: string): boolean => {
      if (hasStarWildcard) return true
      if (subscribedChannels.has(channel)) return true
      for (const prefix of wildcardPrefixes) {
        if (channel.startsWith(prefix)) return true
      }
      return false
    }

    // Pass 1: drop dormant channels with no live subscribers
    // (including wildcard matches like tile:* → tile:X).
    for (const channel of [...this.history.keys()]) {
      if (isProtected(channel)) continue
      const last = this.lastPublishAt.get(channel) ?? 0
      if (now - last > DORMANT_CHANNEL_TTL_MS) this.dropChannel(channel)
    }

    // Pass 2: if still over the cap, evict oldest by last-publish until under.
    if (this.history.size <= MAX_CHANNELS) return
    const byAge = [...this.history.keys()]
      .map(channel => ({ channel, last: this.lastPublishAt.get(channel) ?? 0 }))
      .sort((a, b) => a.last - b.last)
    for (const { channel } of byAge) {
      if (this.history.size <= MAX_CHANNELS) break
      if (isProtected(channel)) continue
      this.dropChannel(channel)
    }
  }
}

export const bus = new EventBus()
export { EventBus }
