import { promises as fs } from 'node:fs'
import { resolve, relative, sep } from 'node:path'
import {
  CAPABILITY_PATTERN,
  commitAttachmentCapabilityReservation,
  getReservedAttachmentCapability,
  MAX_PER_ISSUE,
  reserveAttachmentCapabilities,
  rollbackAttachmentCapabilityReservation,
  sanitizeAttachmentDisplayName,
} from './attachment-capabilities.mjs'
import { openNoFollowFile, readHandlePrefix } from './secure-file-reader.mjs'

const ATTACHMENT_MARKER = 'Attached file paths:'
export const ATTACHMENT_CAPABILITY_MARKER = 'Attached file capabilities:'
const DEFAULT_MAX_REFERENCES = MAX_PER_ISSUE
const DEFAULT_MAX_BYTES_PER_FILE = 16 * 1024
const INTERNAL_CONTEXT_TAGS = [
  {
    open: '<codesurf_peer_context trust="untrusted" source="agent-room">',
    close: '</codesurf_peer_context>',
  },
  {
    open: '<codesurf_file_context trust="untrusted" source="workspace-files">',
    close: '</codesurf_file_context>',
  },
  {
    open: '<codesurf_recent_edit_context trust="untrusted" source="renderer-derived-file-state">',
    close: '</codesurf_recent_edit_context>',
  },
  {
    open: '<codesurf_block_notes_context trust="untrusted" source="renderer-derived-transcript">',
    close: '</codesurf_block_notes_context>',
  },
]

function normalizeWorkspaceId(value) {
  const id = String(value ?? '').trim()
  if (!id || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id) || id.includes('..')) {
    return null
  }
  return id
}

function normalizeSupportedImageMediaTypes(value) {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) throw new Error('supportedImageMediaTypes must be an array')
  return new Set(value
    .filter(item => typeof item === 'string')
    .map(item => item.trim().toLowerCase())
    .filter(item => /^image\/[a-z0-9.+-]+$/.test(item)))
}

async function reserveCapabilityReferences(references, workspaceId, cardId, supportedImages) {
  const capabilityReferences = references.filter(reference => reference.source === 'capability')
  if (capabilityReferences.length === 0) return null
  const reservation = await reserveAttachmentCapabilities({
    capabilities: capabilityReferences.map(reference => reference.capability),
    workspaceId,
    cardId,
    sampleBytes: DEFAULT_MAX_BYTES_PER_FILE,
  })
  try {
    for (const record of reservation.preflight) {
      const mediaType = guessMediaType(record.resolvedPath)
      const binary = record.binarySample || isKnownBinaryMediaType(mediaType)
      if (
        supportedImages
        && binary
        && (!mediaType.startsWith('image/') || !supportedImages.has(mediaType))
      ) {
        throw new Error(`Binary attachment type ${mediaType} is not supported by this provider or execution target`)
      }
    }
    return reservation
  } catch (error) {
    await rollbackAttachmentCapabilityReservation(reservation)
    throw error
  }
}

function normalizeAttachmentSelections(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('attachmentSelections must be an array')
  if (value.length > DEFAULT_MAX_REFERENCES) {
    throw new Error(`attachmentSelections may contain at most ${DEFAULT_MAX_REFERENCES} values`)
  }
  const receipts = value.map(item => String(
    typeof item === 'string' ? item : item?.selectionReceipt,
  ).trim())
  if (receipts.some(receipt => !receipt)) {
    throw new Error('Each attachment selection must include a selectionReceipt')
  }
  if (new Set(receipts).size !== receipts.length) {
    throw new Error('Attachment selection receipts must not contain duplicates')
  }
  return receipts
}

async function reserveSelectionReferences({
  attachmentSelections,
  attachmentSelectionRegistry,
  workspaceId,
  cardId,
  supportedImages,
}) {
  const selectionReceipts = normalizeAttachmentSelections(attachmentSelections)
  if (selectionReceipts.length === 0) return null
  if (!attachmentSelectionRegistry) {
    throw new Error('Attachment selection service is unavailable')
  }
  const reservation = await attachmentSelectionRegistry.reserve({
    workspaceId,
    cardId,
    selectionReceipts,
  })
  try {
    const references = []
    for (const [activationCapability, activation] of reservation.activations) {
      const mediaType = guessMediaType(activation.record.resolvedPath)
      const sample = await readHandlePrefix(
        activation.handle,
        activation.stat.size,
        DEFAULT_MAX_BYTES_PER_FILE,
        true,
      )
      const binary = sample.includes(0) || isKnownBinaryMediaType(mediaType)
      if (
        supportedImages
        && binary
        && (!mediaType.startsWith('image/') || !supportedImages.has(mediaType))
      ) {
        throw new Error(`Binary attachment type ${mediaType} is not supported by this provider or execution target`)
      }
      references.push({
        source: 'selection',
        activationCapability,
        start: Number.MAX_SAFE_INTEGER,
        end: Number.MAX_SAFE_INTEGER,
      })
    }
    return { reservation, references }
  } catch (error) {
    await attachmentSelectionRegistry.rollback(reservation)
    throw error
  }
}

