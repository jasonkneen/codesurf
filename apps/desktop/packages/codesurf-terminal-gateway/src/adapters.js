import path from 'node:path'
import pty from 'node-pty'

import { validateTerminalLaunch } from './launch-contract.js'

function defaultShell() {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe'
  return process.env.SHELL || '/bin/sh'
}

function defaultShellArgs() {
  return process.platform === 'win32' ? [] : ['-l']
}

function terminalEnvironment({ cwd, home }) {
  const env = {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: process.env.LANG || 'C.UTF-8',
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: home || cwd,
  }
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot || 'C:\\Windows'
    env.ComSpec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
  }
  return env
}

/** Real host-side PTY adapter. Use only for trusted local/native deployments. */
export class LocalPtyAdapter {
  constructor(config = {}) {
    this.config = config
  }

  async spawn({ cwd, cols, rows, launchBin, launchArgs }) {
    const launch = validateTerminalLaunch(launchBin, launchArgs)
    const program = launch.launchBin || this.config.shell || defaultShell()
    const args = launch.launchBin ? launch.launchArgs : this.config.shellArgs || defaultShellArgs()
    return pty.spawn(program, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: terminalEnvironment({ cwd, home: this.config.home }),
    })
  }
}

/**
 * Runs a shell inside a constrained Docker container. It is intentionally
 * unavailable unless the gateway is launched with the explicit docker config.
 */
export class DockerSandboxAdapter {
  constructor(config) {
    this.config = config
  }

  async spawn({ cwd, mountRoot, cols, rows, launchBin, launchArgs }) {
    const launch = validateTerminalLaunch(launchBin, launchArgs)
    const relative = path.relative(mountRoot, cwd)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('resolved terminal directory is outside its Docker mount root')
    }
    const mountCwd = relative === '' ? '/workspace' : `/workspace/${relative.split(path.sep).join('/')}`
    const user = this.config.user || defaultDockerUser()
    const args = [
      'run',
      '--rm',
      '--init',
      '-i',
      '--network', 'none',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', String(this.config.pidsLimit),
      '--memory', this.config.memory,
      '--cpus', String(this.config.cpus),
      '--mount', `type=bind,src=${mountRoot},dst=/workspace,rw,bind-propagation=rprivate`,
      '--workdir', mountCwd,
      '--env', 'TERM=xterm-256color',
      '--env', 'COLORTERM=truecolor',
      '--env', 'LANG=C.UTF-8',
      '--env', 'HOME=/tmp',
      '--user', user,
      this.config.image,
      launch.launchBin || this.config.shell,
      ...(launch.launchBin ? launch.launchArgs : this.config.shellArgs),
    ]

    return pty.spawn(this.config.binary, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: mountRoot,
      env: terminalEnvironment({ cwd: mountRoot, home: mountRoot }),
    })
  }
}

function defaultDockerUser() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
  if (uid === 0 || gid === 0) return '1000:1000'
  return `${uid}:${gid}`
}

export function createConfiguredAdapter(config) {
  if (config.adapter.type === 'docker') return new DockerSandboxAdapter(config.adapter.docker)
  return new LocalPtyAdapter(config.adapter.local)
}
