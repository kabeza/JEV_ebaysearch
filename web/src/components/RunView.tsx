import { useEffect, useMemo, useRef, useState } from 'react'
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
  DEFAULT_SETTINGS,
  buildReport,
  type ReportSettings,
  type SortColumn,
} from '../lib/score'
import { download, toCsv, toJson } from '../lib/export'
import { WeightControls } from './WeightControls'
import { ReportTable } from './ReportTable'

interface Props {
  runId: number
  /** The search's requirements, so the view can say what the filter was asked to do. */
  spec: Record<string, unknown>
  onClose: () => void
}

function money(v: number | null): string {
  return v === null ? '—' : `$${v.toFixed(2)}`
}

export default function RunView({ runId, spec, onClose }: Props) {
  const [run, setRun] = useState<Run | null>(null)
  const [listings, setListings] = useState<Listing[]>([])
  const [events, setEvents] = useState<RunEvent[]>([])
  const [judgments, setJudgments] = useState<Judgment[]>([])
  const [error, setError] = useState<string | null>(null)
  // Ranking is local state: no URL, no server, no persistence. A reload returns
  // to the defaults in `DEFAULT_SETTINGS` (spec §5.6).
  const [settings, setSettings] = useState<ReportSettings>(DEFAULT_SETTINGS)
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
  // The report is a pure function of what the page already has. That is the
  // whole reason a control can re-sort it without a request (spec §5.6).
  const report = useMemo(
    () => buildReport(survivors, judgments, settings),
    [listings, judgments, settings],
  )

  // Export writes what the table is showing: the matching rows and, when the
  // discarded toggle is on, the discarded ones too (spec §7).
  const exported = settings.showDiscarded
    ? [...report.matching, ...report.discarded]
    : report.matching

  const sortBy = (column: SortColumn) => {
    setSettings((current) => ({
      ...current,
      sort:
        current.sort.column === column
          ? { column, direction: current.sort.direction === 'desc' ? 'asc' : 'desc' }
          : { column, direction: 'desc' },
    }))
  }

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
            onClick={() => download(`run-${runId}-report.csv`, toCsv(exported), 'text/csv')}
            className="rounded border border-almond-silk/60 px-3 py-1.5 text-sm text-almond-silk"
          >
            Export CSV ({exported.length})
          </button>
          <button
            onClick={() => download(`run-${runId}-report.json`, toJson(exported), 'application/json')}
            className="rounded border border-almond-silk/60 px-3 py-1.5 text-sm text-almond-silk"
          >
            Export JSON
          </button>
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

      <WeightControls
        settings={settings}
        onChange={setSettings}
        onReset={() => setSettings(DEFAULT_SETTINGS)}
        counts={{
          matching: report.matchingCount,
          discarded: report.discardedCount,
          pending: report.pendingCount,
        }}
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <ReportTable
          report={report}
          settings={settings}
          onSort={sortBy}
          onToggleDiscarded={(show) => setSettings((current) => ({ ...current, showDiscarded: show }))}
        />

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
