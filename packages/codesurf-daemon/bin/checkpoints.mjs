import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

// Files larger than this are not snapshotted into checkpoint JSON (base64
// inflation + synchronous writes would bloat storage). They get an oversize
// marker instead; restore leaves the current file untouched.
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024 // 5 MB

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true })
}

function atomicWriteBuffer(filePath, buffer) {
  ensureDir(dirname(filePath))
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  writeFileSync(tempPath, buffer)
  renameSync(tempPath, filePath)
}

function readDirNames(dirPath) {
  try {
    return readdirSync(dirPath)
  } catch {
    return []
  }
}

function normalizePath(value) {
  return String(value ?? '').trim().replace(/\/+$/, '')
}

function normalizeTimestamp(value) {
  const stamp = String(value ?? '').trim()
  if (!stamp) return new Date(0).toISOString()
  const parsed = Date.parse(stamp)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString()
}

function makeUniqueStrings(values) {
  const entries = []
  const seen = new Set()
  for (const value of values) {
    const normalized = normalizePath(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    entries.push(normalized)
  }
  return entries
}

function checkpointDirPath(workspaceContexDir, workspaceId) {
  return join(workspaceContexDir(workspaceId), 'checkpoints')
}

function checkpointFilePath(workspaceContexDir, workspaceId, checkpointId) {
  return join(checkpointDirPath(workspaceContexDir, workspaceId), `${checkpointId}.json`)
}

function runtimeSessionTileId(sessionEntryId) {
  const normalized = String(sessionEntryId ?? '').trim()
  if (!normalized.startsWith('codesurf-runtime:')) return null
  return normalized.slice('codesurf-runtime:'.length) || null
}

function realpathMaybe(filePath) {
  try {
    return realpathSync(filePath)
  } catch {
    return null
  }
}

function resolveWorkspaceBoundaryPath(filePath) {
  const resolvedPath = resolve(String(filePath ?? ''))
  let existingAncestor = resolvedPath
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor)
    if (parent === existingAncestor) {
      return resolvedPath
    }
    existingAncestor = parent
  }

  const realAncestor = realpathMaybe(existingAncestor) ?? resolve(existingAncestor)
  const remainder = relative(existingAncestor, resolvedPath)
  return remainder ? resolve(realAncestor, remainder) : realAncestor
}

function matchWorkspaceRoot(filePath, roots) {
  const boundaryPath = resolveWorkspaceBoundaryPath(filePath)
  for (const root of roots) {
    const boundaryRoot = realpathMaybe(root) ?? resolve(root)
    if (boundaryPath === boundaryRoot || boundaryPath.startsWith(`${boundaryRoot}${sep}`)) {
      return root
    }
  }
  return null
}

function buildDisplayPath(filePath, root) {
  if (!root) return basename(filePath)
  const rel = relative(root, filePath)
  return rel || basename(filePath)
}

function readRuntimeSessionSnapshot(runtimeSessionStatePath, readJsonFile, workspaceId, sessionEntryId) {
  const tileId = runtimeSessionTileId(sessionEntryId)
  if (!tileId) return null
  const state = readJsonFile(runtimeSessionStatePath(workspaceId, tileId), null)
  return state && typeof state === 'object' ? state : null
}

function checkpointSummary(record) {
  const files = Array.isArray(record?.files) ? record.files : []
  return {
    id: typeof record?.id === 'string' ? record.id : '',
    sessionEntryId: typeof record?.sessionEntryId === 'string' ? record.sessionEntryId : '',
    createdAt: normalizeTimestamp(record?.createdAt),
    restoredAt: record?.restoredAt ? normalizeTimestamp(record.restoredAt) : null,
    label: typeof record?.label === 'string' ? record.label : 'Checkpoint',
    reason: typeof record?.reason === 'string' ? record.reason : null,
    fileCount: files.length,
    files: files.map(file => typeof file?.displayPath === 'string' && file.displayPath ? file.displayPath : String(file?.path ?? '')),
  }
}

function checkpointRestoredMessage(record, checkpointId, filesRestored, filesDeleted) {
  const toolId = `checkpoint-restored-${checkpointId}`
  const parts = []
  if (typeof record?.label === 'string' && record.label.trim()) parts.push(`Restored ${record.label.trim()}`)
  else parts.push('Restored checkpoint')
  if (filesRestored > 0) parts.push(`${filesRestored} file${filesRestored === 1 ? '' : 's'} restored`)
  if (filesDeleted > 0) parts.push(`${filesDeleted} file${filesDeleted === 1 ? '' : 's'} removed`)
  return {
    id: toolId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    isStreaming: false,
    toolBlocks: [{
      id: toolId,
      name: 'Checkpoint restored',
      input: '',
      summary: parts.join(' · '),
      status: 'done',
    }],
    contentBlocks: [{ type: 'tool', toolId }],
  }
}

