import { StringDecoder } from 'node:string_decoder'

export const MAX_CONTEXT_FILE_BYTES = 32 * 1024
export const MAX_INSTRUCTION_SECTIONS = 32
export const MAX_IMPORT_DEPTH = 8
export const MAX_IMPORT_CANONICAL_VALIDATION_ATTEMPTS = 512
export const MAX_IMPORT_TRAVERSAL_ATTEMPTS = 128
export const MAX_ROOT_TRAVERSAL_ATTEMPTS = 128
export const MAX_AGGREGATE_INSTRUCTION_BYTES = 128 * 1024
export const MAX_SELECTED_SKILLS = 24
export const MAX_SKILL_DESCRIPTION_BYTES = 2 * 1024
export const MAX_PERSONA_PROMPT_BYTES = 16 * 1024
export const MAX_TRANSCRIPT_CONTEXT_PREVIEW_BYTES = 8 * 1024

// Preassembled skill prompts cross a trust boundary without their original
// per-skill structure. Reuse the instruction aggregate ceiling there so the
// daemon can bound them deterministically before any provider sees them.
export const MAX_SKILLS_PROMPT_BYTES = MAX_AGGREGATE_INSTRUCTION_BYTES
export const MAX_SKILLS_SUMMARY_BYTES = MAX_TRANSCRIPT_CONTEXT_PREVIEW_BYTES

export function utf8ByteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8')
}

function utf8Prefix(value, maxBytes) {
  const budget = Math.max(0, Math.floor(Number(maxBytes) || 0))
  if (budget === 0) return ''
  const source = Buffer.from(String(value ?? ''), 'utf8')
  if (source.length <= budget) return source.toString('utf8')

  // StringDecoder deliberately holds an incomplete trailing code point instead
  // of replacing it, so every byte-bounded prefix remains valid UTF-8 text.
  const decoder = new StringDecoder('utf8')
  return decoder.write(source.subarray(0, budget))
}

function combineReasons(...values) {
  const reasons = []
  for (const value of values) {
    for (const reason of String(value ?? '').split(';')) {
      const normalized = reason.trim()
      if (normalized && !reasons.includes(normalized)) reasons.push(normalized)
    }
  }
  return reasons.join('; ')
}

export function truncationMarker(reason, originalBytes, maxBytes) {
  const omittedBytes = Math.max(0, Number(originalBytes) - Number(maxBytes))
  return `[Context truncated: ${String(reason ?? 'context byte limit').trim() || 'context byte limit'}; ${originalBytes} original UTF-8 bytes, ${maxBytes} byte limit, at least ${omittedBytes} bytes omitted.]`
}

export function truncateUtf8(value, maxBytes, {
  reason = 'context byte limit',
  originalBytes,
} = {}) {
  const text = String(value ?? '')
  const limit = Math.max(0, Math.floor(Number(maxBytes) || 0))
  const measuredBytes = utf8ByteLength(text)
  const sourceBytes = Number.isFinite(originalBytes)
    ? Math.max(measuredBytes, Math.floor(originalBytes))
    : measuredBytes

  if (sourceBytes <= limit && measuredBytes <= limit) {
    return {
      text,
      originalBytes: sourceBytes,
      includedBytes: measuredBytes,
      truncated: false,
      truncationReason: null,
      omittedBytes: 0,
    }
  }

  const normalizedReason = String(reason ?? '').trim() || 'context byte limit'
  const marker = truncationMarker(normalizedReason, sourceBytes, limit)
  const separator = text ? '\n\n' : ''
  const markerBytes = utf8ByteLength(`${separator}${marker}`)
  let bounded

  if (markerBytes <= limit) {
    bounded = `${utf8Prefix(text, limit - markerBytes)}${separator}${marker}`
  } else {
    // Configured product limits are all comfortably larger than this fallback.
    // Keeping it deterministic makes the helper safe for tests/custom callers.
    bounded = utf8Prefix(`[Truncated: ${normalizedReason}]`, limit)
  }

  const includedBytes = utf8ByteLength(bounded)
  return {
    text: bounded,
    originalBytes: sourceBytes,
    includedBytes,
    truncated: true,
    truncationReason: normalizedReason,
    omittedBytes: Math.max(0, sourceBytes - includedBytes),
  }
}

