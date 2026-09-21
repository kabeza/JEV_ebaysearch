import { Fragment, useEffect, useRef, useState } from 'react'
import {
  cancelRun,
  getRun,
  type JevAnswer,
  type Judgment,
  type Listing,
  type Run,
  type RunEvent,
} from '../lib/api'
import { summariseSpec } from '../lib/spec'
import {
  answersByListing,
  isUncertain,
  labelFor,
  levelFor,
  summariseAnswer,
  type ListingAnswer,
} from '../lib/answers'

interface Props {
  runId: number
  /** The search's requirements, so the view can say what the filter was asked to do. */
  spec: Record<string, unknown>
  onClose: () => void
}

function money(v: number | null): string {
  return v === null ? '—' : `$${v.toFixed(2)}`
}

/**
 * What JEV answered about one listing.
 *
 * Uncertainty is shown rather than smoothed over: an answer near the middle of
 * its range is marked, because where JEV sits on the fence is the thing this app
 * exists to let the user see (spec §8.5).
 */
function Answers({ answers }: { answers: ListingAnswer[] }) {
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
function ListingDetailPanel({
  listing,
  answers,
}: {
  listing: Listing
  answers: ListingAnswer[]
}) {
  const detail = listing.detail
  const entries = detail ? Object.entries(detail.specifics) : []

  return (
    <div className="space-y-3 text-sm">
      <Answers answers={answers} />

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

export default function RunView({ runId, spec, onClose }: Props) {
  const [run, setRun] = useState<Run | null>(null)
  const [listings, setListings] = useState<Listing[]>([])
  const [events, setEvents] = useState<RunEvent[]>([])
  const [judgments, setJudgments] = useState<Judgment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)

  // Attach to the live event stream. Because the server replays stored events
  // first, refreshing or reopening this view mid-run still shows everything.
  useEffect(() => {
    void getRun(runId)
      .then((d) => {
        setRun(d.run)
        setListings(d.listings)
        setJudgments(d.judgments)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))

    const source = new EventSource(`/api/runs/${runId}/events`)

    // Listings and run state are re-read from the server rather than patched
    // from the event payload: one code path, and it is the same data the page
    // shows after a refresh. Anything that changes either must call this.
    const refresh = () => {
      void getRun(runId)
        .then((d) => {
          setListings(d.listings)
          setRun(d.run)
          setJudgments(d.judgments)
        })
        .catch(() => {
          /* the next event will try again */
        })
    }

    source.addEventListener('snapshot', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        listings: Listing[]
        run: Run
        judgments?: Judgment[]
      }
      setListings(data.listings)
      setRun(data.run)
      if (data.judgments) setJudgments(data.judgments)
    })

    // Every named event arrives via its own listener; catch them all generically.
    const generic = [
      'run.started',
      'page.fetched',
      'run.progress',
      'run.finished',
      'run.failed',
      'run.cancelled',
      'error',
      // A visited listing gains its item specifics; without this the table keeps
      // showing card data and the detail panel stays empty until a reload.
      'listing.visited',
      'cards.filtered',
      // Answers arrive per batch; each one changes what the table can show.
      'judgments.received',
    ]
    for (const type of generic) {
      source.addEventListener(type, (e) => {
        const ev = JSON.parse((e as MessageEvent).data) as RunEvent
        setEvents((prev) => [...prev, ev])
        // A terminal event must refresh too: the detail phase runs after the last
        // page is fetched, so run.finished is the only signal that it is done.
        if (
          type.startsWith('run.') ||
          type === 'error' ||
          type === 'listing.visited' ||
          type === 'judgments.received'
        ) {
          refresh()
        }
      })
    }

    source.addEventListener('cards.extracted', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as RunEvent
      setEvents((prev) => [...prev, ev])
      refresh()
    })

    source.onerror = () => {
      // The stream can drop and reconnect mid-run; re-reading both keeps the
      // table correct either way, and a finished run is a no-op refresh.
      refresh()
    }

    return () => source.close()
  }, [runId])

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight })
  }, [events.length])

  const finished = run && ['complete', 'failed', 'cancelled'].includes(run.status)

  const survivors = listings.filter((l) => l.stage !== 'rejected')
  const rejected = listings.filter((l) => l.stage === 'rejected')
  const requirements = summariseSpec(spec)
  const answers = answersByListing(judgments)

  return (
    <section className="mt-8 rounded-lg border border-lilac-ash/30 p-5 md:col-span-2">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg text-almond-silk">
            Run {runId}{' '}
            <span className="ml-2 rounded bg-dusty-grape px-2 py-0.5 text-sm text-seashell">
              {run?.status ?? 'loading'}
            </span>
          </h2>
          {run && (
            <p className="mt-1 text-sm text-lilac-ash">
              pages {run.stats.pagesFetched ?? 0} · cards seen {run.stats.cardsSeen ?? 0} · stored{' '}
              {run.stats.listingsStored ?? 0} · filtered out {rejected.length} · details read{' '}
              {run.stats.detailsFetched ?? 0}
              {run.stats.detailsFailed ? ` (${run.stats.detailsFailed} failed)` : ''} · judged{' '}
              {run.stats.judged ?? 0}
              {run.stats.costUsd ? ` · $${Number(run.stats.costUsd).toFixed(4)}` : ''}
            </p>
          )}
          <p className="mt-1 text-sm text-lilac-ash/70">
            {requirements ? `Pre-filter: ${requirements}` : 'No requirements set — nothing pre-filtered'}
          </p>
        </div>
        <div className="flex gap-2">
          {!finished && (
            <button
              onClick={() => void cancelRun(runId)}
              className="rounded border border-almond-silk/60 px-3 py-1.5 text-sm text-almond-silk"
            >
              Cancel
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded border border-lilac-ash/50 px-3 py-1.5 text-sm text-lilac-ash"
          >
            Close
          </button>
        </div>
      </header>

      {run?.error && (
        <p className="mb-4 rounded border border-almond-silk/50 bg-dusty-grape/40 p-3 text-sm text-almond-silk">
          {run.error}
        </p>
      )}
      {error && <p className="mb-4 text-sm text-almond-silk">Error: {error}</p>}

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-lilac-ash">
              <tr className="border-b border-lilac-ash/30">
                <th className="py-2 pr-3 font-normal">Title</th>
                <th className="py-2 pr-3 font-normal">Price</th>
                <th className="py-2 pr-3 font-normal">Ship</th>
                <th className="py-2 pr-3 font-normal">Condition</th>
                <th className="py-2 font-normal">Seller</th>
              </tr>
            </thead>
            <tbody>
              {survivors.map((l) => (
                <Fragment key={l.id}>
                  <tr className="border-b border-lilac-ash/10 align-top">
                    <td className="py-2 pr-2">
                      <button
                        onClick={() => setOpenId(openId === l.id ? null : l.id)}
                        aria-expanded={openId === l.id}
                        title={l.detail ? 'Show item specifics' : 'No listing page detail'}
                        className="px-1 text-lilac-ash hover:text-almond-silk"
                      >
                        {openId === l.id ? '▾' : '▸'}
                      </button>
                    </td>
                    <td className="py-2 pr-3">
                      <a
                        href={l.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-seashell hover:text-almond-silk"
                      >
                        {l.title}
                      </a>
                      {/* No "sponsored" badge: the marker eBay leaves in the DOM is
                          present on every card, so it carries no signal yet. */}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap text-almond-silk">
                      {money(l.price)}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap text-lilac-ash">
                      {money(l.shipping)}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap text-lilac-ash">
                      {l.conditionLabel ?? '—'}
                    </td>
                    <td className="py-2 whitespace-nowrap text-lilac-ash">{l.sellerName ?? '—'}</td>
                  </tr>
                  {openId === l.id && (
                    <tr className="border-b border-lilac-ash/10">
                      <td />
                      <td colSpan={5} className="py-3 pr-3">
                        <ListingDetailPanel
                          listing={l}
                          answers={answers.get(l.id) ?? []}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {survivors.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-lilac-ash/70">
                    {rejected.length > 0
                      ? 'Every card so far was filtered out before JEV — see below.'
                      : 'No listings yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div>
          <h3 className="mb-2 text-sm text-lilac-ash">Live events</h3>
          <div
            ref={feedRef}
            className="h-80 space-y-1 overflow-y-auto rounded border border-lilac-ash/20 bg-dusty-grape/20 p-3 font-mono text-xs text-lilac-ash"
          >
            {events.map((e, i) => (
              <div key={`${e.seq}-${i}`}>
                <span className="text-almond-silk">{e.type}</span>{' '}
                {JSON.stringify(e.payload).slice(0, 110)}
              </div>
            ))}
            {events.length === 0 && <div>waiting…</div>}
          </div>
        </div>
      </div>

      {/*
        Rejected listings are shown, not hidden. They cost nothing and they are
        the only way to tell a filter that is working from one that is eating
        good listings, so each one carries the reason it was stopped.
      */}
      {rejected.length > 0 && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm text-lilac-ash">
            Filtered out ({rejected.length}) — {rejected[0]?.rejectReason}
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-lilac-ash">
                <tr className="border-b border-lilac-ash/30">
                  <th className="py-2 pr-3 font-normal">Title</th>
                  <th className="py-2 pr-3 font-normal">Price</th>
                  <th className="py-2 font-normal">Reason</th>
                </tr>
              </thead>
              <tbody>
                {rejected.map((l) => (
                  <tr key={l.id} className="border-b border-lilac-ash/10 align-top">
                    <td className="py-2 pr-3">
                      <a
                        href={l.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-lilac-ash hover:text-almond-silk"
                      >
                        {l.title}
                      </a>
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap text-lilac-ash">{money(l.price)}</td>
                    <td className="py-2 text-almond-silk/80">{l.rejectReason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  )
}
