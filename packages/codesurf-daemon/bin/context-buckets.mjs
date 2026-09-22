const EXPLICIT_CONTEXT_BUCKETS = Object.freeze(['local-only', 'remote-safe'])

export function getIncludedContextBuckets(executionTarget = 'local') {
  return executionTarget === 'cloud'
    ? ['remote-safe']
    : ['local-only', 'remote-safe']
}

export function buildContextBucketBundle(context, promptOverride) {
  const normalized = normalizeContextBucketBundle(context)
  if (promptOverride === undefined) return normalized

  const details = describeContextBucketsForTool(normalized, promptOverride)
  return {
    ...normalized,
    ...(details.summary || details.input ? { inspect: details } : {}),
  }
}

export function describeContextBucketsForTool(bundle, promptOverride) {
  const normalized = normalizeContextBucketBundle(bundle)
  const input = buildContextBucketToolInput(normalized, promptOverride)
  const visibleSections = normalized.buckets
    .filter(bucket => bucket.included)
    .flatMap(bucket => bucket.sections)

  if (visibleSections.length > 0) {
    const paths = visibleSections.slice(0, 3).map(section => section.displayPath)
    const suffix = visibleSections.length > 3 ? ` +${visibleSections.length - 3} more` : ''
    const bucketSummary = normalized.buckets
      .filter(bucket => bucket.included)
      .map(bucket => `${bucket.bucket}: ${bucket.sectionCount}`)
      .join(', ')
    return {
      summary: `Loaded ${visibleSections.length} instruction section${visibleSections.length === 1 ? '' : 's'} [${bucketSummary}]: ${paths.join(', ')}${suffix}`,
      input,
    }
  }

  if (input) {
    return {
      summary: 'Loaded workspace instructions for this run.',
      input,
    }
  }

  return {
    summary: undefined,
    input: undefined,
  }
}

export function buildContextBucketToolInput(bundle, promptOverride) {
  const normalized = normalizeContextBucketBundle(bundle)
  const prompt = normalizePrompt(promptOverride)
  const lines = []

  if (normalized.buckets.length > 0) {
    lines.push('## Outbound Context Buckets')
    lines.push(`Included buckets: ${normalized.includedBuckets.length > 0 ? normalized.includedBuckets.join(', ') : 'none'}`)
    lines.push('')

    for (const bucket of normalized.buckets) {
      if (bucket.included) {
        lines.push(`### ${bucket.bucket}`)
        if (bucket.sections.length === 0) {
          lines.push('- no sections')
        } else {
          for (const section of bucket.sections) {
            lines.push(`- ${section.displayPath}${section.importedFrom ? ` (imported from ${section.importedFrom})` : ''}`)
          }
        }
      } else {
        lines.push(`### ${bucket.bucket} (omitted from outbound bundle)`)
        lines.push('- omitted from outbound bundle')
      }
      lines.push('')
    }
  }

  if (prompt) {
    if (lines.length > 0) {
      lines.push('## Injected Prompt')
    }
    lines.push(prompt)
  }

  return lines.join('\n').trim() || undefined
}

function normalizeContextBucketBundle(value) {
  if (value && typeof value === 'object' && Array.isArray(value.buckets)) {
    return {
      version: 1,
      includedBuckets: normalizeIncludedBuckets(value.includedBuckets),
      buckets: normalizeBuckets(value.buckets, normalizeIncludedBuckets(value.includedBuckets)),
    }
  }

  const includedBuckets = normalizeIncludedBuckets(
    Array.isArray(value?.includedBuckets) && value.includedBuckets.length > 0
      ? value.includedBuckets
      : getIncludedContextBuckets(value?.executionTarget),
  )
  const sections = normalizeSections(value?.sections)
  const bucketOrder = normalizeBucketOrder(includedBuckets, sections.map(section => section.bucket))

  return {
    version: 1,
    includedBuckets,
    buckets: bucketOrder.map(bucket => {
      const included = includedBuckets.includes(bucket)
      const bucketSections = included
        ? sections.filter(section => section.bucket === bucket).map(section => ({
            scope: section.scope,
            displayPath: section.displayPath,
            importedFrom: section.importedFrom ?? null,
          }))
        : []
      return {
        bucket,
        included,
        sectionCount: bucketSections.length,
        sections: bucketSections,
      }
    }),
  }
}

function normalizeBuckets(buckets, includedBuckets) {
  const normalized = new Map()
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    const bucketName = normalizeBucketName(bucket?.bucket)
    if (!bucketName) continue
    normalized.set(bucketName, {
      bucket: bucketName,
      included: includedBuckets.includes(bucketName),
      sectionCount: 0,
      sections: normalizeBucketSections(bucket?.sections),
    })
  }

  const bucketOrder = normalizeBucketOrder(includedBuckets, normalized.keys())
  return bucketOrder.map(bucketName => {
    const existing = normalized.get(bucketName)
    if (!existing) {
      return {
        bucket: bucketName,
        included: includedBuckets.includes(bucketName),
        sectionCount: 0,
        sections: [],
      }
    }
    const included = includedBuckets.includes(bucketName)
    const sections = included ? existing.sections : []
    return {
      bucket: bucketName,
      included,
      sectionCount: sections.length,
      sections,
    }
  })
}

function normalizeSections(sections) {
  return (Array.isArray(sections) ? sections : [])
    .map(section => {
      const bucket = normalizeBucketName(section?.bucket)
      const displayPath = String(section?.displayPath ?? '').trim()
      if (!bucket || !displayPath) return null
      return {
        scope: String(section?.scope ?? '').trim() || 'workspace',
        bucket,
        displayPath,
        importedFrom: normalizeOptionalString(section?.importedFrom),
      }
    })
    .filter(Boolean)
}

function normalizeBucketSections(sections) {
  return (Array.isArray(sections) ? sections : [])
    .map(section => {
      const displayPath = String(section?.displayPath ?? '').trim()
      if (!displayPath) return null
      return {
        scope: String(section?.scope ?? '').trim() || 'workspace',
        displayPath,
        importedFrom: normalizeOptionalString(section?.importedFrom),
      }
    })
    .filter(Boolean)
}

function normalizeIncludedBuckets(buckets) {
  const normalized = []
  const seen = new Set()
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    const value = normalizeBucketName(bucket)
    if (!value || seen.has(value)) continue
    seen.add(value)
    normalized.push(value)
  }

  const ordered = EXPLICIT_CONTEXT_BUCKETS.filter(bucket => seen.has(bucket))
  for (const bucket of normalized) {
    if (!ordered.includes(bucket)) ordered.push(bucket)
  }
  return ordered
}

function normalizeBucketOrder(...bucketSources) {
  const seen = new Set()
  const extras = []

  for (const bucket of EXPLICIT_CONTEXT_BUCKETS) {
    seen.add(bucket)
  }

  for (const source of bucketSources) {
    for (const bucket of Array.from(source ?? [])) {
      const value = normalizeBucketName(bucket)
      if (!value || seen.has(value)) continue
      seen.add(value)
      extras.push(value)
    }
  }

  return [...EXPLICIT_CONTEXT_BUCKETS, ...extras]
}

function normalizeBucketName(value) {
  const normalized = String(value ?? '').trim()
  return normalized || null
}

function normalizeOptionalString(value) {
  const normalized = String(value ?? '').trim()
  return normalized || null
}

function normalizePrompt(value) {
  const normalized = String(value ?? '').trim()
  return normalized || undefined
}
