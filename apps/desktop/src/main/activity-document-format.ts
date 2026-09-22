import type { ActivityRecord } from '../shared/activity-types.ts'
import { ACTIVITY_DOCUMENT_VERSION } from './activity-validation.ts'

const DOCUMENT_PREFIX = `{"version":${ACTIVITY_DOCUMENT_VERSION},"records":[`
const DOCUMENT_SUFFIX = ']}\n'

export const EMPTY_ACTIVITY_DOCUMENT_BYTES = Buffer.byteLength(
  `${DOCUMENT_PREFIX}${DOCUMENT_SUFFIX}`,
  'utf8',
)

export function activityRecordJson(record: ActivityRecord): string {
  return JSON.stringify(record)
}

export function activityRecordByteLength(record: ActivityRecord): number {
  return Buffer.byteLength(activityRecordJson(record), 'utf8')
}

export function activityDocumentByteLengthFromRecordBytes(recordBytes: readonly number[]): number {
  return EMPTY_ACTIVITY_DOCUMENT_BYTES
    + recordBytes.reduce((total, bytes) => total + bytes, 0)
    + Math.max(0, recordBytes.length - 1)
}

export function serializeCompactActivityDocument(records: readonly ActivityRecord[]): string {
  return `${DOCUMENT_PREFIX}${records.map(activityRecordJson).join(',')}${DOCUMENT_SUFFIX}`
}

export function fitActivityRecordsToDocument(
  records: readonly ActivityRecord[],
  maxBytes: number,
): {
  records: ActivityRecord[]
  bytes: number
  trimmed: boolean
} {
  const fitted: ActivityRecord[] = []
  let bytes = EMPTY_ACTIVITY_DOCUMENT_BYTES
  for (const record of records) {
    const recordBytes = activityRecordByteLength(record)
    const nextBytes = bytes + (fitted.length === 0 ? 0 : 1) + recordBytes
    if (nextBytes > maxBytes) break
    fitted.push(record)
    bytes = nextBytes
  }
  return {
    records: fitted,
    bytes,
    trimmed: fitted.length !== records.length,
  }
}