export function truncateUtf8Buffer(value, maxBytes, options = {}) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '')
  const limit = Math.max(0, Math.floor(Number(maxBytes) || 0))
  const decoder = new StringDecoder('utf8')
  const observed = buffer.length > limit
    ? decoder.write(buffer.subarray(0, Math.min(buffer.length, limit + 1)))
    : decoder.end(buffer)
  return truncateUtf8(observed, limit, options)
}

function normalizeOptionalText(value) {
  return String(value ?? '').trim()
}

function stripAppendedSuffix(value, suffix) {
  if (!value || !suffix) return value
  if (value === suffix) return ''
  const appended = `\n\n${suffix}`
  return value.endsWith(appended)
    ? value.slice(0, -appended.length).trimEnd()
    : value
}

/**
 * Bound two ordered context fragments while reserving capacity for the
 * higher-precedence suffix. Callers may pass a legacy value that already has
 * the suffix appended; the exact duplicate is removed before allocation.
 */
export function boundContextWithReservedSuffix(
  value,
  suffixValue,
  maxBytes,
  {
    reason = 'context byte limit',
    suffixReason = reason,
  } = {},
) {
  const suffix = normalizeOptionalText(suffixValue)
  const base = stripAppendedSuffix(normalizeOptionalText(value), suffix)
  const limit = Math.max(0, Math.floor(Number(maxBytes) || 0))

  if (!suffix) {
    const bounded = truncateUtf8(base, limit, { reason })
    return {
      text: bounded.text || undefined,
      suffix: undefined,
      originalBytes: bounded.originalBytes,
      includedBytes: bounded.includedBytes,
      truncated: bounded.truncated,
      truncationReason: bounded.truncationReason,
      base: bounded,
      higherPrecedenceSuffix: truncateUtf8('', limit, { reason: suffixReason }),
    }
  }

  const boundedSuffix = truncateUtf8(suffix, limit, { reason: suffixReason })
  const separator = base && boundedSuffix.text ? '\n\n' : ''
  const remainingBytes = Math.max(
    0,
    limit - utf8ByteLength(boundedSuffix.text) - utf8ByteLength(separator),
  )
  const boundedBase = truncateUtf8(base, remainingBytes, { reason })
  const text = [boundedBase.text, boundedSuffix.text].filter(Boolean).join('\n\n')
  const originalBytes = utf8ByteLength(base)
    + utf8ByteLength(base && suffix ? '\n\n' : '')
    + utf8ByteLength(suffix)
  const truncationReason = combineReasons(
    boundedBase.truncationReason,
    boundedSuffix.truncationReason,
  ) || null

  return {
    text: text || undefined,
    suffix: boundedSuffix.text || undefined,
    originalBytes,
    includedBytes: utf8ByteLength(text),
    truncated: boundedBase.truncated || boundedSuffix.truncated,
    truncationReason,
    base: boundedBase,
    higherPrecedenceSuffix: boundedSuffix,
  }
}

function normalizeFragmentMetadata(fragment, index) {
  const content = String(fragment?.content ?? '')
  const measuredBytes = utf8ByteLength(content)
  const originalBytes = Number.isFinite(fragment?.originalBytes)
    ? Math.max(measuredBytes, Math.floor(fragment.originalBytes))
    : measuredBytes
  const precedence = Number.isFinite(fragment?.precedence)
    ? Number(fragment.precedence)
    : index
  return {
    source: String(fragment?.source ?? fragment?.path ?? fragment?.displayPath ?? 'context'),
    displayPath: String(fragment?.displayPath ?? fragment?.source ?? 'context'),
    scope: String(fragment?.scope ?? 'workspace'),
    bucket: String(fragment?.bucket ?? 'remote-safe'),
    precedence,
    originalBytes,
    includedBytes: measuredBytes,
    truncated: fragment?.truncated === true,
    truncationReason: fragment?.truncationReason
      ? String(fragment.truncationReason)
      : null,
  }
}

