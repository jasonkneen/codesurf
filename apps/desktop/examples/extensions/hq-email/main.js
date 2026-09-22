/**
 * HQ Email — power-tier extension backend.
 *
 * Wraps the `gog` CLI for Gmail access and exposes email operations
 * as both IPC handlers (for iframe tiles) and MCP tools (for AI agents).
 */

const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const GOG = 'gog'

// ── gog CLI wrapper ──────────────────────────────────────────────────────────

async function gog(args) {
  try {
    const { stdout } = await execFileAsync(GOG, args, { maxBuffer: 10 * 1024 * 1024 })
    return stdout
  } catch (err) {
    throw new Error(`gog ${args.join(' ')} failed: ${err.stderr || err.message}`)
  }
}

function parseFrom(raw) {
  const m = raw.match(/^(.+?)\s*<(.+?)>$/)
  if (m) return { name: m[1].trim(), email: m[2].trim() }
  return { name: raw, email: raw }
}

// ── MIME utilities ───────────────────────────────────────────────────────────

function base64UrlDecode(b64) {
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
}

function decodeQP(input) {
  return input
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

function decodePart(body, headers) {
  if (headers.includes('content-transfer-encoding: base64'))
    return base64UrlDecode(body.replace(/\s/g, ''))
  if (headers.includes('content-transfer-encoding: quoted-printable'))
    return decodeQP(body)
  return body
}

function parseParts(raw, boundary) {
  const parts = raw.split('--' + boundary)
  let html = '', text = ''
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd < 0) continue
    const headers = part.slice(0, headerEnd).toLowerCase()
    let body = part.slice(headerEnd + 4)
    if (body.endsWith('--\r\n')) body = body.slice(0, -5)
    if (body.endsWith('\r\n')) body = body.slice(0, -2)
    const nested = headers.match(/content-type:\s*multipart\/\w+;\s*boundary="?([^"\r\n]+)"?/)
    if (nested) {
      const n = parseParts(part.slice(headerEnd + 4), nested[1])
      if (n.html && !html) html = n.html
      if (n.text && !text) text = n.text
      continue
    }
    if (headers.includes('text/html') && !html) html = decodePart(body, headers)
    else if (headers.includes('text/plain') && !text) text = decodePart(body, headers)
  }
  return { html, text }
}

function extractHtmlFromRawMime(rawB64) {
  const raw = base64UrlDecode(rawB64)
  const ctMatch = raw.match(/Content-Type:\s*multipart\/\w+;\s*boundary="?([^"\r\n]+)"?/i)
  if (!ctMatch) {
    if (raw.includes('<html') || raw.includes('<HTML')) {
      const bodyStart = raw.indexOf('\r\n\r\n')
      return { html: bodyStart > 0 ? raw.slice(bodyStart + 4) : raw, text: '' }
    }
    return { html: '', text: raw }
  }
  return parseParts(raw, ctMatch[1])
}

// ── Cache ────────────────────────────────────────────────────────────────────

const LIST_TTL  = 5  * 60 * 1000  // 5 min — list results go stale quickly
const EMAIL_TTL = 60 * 60 * 1000  // 1 hr  — email bodies rarely change

const listCache  = new Map()  // key: `${account}:${query}` → { emails, ts }
const emailCache = new Map()  // key: `${account}:${id}`    → { email,  ts }

function cacheKey(...parts) { return parts.join(':') }

function getList(account, query) {
  const hit = listCache.get(cacheKey(account, query))
  if (!hit) return null
  return { ...hit, fresh: (Date.now() - hit.ts) < LIST_TTL }
}

function setList(account, query, emails) {
  listCache.set(cacheKey(account, query), { emails, ts: Date.now() })
}

function getEmail(accountKey, id) {
  const hit = emailCache.get(cacheKey(accountKey, id))
  if (!hit) return null
  return { ...hit, fresh: (Date.now() - hit.ts) < EMAIL_TTL }
}

function setEmail(accountKey, id, email) {
  emailCache.set(cacheKey(accountKey, id), { email, ts: Date.now() })
}

function invalidateLists(account) {
  for (const key of listCache.keys()) {
    if (key.startsWith(account + ':')) listCache.delete(key)
  }
}

// ── Email operations ─────────────────────────────────────────────────────────

let defaultAccount = ''
let extSettings = null // set in activate, used by resolveAccount
let busCtx = null      // set in activate, used by background revalidation

async function resolveAccount(account) {
  if (account) return account
  // Always read current settings value so account changes take effect without restart
  const saved = extSettings?.get('account')
  if (saved) return saved
  if (defaultAccount) return defaultAccount
  // Auto-detect first account
  const accounts = await listAccounts()
  if (accounts.length > 0) {
    defaultAccount = accounts[0]
    return defaultAccount
  }
  throw new Error('No Gmail account configured. Run `gog auth login` first.')
}

