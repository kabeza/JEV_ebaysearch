import type { Database as SqliteDatabase } from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildSearchUrl } from '../scraper/url'
import { pace, type PageSource } from '../scraper/browser'
import type { RawCard } from '../scraper/cards'
import {
  insertCards,
  listSurvivors,
  updateListingDetail,
  updateListingStage,
  type StoredListing,
} from '../storage/listings'
import { appendEvent, type RunEvent } from '../storage/events'
import { finishRun, updateRunStats, type RunStatus } from '../storage/runs'
import { prefilter, type Requirements } from './prefilter'
import { judgeSurvivors } from './judge'
import type { PauseDetail } from './pause'
import type { JevClient } from '../jev/client'
import type { SearchRequest } from '../jev/questions'
import type { RunSettings } from '../shared/config'

export interface ExecuteRunOptions {
  db: SqliteDatabase
  runId: number
  keyword: string
  settings: RunSettings
  source: PageSource
  /**
   * What the search asked for. Every card is judged against these the moment it
   * is stored, and only survivors are worth a listing-page visit and a JEV call.
   * Omitted means nothing can be contradicted, so every card survives.
   */
  requirements?: Requirements
  /**
   * JEV judging, run after the survivors' pages have been read. Omitted means
   * the run scrapes and stores but asks nothing.
   */
  judge?: { client: JevClient; batchSize: number; request: SearchRequest }
  minPrice?: number
  maxPrice?: number
  /** Directory for failure screenshots. */
  screenshotsDir?: string
  /** Return true to stop the run. Checked between pages and between batches. */
  isCancelled?: () => boolean
  /**
   * Called when the run cannot make progress without a person: a bot challenge,
   * or a JEV outage the SDK's retries did not survive. It emits the event, sets
   * the status, and **resolves when the run should continue** — with
   * `isCancelled()` true if the person chose to stop instead.
   *
   * Absent, a challenge still fails the run as it always has: a retry with
   * nothing to wait on would fetch the same page forever.
   */
  pause?: (detail: PauseDetail) => Promise<void>
  /**
   * Called with every event after it has been persisted, so live subscribers
   * (the SSE stream) see progress as it happens. Without this the events reach
   * SQLite and the replay works, but a browser watching the run live sees
   * nothing until it reconnects — which is exactly the bug this parameter
   * exists to prevent.
   */
  publish?: (event: RunEvent) => void
  /** Injected so tests can control the clock. */
  now?: () => number
  /** Injected so tests do not actually wait. */
  sleep?: (ms?: number) => Promise<void>
}

export interface RunOutcome {
  status: RunStatus
  pagesFetched: number
  cardsSeen: number
  listingsStored: number
  /** Stored, but stopped by the pre-filter before they could reach JEV. */
  rejected: number
  /** Survivors whose listing page was opened and read. */
  detailsFetched: number
  /** Survivors whose page would not read; they still reach JEV on card data. */
  detailsFailed: number
  /** Survivors that got answers from JEV. */
  judged: number
  /** Answers JEV did not return, reported rather than glossed over. */
  judgmentsMissing: number
  jevInputTokens: number
  costUsd: number
}

/**
 * How many listing pages must fail in a row before it stops looking like unlucky
 * listings and starts looking like eBay having changed its markup.
 */
const CONSECUTIVE_DETAIL_FAILURES_TO_ABORT = 3

/** Text eBay shows when it is refusing or challenging a request. */
const CHALLENGE_MARKERS = [
  'Pardon our interruption',
  'Verify yourself',
  'are you a human',
  'Error Page',
  'Something went wrong on our end',
]

function looksLikeChallenge(title: string): boolean {
  return CHALLENGE_MARKERS.some((m) => title.toLowerCase().includes(m.toLowerCase()))
}

/**
 * Stamps every stored card with its pre-filter verdict — rejected or survivor —
 * and reports what happened, so the UI and the event log can show the filter
 * working rather than silently dropping rows.
 */
function applyPrefilter(
  db: SqliteDatabase,
  idsByItemId: Map<string, number>,
  cards: RawCard[],
  requirements: Requirements,
): { rejected: number; survivors: number; reasons: { title: string; reason: string }[] } {
  let rejected = 0
  let survivors = 0
  const reasons: { title: string; reason: string }[] = []

  for (const card of cards) {
    const id = idsByItemId.get(card.itemId)
    if (id === undefined) continue
    const decision = prefilter(card, requirements)
    updateListingStage(db, id, decision.stage, decision.reason)
    if (decision.stage === 'rejected') {
      rejected++
      // Enough to see what the filter is doing, without shipping every title.
      if (reasons.length < 10) reasons.push({ title: card.title, reason: decision.reason })
    } else {
      survivors++
    }
  }

  return { rejected, survivors, reasons }
}

