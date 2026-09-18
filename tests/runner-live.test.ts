import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/storage/db'
import { createSearch } from '../src/storage/searches'
import { listEvents } from '../src/storage/events'
import { getRun } from '../src/storage/runs'
import { startRun, subscribe, isRunning } from '../src/pipeline/runner'
import type { PageSource } from '../src/scraper/browser'
import type { RawCard } from '../src/scraper/cards'

function card(itemId: string): RawCard {
  return {
    itemId,
    title: `Lenovo ThinkPad T14s Gen 6 ${itemId}`,
    url: `https://www.ebay.com/itm/${itemId}`,
    price: 1200,
    shipping: 0,
    currency: 'USD',
    conditionLabel: 'Brand New',
    sellerName: 'store',
    sellerFeedback: '99% positive (1K)',
    watchers: 2,
    buyingFormat: 'Buy It Now',
    sponsoredMarker: false,
    rawText: ['$1,200.00'],
  }
}

/** No browser, no network, no eBay. */
function fakeSource(): PageSource {
  let served = 0
  return {
    async goto() {
      return { status: 200 }
    },
    async title() {
      return 'ThinkPad T14s Gen 6 for sale | eBay'
    },
    async readCards() {
      served++
      return served === 1 ? [card('111111111'), card('222222222')] : []
    },
    async screenshot() {},
    async close() {},
  }
}

/** Waits until the background run has released the single-run lock. */
async function waitForIdle(timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  while (isRunning() && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('startRun live path', () => {
  it('delivers events to a live subscriber as the run progresses', async () => {
    const db = openDatabase(':memory:')
    const search = createSearch(db, { name: 't', keyword: 'thinkpad', criteriaText: '' })

    const received: string[] = []
    const runId = startRun(db, {
      searchId: search.id,
      settings: { maxPages: 1, pacingMinMs: 1, pacingMaxMs: 2 },
      sourceFactory: async () => fakeSource(),
    })

    // Subscribe exactly as the SSE route does, but immediately — this is the
    // live path. The old bug produced zero events here while the database
    // filled up normally.
    const unsubscribe = subscribe(runId, (e) => received.push(e.type))
    await waitForIdle()
    unsubscribe()

    expect(received).toContain('page.fetched')
    expect(received).toContain('cards.extracted')
    expect(received).toContain('run.finished')
    expect(getRun(db, runId)?.status).toBe('complete')
  })

  it('replay plus live delivery covers every event exactly once', async () => {
    // This is the guarantee the SSE route makes: a browser that attaches late
    // gets the stored events replayed, then live events from that point on,
    // with no gap and no duplicate. A subscriber that attaches mid-run alone
    // would miss run.started — which is why replay exists.
    const db = openDatabase(':memory:')
    const search = createSearch(db, { name: 't', keyword: 'thinkpad', criteriaText: '' })

    const runId = startRun(db, {
      searchId: search.id,
      settings: { maxPages: 1, pacingMinMs: 120, pacingMaxMs: 160 },
      sourceFactory: async () => fakeSource(),
    })

    // Attach while the run is still going, exactly as a late browser would.
    await new Promise((r) => setTimeout(r, 90))
    const replayed = listEvents(db, runId).map((e) => e.seq)
    const live: number[] = []
    const unsubscribe = subscribe(runId, (e) => live.push(e.seq))
    await waitForIdle()
    unsubscribe()

    const delivered = [...replayed, ...live]
    const stored = listEvents(db, runId).map((e) => e.seq)

    expect(delivered).toEqual(stored)
    expect(new Set(delivered).size).toBe(delivered.length) // no duplicates
    expect(replayed.length).toBeGreaterThan(0) // replay actually had work to do
  })

  it('refuses a second concurrent run rather than fighting over the browser profile', async () => {
    const db = openDatabase(':memory:')
    const search = createSearch(db, { name: 't', keyword: 'thinkpad', criteriaText: '' })

    startRun(db, {
      searchId: search.id,
      settings: { maxPages: 1, pacingMinMs: 400, pacingMaxMs: 500 },
      sourceFactory: async () => fakeSource(),
    })

    expect(() => startRun(db, { searchId: search.id })).toThrowError(/already in progress/)
    await waitForIdle()
  })
})
