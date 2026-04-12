import { ipcMain, type WebContents } from 'electron'
import { bus } from '../event-bus'
import type { BusEvent, BusEventType } from '../../shared/types'

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
  ipcMain.handle('bus:publish', (_, channel: string, type: BusEventType, source: string, payload: Record<string, unknown>) => {
    return bus.publish({ channel, type, source, payload })
  })

  ipcMain.handle('bus:subscribe', (event, channel: string, subscriberId: string) => {
    const sub = bus.subscribe(channel, subscriberId, (busEvent: BusEvent) => {
      try {
        event.sender.send('bus:event', busEvent)
      } catch {
        // sender may be destroyed
      }
    })

    trackSenderSubscription(event.sender, subscriberId)

    return sub.id
  })

  ipcMain.handle('bus:unsubscribe', (_, subscriptionId: string) => {
    bus.unsubscribe(subscriptionId)
  })

  ipcMain.handle('bus:unsubscribeAll', (_, subscriberId: string) => {
    bus.unsubscribeAll(subscriberId)
  })

  ipcMain.handle('bus:history', (_, channel: string, limit?: number) => {
    return bus.getHistory(channel, limit)
  })

  ipcMain.handle('bus:channelInfo', (_, channel: string) => {
    return bus.getChannelInfo(channel)
  })

  ipcMain.handle('bus:unreadCount', (_, channel: string, subscriberId: string) => {
    return bus.getUnreadCount(channel, subscriberId)
  })

  ipcMain.handle('bus:markRead', (_, channel: string, subscriberId: string) => {
    bus.markRead(channel, subscriberId)
  })

  ipcMain.handle('bus:dropChannel', (_, channel: string) => {
    return bus.dropChannel(channel)
  })

  ipcMain.handle('bus:dropChannelsMatching', (_, prefix: string) => {
    return bus.dropChannelsMatching(prefix)
  })

  ipcMain.handle('bus:stats', () => {
    return bus.getStats()
  })
}
