import { ipcMain, type WebContents } from 'electron'
import { bus } from '../event-bus'
import type { BusEvent } from '../../shared/types'
import {
  assertBusPublishAllowed,
  assertBusPublishScope,
  assertBusSubscribeAllowed,
  assertSafeBusChannel,
  assertSafeBusToken,
} from '../security/busChannels.ts'

const senderSubscriberIds = new WeakMap<WebContents, Set<string>>()
const senderCleanupAttached = new WeakSet<WebContents>()

function trackSenderSubscription(sender: WebContents, subscriberId: string): void {
  const existing = senderSubscriberIds.get(sender)
  if (existing) existing.add(subscriberId)
  else senderSubscriberIds.set(sender, new Set([subscriberId]))

  if (senderCleanupAttached.has(sender)) return
  senderCleanupAttached.add(sender)
  sender.once('destroyed', () => {
    const subscriberIds = senderSubscriberIds.get(sender)
    if (subscriberIds) {
      for (const id of subscriberIds) bus.unsubscribeAll(id)
    }
    senderSubscriberIds.delete(sender)
    senderCleanupAttached.delete(sender)
  })
}

export function registerBusIPC(): void {
  ipcMain.handle('bus:publish', (_, channel: string, type: string, source: string, payload: Record<string, unknown>) => {
    const validated = assertBusPublishAllowed(channel, source, type)
    assertBusPublishScope(validated.channel, validated.source)
    return bus.publish({
      channel: validated.channel,
      type: validated.type,
      source: validated.source,
      payload: payload ?? {},
    })
  })

  ipcMain.handle('bus:subscribe', (event, channel: string, subscriberId: string) => {
    const validated = assertBusSubscribeAllowed(channel, subscriberId)
    const sub = bus.subscribe(validated.channel, validated.subscriberId, (busEvent: BusEvent) => {
      try {
        event.sender.send('bus:event', busEvent)
      } catch {
        // sender may be destroyed
      }
    })

    trackSenderSubscription(event.sender, validated.subscriberId)

    return sub.id
  })

  ipcMain.handle('bus:unsubscribe', (_, subscriptionId: string) => {
    bus.unsubscribe(assertSafeBusToken(subscriptionId, 'bus subscription'))
  })

  ipcMain.handle('bus:unsubscribeAll', (_, subscriberId: string) => {
    bus.unsubscribeAll(assertSafeBusToken(subscriberId, 'bus subscriber'))
  })

  ipcMain.handle('bus:history', (_, channel: string, limit?: number) => {
    return bus.getHistory(assertSafeBusChannel(channel, { allowWildcard: true }), limit)
  })

  ipcMain.handle('bus:channelInfo', (_, channel: string) => {
    return bus.getChannelInfo(assertSafeBusChannel(channel, { allowWildcard: true }))
  })

  ipcMain.handle('bus:unreadCount', (_, channel: string, subscriberId: string) => {
    const validated = assertBusSubscribeAllowed(channel, subscriberId)
    return bus.getUnreadCount(validated.channel, validated.subscriberId)
  })

  ipcMain.handle('bus:markRead', (_, channel: string, subscriberId: string) => {
    const validated = assertBusSubscribeAllowed(channel, subscriberId)
    bus.markRead(validated.channel, validated.subscriberId)
  })

  ipcMain.handle('bus:dropChannel', (_, channel: string) => {
    return bus.dropChannel(assertSafeBusChannel(channel))
  })

  ipcMain.handle('bus:dropChannelsMatching', (_, prefix: string) => {
    return bus.dropChannelsMatching(assertSafeBusChannel(prefix, { allowWildcard: true }))
  })

  ipcMain.handle('bus:stats', () => {
    return bus.getStats()
  })
}
