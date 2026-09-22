#!/usr/bin/env node
/**
 * Build and launch CodeSurf once with renderer performance probes enabled.
 * Prints only [perf:render] lines plus build/exit status so measurements are readable.
 */
const { spawn } = require('child_process')
const electron = require('electron')

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const timeoutMs = Number(process.env.CODESURF_PERF_TIMEOUT_MS || 45000)

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.stdio || 'inherit', env: options.env || process.env, shell: false })
    let output = ''
    if (child.stdout) child.stdout.on('data', (chunk) => { output += chunk.toString(); process.stdout.write(chunk) })
    if (child.stderr) child.stderr.on('data', (chunk) => { output += chunk.toString(); process.stderr.write(chunk) })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
    })
  })
}

async function main() {
  if (process.env.CODESURF_PERF_SKIP_BUILD !== '1') {
    console.log('[perf:render] building production bundles...')
    await run(npmCmd, ['run', 'build'])
  }

  console.log('[perf:render] launching app once...')
  const env = {
    ...process.env,
    CODESURF_PERF_RENDER: '1',
    CODESURF_PERF_EXIT_AFTER_RENDER: '1',
  }

  const child = spawn(electron, ['.'], { stdio: ['ignore', 'pipe', 'pipe'], env, shell: false })
  let output = ''
  const timer = setTimeout(() => {
    child.kill('SIGTERM')
    console.error(`[perf:render] timed out after ${timeoutMs}ms`)
  }, timeoutMs)

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    output += text
    for (const line of text.split(/\r?\n/)) {
      if (line.includes('[perf:render]')) console.log(line)
    }
  })
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString()
    output += text
    for (const line of text.split(/\r?\n/)) {
      if (line.includes('[perf:render]')) console.error(line)
    }
  })

  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', resolve)
  })
  clearTimeout(timer)

  const lines = output.split(/\r?\n/).filter((line) => line.includes('[perf:render]'))
  if (!lines.some((line) => line.includes('rendererMetrics='))) {
    throw new Error('No renderer metrics captured')
  }
  if (code !== 0) process.exitCode = code || 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
