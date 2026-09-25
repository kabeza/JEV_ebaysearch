import type { RunStatus } from '../lib/api'

/**
 * A run's status, in one place.
 *
 * Two places show it now — the run view's header and each run on the search row —
 * and two copies of a rendering drift: a review of Stage 6 found the report and the
 * live view disagreeing about a row, and Stage 8's defect was a page that said
 * `running` while the run was paused. A paused run must stop looking like a
 * working one wherever it appears, so the treatment lives here and nowhere else.
 */
export function RunStatusBadge({
  status,
  className = '',
}: {
  status: RunStatus | null
  className?: string
}) {
  const paused = status === 'paused'
  return (
    <span
      className={`rounded px-2 py-0.5 text-sm ${
        paused ? 'bg-almond-silk text-space-indigo' : 'bg-dusty-grape text-seashell'
      } ${className}`}
    >
      {status ?? 'loading'}
    </span>
  )
}
