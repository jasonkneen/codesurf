#!/usr/bin/env node
import { createGatewayConfig, createTerminalGateway } from '../src/index.js'

let gateway
let stopping = false

async function stop(exitCode) {
  if (stopping) return
  stopping = true
  try {
    await gateway?.close()
  } finally {
    process.exit(exitCode)
  }
}

try {
  const config = createGatewayConfig(process.env)
  gateway = createTerminalGateway({ config })
  const endpoint = await gateway.listen()
  process.stdout.write(`CodeSurf terminal gateway listening on ${endpoint}\n`)
  process.once('SIGINT', () => { void stop(0) })
  process.once('SIGTERM', () => { void stop(0) })
} catch (error) {
  process.stderr.write(`CodeSurf terminal gateway failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