/**
 * Fetches the search results pages for a run, storing every card it sees.
 *
 * Deliberately loud on failure. An empty or unexpected page is the way a broken
 * scraper most often disguises itself as "no matches", so this throws, saves a
 * screenshot, and records the failure rather than finishing quietly.
 */
export async function executeRun(o: ExecuteRunOptions): Promise<RunOutcome> {
  const now = o.now ?? Date.now
  // The run's own pacing, not the defaults: a search that asks for a slower pace
  // means it, and pacing is the anti-403 mitigation (spec §9.2). Ignoring
  // `settings` here made every run as slow as the defaults allow and made the
  // setting decorative.
  const sleep = o.sleep ?? (() => pace(o.settings.pacingMinMs, o.settings.pacingMaxMs))
  const screenshotsDir = o.screenshotsDir ?? 'data/screenshots'

  const deadline = now() + o.settings.maxMinutes * 60_000
  let pagesFetched = 0
  let cardsSeen = 0
  let listingsStored = 0
  let rejected = 0
  let detailsFetched = 0
  let detailsFailed = 0
  let judged = 0
  let jevInputTokens = 0
  let costUsd = 0
  let judgmentsMissing = 0

  const emit = (type: Parameters<typeof appendEvent>[2], payload: unknown) => {
    const event = appendEvent(o.db, o.runId, type, payload)
    o.publish?.(event)
    return event
  }

  const stats = () => ({
    pagesFetched,
    cardsSeen,
    listingsStored,
    rejected,
    detailsFetched,
    detailsFailed,
    judged,
    jevInputTokens,
    costUsd,
    judgmentsMissing,
  })

  const progress = () => updateRunStats(o.db, o.runId, stats())

  const stopWith = (status: RunStatus, error?: string): RunOutcome => {
    finishRun(o.db, o.runId, { status, error: error ?? null, stats: stats() })
    emit(
      status === 'failed' ? 'run.failed' : status === 'cancelled' ? 'run.cancelled' : 'run.finished',
      { status, ...stats(), error: error ?? null },
    )
    return { status, ...stats() }
  }

  /**
   * Opens each survivor's listing page, in card order, up to the cap.
   *
   * One listing that will not read is bad luck and costs that listing only: it is
   * marked `detail_failed` and still reaches JEV on its card data. Several in a
   * row is not bad luck, it is eBay having changed its markup — that returns a
   * message and fails the run loudly, with a screenshot, rather than quietly
   * producing a run full of card-only listings.
   */
  const visitSurvivors = async (): Promise<string | null> => {
    if (o.settings.maxDetailVisits <= 0) return null

    const survivors = listSurvivors(o.db, o.runId, o.settings.maxDetailVisits)
    let consecutiveFailures = 0
    let lastReason = ''

    const fail = (listing: StoredListing, reason: string) => {
      detailsFailed++
      consecutiveFailures++
      lastReason = reason
      // The reason goes to the event log rather than the listing row: the row's
      // reject_reason means "the pre-filter stopped this one", which is a
      // different claim from "we could not read its page".
      updateListingStage(o.db, listing.id, 'detail_failed', null)
      emit('error', { reason: 'detail_failed', itemId: listing.itemId, message: reason })
    }

    for (const listing of survivors) {
      if (o.isCancelled?.()) return null
      if (now() >= deadline) {
        emit('run.progress', { note: 'time cap reached during listing visits', detailsFetched })
        return null
      }

      const res = await o.source.goto(listing.url)
      if (res.status !== 200) {
        fail(listing, `listing page returned HTTP ${res.status}`)
      } else {
        try {
          const detail = await o.source.readListing()
          updateListingDetail(o.db, listing.id, detail)
          detailsFetched++
          consecutiveFailures = 0
          emit('listing.visited', {
            itemId: listing.itemId,
            url: listing.url,
            specifics: Object.keys(detail.specifics).length,
          })
        } catch (err) {
          fail(listing, err instanceof Error ? err.message : String(err))
        }
      }

      progress()

      if (consecutiveFailures >= CONSECUTIVE_DETAIL_FAILURES_TO_ABORT) {
        mkdirSync(screenshotsDir, { recursive: true })
        const shotPath = join(screenshotsDir, `run${o.runId}-listing-nolayout.png`)
        await o.source.screenshot(shotPath).catch(() => {})
        return (
          `${consecutiveFailures} listing pages in a row could not be read ` +
          `(last: ${lastReason}). eBay's listing layout may have changed. Screenshot: ${shotPath}`
        )
      }

      await sleep()
    }

    return null
  }

  try {
    pages: for (let page = 1; page <= o.settings.maxPages; page++) {
      if (o.isCancelled?.()) return stopWith('cancelled')

      if (now() >= deadline) {
        emit('run.progress', { note: 'time cap reached', pagesFetched })
        break
      }

      const url = buildSearchUrl({
        keyword: o.keyword,
        zip: o.settings.zhomeZip,
        minPrice: o.minPrice,
        maxPrice: o.maxPrice,
        page,
      })

      let res: { status: number }
      // The same page, retried, when a challenge paused the run: `continue` here
      // cannot advance the outer loop, or the page that blocked us would be
      // skipped instead of retried.
      for (;;) {
        res = await o.source.goto(url)
        if (res.status === 200) break

        const title = await o.source.title().catch(() => '')
        mkdirSync(screenshotsDir, { recursive: true })
        const shotPath = join(screenshotsDir, `run${o.runId}-page${page}-${res.status}.png`)
        await o.source.screenshot(shotPath).catch(() => {})
        const message =
          `eBay returned HTTP ${res.status} on page ${page}` +
          (title ? ` (page title: "${title}")` : '') +
          (looksLikeChallenge(title) ? ' — looks like a bot challenge.' : '') +
          ` Screenshot: ${shotPath}`

        // A 404 past the first page is eBay saying "no such page" — the results
        // ended. Ending the run as `failed` there reported a normal end as an
        // error; stopping the paging and finishing keeps what was found.
        if (res.status === 404 && page > 1) {
          emit('run.progress', { page, note: 'no more result pages', status: 404 })
          break pages
        }

        // A 403 is a challenge even when the title says nothing: it is the status
        // eBay returned when it rate-limited a real run (rule 10). A 404 never
        // pauses — it is how a run past its last page ends, so waiting on it
        // would hang every run that reaches its page cap.
        const challenge = res.status === 403 || res.status === 503 || looksLikeChallenge(title)
        if (challenge && o.pause) {
          await o.pause({
            reason: 'bot_challenge',
            page,
            status: res.status,
            title,
            screenshot: shotPath,
            message,
          })
          // The wait ends on a resume **or** a cancel, so check which.
          if (o.isCancelled?.()) return stopWith('cancelled')
          emit('run.progress', { page, retrying: true, after: 'bot_challenge' })
          continue
        }

        emit('error', { page, status: res.status, title, screenshot: shotPath })
        return stopWith('failed', message)
      }

      let cards: RawCard[]
      try {
        cards = await o.source.readCards()
      } catch (err) {
        mkdirSync(screenshotsDir, { recursive: true })
        const shotPath = join(screenshotsDir, `run${o.runId}-page${page}-nolayout.png`)
        await o.source.screenshot(shotPath).catch(() => {})
        const message =
          `Could not read result cards on page ${page}: ` +
          (err instanceof Error ? err.message : String(err)) +
          ` Screenshot: ${shotPath}`
        emit('error', { page, reason: 'extraction_failed', screenshot: shotPath })
        return stopWith('failed', message)
      }

      pagesFetched++
      cardsSeen += cards.length
      const { idsByItemId, stored } = insertCards(o.db, o.runId, cards)
      listingsStored += stored

      const verdicts = applyPrefilter(o.db, idsByItemId, cards, o.requirements ?? {})
      rejected += verdicts.rejected

      emit('page.fetched', { page, url, returned: cards.length })
      emit('cards.extracted', { page, cards: cards.slice(0, 20) })
      emit('cards.filtered', {
        page,
        rejected: verdicts.rejected,
        survivors: verdicts.survivors,
        reasons: verdicts.reasons,
      })
      progress()

      // A page that parses to zero real listings means the layout moved under us.
      if (cards.length === 0) {
        emit('error', { page, reason: 'no_cards_on_page' })
        return stopWith('failed', `Page ${page} produced no readable listings — layout may have changed.`)
      }

      await sleep()
    }

    const detailFailure = await visitSurvivors()
    if (detailFailure) return stopWith('failed', detailFailure)

    if (o.judge) {
      const verdicts = await judgeSurvivors({
        db: o.db,
        runId: o.runId,
        request: o.judge.request,
        client: o.judge.client,
        batchSize: o.judge.batchSize,
        emit,
        isCancelled: o.isCancelled,
        pause: o.pause,
      })
      judged = verdicts.judged
      jevInputTokens = verdicts.inputTokens
      costUsd = verdicts.costUsd
      judgmentsMissing = verdicts.missingAnswers
      // Judging is the point of the run: without answers there is no report, so
      // stopping here must be visible rather than a run that quietly did less.
      if (verdicts.cancelled) return stopWith('cancelled')
      progress()
    }

    return stopWith('complete')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    emit('error', { reason: 'unhandled', message })
    return stopWith('failed', message)
  }
}
