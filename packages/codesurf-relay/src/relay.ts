import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { promises as fs, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { writeFilesAtomically } from './atomicFileWrites'
import { parseRelayMessage, renderRelayMessage } from './markdown'
import {
  safeSlug,
  validateChannelId,
  validateMessageFilename,
  validateParticipantId,
  validateTileId,
  normalizeRelayImpacts,
} from './validation'
import type {
  RelayChannel,
  RelayChannelMessageDraft,
  RelayDirectMessageDraft,
  RelayEvent,
  RelayEventMap,
  RelayMailbox,
  RelayMessage,
  RelayMessageListItem,
  RelayMessageMeta,
  RelayMessageStatus,
  RelayOperationContext,
  RelayParticipant,
  RelayParticipantStatus,
  RelayPriority,
  RelayRelationshipHint,
  RelayWaitOptions,
  RelayWorkContext,
} from './types'

interface RelayPaths {
  root: string
  participants: string
  channels: string
  archive: string
  relationships: string
}

export interface CodesurfRelayOptions {
  workspacePath: string
}

function nowStamp(): { iso: string; ts: number } {
  const now = new Date()
  return { iso: now.toISOString(), ts: now.getTime() }
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true })
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

function assertActive(context?: RelayOperationContext): void {
  context?.assertActive()
}

async function awaitActive<T>(
  operation: () => Promise<T>,
  context?: RelayOperationContext,
): Promise<T> {
  assertActive(context)
  try {
    const result = await operation()
    assertActive(context)
    return result
  } catch (error) {
    assertActive(context)
    throw error
  }
}

async function writeJson(
  path: string,
  value: unknown,
  context?: RelayOperationContext,
): Promise<void> {
  await writeFilesAtomically([
    { path, content: JSON.stringify(value, null, 2) },
  ], context)
}

async function readMessage(path: string, mailbox: RelayMailbox, filename: string): Promise<RelayMessage | null> {
  try {
    return parseRelayMessage(await fs.readFile(path, 'utf8'), mailbox, filename)
  } catch {
    return null
  }
}

export class CodesurfRelay {
  readonly workspacePath: string
  readonly paths: RelayPaths
  readonly events = new EventEmitter()
  private initialized = false
  private initializing: Promise<void> | null = null

  constructor(options: CodesurfRelayOptions) {
    this.workspacePath = options.workspacePath
    this.paths = {
      root: join(this.workspacePath, '.codesurf', 'relay'),
      participants: join(this.workspacePath, '.codesurf', 'relay', 'participants'),
      channels: join(this.workspacePath, '.codesurf', 'relay', 'channels'),
      archive: join(this.workspacePath, '.codesurf', 'relay', 'archive', 'all'),
      relationships: join(this.workspacePath, '.codesurf', 'relay', 'relationships'),
    }
  }

  async init(context?: RelayOperationContext): Promise<void> {
    assertActive(context)
    if (this.initialized) return
    if (this.initializing) {
      await awaitActive(() => this.initializing!, context)
      return
    }

    const initializing = (async () => {
      await awaitActive(() => Promise.all([
        ensureDir(this.paths.participants),
        ensureDir(this.paths.channels),
        ensureDir(this.paths.archive),
        ensureDir(this.paths.relationships),
      ]).then(() => undefined), context)

      const systemFile = this.participantFile('system')
      const existing = await awaitActive(
        () => readJson<RelayParticipant | null>(systemFile, null),
        context,
      )
      if (!existing) {
        const stamp = nowStamp()
        const systemParticipant: RelayParticipant = {
          id: 'system',
          name: 'System',
          kind: 'system',
          status: 'ready',
          channels: [],
          readyAt: stamp.iso,
          readyTs: stamp.ts,
          metadata: {},
        }
        await awaitActive(() => Promise.all([
          ensureDir(this.participantMailboxDir('system', 'inbox')),
          ensureDir(this.participantMailboxDir('system', 'sent')),
          ensureDir(this.participantMailboxDir('system', 'memory')),
          ensureDir(this.participantMailboxDir('system', 'bin')),
          ensureDir(join(this.participantDir('system'), 'cursors')),
        ]).then(() => undefined), context)
        await writeJson(systemFile, systemParticipant, context)
      }

      assertActive(context)
      this.initialized = true
    })()
    this.initializing = initializing

    try {
      await awaitActive(() => initializing, context)
    } finally {
      if (this.initializing === initializing) this.initializing = null
    }
  }

