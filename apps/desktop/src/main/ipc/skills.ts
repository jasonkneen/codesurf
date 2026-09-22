/**
 * Skills IPC — handles .skill files (zip archives containing a top-level
 * `<skill-name>/SKILL.md` plus optional assets/references/scripts folders).
 *
 * Two entry points are exposed:
 *   - `skills:inspect`  → peek at a .skill without extracting so the renderer
 *                         can preview the skill name / description / file list
 *                         in a confirmation modal.
 *   - `skills:install`  → actually extract the .skill into the configured
 *                         Claude skills directory.
 *
 * Also tracks `.skill` files opened via macOS file-association / drag-to-dock
 * (forwarded from `open-file` + `second-instance` events in main/index.ts) and
 * forwards their paths to the focused renderer via `skill:file-opened` so the
 * frontend can surface the install modal automatically.
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync, promises as fs } from 'fs'
import { homedir } from 'os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { assertSafePathSegment, resolveInside } from '../security/pathSegments'

// Default install location for Claude-format skills on macOS. Users can
// override this via the renderer by passing an explicit `targetDir` to
// `skills:install`. We keep the installed layout identical to what Claude
// itself writes so these skills are picked up by both apps.
export const DEFAULT_SKILLS_DIR = path.join(
  homedir(),
  'Library',
  'Application Support',
  'Claude',
  'skills',
)

// Queue of .skill paths opened before the renderer is ready. Drained when the
// first BrowserWindow reports `did-finish-load`.
const pendingSkillFiles: string[] = []
let rendererReady = false

export function queuePendingSkillFile(filePath: string): void {
  if (!filePath || !filePath.toLowerCase().endsWith('.skill')) return
  if (rendererReady) {
    broadcastSkillFile(filePath)
  } else {
    pendingSkillFiles.push(filePath)
  }
}

function broadcastSkillFile(filePath: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) {
    pendingSkillFiles.push(filePath)
    return
  }
  win.webContents.send('skill:file-opened', { path: filePath })
}

export function markRendererReadyAndFlushSkillQueue(): void {
  rendererReady = true
  while (pendingSkillFiles.length > 0) {
    const next = pendingSkillFiles.shift()
    if (next) broadcastSkillFile(next)
  }
}

// --- Zip helpers -----------------------------------------------------------

/**
 * Resolve the `unzip` binary.
 *
 * Hardcoding /usr/bin/unzip broke every non-macOS target this app ships (see
 * package.json win/linux): the path does not exist on Windows, and Linux
 * distros may not have unzip or may place it elsewhere. Probe the usual
 * locations, then fall back to PATH resolution, and fail with an actionable
 * message rather than a bare ENOENT for a path the user never chose.
 */
let cachedUnzipPath: string | null | undefined
function resolveUnzipBinary(): string {
  if (cachedUnzipPath !== undefined) {
    if (cachedUnzipPath === null) {
      throw new Error('`unzip` was not found on this system; install it to add skills from a .zip')
    }
    return cachedUnzipPath
  }
  for (const candidate of ['/usr/bin/unzip', '/bin/unzip', '/usr/local/bin/unzip', '/opt/homebrew/bin/unzip']) {
    if (existsSync(candidate)) {
      cachedUnzipPath = candidate
      return candidate
    }
  }
  // Let the OS resolve it from PATH (covers Linux layouts and Windows shims).
  cachedUnzipPath = process.platform === 'win32' ? 'unzip.exe' : 'unzip'
  return cachedUnzipPath
}

