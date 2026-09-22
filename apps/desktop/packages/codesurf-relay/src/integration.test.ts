import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CodesurfRelay } from './relay'
import { RelayRuntime } from './runtime'
import type { RelayAgentExecutor, RelayTurnInput } from './types'

/**
 * Integration tests for the relay system.
 * These tests use real file system operations in a temp directory.
 */
describe('integration', () => {
  let tempDir: string
  let relay: CodesurfRelay
  let events: Array<{ type: string; payload: unknown }> = []

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'relay-test-'))
    relay = new CodesurfRelay({ workspacePath: tempDir })
    events = []
    
    // Capture all events
    relay.on((event) => {
      events.push({ type: event.type, payload: event.payload })
    })
  })

  afterEach(() => {
    // Cleanup temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  describe('CodesurfRelay', () => {
    it('should initialize storage structure', async () => {
      await relay.init()

      expect(existsSync(join(tempDir, '.codesurf', 'relay', 'participants'))).toBe(true)
      expect(existsSync(join(tempDir, '.codesurf', 'relay', 'channels'))).toBe(true)
      expect(existsSync(join(tempDir, '.codesurf', 'relay', 'archive', 'all'))).toBe(true)
      expect(existsSync(join(tempDir, '.codesurf', 'relay', 'relationships'))).toBe(true)
    })

    it('should create system participant on init', async () => {
      await relay.init()

      const systemParticipant = await relay.getParticipant('system')
      expect(systemParticipant).not.toBeNull()
      expect(systemParticipant?.name).toBe('System')
      expect(systemParticipant?.kind).toBe('system')
    })

    it('should create participant with mailboxes', async () => {
      await relay.init()

      await relay.upsertParticipant({
        id: 'agent-1',
        name: 'Test Agent',
        kind: 'agent',
        status: 'ready',
        channels: [],
      })

      expect(existsSync(join(tempDir, '.codesurf', 'relay', 'participants', 'agent-1', 'mailboxes', 'inbox'))).toBe(true)
      expect(existsSync(join(tempDir, '.codesurf', 'relay', 'participants', 'agent-1', 'mailboxes', 'sent'))).toBe(true)
      expect(existsSync(join(tempDir, '.codesurf', 'relay', 'participants', 'agent-1', 'mailboxes', 'memory'))).toBe(true)
      expect(existsSync(join(tempDir, '.codesurf', 'relay', 'participants', 'agent-1', 'mailboxes', 'bin'))).toBe(true)
    })

    it('should send direct message and create files', async () => {
      await relay.init()

      await relay.upsertParticipant({
        id: 'agent-a',
        name: 'Agent A',
        kind: 'agent',
        status: 'ready',
        channels: [],
      })

      await relay.upsertParticipant({
        id: 'agent-b',
        name: 'Agent B',
        kind: 'agent',
        status: 'ready',
        channels: [],
      })

      await relay.sendDirectMessage('agent-a', {
        to: 'agent-b',
        subject: 'Test message',
        body: 'Hello from A',
        priority: 'high',
      })

      // Check sender's sent mailbox
      const sentDir = join(tempDir, '.codesurf', 'relay', 'participants', 'agent-a', 'mailboxes', 'sent')
      const sentFiles = readdirSync(sentDir)
      expect(sentFiles.length).toBeGreaterThan(0)

      // Check recipient's inbox
      const inboxDir = join(tempDir, '.codesurf', 'relay', 'participants', 'agent-b', 'mailboxes', 'inbox')
      const inboxFiles = readdirSync(inboxDir)
      expect(inboxFiles.length).toBeGreaterThan(0)

      // Check archive
      const archiveDir = join(tempDir, '.codesurf', 'relay', 'archive', 'all')
      const archiveFiles = readdirSync(archiveDir)
      expect(archiveFiles.length).toBeGreaterThan(0)

      // Verify message content
      const inboxMessage = readFileSync(join(inboxDir, inboxFiles[0]), 'utf-8')
      expect(inboxMessage).toContain('Hello from A')
      expect(inboxMessage).toContain('from: "agent-a"')
      expect(inboxMessage).toContain('to: "agent-b"')
      expect(inboxMessage).toContain('status: "unread"')
    })

    it('should send channel message', async () => {
      await relay.init()

      await relay.upsertParticipant({
        id: 'agent-a',
        name: 'Agent A',
        kind: 'agent',
        status: 'ready',
        channels: ['general'],
      })

      await relay.sendChannelMessage('agent-a', {
        channel: 'general',
        subject: 'Announcement',
        body: 'Hello channel!',
      })

      // Check channel messages
      const channelDir = join(tempDir, '.codesurf', 'relay', 'channels', 'general', 'messages')
      expect(existsSync(channelDir)).toBe(true)
      const channelFiles = readdirSync(channelDir)
      expect(channelFiles.length).toBeGreaterThan(0)
    })

    it('should track unread messages', async () => {
      await relay.init()

      await relay.upsertParticipant({
        id: 'agent-a',
        name: 'Agent A',
        kind: 'agent',
        status: 'ready',
        channels: [],
      })

      await relay.upsertParticipant({
        id: 'agent-b',
        name: 'Agent B',
        kind: 'agent',
        status: 'ready',
        channels: [],
      })

      await relay.sendDirectMessage('agent-a', {
        to: 'agent-b',
        subject: 'Unread test',
        body: 'This is unread',
      })

      const unread = await relay.listUnreadDirectMessages('agent-b')
      expect(unread.length).toBe(1)
      expect(unread[0].meta.subject).toBe('Unread test')
    })

    it('should mark messages as read', async () => {
      await relay.init()

      await relay.upsertParticipant({
        id: 'agent-a',
        name: 'Agent A',
        kind: 'agent',
        status: 'ready',
        channels: [],
      })

      await relay.upsertParticipant({
        id: 'agent-b',
        name: 'Agent B',
        kind: 'agent',
        status: 'ready',
        channels: [],
      })

      await relay.sendDirectMessage('agent-a', {
        to: 'agent-b',
        subject: 'Read test',
        body: 'Please read me',
      })

      const unread = await relay.listUnreadDirectMessages('agent-b')
      expect(unread.length).toBe(1)

      await relay.markDirectMessagesRead('agent-b', unread)

      const unreadAfter = await relay.listUnreadDirectMessages('agent-b')
      expect(unreadAfter.length).toBe(0)
    })

    it('should update work context', async () => {
      await relay.init()

      await relay.upsertParticipant({
        id: 'agent-1',
        name: 'Agent 1',
        kind: 'agent',
        status: 'ready',
        channels: [],
      })

      await relay.updateWorkContext('agent-1', {
        summary: 'Working on auth',
        branch: 'feature/auth',
        files: ['src/auth.ts', 'src/jwt.ts'],
        topics: ['security'],
        collaborators: ['agent-2'],
        blockers: [],
        impacts: [
          { targetType: 'agent', targetId: 'agent-2', description: 'API changes', severity: 'high' },
        ],
      })

      const participant = await relay.getParticipant('agent-1')
      expect(participant?.work?.summary).toBe('Working on auth')
      expect(participant?.work?.files).toContain('src/auth.ts')
      expect(participant?.work?.impacts).toHaveLength(1)
    })

    it('should detect relationships between participants', async () => {
      await relay.init()

      await relay.upsertParticipant({
        id: 'agent-1',
        name: 'Agent 1',
        kind: 'agent',
        status: 'ready',
        channels: ['backend'],
      })

      await relay.upsertParticipant({
        id: 'agent-2',
        name: 'Agent 2',
        kind: 'agent',
        status: 'ready',
        channels: ['backend'],
      })

      await relay.updateWorkContext('agent-1', {
        summary: 'Auth work',
        branch: 'feature/auth',
        files: ['src/auth.ts'],
        topics: [],
        collaborators: [],
        blockers: [],
        impacts: [],
      })

      await relay.updateWorkContext('agent-2', {
        summary: 'API work',
        branch: 'feature/auth', // Same branch
        files: ['src/auth.ts'], // Same file
        topics: [],
        collaborators: [],
        blockers: [],
        impacts: [],
      })

      const relationships = await relay.analyzeRelationships()
      
      // Should find relationship between agent-1 and agent-2
      const rel = relationships.find(r => 
        r.participants.includes('agent-1') && r.participants.includes('agent-2')
      )
      expect(rel).toBeDefined()
      expect(rel?.sameBranch).toBe(true)
      expect(rel?.overlappingFiles).toContain('src/auth.ts')
      expect(rel?.sharedChannels).toContain('backend')
      expect(rel?.priority).toBe('high') // Due to overlapping files + same branch
    })

    it('should emit events for participant changes', async () => {
      await relay.init()

      await relay.upsertParticipant({
        id: 'agent-1',
        name: 'Agent 1',
        kind: 'agent',
        status: 'ready',
        channels: [],
      })

      const upsertEvents = events.filter(e => e.type === 'participant_upserted')
      expect(upsertEvents.length).toBeGreaterThan(0)

      await relay.setParticipantStatus('agent-1', 'running')

      const statusEvents = events.filter(e => e.type === 'participant_status')
      expect(statusEvents.length).toBeGreaterThan(0)
    })

    it('should emit events for messages', async () => {
      await relay.init()

      await relay.upsertParticipant({
        id: 'agent-a',
        name: 'Agent A',
        kind: 'agent',
        status: 'ready',
        channels: [],
      })

      await relay.upsertParticipant({
        id: 'agent-b',
        name: 'Agent B',
        kind: 'agent',
        status: 'ready',
        channels: [],
      })

      await relay.sendDirectMessage('agent-a', {
        to: 'agent-b',
        subject: 'Event test',
        body: 'Check events',
      })

      const dmEvents = events.filter(e => e.type === 'direct_message')
      expect(dmEvents.length).toBe(1)
      expect((dmEvents[0].payload as { from: string }).from).toBe('agent-a')

      const centralEvents = events.filter(e => e.type === 'central_message')
      expect(centralEvents.length).toBe(1)
    })

    it('should reject invalid participant IDs', async () => {
      await relay.init()

      await expect(relay.upsertParticipant({
        id: '../etc/passwd',
        name: 'Hacker',
        kind: 'agent',
        status: 'ready',
        channels: [],
      })).rejects.toThrow('Invalid participant ID')
    })

    it('should support memory storage', async () => {
      await relay.init()

      await relay.upsertParticipant({
        id: 'agent-1',
        name: 'Agent 1',
        kind: 'agent',
        status: 'ready',
        channels: [],
      })

      await relay.storeMemory('agent-1', 'Important decision', 'We chose PostgreSQL', {
        context: 'database-selection',
        confidence: 0.95,
      })

      const memories = await relay.listMessages('agent-1', 'memory')
      expect(memories.length).toBe(1)
      expect(memories[0].meta.subject).toBe('Important decision')
    })

    it('should cancel relay waits and release their event subscription', async () => {
      await relay.init()
      const controller = new AbortController()
      const cancellation = new Error('relay generation stopped')
      let active = true
      const listenerCountBeforeWait = relay.events.listenerCount('event')

      const waiting = relay.waitForReady(
        ['never-ready'],
        { timeoutMs: 60_000 },
        {
          signal: controller.signal,
          assertActive() {
            if (!active) throw cancellation
          },
        },
      )
      expect(relay.events.listenerCount('event')).toBe(
        listenerCountBeforeWait + 1,
      )

      active = false
      controller.abort()
      await expect(waiting).rejects.toBe(cancellation)
      expect(relay.events.listenerCount('event')).toBe(
        listenerCountBeforeWait,
      )

      const anyController = new AbortController()
      const anyCancellation = new Error('relay generation stopped again')
      let anyActive = true
      const waitingForAny = relay.waitForAny(
        ['never-done'],
        { timeoutMs: 60_000 },
        {
          signal: anyController.signal,
          assertActive() {
            if (!anyActive) throw anyCancellation
          },
        },
      )
      expect(relay.events.listenerCount('event')).toBe(
        listenerCountBeforeWait + 1,
      )

      anyActive = false
      anyController.abort()
      await expect(waitingForAny).rejects.toBe(anyCancellation)
      expect(relay.events.listenerCount('event')).toBe(
        listenerCountBeforeWait,
      )
    })
  })

  describe('RelayRuntime with real relay', () => {
    it('should spawn agents and send initial task', async () => {
      await relay.init()

      const mockExecutor: RelayAgentExecutor = {
        runTurn: vi.fn().mockResolvedValue(JSON.stringify({ ready: true, status: 'ready' })),
      }

      const runtime = new RelayRuntime(relay, {
        executorFactory: () => mockExecutor,
        turnTimeoutMs: 5000,
      })

      // Spawn an agent
      await runtime.spawn({
        id: 'alice',
        name: 'Alice',
        task: 'Respond to messages',
        channels: [],
      })

      // Verify agent was created
      const alice = await relay.getParticipant('alice')
      expect(alice).not.toBeNull()
      expect(alice?.name).toBe('Alice')

      // Verify initial task message was sent
      const aliceInbox = await relay.listMessages('alice', 'inbox')
      expect(aliceInbox.length).toBeGreaterThan(0)

      runtime.destroy()
    })

    it('should trigger agent on direct message via event', async () => {
      await relay.init()

      const runTurn = vi.fn().mockImplementation(async () => {
        return JSON.stringify({ ready: true, status: 'ready' })
      })
      const mockExecutor: RelayAgentExecutor = {
        runTurn,
      }

      const runtime = new RelayRuntime(relay, {
        executorFactory: () => mockExecutor,
        turnTimeoutMs: 5000,
      })

      // Create both agents
      await relay.upsertParticipant({
        id: 'alice',
        name: 'Alice',
        kind: 'agent',
        status: 'ready',
        channels: [],
      })

      await relay.upsertParticipant({
        id: 'bob',
        name: 'Bob',
        kind: 'agent',
        status: 'ready',
        channels: [],
      })

      // Manually add bob to runtime's agent map
      await runtime.spawn({
        id: 'bob',
        name: 'Bob',
        task: 'Listen for messages',
        channels: [],
      })
      expect(runTurn).toHaveBeenCalledTimes(1)

      // Alice sends message to Bob
      await relay.sendDirectMessage('alice', {
        to: 'bob',
        subject: 'Hello',
        body: 'Hi Bob!',
      })

      await vi.waitFor(() => {
        expect(runTurn).toHaveBeenCalledTimes(2)
      })
      const secondTurn = runTurn.mock.calls[1][0] as RelayTurnInput
      expect(secondTurn.unreadDirectMessages).toHaveLength(1)
      expect(secondTurn.unreadDirectMessages[0].meta.from).toBe('alice')
      expect(secondTurn.unreadDirectMessages[0].body).toBe('Hi Bob!')
      await vi.waitFor(async () => {
        expect(await relay.listUnreadDirectMessages('bob')).toHaveLength(0)
      })

      await runtime.destroy()
    })
  })
})