export async function expandFileReferences({
  message,
  workspaceId,
  cardId,
  workspaceDir,
  executionTarget = 'local',
  maxReferences = DEFAULT_MAX_REFERENCES,
  maxBytesPerFile = DEFAULT_MAX_BYTES_PER_FILE,
  supportedImageMediaTypes,
  attachmentSelections,
  attachmentSelectionRegistry,
} = {}) {
  const normalizedWorkspaceDir = normalizeWorkspaceDir(workspaceDir)
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId)
  const normalizedCardId = normalizeWorkspaceId(cardId)
  const normalizedMessage = normalizeMessageText(message)

  const normalizedSelections = normalizeAttachmentSelections(attachmentSelections)
  if (!normalizedWorkspaceDir || (!normalizedMessage && normalizedSelections.length === 0)) {
    return {
      changed: false,
      message: normalizedMessage,
      bodyText: normalizedMessage,
      contextText: undefined,
      references: [],
      summaryText: undefined,
      inputText: undefined,
    }
  }

  // Host-appended room/file context is model-visible user data, not part of
  // the user's file-reference expression. Protect it before scanning so a
  // peer message such as `please inspect @secret.txt` cannot make the daemon
  // read and inline an unrelated workspace file on the next chat turn.
  const protectedContext = splitTrailingInternalContext(normalizedMessage)
  const parsed = parseReferenceMentions(protectedContext.bodyText)
  const bodyText = appendInternalContext(parsed.bodyText, protectedContext.suffixText)
  if (parsed.hadAttachmentCapabilities && normalizedSelections.length > 0) {
    throw new Error('Legacy attachment capabilities cannot be combined with structured attachment selections')
  }
  if (parsed.references.length === 0 && normalizedSelections.length === 0) {
    return {
      changed: false,
      message: normalizedMessage,
      bodyText: normalizedMessage,
      contextText: undefined,
      references: [],
      summaryText: undefined,
      inputText: undefined,
    }
  }

  if (parsed.references.length + normalizedSelections.length > maxReferences) {
    throw new Error(`A message may contain at most ${maxReferences} combined file references and attachments`)
  }

  const resolvedWorkspaceDir = await fs.realpath(normalizedWorkspaceDir)
  const supportedImages = normalizeSupportedImageMediaTypes(supportedImageMediaTypes)
  const reservation = await reserveCapabilityReferences(
    parsed.references,
    normalizedWorkspaceId,
    normalizedCardId,
    supportedImages,
  )
  const selection = await reserveSelectionReferences({
    attachmentSelections: normalizedSelections,
    attachmentSelectionRegistry,
    workspaceId: normalizedWorkspaceId,
    cardId: normalizedCardId,
    supportedImages,
  }).catch(async error => {
    if (reservation) await rollbackAttachmentCapabilityReservation(reservation)
    throw error
  })
  const allReferences = selection
    ? [...parsed.references, ...selection.references]
    : parsed.references
  let capabilityCommitted = false
  let selectionCommitted = false
  try {
    const collected = []
    const seenPaths = new Set()

    for (const reference of allReferences) {
      if (collected.length >= maxReferences) break
      const loaded = await loadWorkspaceReference(
        reference,
        resolvedWorkspaceDir,
        maxBytesPerFile,
        supportedImages,
        reservation,
        selection?.reservation,
        attachmentSelectionRegistry,
      )
      if (!loaded) continue
      if (seenPaths.has(loaded.resolvedPath)) continue
      seenPaths.add(loaded.resolvedPath)
      collected.push(loaded)
    }

    let result
    if (collected.length === 0) {
      result = (parsed.hadAttachmentCapabilities || normalizedSelections.length > 0)
        ? {
            changed: true,
            message: bodyText,
            bodyText,
            contextText: undefined,
            references: [],
            summaryText: undefined,
            inputText: undefined,
          }
        : {
            changed: false,
            message: normalizedMessage,
            bodyText: normalizedMessage,
            contextText: undefined,
            references: [],
            summaryText: undefined,
            inputText: undefined,
          }
    } else {
      const contextText = buildFileReferenceContext({
        executionTarget,
        references: collected,
      })
      const messageText = [bodyText.trim(), contextText].filter(Boolean).join('\n\n').trim()
      result = {
        changed: messageText !== normalizedMessage,
        message: messageText,
        bodyText,
        contextText,
        references: collected.map(reference => ({
          source: reference.source,
          capability: reference.capability,
          displayPath: reference.displayPath,
          byteCount: reference.byteCount,
          truncated: reference.truncated,
          binary: Boolean(reference.binary),
          mediaType: reference.mediaType,
          resolvedPath: reference.resolvedPath,
          device: reference.device,
          inode: reference.inode,
          mtimeMs: reference.mtimeMs,
          ctimeMs: reference.ctimeMs,
          ownedTemporary: reference.ownedTemporary === true,
        })),
        ownedTemporaryAttachments: collected
          .filter(reference => reference.binary && reference.ownedTemporary)
          .map(reference => ({
            ...(reference.hostCleanupToken
              ? { hostCleanupToken: reference.hostCleanupToken }
              : { capability: reference.legacyCapability }),
            path: reference.resolvedPath,
            mediaType: reference.mediaType,
            displayPath: reference.displayPath,
            byteCount: reference.byteCount,
            device: reference.device,
            inode: reference.inode,
            mtimeMs: reference.mtimeMs,
            ctimeMs: reference.ctimeMs,
            ownedTemporary: true,
          })),
        summaryText: buildSummaryText(collected),
        inputText: buildInputText(collected),
      }
    }

    if (reservation) {
      await commitAttachmentCapabilityReservation(reservation, {
        deferOwnedCapabilities: collected
          .filter(reference => reference.binary && reference.ownedTemporary && reference.legacyCapability)
          .map(reference => reference.legacyCapability),
      })
      capabilityCommitted = true
    }
    if (selection) {
      await attachmentSelectionRegistry.commit(selection.reservation, {
        deferOwnedActivationCapabilities: collected
          .filter(reference => reference.binary && reference.ownedTemporary && reference.activationCapability)
          .map(reference => reference.activationCapability),
      })
      selectionCommitted = true
    }
    return result
  } finally {
    if (reservation && !capabilityCommitted) {
      await rollbackAttachmentCapabilityReservation(reservation)
    }
    if (selection && !selectionCommitted) {
      await attachmentSelectionRegistry.rollback(selection.reservation)
    }
  }
}

