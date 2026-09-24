import { EventEmitter } from 'node:events'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { launchBrowser, playwrightPageSource, type PageSource } from '../scraper/browser'
import { executeRun } from './run'
import { rejudgeRun } from './rejudge'
import { requirementsFromSpec } from './prefilter'
import { createJevClient, type JevClient } from '../jev/client'
import { DEFAULT_ACCEPTED_CONDITIONS, type SearchRequest } from '../jev/questions'
import { createRun, getRun, finishRun } from '../storage/runs'
import { nextQuestionnaireVersion } from '../storage/judgments'
import type { QuestionnaireDraft } from '../jev/draft'
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
  /**
   * Overrides the JEV client, for the same reason. Production leaves it unset
   * and the real client is built, which fails fast if the API key is missing.
   */
  judgeClientFactory?: () => JevClient
}

/** Emits every event for a run as it is appended. */
const bus = new EventEmitter()
bus.setMaxListeners(100)

/** The one job in flight, a run or a re-judge — they share the lock (rule 9). */
let active: { runId: number; cancelled: boolean; kind: 'run' | 'rejudge' } | null = null

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
  active = { runId: run.id, cancelled: false, kind: 'run' }

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

      // Built before the first page load on purpose: a missing or bad API key
      // should fail the run in the first second, not after it has spent page
      // loads on eBay gathering listings it can never judge.
      const judgeClient = (o.judgeClientFactory ?? createJevClient)()

      const judgeRequest: SearchRequest = {
        keyword: search.keyword,
        criteria_text: search.criteriaText,
        spec: search.spec ?? {},
        max_price: maxPrice,
        accepted_conditions: DEFAULT_ACCEPTED_CONDITIONS,
      }

      const outcome = await executeRun({
        db,
        runId: run.id,
        keyword: search.keyword,
        settings,
        source,
        requirements: requirementsFromSpec(search.spec ?? {}),
        judge: { client: judgeClient, batchSize: settings.batchSize, request: judgeRequest },
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

export interface StartRejudgeOptions {
  runId: number
  draft: QuestionnaireDraft
  batchSize?: number
  /**
   * Overrides the JEV client, exactly as `StartRunOptions.judgeClientFactory`
   * does: tests inject a fake, production builds the real one and fails fast
   * without an API key.
   */
  judgeClientFactory?: () => JevClient
}

/**
 * Re-judges a stored run in the background, under the same one-job-at-a-time
 * lock a run takes (spec §3 decision 6): one JEV client, one SQLite file, one
 * user. The client is built before the lock is taken, so a missing API key is a
 * refusal rather than a half-finished version.
 *
 * Returns the version number the route answers with; the questionnaire id does
 * not exist until the background job writes its row, and it arrives with the
 * `rejudge.started` event the caller is already subscribed to.
 */
export function startRejudge(db: SqliteDatabase, o: StartRejudgeOptions): { version: number } {
  if (active) {
    throw new Error(`A run is already in progress (run ${active.runId}). Wait for it to finish.`)
  }
  const stored = getRun(db, o.runId)
  if (!stored) throw new Error(`No run with id ${o.runId}`)

  const batchSize =
    o.batchSize ?? Number((stored.settings as { batchSize?: number }).batchSize ?? DEFAULTS.batchSize)
  const client = (o.judgeClientFactory ?? createJevClient)()
  const version = nextQuestionnaireVersion(db, o.runId)

  active = { runId: o.runId, cancelled: false, kind: 'rejudge' }
  // Set by the pipeline's own emit, so this does not double-report a failure.
  let emittedFailure = false

  // Fire and forget: the HTTP handler returns immediately, answers arrive by SSE.
  void (async () => {
    try {
      await rejudgeRun({
        db,
        runId: o.runId,
        draft: o.draft,
        client,
        batchSize,
        emit: (type, payload) => {
          if (type === 'rejudge.failed') emittedFailure = true
          emit(db, o.runId, type, payload)
        },
        isCancelled: () => active?.cancelled ?? true,
      })
    } catch (err) {
      // `rejudgeRun` publishes `rejudge.failed` itself, but anything that throws
      // before it gets that far — a run with nothing to judge, a request the
      // questions cannot be built from — would otherwise leave no trace at all.
      // Silence is a bug (rule 7), so the failure is recorded either way.
      if (!emittedFailure) {
        emit(db, o.runId, 'rejudge.failed', {
          message: err instanceof Error ? err.message : String(err),
        })
      }
    } finally {
      active = null
    }
  })()

  return { version }
}