export function createCheckpointStore({
  assertSafeId,
  atomicWriteJson,
  materializeWorkspace,
  readJsonFile,
  readWorkspaceState,
  runtimeSessionStatePath,
  workspaceContexDir,
}) {
  function workspaceRoots(workspaceId, extraRoots = []) {
    const state = readWorkspaceState()
    const workspace = state.workspaces.find(entry => entry.id === workspaceId)
    const persistedRoots = []
    if (workspace) {
      const materialized = materializeWorkspace(workspace, state.projects)
      persistedRoots.push(
        materialized.path,
        ...(Array.isArray(materialized.projectPaths) ? materialized.projectPaths : []),
      )
    }
    return makeUniqueStrings([
      ...persistedRoots,
      ...(Array.isArray(extraRoots) ? extraRoots : []),
    ])
  }

  function listCheckpointRecords(workspaceId) {
    assertSafeId(workspaceId)
    const dirPath = checkpointDirPath(workspaceContexDir, workspaceId)
    const records = []
    for (const name of readDirNames(dirPath)) {
      if (!name.endsWith('.json')) continue
      const parsed = readJsonFile(join(dirPath, name), null)
      if (!parsed || typeof parsed !== 'object') continue
      if (typeof parsed.id !== 'string' || !parsed.id.trim()) continue
      if (typeof parsed.sessionEntryId !== 'string' || !parsed.sessionEntryId.trim()) continue
      records.push(parsed)
    }
    records.sort((a, b) => Date.parse(String(b.createdAt ?? 0)) - Date.parse(String(a.createdAt ?? 0)))
    return records
  }

  function listCheckpoints(workspaceId, sessionEntryId = null) {
    const normalizedSessionEntryId = String(sessionEntryId ?? '').trim()
    return listCheckpointRecords(workspaceId)
      .filter(record => !normalizedSessionEntryId || record.sessionEntryId === normalizedSessionEntryId)
      .map(checkpointSummary)
  }

  function syncRuntimeSessionCheckpointMetadata(workspaceId, sessionEntryId, extras = {}, sessionState = null) {
    const tileId = runtimeSessionTileId(sessionEntryId)
    if (!tileId) return null
    const currentState = sessionState ?? readJsonFile(runtimeSessionStatePath(workspaceId, tileId), null)
    if (!currentState || typeof currentState !== 'object') return null
    const checkpoints = listCheckpoints(workspaceId, sessionEntryId)
    const latest = checkpoints[0] ?? null
    const nextState = {
      ...currentState,
      checkpoints: {
        ...((currentState.checkpoints && typeof currentState.checkpoints === 'object') ? currentState.checkpoints : {}),
        count: checkpoints.length,
        latestCheckpointId: latest?.id ?? null,
        latestCheckpointAt: latest?.createdAt ?? null,
        ...extras,
      },
    }
    atomicWriteJson(runtimeSessionStatePath(workspaceId, tileId), nextState)
    return nextState
  }

  function resolveCheckpointTargets(workspaceId, files, extraRoots = []) {
    const roots = workspaceRoots(workspaceId, extraRoots)
    const primaryRoot = roots[0] ?? null
    if (!primaryRoot) return { targets: [], invalidPaths: [] }

    const targets = new Map()
    const invalidPaths = []
    for (const candidate of Array.isArray(files) ? files : []) {
      const rawPath = String(candidate ?? '').trim()
      if (!rawPath) continue
      const resolvedPath = rawPath.startsWith('/') ? resolve(rawPath) : resolve(primaryRoot, rawPath)
      const root = matchWorkspaceRoot(resolvedPath, roots)
      if (!root) {
        invalidPaths.push(resolvedPath)
        continue
      }
      const boundaryPath = resolveWorkspaceBoundaryPath(resolvedPath)
      targets.set(boundaryPath, {
        path: resolvedPath,
        fsPath: boundaryPath,
        displayPath: buildDisplayPath(resolvedPath, root),
      })
    }
    return { targets: [...targets.values()], invalidPaths, roots }
  }

  function captureFileSnapshot(targetPath, logicalPath, displayPath) {
    if (!existsSync(targetPath)) {
      return {
        path: logicalPath,
        fsPath: targetPath,
        displayPath,
        existed: false,
        size: 0,
        encoding: null,
        content: null,
      }
    }

    try {
      // Cap snapshot size: base64-in-JSON inflates content ~33% and a
      // checkpoint is written before every edit, so a large generated/lockfile
      // would bloat storage and stall the synchronous write. Store an oversize
      // marker instead; restore skips it (and warns) rather than corrupting.
      const stat = statSync(targetPath)
      if (stat.size > MAX_SNAPSHOT_BYTES) {
        return {
          path: logicalPath,
          fsPath: targetPath,
          displayPath,
          existed: true,
          size: stat.size,
          encoding: null,
          content: null,
          oversize: true,
        }
      }
      const buffer = readFileSync(targetPath)
      return {
        path: logicalPath,
        fsPath: targetPath,
        displayPath,
        existed: true,
        size: buffer.length,
        encoding: 'base64',
        content: buffer.toString('base64'),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to snapshot ${displayPath}: ${message}`)
    }
  }

  function readCheckpointFileSnapshot(target) {
    const snapshotPath = target.fsPath ?? target.path
    return captureFileSnapshot(snapshotPath, target.path, target.displayPath)
  }

  function applyStoredFileSnapshot(file) {
    const targetPath = String(file?.fsPath ?? file?.path ?? '')
    if (!targetPath) throw new Error('Checkpoint file path is missing')
    if (file?.oversize) {
      // File was too large to snapshot — we have no prior contents to restore.
      // Leave the current file as-is rather than deleting it (content is null
      // here, which would otherwise hit the delete branch below).
      return { skipped: true, reason: 'oversize' }
    }
    if (file?.existed === false || file?.content == null) {
      if (existsSync(targetPath)) {
        rmSync(targetPath, { force: true })
      }
      return { deleted: true }
    }

    try {
      const buffer = Buffer.from(String(file.content), 'base64')
      atomicWriteBuffer(targetPath, buffer)
      return { deleted: false }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to restore ${file?.displayPath ?? targetPath}: ${message}`)
    }
  }

  function createCheckpoint(workspaceId, sessionEntryId, options = {}) {
    assertSafeId(workspaceId)
    const normalizedSessionEntryId = String(sessionEntryId ?? '').trim()
    if (!normalizedSessionEntryId) return { ok: false, error: 'sessionEntryId is required' }

    const extraRoots = makeUniqueStrings(Array.isArray(options.workspaceRoots)
      ? options.workspaceRoots
      : Array.isArray(options.additionalWorkspaceRoots)
        ? options.additionalWorkspaceRoots
        : [])
    const { targets, invalidPaths, roots } = resolveCheckpointTargets(workspaceId, options.files, extraRoots)
    if (invalidPaths.length > 0) {
      return { ok: false, error: `Checkpoint paths must stay inside workspace roots: ${invalidPaths[0]}` }
    }
    if (targets.length === 0) {
      return { ok: false, error: 'No checkpointable workspace files were provided' }
    }

    let checkpointPath = null
    try {
      const checkpointId = `checkpoint-${Date.now()}-${randomUUID().slice(0, 8)}`
      checkpointPath = checkpointFilePath(workspaceContexDir, workspaceId, checkpointId)
      const record = {
        version: 1,
        id: checkpointId,
        workspaceId,
        sessionEntryId: normalizedSessionEntryId,
        label: String(options.label ?? '').trim() || 'Checkpoint',
        reason: String(options.reason ?? '').trim() || null,
        createdAt: new Date().toISOString(),
        source: typeof options.source === 'string' ? options.source : 'daemon',
        workspaceRoots: roots,
        metadata: options.metadata && typeof options.metadata === 'object' ? options.metadata : {},
        files: targets.map(readCheckpointFileSnapshot),
        sessionStateSnapshot: readRuntimeSessionSnapshot(runtimeSessionStatePath, readJsonFile, workspaceId, normalizedSessionEntryId),
      }

      atomicWriteJson(checkpointPath, record)
      syncRuntimeSessionCheckpointMetadata(workspaceId, normalizedSessionEntryId)
      return { ok: true, checkpoint: checkpointSummary(record) }
    } catch (error) {
      try {
        if (checkpointPath) rmSync(checkpointPath, { force: true })
      } catch {
        // best-effort rollback
      }
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `Checkpoint creation failed: ${message}` }
    }
  }

  function restoreCheckpoint(workspaceId, checkpointId, options = {}) {
    assertSafeId(workspaceId)
    assertSafeId(checkpointId)

    const record = readJsonFile(checkpointFilePath(workspaceContexDir, workspaceId, checkpointId), null)
    if (!record || typeof record !== 'object') {
      return { ok: false, error: 'Checkpoint not found' }
    }

    const normalizedSessionEntryId = String(options.sessionEntryId ?? '').trim()
    if (normalizedSessionEntryId && record.sessionEntryId !== normalizedSessionEntryId) {
      return { ok: false, error: 'Checkpoint does not belong to that session' }
    }

    const extraRoots = makeUniqueStrings([
      ...(Array.isArray(record.workspaceRoots) ? record.workspaceRoots : []),
      ...(Array.isArray(options.workspaceRoots) ? options.workspaceRoots : []),
      ...(Array.isArray(options.additionalWorkspaceRoots) ? options.additionalWorkspaceRoots : []),
    ])
    const roots = workspaceRoots(workspaceId, extraRoots)
    const files = Array.isArray(record.files) ? record.files : []
    for (const file of files) {
      const targetPath = String(file?.fsPath ?? file?.path ?? '')
      if (!matchWorkspaceRoot(targetPath, roots)) {
        return { ok: false, error: `Checkpoint file is outside workspace roots: ${targetPath}` }
      }
    }

    let filesRestored = 0
    let filesDeleted = 0
    const rollbackSnapshots = []
    const tileId = runtimeSessionTileId(record.sessionEntryId)
    const runtimeStateFile = tileId ? runtimeSessionStatePath(workspaceId, tileId) : null
    const priorRuntimeState = runtimeStateFile ? readJsonFile(runtimeStateFile, null) : null
    const hadRuntimeState = runtimeStateFile ? existsSync(runtimeStateFile) : false

    try {
      for (const file of files) {
        const targetPath = String(file?.fsPath ?? file?.path ?? '')
        rollbackSnapshots.push(captureFileSnapshot(targetPath, String(file?.path ?? targetPath), String(file?.displayPath ?? targetPath)))
      }

      for (const file of files) {
        const outcome = applyStoredFileSnapshot(file)
        if (outcome.deleted) filesDeleted += 1
        else filesRestored += 1
      }

      let restoredSessionState = null
      if (record.sessionStateSnapshot && typeof record.sessionStateSnapshot === 'object' && tileId && runtimeStateFile) {
        restoredSessionState = {
          ...record.sessionStateSnapshot,
          updatedAt: Date.now(),
        }
        const restoredMessage = checkpointRestoredMessage(record, checkpointId, filesRestored, filesDeleted)
        restoredSessionState.messages = [
          ...(Array.isArray(restoredSessionState.messages) ? restoredSessionState.messages : []),
          restoredMessage,
        ]
        atomicWriteJson(runtimeStateFile, restoredSessionState)
      }

      const restoredAt = new Date().toISOString()
      const updatedRecord = { ...record, restoredAt }
      atomicWriteJson(checkpointFilePath(workspaceContexDir, workspaceId, checkpointId), updatedRecord)
      syncRuntimeSessionCheckpointMetadata(workspaceId, record.sessionEntryId, {
        lastRestoredCheckpointId: checkpointId,
        lastRestoredAt: restoredAt,
      }, restoredSessionState)

      return {
        ok: true,
        checkpoint: checkpointSummary(updatedRecord),
        filesRestored,
        filesDeleted,
      }
    } catch (error) {
      for (const snapshot of [...rollbackSnapshots].reverse()) {
        try {
          applyStoredFileSnapshot(snapshot)
        } catch {
          // best-effort rollback
        }
      }
      if (runtimeStateFile) {
        try {
          if (hadRuntimeState) {
            atomicWriteJson(runtimeStateFile, priorRuntimeState)
          } else {
            rmSync(runtimeStateFile, { force: true })
          }
        } catch {
          // best-effort rollback
        }
      }
      try {
        atomicWriteJson(checkpointFilePath(workspaceContexDir, workspaceId, checkpointId), record)
      } catch {
        // best-effort rollback
      }
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `Checkpoint restore failed: ${message}` }
    }
  }

  return {
    createCheckpoint,
    listCheckpoints,
    restoreCheckpoint,
  }
}