export function budgetInstructionFragments(fragments, {
  maxSections = MAX_INSTRUCTION_SECTIONS,
  maxBytes = MAX_AGGREGATE_INSTRUCTION_BYTES,
  reservedBytes = 0,
} = {}) {
  const entries = (Array.isArray(fragments) ? fragments : [])
    .map((fragment, index) => ({
      index,
      fragment,
      content: String(fragment?.content ?? ''),
      metadata: normalizeFragmentMetadata(fragment, index),
    }))
    .filter(entry => entry.content.trim().length > 0)
  const ranked = [...entries].sort((left, right) => {
    if (left.metadata.precedence !== right.metadata.precedence) {
      return right.metadata.precedence - left.metadata.precedence
    }
    return right.index - left.index
  })
  const sectionLimit = Math.max(0, Math.floor(Number(maxSections) || 0))
  const byteLimit = Math.max(0, Math.floor(Number(maxBytes) || 0))
  const reserved = Math.min(byteLimit, Math.max(0, Math.floor(Number(reservedBytes) || 0)))
  const contentCapacity = byteLimit - reserved
  const selected = new Set(ranked.slice(0, sectionLimit).map(entry => entry.index))
  const accepted = new Map()
  const omitted = []
  let remainingBytes = contentCapacity
  let omittedByCount = 0
  let omittedByAggregate = 0
  let truncatedByAggregate = 0

  for (const entry of ranked) {
    if (!selected.has(entry.index)) {
      omittedByCount += 1
      omitted.push({
        ...entry.metadata,
        includedBytes: 0,
        truncated: true,
        truncationReason: combineReasons(
          entry.metadata.truncationReason,
          `maximum included instruction sections (${sectionLimit})`,
        ),
      })
      continue
    }

    const currentBytes = utf8ByteLength(entry.content)
    if (currentBytes <= remainingBytes) {
      accepted.set(entry.index, {
        ...entry.fragment,
        content: entry.content,
        ...entry.metadata,
        includedBytes: currentBytes,
      })
      remainingBytes -= currentBytes
      continue
    }

    const aggregateReason = `maximum aggregate instruction bytes (${byteLimit})`
    const reason = combineReasons(entry.metadata.truncationReason, aggregateReason)
    const minimumMarkerBytes = utf8ByteLength(
      truncationMarker(reason, entry.metadata.originalBytes, remainingBytes),
    )
    if (remainingBytes <= 0 || minimumMarkerBytes > remainingBytes) {
      omittedByAggregate += 1
      omitted.push({
        ...entry.metadata,
        includedBytes: 0,
        truncated: true,
        truncationReason: reason,
      })
      continue
    }

    const bounded = truncateUtf8(entry.content, remainingBytes, {
      reason,
      originalBytes: entry.metadata.originalBytes,
    })
    accepted.set(entry.index, {
      ...entry.fragment,
      content: bounded.text,
      ...entry.metadata,
      includedBytes: bounded.includedBytes,
      truncated: true,
      truncationReason: reason,
    })
    truncatedByAggregate += 1
    remainingBytes -= bounded.includedBytes
  }

  return {
    fragments: entries
      .filter(entry => accepted.has(entry.index))
      .map(entry => accepted.get(entry.index)),
    omitted,
    originalSectionCount: entries.length,
    includedSectionCount: accepted.size,
    omittedSectionCount: omitted.length,
    omittedByCount,
    omittedByAggregate,
    truncatedByAggregate,
    includedBytes: contentCapacity - remainingBytes,
    reservedBytes: reserved,
    maxSections: sectionLimit,
    maxBytes: byteLimit,
  }
}

export function formatInstructionBudgetNotice(budget, extraNotices = []) {
  const lines = []
  if (budget?.omittedByCount > 0) {
    lines.push(`${budget.omittedByCount} lower-precedence instruction section${budget.omittedByCount === 1 ? '' : 's'} omitted by maximum included instruction sections (${budget.maxSections}).`)
  }
  if ((budget?.omittedByAggregate ?? 0) > 0 || (budget?.truncatedByAggregate ?? 0) > 0) {
    const affected = (budget?.omittedByAggregate ?? 0) + (budget?.truncatedByAggregate ?? 0)
    lines.push(`${affected} lower-precedence instruction section${affected === 1 ? '' : 's'} truncated or omitted by maximum aggregate instruction bytes (${budget.maxBytes}).`)
  }
  for (const notice of Array.isArray(extraNotices) ? extraNotices : []) {
    const normalized = String(notice ?? '').trim()
    if (normalized && !lines.includes(normalized)) lines.push(normalized)
  }
  if (lines.length === 0) return undefined
  return `[Instruction context budget: ${lines.join(' ')}]`
}

export function previewContextToolInput(value) {
  return truncateUtf8(value, MAX_TRANSCRIPT_CONTEXT_PREVIEW_BYTES, {
    reason: `maximum transcript context preview bytes (${MAX_TRANSCRIPT_CONTEXT_PREVIEW_BYTES})`,
  })
}