async function listAccounts() {
  const out = await gog(['auth', 'list', '--no-input', '--plain'])
  return out.split('\n').map(l => l.split('\t')[0].trim()).filter(l => l.includes('@'))
}

async function searchEmails(account, query, max = 50) {
  const acct = await resolveAccount(account)
  const out = await gog(['gmail', 'search', query, '-a', acct, '--json', '--no-input', '--max', String(max)])
  const data = JSON.parse(out)
  return (data.threads || []).map(t => ({
    id: t.id,
    subject: t.subject || '(No Subject)',
    from: t.from,
    date: t.date,
    labels: t.labels || [],
    isUnread: (t.labels || []).includes('UNREAD'),
    hasAttachments: (t.labels || []).includes('Attachments'),
    snippet: '',
  }))
}

async function fetchEmailFromApi(account, messageId) {
  const acct = await resolveAccount(account)
  const fullOut = await gog(['gmail', 'get', messageId, '-a', acct, '--json', '--no-input'])
  const data = JSON.parse(fullOut)
  const msg = data.message
  const headers = data.headers

  let bodyHtml = ''
  let bodyText = data.body ? decodeQP(data.body) : ''
  bodyText = bodyText
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))

  try {
    const rawOut = await gog(['gmail', 'get', messageId, '-a', acct, '--json', '--no-input', '--format=raw'])
    const rawData = JSON.parse(rawOut)
    const rawB64 = rawData.message?.raw || ''
    if (rawB64) {
      const { html, text } = extractHtmlFromRawMime(rawB64)
      if (html) bodyHtml = html
      if (text && !bodyText) bodyText = text
    }
  } catch (e) {
    // Fall back to plain text
  }

  return {
    id: msg.id,
    threadId: msg.threadId,
    subject: headers.subject || '(No Subject)',
    from: headers.from,
    to: headers.to,
    date: headers.date,
    snippet: msg.snippet || '',
    labels: msg.labelIds || [],
    isUnread: (msg.labelIds || []).includes('UNREAD'),
    hasAttachments: false,
    body: bodyText,
    bodyHtml: bodyHtml || undefined,
  }
}

async function archiveEmail(account, messageId) {
  const acct = await resolveAccount(account)
  await gog(['gmail', 'archive', messageId, '-a', acct, '--json', '--no-input'])
  emailCache.delete(cacheKey(acct, messageId))
  invalidateLists(acct)
}

async function trashEmail(account, messageId) {
  const acct = await resolveAccount(account)
  await gog(['gmail', 'trash', messageId, '-a', acct, '--json', '--no-input'])
  emailCache.delete(cacheKey(acct, messageId))
  invalidateLists(acct)
}

// ── Extension activate ───────────────────────────────────────────────────────

