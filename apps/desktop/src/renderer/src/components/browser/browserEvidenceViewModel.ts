import type { BrowserEvidenceEvent } from '../../../../shared/browserEvidence'

export type BrowserEvidenceFilter = 'all' | 'issues' | 'console' | 'load-failure' | 'lifecycle'

export const BROWSER_EVIDENCE_FILTERS: ReadonlyArray<{
  id: BrowserEvidenceFilter
  label: string
}> = [
  { id: 'all', label: 'All' },
  { id: 'issues', label: 'Issues' },
  { id: 'console', label: 'Console' },
  { id: 'load-failure', label: 'Loads' },
  { id: 'lifecycle', label: 'Lifecycle' },
]

export function filterBrowserEvidence(
  events: readonly BrowserEvidenceEvent[],
  filter: BrowserEvidenceFilter,
  limit = 50,
): BrowserEvidenceEvent[] {
  const filtered = filter === 'all'
    ? events
    : filter === 'issues'
      ? events.filter(event => event.severity === 'error' || event.severity === 'warning')
      : events.filter(event => event.kind === filter)

  return filtered
    .slice()
    .reverse()
    .slice(0, Math.max(0, Math.floor(limit)))
}
