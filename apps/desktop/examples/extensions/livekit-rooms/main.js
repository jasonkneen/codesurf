/**
 * LiveKit Rooms — power-tier extension backend.
 *
 * Manages a local livekit-server --dev process, generates JWT tokens
 * using Node.js crypto (zero npm deps), and exposes room CRUD via
 * the LiveKit HTTP API (twirp).
 */

const { spawn, execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs/promises')
const http = require('http')
const https = require('https')
const url = require('url')
const os = require('os')
const path = require('path')

// ── JWT (compact, zero-dep) ──────────────────────────────────────────────────

function base64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function createToken(apiKey, apiSecret, grants, ttlSeconds = 3600) {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    iss: apiKey,
    sub: grants.identity || '',
    nbf: now,
    exp: now + ttlSeconds,
    iat: now,
    jti: grants.identity + '-' + now,
    video: {}
  }

  if (grants.roomJoin)   payload.video.roomJoin = true
  if (grants.roomCreate) payload.video.roomCreate = true
  if (grants.roomList)   payload.video.roomList = true
  if (grants.roomAdmin)  payload.video.roomAdmin = true
  if (grants.room)       payload.video.room = grants.room
  if (grants.canPublish !== undefined) payload.video.canPublish = grants.canPublish
  if (grants.canSubscribe !== undefined) payload.video.canSubscribe = grants.canSubscribe
  if (grants.canPublishData !== undefined) payload.video.canPublishData = grants.canPublishData

  const segments = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload))
  const sig = crypto.createHmac('sha256', apiSecret).update(segments).digest()
  return segments + '.' + base64url(sig)
}

// ── LiveKit Twirp API client ─────────────────────────────────────────────────

function httpApiUrl(wsUrl) {
  // ws://host:7880 -> http://host:7880
  // wss://host     -> https://host
  return wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
}