function splitTrailingInternalContext(message) {
  let bodyText = message
  const suffixes = []

  while (bodyText) {
    let match = null
    for (const tag of INTERNAL_CONTEXT_TAGS) {
      const marker = `\n\n${tag.open}\n`
      const close = `\n${tag.close}`
      if (!bodyText.endsWith(close)) continue
      const start = bodyText.lastIndexOf(marker)
      if (start < 0) continue
      if (!match || start > match.start) match = { ...tag, marker, start }
    }
    if (!match) break
    suffixes.unshift(bodyText.slice(match.start + 2))
    bodyText = bodyText.slice(0, match.start).trimEnd()
  }

  return {
    bodyText,
    suffixText: suffixes.join('\n\n') || undefined,
  }
}

function appendInternalContext(bodyText, suffixText) {
  return [bodyText.trim(), suffixText].filter(Boolean).join('\n\n').trim()
}

function normalizeWorkspaceDir(value) {
  const text = String(value ?? '').trim()
  return text ? resolve(text) : null
}

function normalizeMessageText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
}

function parseReferenceMentions(message) {
  const {
    bodyText,
    attachmentCapabilities: capabilities,
    hadAttachmentCapabilities,
  } = splitAttachmentReferences(message)
  const parsedReferences = []
  const explicitRanges = []

  for (const reference of collectExplicitReferences(bodyText)) {
    explicitRanges.push({ start: reference.start, end: reference.end })
    parsedReferences.push(reference)
  }

  for (const reference of collectInlineReferences(bodyText, explicitRanges)) {
    parsedReferences.push(reference)
  }

  for (const attachment of capabilities) {
    parsedReferences.push({
      source: 'capability',
      capability: attachment.capability,
      displayName: attachment.displayName,
      start: Number.MAX_SAFE_INTEGER,
      end: Number.MAX_SAFE_INTEGER,
    })
  }

  parsedReferences.sort((a, b) => a.start - b.start)

  return {
    bodyText,
    references: parsedReferences,
    hadAttachmentCapabilities,
  }
}

