import { useEffect, useRef, useState } from 'react'
import { cancelRun, getRun, type Listing, type Run, type RunEvent } from '../lib/api'

interface Props {
  runId: number
  onClose: () => void
}

function money(v: number | null): string {
  return v === null ? '—' : `$${v.toFixed(2)}`
}

export default function RunView({ runId, onClose }: Props) {
  const [run, setRun] = useState<Run | null>(null)
  const [listings, setListings] = useState<Listing[]>([])
  const [events, setEvents] = useState<RunEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)

  // Attach to the live event stream. Because the server replays stored events
  // first, refreshing or reopening this view mid-run still shows everything.
  useEffect(() => {
    void getRun(runId)
      .then((d) => {
        setRun(d.run)
        setListings(d.listings)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))

    const source = new EventSource(`/api/runs/${runId}/events`)

    source.addEventListener('snapshot', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { listings: Listing[]; run: Run }
      setListings(data.listings)
      setRun(data.run)
    })

    source.onmessage = () => {}

    // Every named event arrives via its own listener; catch them all generically.
    source.addEventListener('cards.extracted', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as RunEvent
      setEvents((prev) => [...prev, ev])
      void getRun(runId).then((d) => {
        setListings(d.listings)
        setRun(d.run)
      })
    })

    const generic = ['run.started', 'page.fetched', 'run.progress', 'run.finished', 'run.failed', 'run.cancelled', 'error']
    for (const type of generic) {
      source.addEventListener(type, (e) => {
        const ev = JSON.parse((e as MessageEvent).data) as RunEvent
        setEvents((prev) => [...prev, ev])
        if (type.startsWith('run.') || type === 'error') {
          void getRun(runId).then((d) => setRun(d.run))
        }
      })
    }

    source.onerror = () => {
      // The stream closes when the run ends; a terminal status means stop, not an error.
      void getRun(runId).then((d) => setRun(d.run))
    }

    return () => source.close()
  }, [runId])

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight })
  }, [events.length])

  const finished = run && ['complete', 'failed', 'cancelled'].includes(run.status)

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
              {run.stats.listingsStored ?? 0}
            </p>
          )}
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
              {listings.map((l) => (
                <tr key={l.id} className="border-b border-lilac-ash/10 align-top">
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
                  <td className="py-2 pr-3 whitespace-nowrap text-almond-silk">{money(l.price)}</td>
                  <td className="py-2 pr-3 whitespace-nowrap text-lilac-ash">{money(l.shipping)}</td>
                  <td className="py-2 pr-3 whitespace-nowrap text-lilac-ash">
                    {l.conditionLabel ?? '—'}
                  </td>
                  <td className="py-2 whitespace-nowrap text-lilac-ash">{l.sellerName ?? '—'}</td>
                </tr>
              ))}
              {listings.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-lilac-ash/70">
                    No listings yet.
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
    </section>
  )
}