  on(listener: (event: RelayEvent) => void): () => void {
    this.events.on('event', listener)
    return () => this.events.off('event', listener)
  }

  private emit<K extends keyof RelayEventMap>(
    type: K,
    payload: RelayEventMap[K],
    context?: RelayOperationContext,
  ): void {
    assertActive(context)
    this.events.emit('event', { type, timestamp: Date.now(), payload } as RelayEvent)
  }

  participantDir(id: string): string {
    validateParticipantId(id)
    return join(this.paths.participants, id)
  }

  participantFile(id: string): string {
    return join(this.participantDir(id), 'participant.json')
  }

  participantMailboxDir(id: string, mailbox: Exclude<RelayMailbox, 'channel' | 'central'>): string {
    return join(this.participantDir(id), 'mailboxes', mailbox)
  }

  participantCursorFile(id: string, channel: string): string {
    validateChannelId(channel)
    return join(this.participantDir(id), 'cursors', `${channel}.json`)
  }

  channelDir(id: string): string {
    validateChannelId(id)
    return join(this.paths.channels, id)
  }

  channelFile(id: string): string {
    return join(this.channelDir(id), 'channel.json')
  }

  channelMessagesDir(id: string): string {
    return join(this.channelDir(id), 'messages')
  }

  tileMailboxDir(tileId: string, mailbox: Exclude<RelayMailbox, 'channel' | 'central'>): string {
    validateTileId(tileId)
    return join(this.workspacePath, '.codesurf', tileId, 'messages', mailbox)
  }

  async listParticipants(
    context?: RelayOperationContext,
  ): Promise<RelayParticipant[]> {
    await this.init(context)
    try {
      const entries = await awaitActive(
        () => fs.readdir(this.paths.participants),
        context,
      )
      const participants = await awaitActive(
        () => Promise.all(entries.map(id => (
          readJson<RelayParticipant | null>(this.participantFile(id), null)
        ))),
        context,
      )
      return participants.filter(Boolean).sort((a, b) => a!.name.localeCompare(b!.name)) as RelayParticipant[]
    } catch (error) {
      assertActive(context)
      return []
    }
  }

  async getParticipant(
    id: string,
    context?: RelayOperationContext,
  ): Promise<RelayParticipant | null> {
    await this.init(context)
    return awaitActive(
      () => readJson<RelayParticipant | null>(this.participantFile(id), null),
      context,
    )
  }