function runCmd(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${cmd} ${args.join(' ')} failed (code ${code}): ${stderr || stdout}`))
    })
  })
}

// macOS / Linux: `unzip -Z1 <file>` lists archive entries, one per line.
async function listZipEntries(zipPath: string): Promise<string[]> {
  const { stdout } = await runCmd(resolveUnzipBinary(), ['-Z1', zipPath])
  return stdout.split('\n').map(l => l.trim()).filter(Boolean)
}

// `unzip -Z <file>` (zipinfo default long listing) produces lines like:
//   -rw-r--r--  3.0 unx     123 bx defN  …  path/to/file
//   drwxr-xr-x  3.0 unx       0 bx stor  …  dir/
//   lrwxrwxrwx  3.0 unx      12 bx stor  …  dir/link -> target
//
// The first character is '-' for file, 'd' for directory, 'l' for symlink.
// We use this to reject any symlink entries before we hand the archive to unzip.
async function listZipVerbose(zipPath: string): Promise<Array<{ name: string; isSymlink: boolean }>> {
  // -Z without -1 gives the default zipinfo listing with permissions + filename.
  // The last field (after all fixed-width fields) is the filename; we split on
  // whitespace and take the last token. This is reliable for all well-formed
  // entries that don't contain spaces — and for traversal-attack entries the
  // name itself is the threat (we validate it separately), so precision here
  // is on the permissions column, not the name.
  const { stdout } = await runCmd(resolveUnzipBinary(), ['-Z', zipPath])
  const results: Array<{ name: string; isSymlink: boolean }> = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('Archive:') || trimmed.startsWith('Zip file size:') || trimmed.startsWith('End-of-central-directory')) continue
    // Lines starting with a file-type character then permission bits: [-dls]rwx…
    if (!/^[-dls]/.test(trimmed)) continue
    const isSymlink = trimmed.startsWith('l')
    // Name is the last whitespace-separated token on the line.
    const parts = trimmed.split(/\s+/)
    const name = parts[parts.length - 1]
    if (name) results.push({ name, isSymlink })
  }
  return results
}

/**
 * Validate all entries in the archive before extraction.
 * Rejects:
 *   - entries whose paths are absolute
 *   - entries containing `..` path segments
 *   - entries that are symlinks (first permission char `l`)
 * Throws with a descriptive message on the first offending entry.
 */
async function assertSafeZipEntries(zipPath: string): Promise<void> {
  const verbose = await listZipVerbose(zipPath)
  for (const { name, isSymlink } of verbose) {
    if (isSymlink) {
      throw new Error(`Archive entry is a symlink: ${name}`)
    }
    if (path.isAbsolute(name)) {
      throw new Error(`Archive entry has absolute path: ${name}`)
    }
    // Reject any segment that is `..`
    const segments = name.split('/')
    for (const seg of segments) {
      if (seg === '..') {
        throw new Error(`Archive entry contains path traversal: ${name}`)
      }
    }
  }
}

// Print a single archive member to stdout without touching disk.
async function readZipEntry(zipPath: string, entryName: string): Promise<string> {
  const { stdout } = await runCmd(resolveUnzipBinary(), ['-p', zipPath, entryName])
  return stdout
}

// Strip an optional leading `<folder>/` from every entry so we can detect the
// canonical skill-folder name (matches the Claude convention of one top-level
// folder inside the .skill archive).
function inferTopFolder(entries: string[]): string | null {
  const tops = new Set<string>()
  for (const entry of entries) {
    const first = entry.split('/')[0]
    if (!first) continue
    tops.add(first)
  }
  if (tops.size !== 1) return null
  return Array.from(tops)[0] ?? null
}

interface SkillManifest {
  name: string
  description: string
  topFolder: string
  entryCount: number
  hasSkillMd: boolean
  preview: string
}

async function readSkillManifest(zipPath: string): Promise<SkillManifest> {
  const entries = await listZipEntries(zipPath)
  const topFolder = inferTopFolder(entries) ?? path.basename(zipPath, path.extname(zipPath))
  const skillEntry = entries.find(e => /(^|\/)skill\.md$/i.test(e))
  let name = topFolder
  let description = ''
  let preview = ''
  let hasSkillMd = false
  if (skillEntry) {
    hasSkillMd = true
    const content = await readZipEntry(zipPath, skillEntry)
    preview = content.slice(0, 4000)
    const nameMatch = content.match(/^---[\s\S]*?name:\s*(.+?)$/m)
    const descMatch = content.match(/^---[\s\S]*?description:\s*(.+?)$/m)
    if (nameMatch?.[1]) name = nameMatch[1].trim()
    if (descMatch?.[1]) description = descMatch[1].trim()
  }
  return { name, description, topFolder, entryCount: entries.length, hasSkillMd, preview }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true } catch { return false }
}

async function extractSkill(
  zipPath: string,
  targetDir: string,
  opts: { overwrite: boolean },
): Promise<{ installedPath: string; entries: string[] }> {
  // Validate all archive entries before touching disk: reject traversal, absolute
  // paths, and symlinks.
  await assertSafeZipEntries(zipPath)

  await ensureDir(targetDir)
  const manifest = await readSkillManifest(zipPath)

  // Validate the top-level folder name derived from archive contents.
  const safeTopFolder = assertSafePathSegment(manifest.topFolder, 'skill folder name')

  // Resolve the installation path and assert it stays inside targetDir.
  const installedPath = resolveInside(targetDir, safeTopFolder)

  if (await pathExists(installedPath)) {
    if (!opts.overwrite) {
      throw new Error(`Skill already installed at ${installedPath}. Pass overwrite=true to replace.`)
    }
    // Safety: re-assert the resolved path is inside targetDir before recursive delete.
    resolveInside(targetDir, safeTopFolder)
    await fs.rm(installedPath, { recursive: true, force: true })
  }
  // `-o` = overwrite without prompt; `-d` = target directory. The archive
  // already contains a `<folder>/` prefix so extracting into `targetDir`
  // yields `targetDir/<folder>/…`.
  await runCmd(resolveUnzipBinary(), ['-o', '-qq', zipPath, '-d', targetDir])
  const entries = await listZipEntries(zipPath)
  return { installedPath, entries }
}

// --- IPC registration ------------------------------------------------------

export function registerSkillsIPC(): void {
  ipcMain.handle('skills:inspect', async (_evt, zipPath: string) => {
    if (typeof zipPath !== 'string' || !zipPath.toLowerCase().endsWith('.skill')) {
      throw new Error('skills:inspect requires a .skill file path')
    }
    const stat = await fs.stat(zipPath)
    if (!stat.isFile()) throw new Error(`${zipPath} is not a file`)
    const manifest = await readSkillManifest(zipPath)
    return { ...manifest, zipPath, sizeBytes: stat.size }
  })

  ipcMain.handle('skills:install', async (_evt, args: { zipPath: string; targetDir?: string; overwrite?: boolean }) => {
    const zipPath = args?.zipPath
    if (typeof zipPath !== 'string' || !zipPath.toLowerCase().endsWith('.skill')) {
      throw new Error('skills:install requires args.zipPath pointing at a .skill file')
    }

    // Constrain targetDir to DEFAULT_SKILLS_DIR or a subdirectory of it.
    // resolveInside throws if rawTargetDir resolves outside the skills root,
    // preventing arbitrary filesystem writes via renderer-supplied paths.
    const rawTargetDir = typeof args?.targetDir === 'string' && args.targetDir.trim()
      ? args.targetDir.trim()
      : DEFAULT_SKILLS_DIR
    const targetDir = resolveInside(DEFAULT_SKILLS_DIR, rawTargetDir)

    const { installedPath, entries } = await extractSkill(zipPath, targetDir, { overwrite: !!args?.overwrite })
    return { installedPath, entries, targetDir }
  })

  ipcMain.handle('skills:getDefaultTargetDir', () => DEFAULT_SKILLS_DIR)

  // Called once by the renderer when ChatTile/App mounts so any .skill queued
  // via `open-file` before the window existed gets flushed immediately.
  ipcMain.handle('skills:rendererReady', () => {
    markRendererReadyAndFlushSkillQueue()
    return true
  })

  // Ensure freshly-launched windows that auto-open a .skill don't miss the
  // broadcast if the renderer mounts fast enough to race the queue drain.
  app.on('browser-window-created', (_evt, win) => {
    win.webContents.once('did-finish-load', () => {
      markRendererReadyAndFlushSkillQueue()
    })
  })
}