function twirpRequest(wsUrl, apiKey, apiSecret, service, method, body) {
  return new Promise((resolve, reject) => {
    const baseUrl = httpApiUrl(wsUrl)
    const fullUrl = baseUrl + '/twirp/livekit.' + service + '/' + method
    const parsed = new url.URL(fullUrl)
    const data = JSON.stringify(body || {})
    const token = createToken(apiKey, apiSecret, {
      identity: 'contex-admin',
      roomCreate: true,
      roomList: true,
      roomAdmin: true,
    })

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'Content-Length': Buffer.byteLength(data),
      },
    }

    const transport = parsed.protocol === 'https:' ? https : http
    const req = transport.request(options, (res) => {
      let chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        if (res.statusCode >= 400) {
          reject(new Error('LiveKit API ' + res.statusCode + ': ' + raw))
        } else {
          try { resolve(JSON.parse(raw)) }
          catch { resolve(raw) }
        }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// ── Extension ────────────────────────────────────────────────────────────────

module.exports = {
  async activate(ctx) {
    ctx.log('LiveKit Rooms extension activated')

    let serverProcess = null
    let serverRunning = false
    let serverLogs = []
    const MAX_LOGS = 200

    function getConfig() {
      return {
        serverUrl: ctx.settings.get('serverUrl') || 'ws://localhost:7880',
        apiKey: ctx.settings.get('apiKey') || 'devkey',
        apiSecret: ctx.settings.get('apiSecret') || 'secret',
      }
    }

    function pushLog(line) {
      serverLogs.push(line)
      if (serverLogs.length > MAX_LOGS) serverLogs.shift()
    }

    async function saveSnapshotData(dataUrl, roomName) {
      const match = String(dataUrl || '').match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i)
      if (!match) throw new Error('Invalid snapshot payload')

      const mimeType = match[1].toLowerCase()
      const base64 = match[2]
      const ext = mimeType.includes('png') ? 'png' : 'jpg'
      const buffer = Buffer.from(base64, 'base64')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const roomSlug = String(roomName || 'room').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '') || 'room'
      const dir = path.join(os.tmpdir(), 'codesurf-livekit')
      await fs.mkdir(dir, { recursive: true })
      const filePath = path.join(dir, `${roomSlug}-${stamp}.${ext}`)
      await fs.writeFile(filePath, buffer)
      return filePath
    }

    function getShellPath() {
      try {
        const shell = process.env.SHELL || '/bin/zsh'
        return execFileSync(shell, ['-ilc', 'echo -n "$PATH"'], {
          timeout: 5000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim()
      } catch (err) {
        return process.env.PATH || [
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
          '/usr/sbin',
          '/sbin',
        ].join(':')
      }
    }

    function resolveLivekitBinary() {
      const shell = process.env.SHELL || '/bin/zsh'
      try {
        const path = execFileSync(shell, ['-ilc', 'command -v livekit-server'], {
          timeout: 5000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim()
        return path || null
      } catch (err) {
        return null
      }
    }

    function publishStatus() {
      ctx.bus.publish('lk-server', 'status', {
        running: serverRunning,
        local: !!serverProcess,
        url: getConfig().serverUrl,
        logTail: serverLogs.slice(-30),
      })
    }

    // ── Local server management ────────────────────────────────────────────

    function startLocal() {
      if (serverProcess) return { ok: false, error: 'Already running' }

      const args = ['--dev']
      const config = getConfig()
      const shellPath = getShellPath()
      const binaryPath = resolveLivekitBinary()

      // Pass keys if non-default
      if (config.apiKey && config.apiKey !== 'devkey') {
        args.push('--keys', config.apiKey + ':' + config.apiSecret)
      }

      if (!binaryPath) {
        pushLog('[codesurf] livekit-server was not found on your shell PATH')
        pushLog('[codesurf] Install livekit-server or expose it in your login shell PATH')
        publishStatus()
        return { ok: false, error: 'livekit-server not found on PATH' }
      }

      try {
        serverProcess = spawn(binaryPath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PATH: shellPath },
        })
      } catch (err) {
        return { ok: false, error: 'Failed to spawn livekit-server: ' + err.message }
      }

      serverRunning = true
      serverLogs = []
      pushLog('[codesurf] Starting ' + binaryPath + ' --dev ...')

      serverProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean)
        lines.forEach(l => pushLog(l))
        publishStatus()
      })

      serverProcess.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean)
        lines.forEach(l => pushLog('[stderr] ' + l))
        publishStatus()
      })

      serverProcess.on('close', (code) => {
        pushLog('[codesurf] livekit-server exited with code ' + code)
        serverProcess = null
        serverRunning = false
        publishStatus()
      })

      serverProcess.on('error', (err) => {
        pushLog('[codesurf] Error: ' + err.message)
        serverProcess = null
        serverRunning = false
        publishStatus()
      })

      publishStatus()
      return { ok: true }
    }

    function stopLocal() {
      if (!serverProcess) return { ok: false, error: 'Not running' }
      serverProcess.kill('SIGTERM')
      pushLog('[codesurf] Sent SIGTERM to livekit-server')
      // Process close handler will update state
      return { ok: true }
    }

    // ── Room operations (via Twirp API) ────────────────────────────────────

    async function listRooms() {
      const c = getConfig()
      const res = await twirpRequest(c.serverUrl, c.apiKey, c.apiSecret, 'RoomService', 'ListRooms', {})
      return res.rooms || []
    }

    async function createRoom(name, opts) {
      const c = getConfig()
      const body = { name }
      if (opts?.emptyTimeout) body.empty_timeout = opts.emptyTimeout
      if (opts?.maxParticipants) body.max_participants = opts.maxParticipants
      return await twirpRequest(c.serverUrl, c.apiKey, c.apiSecret, 'RoomService', 'CreateRoom', body)
    }

    async function deleteRoom(name) {
      const c = getConfig()
      return await twirpRequest(c.serverUrl, c.apiKey, c.apiSecret, 'RoomService', 'DeleteRoom', { room: name })
    }

    async function listParticipants(roomName) {
      const c = getConfig()
      const res = await twirpRequest(c.serverUrl, c.apiKey, c.apiSecret, 'RoomService', 'ListParticipants', { room: roomName })
      return res.participants || []
    }

    async function generateToken(identity, roomName, opts) {
      const c = getConfig()
      return createToken(c.apiKey, c.apiSecret, {
        identity: identity,
        room: roomName,
        roomJoin: true,
        canPublish: opts?.canPublish !== false,
        canSubscribe: opts?.canSubscribe !== false,
        canPublishData: opts?.canPublishData !== false,
      }, opts?.ttl || 86400)
    }

    // ── IPC handlers (for iframe tiles via ext.invoke) ─────────────────────

    ctx.ipc.handle('getStatus', async () => {
      return JSON.stringify({
        running: serverRunning,
        local: !!serverProcess,
        url: getConfig().serverUrl,
        logTail: serverLogs.slice(-30),
      })
    })

    ctx.ipc.handle('startLocal', async () => {
      return JSON.stringify(startLocal())
    })

    ctx.ipc.handle('stopLocal', async () => {
      return JSON.stringify(stopLocal())
    })

    ctx.ipc.handle('getConfig', async () => {
      return JSON.stringify(getConfig())
    })

    ctx.ipc.handle('setConfig', async (args) => {
      const data = typeof args === 'string' ? JSON.parse(args) : (args || {})
      if (data.serverUrl !== undefined) ctx.settings.get('serverUrl') // ensure loaded
      // Settings are persisted via the settings API from the tile side
      return JSON.stringify({ ok: true })
    })

    ctx.ipc.handle('listRooms', async () => {
      const rooms = await listRooms()
      return JSON.stringify({ rooms })
    })

    ctx.ipc.handle('createRoom', async (args) => {
      const data = typeof args === 'string' ? JSON.parse(args) : (args || {})
      if (!data.name) throw new Error('Missing room name')
      const room = await createRoom(data.name, data)
      ctx.bus.publish('lk-rooms', 'roomCreated', { room })
      return JSON.stringify({ room })
    })

    ctx.ipc.handle('deleteRoom', async (args) => {
      const data = typeof args === 'string' ? JSON.parse(args) : (args || {})
      if (!data.name) throw new Error('Missing room name')
      await deleteRoom(data.name)
      ctx.bus.publish('lk-rooms', 'roomDeleted', { name: data.name })
      return JSON.stringify({ ok: true })
    })

    ctx.ipc.handle('listParticipants', async (args) => {
      const data = typeof args === 'string' ? JSON.parse(args) : (args || {})
      if (!data.room) throw new Error('Missing room name')
      const participants = await listParticipants(data.room)
      return JSON.stringify({ participants })
    })

    ctx.ipc.handle('generateToken', async (args) => {
      const data = typeof args === 'string' ? JSON.parse(args) : (args || {})
      if (!data.identity) throw new Error('Missing identity')
      if (!data.room) throw new Error('Missing room')
      const token = await generateToken(data.identity, data.room, data)
      const c = getConfig()
      return JSON.stringify({ token, serverUrl: c.serverUrl })
    })

    ctx.ipc.handle('getLogs', async () => {
      return JSON.stringify({ logs: serverLogs })
    })

    ctx.ipc.handle('sendChatToRoom', async (args) => {
      const data = typeof args === 'string' ? JSON.parse(args) : (args || {})
      if (!data.text) throw new Error('Missing chat text')
      ctx.bus.publish('lk-chat', 'command', {
        action: 'sendChat',
        payload: {
          room: data.room || null,
          text: data.text,
          sender: data.sender || null,
        },
      })
      return JSON.stringify({ ok: true })
    })

    ctx.ipc.handle('saveSnapshot', async (args) => {
      const data = typeof args === 'string' ? JSON.parse(args) : (args || {})
      if (!data.dataUrl) throw new Error('Missing snapshot data')
      const filePath = await saveSnapshotData(data.dataUrl, data.room || null)
      return JSON.stringify({ ok: true, path: filePath })
    })

    // ── MCP tools (for AI agents) ──────────────────────────────────────────

    ctx.mcp.registerTool({
      name: 'lk_list_rooms',
      description: 'List all active LiveKit rooms.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => JSON.stringify({ rooms: await listRooms() }),
    })

    ctx.mcp.registerTool({
      name: 'lk_create_room',
      description: 'Create a new LiveKit room.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      handler: async (args) => {
        const room = await createRoom(args.name)
        return JSON.stringify({ room })
      },
    })

    ctx.mcp.registerTool({
      name: 'lk_delete_room',
      description: 'Delete a LiveKit room.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      handler: async (args) => {
        await deleteRoom(args.name)
        return JSON.stringify({ ok: true })
      },
    })

    ctx.mcp.registerTool({
      name: 'lk_list_participants',
      description: 'List participants in a LiveKit room.',
      inputSchema: {
        type: 'object',
        properties: { room: { type: 'string' } },
        required: ['room'],
      },
      handler: async (args) => {
        const participants = await listParticipants(args.room)
        return JSON.stringify({ participants })
      },
    })

    ctx.mcp.registerTool({
      name: 'lk_generate_token',
      description: 'Generate a join token for a LiveKit room.',
      inputSchema: {
        type: 'object',
        properties: {
          identity: { type: 'string', description: 'Participant identity' },
          room: { type: 'string', description: 'Room name' },
        },
        required: ['identity', 'room'],
      },
      handler: async (args) => {
        const token = await generateToken(args.identity, args.room)
        const c = getConfig()
        return JSON.stringify({ token, serverUrl: c.serverUrl })
      },
    })

    ctx.mcp.registerTool({
      name: 'lk_send_chat_message',
      description: 'Queue a text message into a joined LiveKit room tile.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message body' },
          sender: { type: 'string', description: 'Optional sender label' },
          room: { type: 'string', description: 'Optional room name filter' },
        },
        required: ['text'],
      },
      handler: async (args) => {
        ctx.bus.publish('lk-chat', 'command', {
          action: 'sendChat',
          payload: {
            room: args.room || null,
            text: args.text,
            sender: args.sender || null,
          },
        })
        return JSON.stringify({ ok: true, queued: true })
      },
    })

    // ── Bus commands from tiles ─────────────────────────────────────────────

    ctx.bus.subscribe('lk-cmd', 'livekit-rooms-ext', async (event) => {
      const { action, payload } = event?.payload || {}
      try {
        let result
        if (action === 'startLocal') result = startLocal()
        else if (action === 'stopLocal') result = stopLocal()
        else if (action === 'listRooms') result = { rooms: await listRooms() }
        else if (action === 'createRoom') result = { room: await createRoom(payload?.name, payload) }
        else if (action === 'deleteRoom') { await deleteRoom(payload?.name); result = { ok: true } }
        else if (action === 'listParticipants') result = { participants: await listParticipants(payload?.room) }
        else if (action === 'generateToken') {
          const token = await generateToken(payload?.identity, payload?.room)
          const c = getConfig()
          result = { token, serverUrl: c.serverUrl }
        }
        if (result) ctx.bus.publish('lk-rooms', 'data', { action, result })
      } catch (err) {
        ctx.bus.publish('lk-rooms', 'error', { action, error: err.message })
      }
    })

    // ── Periodic status broadcast ───────────────────────────────────────────

    const statusInterval = setInterval(publishStatus, 5000)

    return () => {
      clearInterval(statusInterval)
      if (serverProcess) {
        serverProcess.kill('SIGTERM')
        serverProcess = null
      }
      ctx.log('LiveKit Rooms extension deactivated')
    }
  },
}