  async upsertParticipant(
    input: Partial<RelayParticipant> & Pick<RelayParticipant, 'id' | 'name' | 'kind' | 'status'>,
    context?: RelayOperationContext,
  ): Promise<RelayParticipant> {
    assertActive(context)
    validateParticipantId(input.id)
    await this.init(context)
    const existing = await this.getParticipant(input.id, context)
    const participant: RelayParticipant = {
      id: input.id,
      name: input.name,
      kind: input.kind,
      status: input.status,
      task: input.task ?? existing?.task,
      tileId: input.tileId ?? existing?.tileId,
      provider: input.provider ?? existing?.provider,
      model: input.model ?? existing?.model,
      channels: unique(input.channels ?? existing?.channels ?? []),
      readyAt: input.readyAt ?? existing?.readyAt,
      readyTs: input.readyTs ?? existing?.readyTs,
      startedAt: input.startedAt ?? existing?.startedAt,
      startedTs: input.startedTs ?? existing?.startedTs,
      stoppedAt: input.stoppedAt ?? existing?.stoppedAt,
      stoppedTs: input.stoppedTs ?? existing?.stoppedTs,
      work: input.work ?? existing?.work,
      metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) },
    }

    await awaitActive(() => Promise.all([
      ensureDir(this.participantMailboxDir(participant.id, 'inbox')),
      ensureDir(this.participantMailboxDir(participant.id, 'sent')),
      ensureDir(this.participantMailboxDir(participant.id, 'memory')),
      ensureDir(this.participantMailboxDir(participant.id, 'bin')),
      ensureDir(join(this.participantDir(participant.id), 'cursors')),
    ]).then(() => undefined), context)
    await writeJson(this.participantFile(participant.id), participant, context)

    for (const channel of participant.channels) {
      await this.joinChannel(channel, participant.id, context)
    }

    this.emit('participant_upserted', { participant }, context)
    if (participant.status === 'ready') {
      this.emit('ready', { participantId: participant.id }, context)
    }
    await this.writeRelationshipsSnapshot(context)
    assertActive(context)
    return participant
  }

  async setParticipantStatus(
    participantId: string,
    status: RelayParticipantStatus,
    context?: RelayOperationContext,
  ): Promise<RelayParticipant> {
    assertActive(context)
    const participant = await this.getParticipant(participantId, context)
    if (!participant) throw new Error(`Unknown participant: ${participantId}`)
    const stamp = nowStamp()
    const next: RelayParticipant = {
      ...participant,
      status,
      readyAt: status === 'ready' && !participant.readyAt ? stamp.iso : participant.readyAt,
      readyTs: status === 'ready' && !participant.readyTs ? stamp.ts : participant.readyTs,
      startedAt: status === 'running' && !participant.startedAt ? stamp.iso : participant.startedAt,
      startedTs: status === 'running' && !participant.startedTs ? stamp.ts : participant.startedTs,
      stoppedAt: ['done', 'stopped', 'error'].includes(status) ? stamp.iso : participant.stoppedAt,
      stoppedTs: ['done', 'stopped', 'error'].includes(status) ? stamp.ts : participant.stoppedTs,
    }
    await this.upsertParticipant(next, context)
    this.emit('participant_status', { participantId, status }, context)
    return next
  }

  async updateWorkContext(
    participantId: string,
    work: RelayWorkContext,
    context?: RelayOperationContext,
  ): Promise<RelayParticipant> {
    assertActive(context)
    const participant = await this.getParticipant(participantId, context)
    if (!participant) throw new Error(`Unknown participant: ${participantId}`)
    const stamp = nowStamp()
    return this.upsertParticipant({
      ...participant,
      status: participant.status,
      work: {
        ...participant.work,
        ...work,
        files: unique(work.files ?? participant.work?.files ?? []),
        topics: unique(work.topics ?? participant.work?.topics ?? []),
        collaborators: unique(work.collaborators ?? participant.work?.collaborators ?? []),
        blockers: unique(work.blockers ?? participant.work?.blockers ?? []),
        impacts: normalizeRelayImpacts(work.impacts ?? participant.work?.impacts ?? []),
        updatedAt: stamp.iso,
        updatedTs: stamp.ts,
      },
    }, context)
  }

  async listChannels(
    context?: RelayOperationContext,
  ): Promise<RelayChannel[]> {
    await this.init(context)
    try {
      const entries = await awaitActive(
        () => fs.readdir(this.paths.channels),
        context,
      )
      const channels = await awaitActive(
        () => Promise.all(entries.map(id => (
          readJson<RelayChannel | null>(this.channelFile(id), null)
        ))),
        context,
      )
      return channels.filter(Boolean).sort((a, b) => a!.name.localeCompare(b!.name)) as RelayChannel[]
    } catch (error) {
      assertActive(context)
      return []
    }
  }

  async getChannel(
    id: string,
    context?: RelayOperationContext,
  ): Promise<RelayChannel | null> {
    await this.init(context)
    return awaitActive(
      () => readJson<RelayChannel | null>(this.channelFile(id), null),
      context,
    )
  }

  async upsertChannel(
    input: Pick<RelayChannel, 'id' | 'name'> & Partial<RelayChannel>,
    context?: RelayOperationContext,
  ): Promise<RelayChannel> {
    assertActive(context)
    await this.init(context)
    const existing = await this.getChannel(input.id, context)
    const stamp = nowStamp()
    const channel: RelayChannel = {
      id: input.id,
      name: input.name,
      description: input.description ?? existing?.description,
      members: unique(input.members ?? existing?.members ?? []),
      bridges: input.bridges ?? existing?.bridges ?? [],
      metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) },
      createdAt: existing?.createdAt ?? stamp.iso,
      createdTs: existing?.createdTs ?? stamp.ts,
      updatedAt: stamp.iso,
      updatedTs: stamp.ts,
    }

    await awaitActive(
      () => ensureDir(this.channelMessagesDir(channel.id)),
      context,
    )
    await writeJson(this.channelFile(channel.id), channel, context)
    return channel
  }

  async joinChannel(
    channelId: string,
    participantId: string,
    context?: RelayOperationContext,
  ): Promise<RelayChannel> {
    const channel = await this.upsertChannel(
      { id: channelId, name: channelId },
      context,
    )
    if (!channel.members.includes(participantId)) {
      const next = await this.upsertChannel({
        ...channel,
        members: [...channel.members, participantId],
      }, context)
      return next
    }
    return channel
  }

  async leaveChannel(
    channelId: string,
    participantId: string,
    context?: RelayOperationContext,
  ): Promise<RelayChannel | null> {
    const channel = await this.getChannel(channelId, context)
    if (!channel) return null
    return this.upsertChannel({
      ...channel,
      members: channel.members.filter(member => member !== participantId),
    }, context)
  }

  private async writeMessageCopies(options: {
    filename: string
    meta: RelayMessageMeta
    body: string
    data?: Record<string, unknown>
    sender?: RelayParticipant | null
    recipient?: RelayParticipant | null
    channelId?: string
  }, context?: RelayOperationContext): Promise<RelayMessage> {
    const content = renderRelayMessage(options.meta, options.body, options.data)
    const files: Array<{ path: string; content: string }> = []

    if (options.meta.scope === 'direct' || options.meta.scope === 'system') {
      files.push({
        path: join(
          this.participantMailboxDir(options.meta.from, 'sent'),
          options.filename,
        ),
        content,
      })
      if (options.sender?.tileId) {
        files.push({
          path: join(
            this.tileMailboxDir(options.sender.tileId, 'sent'),
            options.filename,
          ),
          content,
        })
      }

      if (options.meta.to) {
        const inboxMeta: RelayMessageMeta = { ...options.meta, status: 'unread' }
        const inboxContent = renderRelayMessage(inboxMeta, options.body, options.data)
        files.push({
          path: join(
            this.participantMailboxDir(options.meta.to, 'inbox'),
            options.filename,
          ),
          content: inboxContent,
        })
        if (options.recipient?.tileId) {
          files.push({
            path: join(
              this.tileMailboxDir(options.recipient.tileId, 'inbox'),
              options.filename,
            ),
            content: inboxContent,
          })
        }
      }
    }

    if (options.meta.scope === 'channel' && options.channelId) {
      files.push({
        path: join(
          this.channelMessagesDir(options.channelId),
          options.filename,
        ),
        content,
      })
    }

    files.push({
      path: join(this.paths.archive, options.filename),
      content,
    })
    await writeFilesAtomically(files, context)

    return {
      mailbox: options.meta.scope === 'channel' ? 'channel' : 'sent',
      filename: options.filename,
      meta: options.meta,
      body: options.body,
      data: options.data,
    }
  }

  async sendDirectMessage(
    from: string,
    draft: RelayDirectMessageDraft,
    context?: RelayOperationContext,
  ): Promise<RelayMessage> {
    assertActive(context)
    await this.init(context)
    const sender = await this.getParticipant(from, context)
    const recipient = await this.getParticipant(draft.to, context)
    if (!sender) throw new Error(`Unknown sender: ${from}`)
    if (!recipient) throw new Error(`Unknown recipient: ${draft.to}`)

    const stamp = nowStamp()
    const id = randomUUID()
    const filename = `${stamp.iso.replace(/[:.]/g, '-')}-${safeSlug(draft.subject)}.md`
    const meta: RelayMessageMeta = {
      protocol: 'codesurf-relay/v1',
      id,
      threadId: draft.threadId ?? id,
      scope: from === 'system' ? 'system' : 'direct',
      kind: draft.kind ?? 'request',
      priority: draft.priority ?? 'normal',
      from,
      to: draft.to,
      subject: draft.subject,
      status: 'sent',
      createdAt: stamp.iso,
      createdTs: stamp.ts,
      updatedAt: stamp.iso,
      updatedTs: stamp.ts,
      replyToId: draft.replyToId,
      bcc: 'central',
    }

    const message = await this.writeMessageCopies({
      filename,
      meta,
      body: draft.body,
      data: draft.data,
      sender,
      recipient,
    }, context)

    this.emit('direct_message', { from, to: draft.to, message }, context)
    this.emit(
      'central_message',
      { message: { ...message, mailbox: 'central' } },
      context,
    )
    return message
  }

  async sendChannelMessage(
    from: string,
    draft: RelayChannelMessageDraft,
    context?: RelayOperationContext,
  ): Promise<RelayMessage> {
    assertActive(context)
    await this.init(context)
    const sender = await this.getParticipant(from, context)
    if (!sender) throw new Error(`Unknown sender: ${from}`)
    const channel = await this.joinChannel(draft.channel, from, context)

    const stamp = nowStamp()
    const id = randomUUID()
    const filename = `${stamp.iso.replace(/[:.]/g, '-')}-${safeSlug(draft.subject)}.md`
    const meta: RelayMessageMeta = {
      protocol: 'codesurf-relay/v1',
      id,
      threadId: draft.threadId ?? id,
      scope: 'channel',
      kind: draft.kind ?? 'channel',
      priority: draft.priority ?? 'normal',
      from,
      channel: channel.id,
      subject: draft.subject,
      status: 'sent',
      createdAt: stamp.iso,
      createdTs: stamp.ts,
      updatedAt: stamp.iso,
      updatedTs: stamp.ts,
      replyToId: draft.replyToId,
      bcc: 'central',
    }

    const message = await this.writeMessageCopies({
      filename,
      meta,
      body: draft.body,
      data: draft.data,
      sender,
      channelId: channel.id,
    }, context)

    this.emit(
      'channel_message',
      { from, channel: channel.id, message },
      context,
    )
    this.emit(
      'central_message',
      { message: { ...message, mailbox: 'central' } },
      context,
    )
    return message
  }

  async storeMemory(
    participantId: string,
    subject: string,
    body: string,
    data?: Record<string, unknown>,
    context?: RelayOperationContext,
  ): Promise<RelayMessage> {
    assertActive(context)
    const participant = await this.getParticipant(participantId, context)
    if (!participant) throw new Error(`Unknown participant: ${participantId}`)
    const stamp = nowStamp()
    const id = randomUUID()
    const filename = `${stamp.iso.replace(/[:.]/g, '-')}-${safeSlug(subject)}.md`
    const meta: RelayMessageMeta = {
      protocol: 'codesurf-relay/v1',
      id,
      threadId: id,
      scope: 'system',
      kind: 'memory',
      priority: 'normal',
      from: participantId,
      to: participantId,
      subject,
      status: 'archived',
      createdAt: stamp.iso,
      createdTs: stamp.ts,
      updatedAt: stamp.iso,
      updatedTs: stamp.ts,
      bcc: 'central',
    }
    const content = renderRelayMessage(meta, body, data)
    const files = [{
      path: join(
        this.participantMailboxDir(participantId, 'memory'),
        filename,
      ),
      content,
    }, {
      path: join(this.paths.archive, filename),
      content,
    }]
    if (participant.tileId) {
      files.push({
        path: join(
          this.tileMailboxDir(participant.tileId, 'memory'),
          filename,
        ),
        content,
      })
    }
    await writeFilesAtomically(files, context)
    return { mailbox: 'memory', filename, meta, body, data }
  }

  async listMessages(participantId: string, mailbox: Exclude<RelayMailbox, 'channel' | 'central'>, limit?: number): Promise<RelayMessageListItem[]> {
    const dir = this.participantMailboxDir(participantId, mailbox)
    try {
      const files = (await fs.readdir(dir)).filter(name => name.endsWith('.md')).sort().reverse()
      const selected = limit ? files.slice(0, limit) : files
      const messages = await Promise.all(selected.map(async filename => {
        const message = await readMessage(join(dir, filename), mailbox, filename)
        return message ? { mailbox, filename, meta: message.meta } : null
      }))
      return messages.filter(Boolean) as RelayMessageListItem[]
    } catch {
      return []
    }
  }

  async readParticipantMessage(participantId: string, mailbox: Exclude<RelayMailbox, 'channel' | 'central'>, filename: string): Promise<RelayMessage | null> {
    validateMessageFilename(filename)
    return readMessage(join(this.participantMailboxDir(participantId, mailbox), filename), mailbox, filename)
  }

  async updateMessageStatus(
    participantId: string,
    mailbox: Exclude<RelayMailbox, 'channel' | 'central'>,
    filename: string,
    status: RelayMessageStatus,
    context?: RelayOperationContext,
  ): Promise<boolean> {
    assertActive(context)
    validateMessageFilename(filename)
    const existing = await awaitActive(
      () => this.readParticipantMessage(participantId, mailbox, filename),
      context,
    )
    if (!existing) return false
    const stamp = nowStamp()
    const next: RelayMessage = {
      ...existing,
      meta: {
        ...existing.meta,
        status,
        updatedAt: stamp.iso,
        updatedTs: stamp.ts,
      },
    }
    const content = renderRelayMessage(next.meta, next.body, next.data)
    const participant = await this.getParticipant(participantId, context)
    const files = [{
      path: join(
        this.participantMailboxDir(participantId, mailbox),
        filename,
      ),
      content,
    }]
    if (participant?.tileId) {
      files.push({
        path: join(
          this.tileMailboxDir(participant.tileId, mailbox),
          filename,
        ),
        content,
      })
    }
    await writeFilesAtomically(files, context)
    return true
  }

  async listChannelMessages(channelId: string, limit?: number): Promise<RelayMessageListItem[]> {
    try {
      const files = (await fs.readdir(this.channelMessagesDir(channelId))).filter(name => name.endsWith('.md')).sort().reverse()
      const selected = limit ? files.slice(0, limit) : files
      const messages = await Promise.all(selected.map(async filename => {
        const message = await readMessage(join(this.channelMessagesDir(channelId), filename), 'channel', filename)
        return message ? { mailbox: 'channel', filename, meta: message.meta } : null
      }))
      return messages.filter(Boolean) as RelayMessageListItem[]
    } catch {
      return []
    }
  }

  async readChannelMessage(channelId: string, filename: string): Promise<RelayMessage | null> {
    return readMessage(join(this.channelMessagesDir(channelId), filename), 'channel', filename)
  }

  async listCentralFeed(limit?: number): Promise<RelayMessageListItem[]> {
    try {
      const files = (await fs.readdir(this.paths.archive)).filter(name => name.endsWith('.md')).sort().reverse()
      const selected = limit ? files.slice(0, limit) : files
      const messages = await Promise.all(selected.map(async filename => {
        const message = await readMessage(join(this.paths.archive, filename), 'central', filename)
        return message ? { mailbox: 'central', filename, meta: message.meta } : null
      }))
      return messages.filter(Boolean) as RelayMessageListItem[]
    } catch {
      return []
    }
  }

  async listUnreadDirectMessages(participantId: string): Promise<RelayMessage[]> {
    const items = await this.listMessages(participantId, 'inbox')
    const unread = items.filter(item => item.meta.status === 'unread')
    const messages = await Promise.all(unread.map(item => this.readParticipantMessage(participantId, 'inbox', item.filename)))
    return messages.filter(Boolean) as RelayMessage[]
  }

  async listUnreadChannelMessages(participantId: string): Promise<RelayMessage[]> {
    const participant = await this.getParticipant(participantId)
    if (!participant) return []
    const all: RelayMessage[] = []
    for (const channel of participant.channels) {
      const cursor = await readJson<{ lastReadTs: number }>(this.participantCursorFile(participantId, channel), { lastReadTs: 0 })
      const items = await this.listChannelMessages(channel)
      const fresh = items.filter(item => item.meta.createdTs > cursor.lastReadTs && item.meta.from !== participantId)
      const messages = await Promise.all(fresh.map(item => this.readChannelMessage(channel, item.filename)))
      all.push(...(messages.filter(Boolean) as RelayMessage[]))
    }
    return all.sort((a, b) => a.meta.createdTs - b.meta.createdTs)
  }

  async markDirectMessagesRead(
    participantId: string,
    messages: RelayMessage[],
    context?: RelayOperationContext,
  ): Promise<void> {
    await awaitActive(
      () => Promise.all(messages.map(message => this.updateMessageStatus(
        participantId,
        'inbox',
        message.filename,
        'read',
        context,
      ))).then(() => undefined),
      context,
    )
  }

  async advanceChannelCursor(
    participantId: string,
    channelId: string,
    timestamp: number,
    context?: RelayOperationContext,
  ): Promise<void> {
    await writeJson(
      this.participantCursorFile(participantId, channelId),
      { lastReadTs: timestamp },
      context,
    )
  }

  async analyzeRelationships(): Promise<RelayRelationshipHint[]> {
    const participants = (await this.listParticipants()).filter(participant => participant.id !== 'system')
    const hints: RelayRelationshipHint[] = []

    for (let i = 0; i < participants.length; i++) {
      for (let j = i + 1; j < participants.length; j++) {
        const a = participants[i]
        const b = participants[j]
        const sharedChannels = a.channels.filter(channel => b.channels.includes(channel))
        const overlappingFiles = (a.work?.files ?? []).filter(file => (b.work?.files ?? []).includes(file))
        const sameBranch = !!a.work?.branch && a.work?.branch === b.work?.branch
        const sameWorktree = !!a.work?.worktreePath && a.work?.worktreePath === b.work?.worktreePath
        // Read defensively: a participant.json written before impacts were
        // normalized may still hold a non-array, and throwing here would take
        // out every relationship analysis for the whole workspace.
        const impacts = [
          ...normalizeRelayImpacts(a.work?.impacts).filter(impact => impact.targetType === 'agent' && impact.targetId === b.id),
          ...normalizeRelayImpacts(b.work?.impacts).filter(impact => impact.targetType === 'agent' && impact.targetId === a.id),
        ]
        if (!sharedChannels.length && !overlappingFiles.length && !sameBranch && !sameWorktree && !impacts.length) continue

        const parts: string[] = []
        if (sharedChannels.length) parts.push(`share channels ${sharedChannels.join(', ')}`)
        if (overlappingFiles.length) parts.push(`touch the same files (${overlappingFiles.slice(0, 5).join(', ')})`)
        if (sameBranch) parts.push(`are on the same branch ${a.work?.branch}`)
        if (sameWorktree) parts.push('share the same worktree')
        if (impacts.length) parts.push(`have explicit impact alerts (${impacts.map(impact => impact.description).join('; ')})`)

        const priority: RelayPriority = impacts.some(impact => impact.severity === 'high') || overlappingFiles.length > 2
          ? 'critical'
          : sameBranch || sameWorktree || overlappingFiles.length > 0
            ? 'high'
            : 'normal'

        hints.push({
          participants: [a.id, b.id],
          sameBranch,
          sameWorktree,
          sharedChannels,
          overlappingFiles,
          impacts,
          priority,
          summary: `${a.name} and ${b.name} ${parts.join(', ')}`,
        })
      }
    }

    const order: Record<RelayPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 }
    return hints.sort((a, b) => order[a.priority] - order[b.priority] || a.summary.localeCompare(b.summary))
  }

  async writeRelationshipsSnapshot(
    context?: RelayOperationContext,
  ): Promise<void> {
    const hints = await awaitActive(
      () => this.analyzeRelationships(),
      context,
    )
    await writeJson(
      join(this.paths.relationships, 'latest.json'),
      { generatedAt: new Date().toISOString(), hints },
      context,
    )
  }

  async waitForReady(
    ids: string[],
    options: RelayWaitOptions = {},
    context?: RelayOperationContext,
  ): Promise<void> {
    assertActive(context)
    const timeoutMs = options.timeoutMs ?? 60_000
    const pending = new Set(ids)
    if (pending.size === 0) return

    await awaitActive(() => new Promise<void>((resolve, reject) => {
      let settled = false
      let unsubscribe = () => {}
      const cleanup = () => {
        clearTimeout(timer)
        unsubscribe()
        context?.signal?.removeEventListener('abort', onAbort)
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const succeed = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const timer = setTimeout(() => {
        fail(new Error(`Timed out waiting for ready: ${Array.from(pending).join(', ')}`))
      }, timeoutMs)

      const listener = (event: RelayEvent) => {
        if (event.type !== 'ready') return
        pending.delete((event.payload as { participantId: string }).participantId)
        if (pending.size === 0) succeed()
      }
      const onAbort = () => fail(new Error('Relay wait was cancelled'))

      context?.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        assertActive(context)
        unsubscribe = this.on(listener)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        return
      }

      void this.listParticipants(context).then(
        current => {
          if (settled) return
          current
            .filter(participant => participant.status === 'ready')
            .forEach(participant => pending.delete(participant.id))
          if (pending.size === 0) succeed()
        },
        error => fail(
          error instanceof Error ? error : new Error(String(error)),
        ),
      )
    }), context)
  }

  async waitForAny(
    ids: string[],
    options: RelayWaitOptions = {},
    context?: RelayOperationContext,
  ): Promise<RelayParticipant> {
    assertActive(context)
    const timeoutMs = options.timeoutMs ?? 5 * 60_000
    const doneStates = new Set<RelayParticipantStatus>(['done', 'error', 'stopped'])

    return awaitActive(() => new Promise<RelayParticipant>((resolve, reject) => {
      let settled = false
      let unsubscribe = () => {}
      const cleanup = () => {
        clearTimeout(timer)
        unsubscribe()
        context?.signal?.removeEventListener('abort', onAbort)
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const succeed = (participant: RelayParticipant) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(participant)
      }
      const timer = setTimeout(() => {
        fail(new Error(`Timed out waiting for any of: ${ids.join(', ')}`))
      }, timeoutMs)

      const listener = (event: RelayEvent) => {
        if (event.type !== 'participant_status') return
        const payload = event.payload as { participantId: string; status: RelayParticipantStatus }
        if (!ids.includes(payload.participantId)) return
        if (!doneStates.has(payload.status)) return
        void this.getParticipant(payload.participantId, context).then(
          participant => {
            if (!participant) {
              fail(new Error(`Participant disappeared: ${payload.participantId}`))
              return
            }
            succeed(participant)
          },
          error => fail(
            error instanceof Error ? error : new Error(String(error)),
          ),
        )
      }
      const onAbort = () => fail(new Error('Relay wait was cancelled'))

      context?.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        assertActive(context)
        unsubscribe = this.on(listener)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        return
      }

      void this.listParticipants(context).then(
        current => {
          if (settled) return
          const immediate = current.find(
            participant => ids.includes(participant.id)
              && doneStates.has(participant.status),
          )
          if (immediate) succeed(immediate)
        },
        error => fail(
          error instanceof Error ? error : new Error(String(error)),
        ),
      )
    }), context)
  }

  async moveMessage(
    participantId: string,
    fromMailbox: Exclude<RelayMailbox, 'channel' | 'central'>,
    toMailbox: Exclude<RelayMailbox, 'channel' | 'central'>,
    filename: string,
    context?: RelayOperationContext,
  ): Promise<boolean> {
    assertActive(context)
    validateMessageFilename(filename)
    try {
      await awaitActive(
        () => ensureDir(this.participantMailboxDir(participantId, toMailbox)),
        context,
      )
      const participant = await this.getParticipant(participantId, context)
      if (participant?.tileId) {
        await awaitActive(
          () => ensureDir(this.tileMailboxDir(participant.tileId!, toMailbox)),
          context,
        )
      }

      assertActive(context)
      renameSync(
        join(this.participantMailboxDir(participantId, fromMailbox), filename),
        join(
          this.participantMailboxDir(participantId, toMailbox),
          basename(filename),
        ),
      )
      if (participant?.tileId) {
        try {
          renameSync(
            join(
              this.tileMailboxDir(participant.tileId, fromMailbox),
              filename,
            ),
            join(
              this.tileMailboxDir(participant.tileId, toMailbox),
              basename(filename),
            ),
          )
        } catch {}
      }
      return true
    } catch (error) {
      assertActive(context)
      return false
    }
  }
}
