import type { Database as SqliteDatabase } from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildSearchUrl } from '../scraper/url'
import { pace, type PageSource } from '../scraper/browser'
import type { RawCard } from '../scraper/cards'
import { insertCards } from '../storage/listings'
import { appendEvent, type RunEvent } from '../storage/events'
import { finishRun, updateRunStats, type RunStatus } from '../storage/runs'
import type { RunSettings } from '../shared/config'

export interface ExecuteRunOptions {
  db: SqliteDatabase
  runId: number
  keyword: string
  settings: RunSettings
  source: PageSource
  minPrice?: number
  maxPrice?: number
  /** Directory for failure screenshots. */
  screenshotsDir?: string
  /** Return true to stop the run. Checked between pages. */
  isCancelled?: () => boolean
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
}

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
 * Fetches the search results pages for a run, storing every card it sees.
 *
 * Deliberately loud on failure. An empty or unexpected page is the way a broken
 * scraper most often disguises itself as "no matches", so this throws, saves a
 * screenshot, and records the failure rather than finishing quietly.
 */
export async function executeRun(o: ExecuteRunOptions): Promise<RunOutcome> {
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? pace
  const screenshotsDir = o.screenshotsDir ?? 'data/screenshots'

  const deadline = now() + o.settings.maxMinutes * 60_000
  let pagesFetched = 0
  let cardsSeen = 0
  let listingsStored = 0

  const emit = (type: Parameters<typeof appendEvent>[2], payload: unknown) => {
    const event = appendEvent(o.db, o.runId, type, payload)
    o.publish?.(event)
    return event
  }

  const progress = () => updateRunStats(o.db, o.runId, { pagesFetched, cardsSeen, listingsStored })

  const stopWith = (status: RunStatus, error?: string): RunOutcome => {
    finishRun(o.db, o.runId, {
      status,
      error: error ?? null,
      stats: { pagesFetched, cardsSeen, listingsStored },
    })
    emit(
      status === 'failed' ? 'run.failed' : status === 'cancelled' ? 'run.cancelled' : 'run.finished',
      { status, pagesFetched, cardsSeen, listingsStored, error: error ?? null },
    )
    return { status, pagesFetched, cardsSeen, listingsStored }
  }

  try {
    for (let page = 1; page <= o.settings.maxPages; page++) {
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

      const res = await o.source.goto(url)

      if (res.status !== 200) {
        const title = await o.source.title().catch(() => '')
        mkdirSync(screenshotsDir, { recursive: true })
        const shotPath = join(screenshotsDir, `run${o.runId}-page${page}-${res.status}.png`)
        await o.source.screenshot(shotPath).catch(() => {})
        const message =
          `eBay returned HTTP ${res.status} on page ${page}` +
          (title ? ` (page title: "${title}")` : '') +
          (looksLikeChallenge(title) ? ' — looks like a bot challenge.' : '') +
          ` Screenshot: ${shotPath}`
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
      const inserted = insertCards(o.db, o.runId, cards)
      listingsStored += inserted

      emit('page.fetched', { page, url, returned: cards.length })
      emit('cards.extracted', { page, cards: cards.slice(0, 20) })
      progress()

      // A page that parses to zero real listings means the layout moved under us.
      if (cards.length === 0) {
        emit('error', { page, reason: 'no_cards_on_page' })
        return stopWith('failed', `Page ${page} produced no readable listings — layout may have changed.`)
      }

      await sleep()
    }

    return stopWith('complete')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    emit('error', { reason: 'unhandled', message })
    return stopWith('failed', message)
  }
}
