#!/usr/bin/env node
'use strict'

const readline = require('node:readline')
const path = require('node:path')
const fs = require('node:fs')
const pty = require('node-pty')

const sessions = new Map()

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function safeCwd(candidate) {
  if (typeof candidate === 'string' && candidate.trim()) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch {}
  }
  return process.cwd()
}

function defaultShell() {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe'
  return process.env.SHELL || (fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash')
}

function create(message) {
  const tileId = String(message.tileId || '')
  if (!tileId) return send({ type: 'error', tileId, error: 'missing tileId' })
  if (sessions.has(tileId)) return send({ type: 'created', tileId, cols: 80, rows: 24, buffer: sessions.get(tileId).buffer || '' })

  const cwd = safeCwd(message.cwd)
  const shell = typeof message.shell === 'string' && message.shell.trim() ? message.shell : defaultShell()
  const args = Array.isArray(message.args) ? message.args.map(String) : []
  try {
    const term = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, ...(message.env && typeof message.env === 'object' ? message.env : {}), TERM: 'xterm-256color' },
    })
    const session = { term, shell, cwd, buffer: '' }
    sessions.set(tileId, session)
    term.onData((data) => {
      session.buffer = (session.buffer + data).slice(-200000)
      send({ type: 'data', tileId, data })
      send({ type: 'active', tileId })
    })
    term.onExit(({ exitCode }) => {
      sessions.delete(tileId)
      send({ type: 'exit', tileId, exitCode })
    })
    send({ type: 'created', tileId, cols: 80, rows: 24, buffer: '' })
  } catch (error) {
    send({ type: 'error', tileId, error: error instanceof Error ? error.message : String(error) })
  }
}

function destroy(tileId) {
  const session = sessions.get(tileId)
  if (!session) return
  try { session.term.kill() } catch {}
  sessions.delete(tileId)
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch { return send({ type: 'error', error: 'invalid JSON command' }) }
  const tileId = String(message.tileId || '')
  const session = tileId ? sessions.get(tileId) : null

  switch (message.type) {
    case 'create':
      create(message)
      break
    case 'write':
      session?.term.write(String(message.data || ''))
      break
    case 'resize':
      if (session) session.term.resize(Math.max(1, Math.floor(Number(message.cols) || 80)), Math.max(1, Math.floor(Number(message.rows) || 24)))
      break
    case 'destroy':
    case 'detach':
      destroy(tileId)
      break
    case 'ping':
      send({ type: 'pong' })
      break
  }
})

process.on('SIGTERM', () => {
  for (const tileId of sessions.keys()) destroy(tileId)
  process.exit(0)
})
process.on('SIGINT', () => {
  for (const tileId of sessions.keys()) destroy(tileId)
  process.exit(0)
})
