import { Fragment, useState } from 'react'
import { ListingDetailPanel } from './AnswerDetail'
import { SellerBadge } from './SellerBadge'
import { WEIGHTED_SIGNALS, type Report, type ReportSettings, type SortColumn } from '../lib/score'

function money(v: number | null): string {
  return v === null ? '—' : `$${v.toFixed(2)}`
}

const COLUMNS: { key: SortColumn; label: string; className?: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'price', label: 'Price', className: 'pr-3' },
  { key: 'shipping', label: 'Ship', className: 'pr-3' },
  { key: 'seller', label: 'Seller' },
  { key: 'trust', label: 'Feedback' },
  { key: 'blend', label: 'Blend' },
]

interface Props {
  report: Report
  settings: ReportSettings
  onSort: (column: SortColumn) => void
  onToggleDiscarded: (show: boolean) => void
}

/**
 * The report. Rows come in already scored and sorted — this component decides
 * nothing about ranking, which is why the controls above it can re-sort the
 * table without a request (spec §5.6).
 *
 * What is *not* shown is stated rather than implied: the counts line names the
 * discarded rows, the unjudged ones, and how many rows the limit is holding
 * back (CLAUDE.md rule 7 — silence is a bug).
 */
export function ReportTable({ report, settings, onSort, onToggleDiscarded }: Props) {
  const [openId, setOpenId] = useState<number | null>(null)

  const rows = [...report.matching, ...report.pending]
  const visible = settings.showDiscarded ? [...rows, ...report.discarded] : rows

  const header = (column: SortColumn, label: string, className?: string) => (
    <th
      key={column}
      className={`py-2 font-normal ${className ?? 'pr-3'}`}
      aria-sort={
        settings.sort.column === column
          ? settings.sort.direction === 'asc'
            ? 'ascending'
            : 'descending'
          : 'none'
      }
    >
      <button onClick={() => onSort(column)} className="text-lilac-ash hover:text-almond-silk">
        {label}
        {settings.sort.column === column ? (settings.sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  )

  return (
    <div className="overflow-x-auto">
      {!report.blendAvailable && (
        <p className="mb-2 rounded border border-almond-silk/40 bg-dusty-grape/30 p-2 text-sm text-almond-silk">
          Every weight is zero, so there is no blend and no order. Raise a weight to rank.
        </p>
      )}

      <table className="w-full text-left text-sm">
        <thead className="text-lilac-ash">
          <tr className="border-b border-lilac-ash/30">
            <th className="py-2 pr-1 font-normal" />
            {COLUMNS.map((c) => header(c.key, c.label, c.className))}
            <th className="py-2 font-normal">Condition</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => (
            <Fragment key={row.listing.id}>
              <tr
                className={`border-b border-lilac-ash/10 align-top ${
                  row.highlighted ? 'bg-seashell/10' : ''
                } ${row.matching ? '' : 'opacity-60'}`}
              >
                <td className="py-2 pr-1">
                  <button
                    onClick={() => setOpenId(openId === row.listing.id ? null : row.listing.id)}
                    aria-expanded={openId === row.listing.id}
                    aria-label={`answers for ${row.listing.title}`}
                    title={row.listing.detail ? 'Show item specifics' : 'No listing page detail'}
                    className="px-1 text-lilac-ash hover:text-almond-silk"
                  >
                    {openId === row.listing.id ? '▾' : '▸'}
                  </button>
                </td>
                <td className="py-2 pr-3">
                  <a
                    href={row.listing.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-seashell hover:text-almond-silk"
                  >
                    {row.listing.title}
                  </a>
                  {row.highlighted && <span className="ml-2 text-xs text-almond-silk">best</span>}
                  {/* Why a row is not matching, on the row itself: a gate reject
                      and a threshold miss look identical otherwise, and the
                      discarded toggle exists to tell them apart. */}
                  {!row.matching && row.discardReason && (
                    <span className="block text-xs text-lilac-ash/60">{row.discardReason}</span>
                  )}
                  {/* No "sponsored" badge: the marker eBay leaves in the DOM is
                      present on every card, so it carries no signal yet. */}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap text-almond-silk">
                  {money(row.listing.price)}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap text-lilac-ash">
                  {money(row.listing.shipping)}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap text-lilac-ash">
                  {row.listing.sellerName ?? '—'}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap text-lilac-ash">
                  {/* A badge carries the count; without one the percentage is
                      still stated (spec §5.6.1). Printing both would say 100%
                      twice. */}
                  {row.trust.tier === 'not_marked' ? (
                    row.trust.pct === null ? '—' : `${row.trust.pct}%`
                  ) : (
                    <SellerBadge trust={row.trust} />
                  )}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap font-mono text-almond-silk">
                  {row.blend === null ? '—' : row.blend.toFixed(3)}
                </td>
                <td className="py-2 whitespace-nowrap text-lilac-ash">
                  {row.listing.conditionLabel ?? '—'}
                </td>
              </tr>
              {openId === row.listing.id && (
                <tr className="border-b border-lilac-ash/10">
                  <td />
                  <td colSpan={7} className="py-3 pr-3">
                    <ListingDetailPanel
                      listing={row.listing}
                      answers={Object.entries(row.answers).map(([questionKey, answer]) => ({
                        questionKey,
                        answer,
                      }))}
                    />
                    {row.missing.length > 0 && (
                      <p className="mt-2 text-xs text-lilac-ash/70">
                        Not in the blend — no answer for{' '}
                        {row.missing.map((s) => s.replace(/_/g, ' ')).join(', ')}
                      </p>
                    )}
                    {Object.keys(row.answers).length === 0 && (
                      <p className="mt-2 text-xs text-lilac-ash/70">
                        Not judged yet — showing card data only, and it is not ranked.
                      </p>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}

          {visible.length === 0 && (
            <tr>
              <td colSpan={8} className="py-4 text-lilac-ash/70">
                {report.discardedCount > 0
                  ? `Nothing matched. ${report.discardedCount} judged listings were discarded — tick “show discarded” to inspect them.`
                  : report.pendingCount > 0
                    ? `${report.pendingCount} listings are waiting to be judged.`
                    : 'No listings yet.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <p className="mt-2 text-xs text-lilac-ash/70">
        {report.matchingCount} matching
        {report.matchingCount > settings.maxRows ? ` (showing ${settings.maxRows})` : ''} ·{' '}
        {report.discardedCount} discarded · {report.pendingCount} not judged yet
        {report.discardedCount > 0 && !settings.showDiscarded && (
          <>
            {' · '}
            <button
              onClick={() => onToggleDiscarded(true)}
              className="underline hover:text-almond-silk"
            >
              show discarded
            </button>
          </>
        )}
      </p>
      <p className="mt-1 text-xs text-lilac-ash/50">
        blend = weighted average of: {WEIGHTED_SIGNALS.join(', ')}
      </p>
    </div>
  )
}
