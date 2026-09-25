import { useEffect, useMemo, useRef, useState } from 'react'
import {
  cancelRun,
  getRun,
  resumeRun,
  type JevAnswer,
  type Judgment,
  type Listing,
  type Questionnaire,
  type Run,
  type RunEvent,
  type Search,
} from '../lib/api'
import { summariseSpec } from '../lib/spec'
import {
  DEFAULT_SETTINGS,
  buildReport,
  type ReportSettings,
  type SortColumn,
} from '../lib/score'
import { download, toCsv, toJson } from '../lib/export'
import { rowsToExport, visibleCount } from '../lib/reportText'
import {
  answersByListing,
  judgmentsForVersion,
  previousVersionOf,
  selectVersion,
} from '../lib/versions'
import { VersionSelector } from './VersionSelector'
import { QuestionEditor } from './QuestionEditor'
import { acceptedConditionsFrom, type SearchRequest } from '../../../src/jev/questions'
import { WeightControls } from './WeightControls'
import { ReportTable } from './ReportTable'

interface Props {
  runId: number
  /** The search this run belongs to: its requirements, and what the editor starts from. */
  search: Search
  onClose: () => void
}

function money(v: number | null): string {
  return v === null ? '—' : `$${v.toFixed(2)}`
}

export default function RunView({ runId, search, onClose }: Props) {
  const spec = search.spec
  const [run, setRun] = useState<Run | null>(null)
  const [listings, setListings] = useState<Listing[]>([])
  const [events, setEvents] = useState<RunEvent[]>([])
  const [judgments, setJudgments] = useState<Judgment[]>([])
  const [questionnaires, setQuestionnaires] = useState<Questionnaire[]>([])
  // Which version's answers the report shows. Ranking is local state, like the
  // weights: nothing here talks to the server.
  const [questionnaireId, setQuestionnaireId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
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
        setQuestionnaires(d.questionnaires)
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
          setQuestionnaires(d.questionnaires)
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
      // A challenge or a JEV outage stops the run where it stands: without these
      // the page keeps showing `running` and never offers Resume, which is the
      // one thing a paused run needs from its reader.
      'run.paused',
      'run.resumed',
      'error',
      // A visited listing gains its item specifics; without this the table keeps
      // showing card data and the detail panel stays empty until a reload.
      'listing.visited',
      'cards.filtered',
      // Answers arrive per batch; each one changes what the table can show.
      'judgments.received',
      // A re-judge is a second judging of the same run: its events carry the new
      // version's answers, so the view refreshes exactly as it does for a run.
      'rejudge.started',
      'rejudge.finished',
      'rejudge.failed',
    ]
    for (const type of generic) {
      source.addEventListener(type, (e) => {
        const ev = JSON.parse((e as MessageEvent).data) as RunEvent
        setEvents((prev) => [...prev, ev])
        // A terminal event must refresh too: the detail phase runs after the last
        // page is fetched, so run.finished is the only signal that it is done.
        if (
          type.startsWith('run.') ||
          type.startsWith('rejudge.') ||
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

  // The newest version is what the last judging produced, and an ordinary run has
  // exactly one. `answersOf` in score.ts keys answers by listing and question, so
  // handing it every version's judgments would mix them silently — and a selection
  // left over from another run must fall back rather than filter to nothing.
  const selected = selectVersion(questionnaires, questionnaireId)
  const selectedRows = useMemo(
    () => (selected === null ? judgments : judgmentsForVersion(judgments, selected)),
    [judgments, selected],
  )
  const previous = selected === null ? null : previousVersionOf(questionnaires, selected)
  const previousAnswers = useMemo(
    () => (previous ? answersByListing(judgmentsForVersion(judgments, previous.id)) : undefined),
    [judgments, previous],
  )
  const selectedVersion = questionnaires.find((q) => q.id === selected)?.version
  // The report is a pure function of what the page already has. That is the
  // whole reason a control can re-sort it without a request (spec §5.6).
  const report = useMemo(
    () => buildReport(survivors, selectedRows, settings),
    [listings, selectedRows, settings],
  )

  // Export writes what the table is showing — the matching rows, the ones still
  // waiting to be judged (they are on screen, and their status column says so),
  // and the discarded ones when the toggle is on (spec §7).
  const exported = rowsToExport(report, settings.showDiscarded)

  // What the questions are asked against, as the server's `SearchRequest`: the
  // draft's buyer-side half. A search created before Stage 7 has no spec, so this
  // is where the editor can finally fill one in — and since a re-judge writes the
  // request back onto the search, this is also what the next fresh run will use.
  // Both conditions resolvers are the server's own, so the editor cannot open on
  // something a run would not do.
  const fallbackRequest: SearchRequest = useMemo(
    () => ({
      keyword: search.keyword,
      criteria_text: search.criteriaText,
      spec: search.spec,
      max_price: typeof search.spec?.max_price === 'number' ? search.spec.max_price : undefined,
      accepted_conditions: acceptedConditionsFrom(search.spec),
    }),
    [search],
  )

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
            {/* A paused run is stopped, waiting for a person: it must not wear
                the same badge as one that is working. */}
            <span
              className={`ml-2 rounded px-2 py-0.5 text-sm ${
                run?.status === 'paused'
                  ? 'bg-almond-silk text-space-indigo'
                  : 'bg-dusty-grape text-seashell'
              }`}
            >
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
          {finished && survivors.length > 0 && (
            <button
              onClick={() => setEditing((current) => !current)}
              className="rounded border border-almond-silk/60 px-3 py-1.5 text-sm text-almond-silk"
            >
              Edit questions
            </button>
          )}
          <VersionSelector
            questionnaires={questionnaires}
            selected={selected}
            onSelect={setQuestionnaireId}
          />
          {run?.status === 'paused' && (
            <button
              onClick={() => void resumeRun(runId)}
              className="rounded bg-almond-silk px-3 py-1.5 text-sm font-medium text-space-indigo"
            >
              Resume
            </button>
          )}
          {!finished && (
            <button
              onClick={() => void cancelRun(runId)}
              className="rounded border border-almond-silk/60 px-3 py-1.5 text-sm text-almond-silk"
            >
              Cancel
            </button>
          )}
          <button
            onClick={() =>
              download(`run-${runId}-report.csv`, toCsv(exported, selectedVersion), 'text/csv')
            }
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

      {editing && (
        <QuestionEditor
          // Keyed on the version: opening the editor from another version must
          // prefill from that version's stored questions, not the last edit.
          key={selected ?? 'none'}
          runId={runId}
          version={selectedVersion ?? null}
          definition={questionnaires.find((q) => q.id === selected)?.definition ?? null}
          fallbackRequest={fallbackRequest}
          onStarted={() => setEditing(false)}
          onClose={() => setEditing(false)}
        />
      )}

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
          // What the table will actually render, so the label cannot promise more
          // rows than the row limit lets through.
          discarded: visibleCount(report.discardedCount, settings.maxRows),
          pending: report.pendingCount,
        }}
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <ReportTable
          report={report}
          settings={settings}
          rejectedCount={rejected.length}
          previousAnswers={previousAnswers}
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
