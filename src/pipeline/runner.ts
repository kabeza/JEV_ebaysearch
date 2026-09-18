import { EventEmitter } from 'node:events'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { launchBrowser, playwrightPageSource, type PageSource } from '../scraper/browser'
import { executeRun } from './run'
import { createRun, getRun, finishRun } from '../storage/runs'
import { appendEvent, listEvents, type RunEvent } from '../storage/events'
import { listListings } from '../storage/listings'
import { getSearch } from '../storage/searches'
import { DEFAULTS, type RunSettings } from '../shared/config'

export interface StartRunOptions {
  searchId: number
  /** Override any run defaults. */
  settings?: Partial<RunSettings>
  profileDir?: string
  screenshotsDir?: string
  /**
   * Overrides the page source. Tests use this to exercise the whole live path —
   * start, publish, subscribe, finish — without launching a browser or touching
   * eBay. Production never passes it.
   */
  sourceFactory?: () => Promise<PageSource>
}

/** Emits every event for a run as it is appended. */
const bus = new EventEmitter()
bus.setMaxListeners(100)

let active: { runId: number; cancelled: boolean } | null = null

export function activeRunId(): number | null {
  return active?.runId ?? null
}

export function isRunning(): boolean {
  return active !== null
}

export function cancelRun(runId: number): boolean {
  if (active?.runId !== runId) return false
  active.cancelled = true
  return true
}

export function subscribe(runId: number, cb: (e: RunEvent) => void): () => void {
  const handler = (e: RunEvent) => cb(e)
  bus.on(`run:${runId}`, handler)
  return () => bus.off(`run:${runId}`, handler)
}

function emit(db: SqliteDatabase, runId: number, type: Parameters<typeof appendEvent>[2], payload: unknown) {
  const event = appendEvent(db, runId, type, payload)
  bus.emit(`run:${runId}`, event)
  return event
}

/**
 * Starts a run in the background and returns its id immediately.
 *
 * Only one run at a time: a second concurrent run would fight over the same
 * browser profile and double the JEV spend for no benefit to a single user.
 */
export function startRun(db: SqliteDatabase, o: StartRunOptions): number {
  if (active) {
    throw new Error(`A run is already in progress (run ${active.runId}). Wait for it to finish.`)
  }

  const search = getSearch(db, o.searchId)
  if (!search) throw new Error(`No search with id ${o.searchId}`)

  const settings: RunSettings = { ...DEFAULTS, ...(o.settings ?? {}), ...(search.settings as Partial<RunSettings>) }
  const run = createRun(db, search.id, settings as unknown as Record<string, unknown>)
  active = { runId: run.id, cancelled: false }

  emit(db, run.id, 'run.started', {
    runId: run.id,
    searchId: search.id,
    keyword: search.keyword,
    settings,
  })

  // Fire and forget: the HTTP handler returns immediately, progress arrives by SSE.
  void (async () => {
    let context: Awaited<ReturnType<typeof launchBrowser>> | null = null
    try {
      let source: PageSource
      if (o.sourceFactory) {
        source = await o.sourceFactory()
      } else {
        context = await launchBrowser({
          profileDir: o.profileDir ?? 'data/browser-profile',
          headed: settings.headed,
        })
        const page = context.pages()[0] ?? (await context.newPage())
        source = playwrightPageSource(page)
      }

      const maxPrice = typeof search.spec?.max_price === 'number' ? search.spec.max_price : undefined
      const minPrice = typeof search.spec?.min_price === 'number' ? search.spec.min_price : undefined

      const outcome = await executeRun({
        db,
        runId: run.id,
        keyword: search.keyword,
        settings,
        source,
        minPrice,
        maxPrice,
        screenshotsDir: o.screenshotsDir ?? 'data/screenshots',
        isCancelled: () => active?.cancelled ?? true,
        // Without this the run writes events to SQLite but live viewers see
        // nothing until they reconnect. The pipeline must publish as it goes.
        publish: (event) => bus.emit(`run:${run.id}`, event),
      })
      void outcome
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit(db, run.id, 'error', { reason: 'launch_failed', message })
      finishRun(db, run.id, { status: 'failed', error: message })
    } finally {
      await context?.close().catch(() => {})
      active = null
    }
  })()

  return run.id
}

/** Everything a freshly attached browser needs to draw the current run. */
export function runSnapshot(db: SqliteDatabase, runId: number) {
  const run = getRun(db, runId)
  if (!run) return null
  return {
    run,
    events: listEvents(db, runId),
    listings: listListings(db, runId),
  }
}