function splitAttachmentReferences(message) {
  if (message.includes(ATTACHMENT_MARKER)) {
    throw new Error('Raw attachment paths are not accepted; use a host-issued attachment capability')
  }
  const markerIndex = message.indexOf(ATTACHMENT_CAPABILITY_MARKER)
  if (markerIndex < 0) {
    return {
      bodyText: message,
      attachmentCapabilities: [],
      hadAttachmentCapabilities: false,
    }
  }

  const bodyText = message.slice(0, markerIndex).trim()
  const attachmentText = message.slice(markerIndex + ATTACHMENT_CAPABILITY_MARKER.length).trim()
  const attachmentCapabilities = attachmentText
    .split(/\n/)
    .map(line => {
      const [capability, ...labelParts] = line.trim().split('\t')
      if (!CAPABILITY_PATTERN.test(capability ?? '')) {
        throw new Error('Attachment capability is invalid')
      }
      return {
        capability,
        displayName: sanitizeAttachmentDisplayName(labelParts.join(' ') || 'attachment'),
      }
    })
    .filter(Boolean)

  if (attachmentCapabilities.length === 0) {
    return {
      bodyText: message,
      attachmentCapabilities: [],
      hadAttachmentCapabilities: false,
    }
  }

  return {
    bodyText,
    attachmentCapabilities,
    hadAttachmentCapabilities: true,
  }
}

function collectExplicitReferences(text) {
  const references = []
  const pattern = /(^|[^\w@])@(file|path)(?::|\s+)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"'`<>()[\]{}]+))/g

  for (const match of text.matchAll(pattern)) {
    const prefix = match[1] ?? ''
    const pathText = normalizeCandidatePath(match[3] ?? match[4] ?? match[5] ?? '')
    if (!pathText) continue
    const start = (match.index ?? 0) + prefix.length
    const rawSource = String(match[0]).slice(prefix.length)
    references.push({
      source: rawSource,
      candidatePath: pathText,
      start,
      end: start + rawSource.length,
    })
  }

  return references
}

function collectInlineReferences(text, explicitRanges) {
  const references = []
  const pattern = /(^|[^\w@])@((?:\.{1,2}\/)?[^\s"'`<>()[\]{}]+(?:\/[^\s"'`<>()[\]{}]+)+|(?:\.{1,2}\/)?[^\s"'`<>()[\]{}]+\.[^\s"'`<>()[\]{}]+)/g

  for (const match of text.matchAll(pattern)) {
    const prefix = match[1] ?? ''
    const rawCandidate = String(match[2] ?? '')
    const candidatePath = normalizeCandidatePath(rawCandidate)
    if (!candidatePath) continue
    if (/^(?:file|path)$/i.test(candidatePath) || /^(?:file|path):/i.test(candidatePath)) continue
    const start = (match.index ?? 0) + prefix.length
    const source = `@${rawCandidate}`
    const end = start + source.length
    if (rangeOverlaps({ start, end }, explicitRanges)) continue
    references.push({
      source: `@${candidatePath}`,
      candidatePath,
      start,
      end: start + candidatePath.length + 1,
      // Auto-detected from prose, not an explicit @file:/@path: reference. These
      // are best-effort: a mention that doesn't resolve to a real workspace file
      // (e.g. an npm spec like @ai-sdk/harness@canary) is left as literal text,
      // never a fatal error.
      heuristic: true,
    })
  }

  return references
}

function normalizeCandidatePath(value) {
  let next = String(value ?? '').trim()
  if (!next) return null
  if (next.includes('\u0000')) {
    throw new Error('File references must not contain NUL bytes')
  }
  next = next.replace(/^file:\/\//i, '')
  while (/[),.;:!?]$/.test(next) && !/[\\/]$/.test(next)) {
    next = next.slice(0, -1)
  }
  return next || null
}

function rangeOverlaps(candidate, ranges) {
  return ranges.some(range => candidate.start < range.end && range.start < candidate.end)
}

