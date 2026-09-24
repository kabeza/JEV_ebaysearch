import { Fragment } from 'react'
import {
  isUncertain,
  labelFor,
  levelFor,
  summariseAnswer,
  type ListingAnswer,
} from '../lib/answers'
import type { JevAnswer, Listing } from '../lib/api'

/**
 * What JEV answered about one listing.
 *
 * Uncertainty is shown rather than smoothed over: an answer near the middle of
 * its range is marked, because where JEV sits on the fence is the thing this app
 * exists to let the user see (spec §8.5).
 *
 * Moved here from RunView unchanged when the report arrived, because the live
 * feed and a report row must show an answer the same way. The rendering is
 * deliberately untouched: it already tells a noul (0…1) apart from a score
 * (0…n-1) and flags the fence with `isUncertain` rather than with `confidence`.
 */
export function Answers({
  answers,
  previous,
}: {
  answers: ListingAnswer[]
  /** The previous version's answers for this listing, when there is one. */
  previous?: Record<string, JevAnswer>
}) {
  if (answers.length === 0) {
    return <p className="text-sm text-lilac-ash/60">No answers for this listing yet.</p>
  }

  return (
    <ul className="space-y-1 text-sm">
      {answers.map(({ questionKey, answer }) => {
        const level = levelFor(answer)
        return (
          <li key={questionKey} className="flex flex-wrap items-baseline gap-x-3">
            <span className="w-44 shrink-0 text-lilac-ash">{labelFor(questionKey)}</span>
            <span className="font-mono text-almond-silk">{summariseAnswer(answer)}</span>
            {isUncertain(answer) && (
              <span className="rounded bg-dusty-grape px-1.5 text-xs text-lilac-ash">
                near the fence
              </span>
            )}
            {answer.confidence !== undefined && (
              <span className="text-xs text-lilac-ash/60">
                confidence {(answer.confidence * 100).toFixed(0)}%
              </span>
            )}
            {level && <span className="text-xs text-lilac-ash/80">{level}</span>}
            {/* What the version before this one said, on the same line, through
                the same formatter — so the two cannot read differently. */}
            {previous?.[questionKey] && (
              <span className="text-xs text-lilac-ash/50">
                was {summariseAnswer(previous[questionKey])}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * What the listing page said (spec §5.4).
 *
 * A listing that was never visited, or whose page would not read, says so plainly
 * rather than showing an empty table — "we did not look" and "nothing there" are
 * different answers, and only one of them is a reason to distrust the data.
 */
export function ListingDetailPanel({
  listing,
  answers,
  previous,
}: {
  listing: Listing
  answers: ListingAnswer[]
  previous?: Record<string, JevAnswer>
}) {
  const detail = listing.detail
  const entries = detail ? Object.entries(detail.specifics) : []

  return (
    <div className="space-y-3 text-sm">
      <Answers answers={answers} previous={previous} />

      {!detail ? (
        <p className="text-lilac-ash/70">
          {listing.stage === 'detail_failed'
            ? 'This listing page could not be read, so it was judged on its card data alone.'
            : 'No listing page was opened for this one — past the per-run detail cap — so it was judged on its card data alone.'}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1">
            {entries.map(([label, value]) => (
              <Fragment key={label}>
                <dt className="text-lilac-ash">{label}</dt>
                <dd className="text-seashell/90">{value}</dd>
              </Fragment>
            ))}
            {entries.length === 0 && (
              <dd className="col-span-2 text-lilac-ash/70">
                The listing page stated no item specifics.
              </dd>
            )}
          </dl>
          <p className="text-lilac-ash/80">
            From the listing page: condition {detail.condition ?? '—'}, seller{' '}
            {detail.sellerName ?? '—'}
            {detail.sellerFeedback ? ` (${detail.sellerFeedback})` : ''}
          </p>
        </>
      )}
    </div>
  )
}