module.exports = {
  async activate(ctx) {
    ctx.log('HQ Email extension activated')

    extSettings = ctx.settings
    busCtx = ctx.bus
    const settingsAccount = ctx.settings.get('account')
    if (settingsAccount) defaultAccount = settingsAccount

    // ── Shared: cached list fetch with stale-while-revalidate ──────────────

    async function cachedList(account, query, max) {
      const acct = await resolveAccount(account)
      const hit = getList(acct, query)

      if (hit) {
        // Return cached immediately; if stale, revalidate in background
        if (!hit.fresh) {
          searchEmails(account, query, max).then(emails => {
            setList(acct, query, emails)
            ctx.bus.publish('hq-email', 'data', { action: 'listUpdate', query, emails })
          }).catch(() => {})
        }
        return JSON.stringify({ emails: hit.emails, cached: true })
      }

      // No cache — fetch, store, return
      const emails = await searchEmails(account, query, max)
      setList(acct, query, emails)
      return JSON.stringify({ emails })
    }

    // ── IPC handlers (for iframe tiles via ext.invoke) ─────────────────────

    ctx.ipc.handle('listAccounts', async () => {
      return JSON.stringify({ accounts: await listAccounts() })
    })

    ctx.ipc.handle('fetchInbox',   async (args) => {
      const { max = 50, account } = typeof args === 'string' ? JSON.parse(args) : (args || {})
      return cachedList(account, 'in:inbox', max)
    })
    ctx.ipc.handle('fetchUnread',  async (args) => {
      const { max = 50, account } = typeof args === 'string' ? JSON.parse(args) : (args || {})
      return cachedList(account, 'is:unread', max)
    })
    ctx.ipc.handle('fetchSent',    async (args) => {
      const { max = 50, account } = typeof args === 'string' ? JSON.parse(args) : (args || {})
      return cachedList(account, 'in:sent', max)
    })
    ctx.ipc.handle('fetchStarred', async (args) => {
      const { max = 50, account } = typeof args === 'string' ? JSON.parse(args) : (args || {})
      return cachedList(account, 'is:starred', max)
    })
    ctx.ipc.handle('fetchDrafts',  async (args) => {
      const { max = 50, account } = typeof args === 'string' ? JSON.parse(args) : (args || {})
      return cachedList(account, 'in:drafts', max)
    })

    ctx.ipc.handle('fetchEmail', async (args) => {
      const { id, account } = typeof args === 'string' ? JSON.parse(args) : (args || {})
      if (!id) throw new Error('Missing email id')
      const acct = await resolveAccount(account)
      const hit = getEmail(acct, id)
      if (hit) {
        // Email bodies don't change — serve from cache, revalidate only if very stale
        if (!hit.fresh) {
          fetchEmailFromApi(account, id).then(email => {
            setEmail(acct, id, email)
            ctx.bus.publish('hq-email', 'data', { action: 'emailUpdate', id, email })
          }).catch(() => {})
        }
        return JSON.stringify({ email: hit.email, cached: true })
      }
      const email = await fetchEmailFromApi(account, id)
      setEmail(acct, id, email)
      return JSON.stringify({ email })
    })

    ctx.ipc.handle('searchEmails', async (args) => {
      const { query, max = 25, account } = typeof args === 'string' ? JSON.parse(args) : (args || {})
      if (!query) throw new Error('Missing search query')
      const emails = await searchEmails(account, query, max)
      return JSON.stringify({ emails })
    })

    ctx.ipc.handle('archiveEmail', async (args) => {
      const { id, account } = typeof args === 'string' ? JSON.parse(args) : (args || {})
      if (!id) throw new Error('Missing email id')
      await archiveEmail(account, id)
      return JSON.stringify({ ok: true })
    })

    ctx.ipc.handle('trashEmail', async (args) => {
      const { id, account } = typeof args === 'string' ? JSON.parse(args) : (args || {})
      if (!id) throw new Error('Missing email id')
      await trashEmail(account, id)
      return JSON.stringify({ ok: true })
    })

    // ── MCP tools (for AI agents) ──────────────────────────────────────────

    ctx.mcp.registerTool({
      name: 'list_accounts',
      description: 'List configured Gmail accounts',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => JSON.stringify({ accounts: await listAccounts() }),
    })

    ctx.mcp.registerTool({
      name: 'inbox',
      description: 'Fetch inbox emails. Returns subject, from, date, labels.',
      inputSchema: {
        type: 'object',
        properties: {
          max: { type: 'number', description: 'Max emails to fetch (default 50)' },
          account: { type: 'string', description: 'Gmail account (auto-detected if omitted)' },
        },
      },
      handler: async (args) => {
        const emails = await searchEmails(args.account, 'in:inbox', args.max || 50)
        return JSON.stringify({ count: emails.length, emails })
      },
    })

    ctx.mcp.registerTool({
      name: 'read_email',
      description: 'Read a single email by ID. Returns full body.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Email/thread ID' },
          account: { type: 'string', description: 'Gmail account' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const email = await fetchEmailFromApi(args.account, args.id)
        return JSON.stringify(email)
      },
    })

    ctx.mcp.registerTool({
      name: 'search',
      description: 'Search emails with Gmail query syntax (e.g. "from:boss subject:urgent")',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Gmail search query' },
          max: { type: 'number', description: 'Max results (default 25)' },
          account: { type: 'string', description: 'Gmail account' },
        },
        required: ['query'],
      },
      handler: async (args) => {
        const emails = await searchEmails(args.account, args.query, args.max || 25)
        return JSON.stringify({ count: emails.length, emails })
      },
    })

    ctx.mcp.registerTool({
      name: 'archive',
      description: 'Archive an email by ID',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Email ID to archive' },
          account: { type: 'string', description: 'Gmail account' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        await archiveEmail(args.account, args.id)
        return JSON.stringify({ ok: true, id: args.id })
      },
    })

    ctx.mcp.registerTool({
      name: 'trash',
      description: 'Move an email to trash by ID',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Email ID to trash' },
          account: { type: 'string', description: 'Gmail account' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        await trashEmail(args.account, args.id)
        return JSON.stringify({ ok: true, id: args.id })
      },
    })

    // ── Bus listener for tile commands ─────────────────────────────────────

    ctx.bus.subscribe('hq-email-cmd', 'hq-email-ext', async (event) => {
      const { action, payload } = event?.payload || {}
      try {
        let result
        if (action === 'fetchInbox') result = await searchEmails(payload?.account, 'in:inbox', payload?.max)
        else if (action === 'fetchEmail') result = await fetchEmailFromApi(payload?.account, payload?.id)
        else if (action === 'searchEmails') result = await searchEmails(payload?.account, payload?.query, payload?.max)
        else if (action === 'archiveEmail') { await archiveEmail(payload?.account, payload?.id); result = { ok: true } }
        else if (action === 'trashEmail') { await trashEmail(payload?.account, payload?.id); result = { ok: true } }
        if (result) {
          ctx.bus.publish('hq-email', 'data', { action, result })
        }
      } catch (err) {
        ctx.bus.publish('hq-email', 'error', { action, error: err.message })
      }
    })

    return () => {
      ctx.log('HQ Email extension deactivated')
    }
  },
}