async function loadWorkspaceReference(
  reference,
  workspaceRoot,
  maxBytesPerFile,
  supportedImages,
  reservation,
  selectionReservation,
  attachmentSelectionRegistry,
) {
  const isCapability = reference.source === 'capability'
  const isSelection = reference.source === 'selection'
  const isExternalAttachment = isCapability || isSelection
  const resolvedRequestedPath = isExternalAttachment
    ? null
    : resolveReferencePath(reference.candidatePath, workspaceRoot)
  let handle = null
  let attachmentRecord = null

  try {
    let openedStat
    let resolvedPath
    let displayPath
    if (isExternalAttachment) {
      const reserved = isCapability
        ? await getReservedAttachmentCapability(reservation, reference.capability)
        : await attachmentSelectionRegistry.getReserved(
            selectionReservation,
            reference.activationCapability,
          )
      attachmentRecord = reserved.record
      handle = reserved.handle
      openedStat = reserved.stat
      resolvedPath = attachmentRecord.resolvedPath
      displayPath = attachmentRecord.displayName ?? attachmentRecord.displayPath
    } else {
      let opened
      try {
        opened = await openNoFollowFile(resolvedRequestedPath, null, `File reference ${reference.source}`)
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'ELOOP') {
          throw new Error(`File reference ${reference.source} must not be a symlink`)
        }
        throw error
      }
      handle = opened.handle
      openedStat = opened.stat
      resolvedPath = await fs.realpath(resolvedRequestedPath)
      if (!isWithinRoot(resolvedPath, workspaceRoot)) {
        throw new Error(`File reference ${reference.source} resolves outside the workspace root`)
      }
      const currentStat = await fs.stat(resolvedPath)
      if (openedStat.dev !== currentStat.dev || openedStat.ino !== currentStat.ino) {
        throw new Error(`File reference ${reference.source} changed during validation`)
      }
      displayPath = getDisplayPath(resolvedPath, workspaceRoot)
    }

    const byteCount = openedStat.size
    const sampled = await readHandlePrefix(handle, byteCount, maxBytesPerFile, true)
    if (isExternalAttachment) {
      // Detect a rename/replacement that races the positional read. The open
      // handle protects the bytes we sampled; this second path attestation
      // prevents committing a transaction whose visible path changed midway.
      if (isCapability) {
        await getReservedAttachmentCapability(reservation, reference.capability)
      } else {
        await attachmentSelectionRegistry.getReserved(
          selectionReservation,
          reference.activationCapability,
        )
      }
    }
    const mediaType = guessMediaType(resolvedPath)
    const isBinary = sampled.includes(0) || isKnownBinaryMediaType(mediaType)

    if (isBinary) {
      if (
        supportedImages
        && (!mediaType.startsWith('image/') || !supportedImages.has(mediaType))
      ) {
        throw new Error(`Binary attachment type ${mediaType} is not supported by this provider or execution target`)
      }
      return {
        source: normalizeReferenceSource(reference.source, displayPath),
        capability: isCapability ? reference.capability : undefined,
        legacyCapability: isCapability ? reference.capability : undefined,
        activationCapability: isSelection ? reference.activationCapability : undefined,
        hostCleanupToken: isSelection ? attachmentRecord.hostCleanupToken : undefined,
        resolvedPath,
        displayPath,
        byteCount,
        truncated: false,
        binary: true,
        mediaType,
        device: String(openedStat.dev),
        inode: String(openedStat.ino),
        mtimeMs: openedStat.mtimeMs,
        ctimeMs: openedStat.ctimeMs,
        ownedTemporary: attachmentRecord?.ownedTemporary === true,
        content: '',
        previewByteCount: 0,
      }
    }

    const limitedBuffer = sampled.byteLength > maxBytesPerFile
      ? sampled.subarray(0, maxBytesPerFile)
      : sampled
    return {
      source: normalizeReferenceSource(reference.source, displayPath),
      capability: isCapability ? reference.capability : undefined,
      legacyCapability: isCapability ? reference.capability : undefined,
      activationCapability: isSelection ? reference.activationCapability : undefined,
      hostCleanupToken: isSelection ? attachmentRecord.hostCleanupToken : undefined,
      resolvedPath,
      displayPath,
      byteCount,
      truncated: byteCount > maxBytesPerFile,
      binary: false,
      ownedTemporary: attachmentRecord?.ownedTemporary === true,
      content: normalizeFileContent(limitedBuffer.toString('utf8')),
      previewByteCount: limitedBuffer.byteLength,
    }
  } catch (error) {
    if (error?.code === 'ENOENT' && handle == null) {
      if (reference.heuristic) return null
      throw new Error(`File reference ${reference.source} was not found in the workspace`)
    }
    if (error?.code === 'EISDIR') {
      throw new Error(`File reference ${reference.source} must point to a file`)
    }
    if (error instanceof Error && /(outside the workspace root|symlink|symbolic link|changed during validation|must point to a file|was not found|capability|attachment changed)/i.test(error.message)) {
      throw error
    }
    throw new Error(`Failed to read file reference ${reference.source}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (!attachmentRecord) {
      await handle?.close().catch(() => {})
    }
  }
}

function isKnownBinaryMediaType(mediaType) {
  return mediaType !== 'application/octet-stream'
    && mediaType !== 'image/svg+xml'
}

function guessMediaType(filePath) {
  const ext = String(filePath).toLowerCase().split('.').pop() || ''
  switch (ext) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'bmp': return 'image/bmp'
    case 'svg': return 'image/svg+xml'
    case 'heic': return 'image/heic'
    case 'pdf': return 'application/pdf'
    case 'zip': return 'application/zip'
    case 'mp4': return 'video/mp4'
    case 'mov': return 'video/quicktime'
    case 'mp3': return 'audio/mpeg'
    case 'wav': return 'audio/wav'
    default: return 'application/octet-stream'
  }
}

function resolveReferencePath(candidatePath, workspaceRoot) {
  const trimmed = String(candidatePath ?? '').trim()
  return trimmed.startsWith('/')
    ? resolve(trimmed)
    : resolve(workspaceRoot, trimmed)
}

function isWithinRoot(candidatePath, rootPath) {
  const normalizedRoot = resolve(rootPath)
  const normalizedCandidate = resolve(candidatePath)
  const rootWithSeparator = normalizedRoot.endsWith(sep)
    ? normalizedRoot
    : `${normalizedRoot}${sep}`
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootWithSeparator)
}

function getDisplayPath(filePath, workspaceRoot) {
  const rel = relative(workspaceRoot, filePath)
  return rel || filePath.split(sep).pop() || filePath
}

function normalizeReferenceSource(source, displayPath) {
  return source === 'capability' || source === 'selection'
    ? 'attachment'
    : `@${displayPath}`
}

function normalizeFileContent(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trimEnd()
}

function buildFileReferenceContext({ executionTarget, references }) {
  const lines = [
    '## Referenced workspace files',
    executionTarget === 'cloud'
      ? 'CodeSurf expanded these local workspace file references before cloud execution. Paths are shown relative to the workspace root.'
      : 'CodeSurf expanded these local workspace file references before execution. Paths are shown relative to the workspace root.',
  ]

  for (const reference of references) {
    lines.push('')
    lines.push(`### ${reference.displayPath}`)
    lines.push(`Source: ${reference.source}`)
    if (reference.binary) {
      const mediaType = reference.mediaType || 'application/octet-stream'
      lines.push(`Type: ${mediaType}`)
      lines.push(`Size: ${formatByteCount(reference.byteCount)}`)
      lines.push(`(binary attachment — content not inlined)`)
      continue
    }
    lines.push(`<<<BEGIN FILE ${reference.displayPath}>>>`)
    lines.push(reference.content || '(empty file)')
    if (reference.truncated) {
      lines.push(`<<<TRUNCATED: showing first ${reference.previewByteCount} of ${reference.byteCount} bytes>>>`)
    }
    lines.push(`<<<END FILE ${reference.displayPath}>>>`)
  }

  return lines.join('\n').trim()
}

function buildSummaryText(references) {
  const paths = references.slice(0, 3).map(reference => reference.displayPath)
  const suffix = references.length > 3 ? ` +${references.length - 3} more` : ''
  return `Expanded ${references.length} workspace file reference${references.length === 1 ? '' : 's'}: ${paths.join(', ')}${suffix}`
}

function buildInputText(references) {
  return references.map(reference => {
    const sourceLabel = reference.source === 'attachment' ? 'attachment' : reference.source
    const suffix = reference.binary
      ? `, ${reference.mediaType || 'binary'}`
      : (reference.truncated ? ', truncated' : '')
    return `- ${sourceLabel} → ${reference.displayPath} (${formatByteCount(reference.byteCount)}${suffix})`
  }).join('\n')
}

function formatByteCount(value) {
  const bytes = Math.max(0, Number(value) || 0)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
