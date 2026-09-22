import type { RelayMailbox, RelayMessage, RelayMessageMeta } from './types'

function encodeValue(value: string | number | undefined): string {
  if (value === undefined) return 'null'
  return JSON.stringify(value)
}

function decodeValue(raw: string): string | number | null {
  const trimmed = raw.trim()
  if (trimmed === 'null') return null
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed) as string
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  const num = Number(trimmed)
  return Number.isFinite(num) ? num : trimmed
}

function extractStructuredData(body: string): { body: string; data?: Record<string, unknown> } {
  const match = body.match(/\n```codesurf-data\n([\s\S]*?)\n```\s*$/)
  if (!match) return { body: body.trim() }
  try {
    return {
      body: body.slice(0, match.index).trim(),
      data: JSON.parse(match[1]) as Record<string, unknown>,
    }
  } catch {
    return { body: body.trim() }
  }
}

export function renderRelayMessage(meta: RelayMessageMeta, body: string, data?: Record<string, unknown>): string {
  const lines = [
    '---',
    `protocol: ${encodeValue(meta.protocol)}`,
    `id: ${encodeValue(meta.id)}`,
    `threadId: ${encodeValue(meta.threadId)}`,
    `scope: ${encodeValue(meta.scope)}`,
    `kind: ${encodeValue(meta.kind)}`,
    `priority: ${encodeValue(meta.priority)}`,
    `from: ${encodeValue(meta.from)}`,
    `to: ${encodeValue(meta.to)}`,
    `channel: ${encodeValue(meta.channel)}`,
    `subject: ${encodeValue(meta.subject)}`,
    `status: ${encodeValue(meta.status)}`,
    `createdAt: ${encodeValue(meta.createdAt)}`,
    `createdTs: ${encodeValue(meta.createdTs)}`,
    `updatedAt: ${encodeValue(meta.updatedAt)}`,
    `updatedTs: ${encodeValue(meta.updatedTs)}`,
    `replyToId: ${encodeValue(meta.replyToId)}`,
    `bcc: ${encodeValue(meta.bcc)}`,
    '---',
    '',
    body.trim(),
  ]

  if (data && Object.keys(data).length > 0) {
    lines.push('', '```codesurf-data', JSON.stringify(data, null, 2), '```')
  }

  lines.push('')
  return lines.join('\n')
}

export function parseRelayMessage(content: string, mailbox: RelayMailbox, filename: string): RelayMessage | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return null

  const values = new Map<string, string | number | null>()
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    values.set(line.slice(0, idx).trim(), decodeValue(line.slice(idx + 1)))
  }

  if (values.get('protocol') !== 'codesurf-relay/v1') return null

  const payload = extractStructuredData(match[2] ?? '')
  const meta: RelayMessageMeta = {
    protocol: 'codesurf-relay/v1',
    id: String(values.get('id') ?? ''),
    threadId: String(values.get('threadId') ?? ''),
    scope: String(values.get('scope') ?? 'direct') as RelayMessageMeta['scope'],
    kind: String(values.get('kind') ?? 'request') as RelayMessageMeta['kind'],
    priority: String(values.get('priority') ?? 'normal') as RelayMessageMeta['priority'],
    from: String(values.get('from') ?? ''),
    to: values.get('to') ? String(values.get('to')) : undefined,
    channel: values.get('channel') ? String(values.get('channel')) : undefined,
    subject: String(values.get('subject') ?? ''),
    status: String(values.get('status') ?? 'unread') as RelayMessageMeta['status'],
    createdAt: String(values.get('createdAt') ?? ''),
    createdTs: Number(values.get('createdTs') ?? 0),
    updatedAt: String(values.get('updatedAt') ?? values.get('createdAt') ?? ''),
    updatedTs: Number(values.get('updatedTs') ?? values.get('createdTs') ?? 0),
    replyToId: values.get('replyToId') ? String(values.get('replyToId')) : undefined,
    bcc: 'central',
  }

  if (!meta.id || !meta.from) return null

  return {
    mailbox,
    filename,
    meta,
    body: payload.body,
    data: payload.data,
  }
}
