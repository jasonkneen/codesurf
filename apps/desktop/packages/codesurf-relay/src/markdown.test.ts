import { describe, it, expect } from 'vitest'
import { parseRelayMessage, renderRelayMessage } from './markdown'
import type { RelayMessageMeta } from './types'

describe('markdown', () => {
  describe('renderRelayMessage', () => {
    it('should render basic message with frontmatter', () => {
      const meta: RelayMessageMeta = {
        protocol: 'codesurf-relay/v1',
        id: 'msg-1',
        threadId: 'thread-1',
        scope: 'direct',
        kind: 'request',
        priority: 'normal',
        from: 'agent-a',
        to: 'agent-b',
        subject: 'Test message',
        status: 'sent',
        createdAt: '2024-01-01T00:00:00.000Z',
        createdTs: 1704067200000,
        updatedAt: '2024-01-01T00:00:00.000Z',
        updatedTs: 1704067200000,
        bcc: 'central',
      }
      
      const result = renderRelayMessage(meta, 'Hello world')
      
      expect(result).toContain('protocol: "codesurf-relay/v1"')
      expect(result).toContain('id: "msg-1"')
      expect(result).toContain('from: "agent-a"')
      expect(result).toContain('to: "agent-b"')
      expect(result).toContain('Hello world')
    })

    it('should include data block when provided', () => {
      const meta: RelayMessageMeta = {
        protocol: 'codesurf-relay/v1',
        id: 'msg-1',
        threadId: 'thread-1',
        scope: 'direct',
        kind: 'request',
        priority: 'high',
        from: 'agent-a',
        to: 'agent-b',
        subject: 'With data',
        status: 'sent',
        createdAt: '2024-01-01T00:00:00.000Z',
        createdTs: 1704067200000,
        updatedAt: '2024-01-01T00:00:00.000Z',
        updatedTs: 1704067200000,
        bcc: 'central',
      }
      
      const data = { files: ['src/auth.ts'], branch: 'feature/auth' }
      const result = renderRelayMessage(meta, 'Check this', data)
      
      expect(result).toContain('```codesurf-data')
      expect(result).toContain('"files": [')
      expect(result).toContain('"src/auth.ts"')
    })

    it('should handle special characters in subject', () => {
      const meta: RelayMessageMeta = {
        protocol: 'codesurf-relay/v1',
        id: 'msg-1',
        threadId: 'thread-1',
        scope: 'direct',
        kind: 'request',
        priority: 'normal',
        from: 'agent-a',
        to: 'agent-b',
        subject: 'Line\nBreak and "quotes"',
        status: 'sent',
        createdAt: '2024-01-01T00:00:00.000Z',
        createdTs: 1704067200000,
        updatedAt: '2024-01-01T00:00:00.000Z',
        updatedTs: 1704067200000,
        bcc: 'central',
      }
      
      const result = renderRelayMessage(meta, 'Body')
      expect(result).toContain('subject: "Line\\nBreak and \\"quotes\\""')
    })
  })

  describe('parseRelayMessage', () => {
    it('should parse valid message', () => {
      const content = `---
protocol: "codesurf-relay/v1"
id: "msg-1"
threadId: "thread-1"
scope: "direct"
kind: "request"
priority: "normal"
from: "agent-a"
to: "agent-b"
channel: null
subject: "Test"
status: "sent"
createdAt: "2024-01-01T00:00:00.000Z"
createdTs: 1704067200000
updatedAt: "2024-01-01T00:00:00.000Z"
updatedTs: 1704067200000
replyToId: null
bcc: "central"
---

Hello world
`
      
      const result = parseRelayMessage(content, 'inbox', 'test.md')
      
      expect(result).not.toBeNull()
      expect(result?.meta.id).toBe('msg-1')
      expect(result?.meta.from).toBe('agent-a')
      expect(result?.body).toBe('Hello world')
    })

    it('should parse message with data block', () => {
      const content = `---
protocol: "codesurf-relay/v1"
id: "msg-1"
threadId: "thread-1"
scope: "direct"
kind: "request"
priority: "normal"
from: "agent-a"
to: "agent-b"
channel: null
subject: "Test"
status: "sent"
createdAt: "2024-01-01T00:00:00.000Z"
createdTs: 1704067200000
updatedAt: "2024-01-01T00:00:00.000Z"
updatedTs: 1704067200000
replyToId: null
bcc: "central"
---

Body text

\`\`\`codesurf-data
{"key": "value"}
\`\`\`
`
      
      const result = parseRelayMessage(content, 'inbox', 'test.md')
      
      expect(result?.body).toBe('Body text')
      expect(result?.data).toEqual({ key: 'value' })
    })

    it('should reject invalid protocol', () => {
      const content = `---
protocol: "invalid-protocol"
id: "msg-1"
---

Body
`
      
      const result = parseRelayMessage(content, 'inbox', 'test.md')
      expect(result).toBeNull()
    })

    it('should reject missing frontmatter', () => {
      const result = parseRelayMessage('Just body text', 'inbox', 'test.md')
      expect(result).toBeNull()
    })

    it('should reject missing required fields', () => {
      const content = `---
protocol: "codesurf-relay/v1"
id: ""
from: ""
---

Body
`
      
      const result = parseRelayMessage(content, 'inbox', 'test.md')
      expect(result).toBeNull()
    })
  })

  describe('roundtrip', () => {
    it('should preserve message through render and parse', () => {
      const meta: RelayMessageMeta = {
        protocol: 'codesurf-relay/v1',
        id: 'msg-1',
        threadId: 'thread-1',
        scope: 'direct',
        kind: 'request',
        priority: 'high',
        from: 'agent-a',
        to: 'agent-b',
        subject: 'Test subject',
        status: 'sent',
        createdAt: '2024-01-01T00:00:00.000Z',
        createdTs: 1704067200000,
        updatedAt: '2024-01-01T00:01:00.000Z',
        updatedTs: 1704067260000,
        replyToId: 'prev-msg',
        bcc: 'central',
      }
      
      const body = 'Test message body'
      const data = { key: 'value', num: 42 }
      
      const rendered = renderRelayMessage(meta, body, data)
      const parsed = parseRelayMessage(rendered, 'sent', 'test.md')
      
      expect(parsed).not.toBeNull()
      expect(parsed?.meta.id).toBe(meta.id)
      expect(parsed?.meta.from).toBe(meta.from)
      expect(parsed?.meta.subject).toBe(meta.subject)
      expect(parsed?.body).toBe(body)
      expect(parsed?.data).toEqual(data)
    })
  })
})
