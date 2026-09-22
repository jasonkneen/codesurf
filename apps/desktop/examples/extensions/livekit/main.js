/* ------------------------------------------------------------------ *
 *  LiveKit Extension – main.js (power tier)                           *
 *                                                                     *
 *  Manages LiveKit rooms via the LiveKit Server API (REST).           *
 *  Supports two modes:                                                *
 *    - "local"  : spins up livekit-server on localhost                *
 *    - "cloud"  : connects to a remote LiveKit Cloud / self-hosted    *
 *                                                                     *
 *  All HTTP calls go through Node built-ins (no SDK dependency).      *
 *  Token generation uses a minimal JWT helper (HMAC-SHA256).          *
 * ------------------------------------------------------------------ */

const { spawn } = require('child_process')
const crypto = require('crypto')
const http = require('http')
const https = require('https')

/* ---- tiny JWT (HS256) ---- */
function base64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function createJWT(payload, secret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const sig = base64url(
    crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest()
  )
  return `${header}.${body}.${sig}`
}

/* ---- LiveKit access token ---- */
function createAccessToken({ apiKey, apiSecret, room, identity, role }) {
  const now = Math.floor(Date.now() / 1000)
  const grant = {
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true
  }
  if (role === 'host') {
    grant.roomAdmin = true
    grant.roomCreate = true
    grant.roomList = true
  }
  if (role === 'agent') {
    grant.agent = true
    grant.hidden = true
  }
  const payload = {
    iss: apiKey,
    sub: identity,
    iat: now,
    nbf: now,
    exp: now + 86400,
    jti: `${identity}-${now}`,
    video: grant
  }
  return createJWT(payload, apiSecret)
}

/* ---- HTTP helpers ---- */
function request(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(u, opts, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`))
        } else {
          try { resolve(JSON.parse(data || '{}')) } catch { resolve(data) }
        }
      })
    })
    req.on('error', reject)
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

function apiCall(baseUrl, path, apiKey, apiSecret, body) {
  const token = createAccessToken({
    apiKey,
    apiSecret,
    room: '',
    identity: 'server',
    role: 'host'
  })
  const url = `${baseUrl}${path}`
  return request(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  }, body ? JSON.stringify(body) : undefined)
}

/* ---- Default local creds (match livekit-server --dev) ---- */
const LOCAL_API_KEY = 'devkey'
const LOCAL_API_SECRET = 'secret'

/* ================================================================== */
module.exports = {
  activate(ctx) {
    ctx.log('[livekit] extension activated')

    let localProc = null
    let rooms = new Map()         // room name -> { name, createdAt, maxParticipants, participants }
    let serverStatus = 'stopped'  // stopped | starting | running | error

    /* ---- helpers ---- */
    function getConfig() {
      const mode = ctx.settings.get('mode') || 'local'
      const localPort = ctx.settings.get('localPort') || 7880
      const serverUrl = ctx.settings.get('serverUrl') || ''
      const apiKey = ctx.settings.get('apiKey') || ''
      const apiSecret = ctx.settings.get('apiSecret') || ''

      if (mode === 'local') {
        return {
          mode,
          baseUrl: `http://localhost:${localPort}`,
          wsUrl: `ws://localhost:${localPort}`,
          apiKey: apiKey || LOCAL_API_KEY,
          apiSecret: apiSecret || LOCAL_API_SECRET,
          localPort
        }
      }
      return {
        mode,
        baseUrl: serverUrl.replace(/\/$/, ''),
        wsUrl: serverUrl.replace(/^http/, 'ws').replace(/\/$/, ''),
        apiKey,
        apiSecret,
        localPort
      }
    }

    function broadcast() {
      const data = {
        serverStatus,
        mode: getConfig().mode,
        rooms: Array.from(rooms.values())
      }
      ctx.bus.publish('livekit', 'state', data)
    }

    /* ---- local dev server ---- */
    function startLocalServer() {
      if (localProc) return
      const cfg = getConfig()
      serverStatus = 'starting'
      broadcast()

      ctx.log(`[livekit] starting local dev server on port ${cfg.localPort}`)

      localProc = spawn('livekit-server', [
        '--dev',
        '--bind', '0.0.0.0',
        '--port', String(cfg.localPort),
        '--keys', `${cfg.apiKey}: ${cfg.apiSecret}`
      ], { stdio: ['ignore', 'pipe', 'pipe'] })

      localProc.stdout.on('data', (d) => {
        const line = d.toString().trim()
        ctx.log(`[livekit-server] ${line}`)
        if (line.includes('started') || line.includes('listening') || line.includes('ready')) {
          serverStatus = 'running'
          broadcast()
        }
      })

      localProc.stderr.on('data', (d) => {
        const line = d.toString().trim()
        ctx.log(`[livekit-server:err] ${line}`)
        // livekit-server logs to stderr by default
        if (line.includes('started') || line.includes('listening') || line.includes('ready')) {
          serverStatus = 'running'
          broadcast()
        }
      })

      localProc.on('error', (err) => {
        ctx.log(`[livekit] server spawn error: ${err.message}`)
        serverStatus = 'error'
        localProc = null
        broadcast()
      })

      localProc.on('close', (code) => {
        ctx.log(`[livekit] server exited with code ${code}`)
        serverStatus = 'stopped'
        localProc = null
        broadcast()
      })

      // Assume running after 2s if no explicit signal
      setTimeout(() => {
        if (serverStatus === 'starting') {
          serverStatus = 'running'
          broadcast()
        }
      }, 2000)
    }

    function stopLocalServer() {
      if (localProc) {
        ctx.log('[livekit] stopping local server')
        localProc.kill('SIGTERM')
        localProc = null
      }
      serverStatus = 'stopped'
      broadcast()
    }

    /* ---- room management ---- */
    async function createRoom(name, maxParticipants = 0) {
      const cfg = getConfig()
      try {
        await apiCall(cfg.baseUrl, '/twirp/livekit.RoomService/CreateRoom', cfg.apiKey, cfg.apiSecret, {
          name,
          max_participants: maxParticipants
        })
      } catch (e) {
        ctx.log(`[livekit] API create failed (may be ok for local): ${e.message}`)
      }
      rooms.set(name, {
        name,
        createdAt: Date.now(),
        maxParticipants,
        participants: []
      })
      broadcast()
      return { name, maxParticipants }
    }

    async function deleteRoom(name) {
      const cfg = getConfig()
      try {
        await apiCall(cfg.baseUrl, '/twirp/livekit.RoomService/DeleteRoom', cfg.apiKey, cfg.apiSecret, {
          room: name
        })
      } catch (e) {
        ctx.log(`[livekit] API delete failed: ${e.message}`)
      }
      rooms.delete(name)
      broadcast()
    }

    async function listRooms() {
      const cfg = getConfig()
      try {
        const res = await apiCall(cfg.baseUrl, '/twirp/livekit.RoomService/ListRooms', cfg.apiKey, cfg.apiSecret, {})
        const apiRooms = res.rooms || []
        for (const r of apiRooms) {
          if (!rooms.has(r.name)) {
            rooms.set(r.name, {
              name: r.name,
              createdAt: r.creation_time ? r.creation_time * 1000 : Date.now(),
              maxParticipants: r.max_participants || 0,
              participants: []
            })
          }
        }
      } catch (e) {
        ctx.log(`[livekit] listRooms API failed: ${e.message}`)
      }
      broadcast()
      return Array.from(rooms.values())
    }

    async function listParticipants(roomName) {
      const cfg = getConfig()
      try {
        const res = await apiCall(cfg.baseUrl, '/twirp/livekit.RoomService/ListParticipants', cfg.apiKey, cfg.apiSecret, {
          room: roomName
        })
        const participants = (res.participants || []).map((p) => ({
          identity: p.identity,
          name: p.name || p.identity,
          state: p.state,
          joinedAt: p.joined_at,
          tracks: (p.tracks || []).map((t) => ({
            sid: t.sid,
            type: t.type,
            source: t.source,
            muted: t.muted,
            width: t.width,
            height: t.height
          }))
        }))
        const room = rooms.get(roomName)
        if (room) {
          room.participants = participants
          broadcast()
        }
        return participants
      } catch (e) {
        ctx.log(`[livekit] listParticipants failed: ${e.message}`)
        return []
      }
    }

    async function muteParticipant(roomName, identity, trackType, muted) {
      const cfg = getConfig()
      // find the track SID first
      const participants = await listParticipants(roomName)
      const p = participants.find((x) => x.identity === identity)
      if (!p) throw new Error(`participant ${identity} not found`)

      const sourceMap = { audio: 'MICROPHONE', video: 'CAMERA' }
      const track = p.tracks.find((t) => t.source === sourceMap[trackType])
      if (!track) throw new Error(`${trackType} track not found for ${identity}`)

      try {
        await apiCall(cfg.baseUrl, '/twirp/livekit.RoomService/MutePublishedTrack', cfg.apiKey, cfg.apiSecret, {
          room: roomName,
          identity,
          track_sid: track.sid,
          muted
        })
      } catch (e) {
        ctx.log(`[livekit] mute failed: ${e.message}`)
        throw e
      }
      await listParticipants(roomName)
    }

    async function removeParticipant(roomName, identity) {
      const cfg = getConfig()
      try {
        await apiCall(cfg.baseUrl, '/twirp/livekit.RoomService/RemoveParticipant', cfg.apiKey, cfg.apiSecret, {
          room: roomName,
          identity
        })
      } catch (e) {
        ctx.log(`[livekit] removeParticipant failed: ${e.message}`)
      }
      await listParticipants(roomName)
    }

    function generateToken(room, identity, role) {
      const cfg = getConfig()
      const token = createAccessToken({
        apiKey: cfg.apiKey,
        apiSecret: cfg.apiSecret,
        room,
        identity,
        role: role || 'participant'
      })
      return { token, wsUrl: cfg.wsUrl }
    }

    /* ---- IPC handlers (called from tiles via window.contex.ext.invoke) ---- */
    ctx.ipc.handle('getState', () => ({
      serverStatus,
      mode: getConfig().mode,
      rooms: Array.from(rooms.values()),
      config: {
        mode: getConfig().mode,
        localPort: getConfig().localPort,
        serverUrl: getConfig().baseUrl
      }
    }))

    ctx.ipc.handle('startServer', () => {
      const cfg = getConfig()
      if (cfg.mode === 'local') {
        startLocalServer()
      } else {
        serverStatus = 'running'
        broadcast()
      }
      return { serverStatus }
    })

    ctx.ipc.handle('stopServer', () => {
      const cfg = getConfig()
      if (cfg.mode === 'local') {
        stopLocalServer()
      } else {
        serverStatus = 'stopped'
        broadcast()
      }
      return { serverStatus }
    })

    ctx.ipc.handle('createRoom', (name, maxParticipants) => createRoom(name, maxParticipants))
    ctx.ipc.handle('deleteRoom', (name) => deleteRoom(name))
    ctx.ipc.handle('listRooms', () => listRooms())
    ctx.ipc.handle('listParticipants', (room) => listParticipants(room))
    ctx.ipc.handle('generateToken', (room, identity, role) => generateToken(room, identity, role))
    ctx.ipc.handle('muteParticipant', (room, identity, trackType, muted) => muteParticipant(room, identity, trackType, muted))
    ctx.ipc.handle('removeParticipant', (room, identity) => removeParticipant(room, identity))

    /* ---- MCP tools ---- */
    ctx.mcp.registerTool({
      name: 'livekit_list_rooms',
      description: 'List all active LiveKit rooms',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(await listRooms())
    })

    ctx.mcp.registerTool({
      name: 'livekit_create_room',
      description: 'Create a new LiveKit room',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          maxParticipants: { type: 'number' }
        },
        required: ['name']
      },
      handler: async (args) => JSON.stringify(await createRoom(args.name, args.maxParticipants))
    })

    ctx.mcp.registerTool({
      name: 'livekit_join_room',
      description: 'Generate a join token for a LiveKit room',
      inputSchema: {
        type: 'object',
        properties: {
          room: { type: 'string' },
          identity: { type: 'string' },
          role: { type: 'string', enum: ['host', 'participant', 'agent'] }
        },
        required: ['room', 'identity']
      },
      handler: async (args) => JSON.stringify(generateToken(args.room, args.identity, args.role))
    })

    ctx.mcp.registerTool({
      name: 'livekit_list_participants',
      description: 'List participants in a LiveKit room',
      inputSchema: {
        type: 'object',
        properties: { room: { type: 'string' } },
        required: ['room']
      },
      handler: async (args) => JSON.stringify(await listParticipants(args.room))
    })

    ctx.mcp.registerTool({
      name: 'livekit_mute_participant',
      description: 'Mute or unmute a participant audio or video track',
      inputSchema: {
        type: 'object',
        properties: {
          room: { type: 'string' },
          identity: { type: 'string' },
          trackType: { type: 'string', enum: ['audio', 'video'] },
          muted: { type: 'boolean' }
        },
        required: ['room', 'identity', 'trackType', 'muted']
      },
      handler: async (args) => {
        await muteParticipant(args.room, args.identity, args.trackType, args.muted)
        return JSON.stringify({ ok: true })
      }
    })

    /* ---- bus listener for tile commands ---- */
    const subId = ctx.bus.subscribe('livekit-cmd', 'livekit-ext', async (event) => {
      const { action, params } = event?.payload || {}
      try {
        switch (action) {
          case 'startServer': ctx.ipc.handle('startServer')(); break
          case 'stopServer': ctx.ipc.handle('stopServer')(); break
          case 'createRoom': await createRoom(params.name, params.maxParticipants); break
          case 'deleteRoom': await deleteRoom(params.name); break
          case 'listRooms': await listRooms(); break
          default: ctx.log(`[livekit] unknown bus action: ${action}`)
        }
      } catch (e) {
        ctx.log(`[livekit] bus cmd error: ${e.message}`)
      }
    })

    /* ---- cleanup ---- */
    return () => {
      ctx.log('[livekit] extension deactivating')
      ctx.bus.unsubscribe(subId)
      stopLocalServer()
    }
  }
}
