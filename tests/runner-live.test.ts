import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/storage/db'
import { createSearch } from '../src/storage/searches'
import { listEvents } from '../src/storage/events'
import { getRun } from '../src/storage/runs'
import { startRun, subscribe, isRunning, isPaused, cancelRun } from '../src/pipeline/runner'
import type { PageSource } from '../src/scraper/browser'
import type { JevAnswer, JevClient, JevRequest, JevResult } from '../src/jev/client'
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

/** Answers any question asked, so a live-path run behaves like a real one. */
function fakeJevClient(): JevClient {
  return {
    async systemOne(req: JevRequest): Promise<JevResult> {
      const answers: Record<string, JevAnswer> = {}
      for (const key of Object.keys(req.questions)) {
        answers[key] = { type: 'noul', noul: 0.9 }
      }
      return { model: 'fake', answers, usage: { input_tokens: 0, output_tokens: 0 } }
    },
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
    async readListing() {
      return {
        title: 'Lenovo ThinkPad T14s Gen 6 32GB RAM 1TB SSD',
        price: 1200,
        shipping: 0,
        condition: 'Open Box',
        sellerName: 'store',
        sellerFeedback: '99% positive',
        specifics: { Brand: 'Lenovo', 'RAM Size': '32 GB' },
        rawText: ['Brand Lenovo'],
      }
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
      // Detail visits off: this test is about live delivery, and a real visit
      // would pace for seconds per listing. The phase has its own tests.
      settings: { maxPages: 1, pacingMinMs: 1, pacingMaxMs: 2, maxDetailVisits: 0 },
      sourceFactory: async () => fakeSource(),
      // Judging is part of a run now, and the real client needs an API key, so
      // the live-path tests inject a client the same way they inject a source.
      judgeClientFactory: fakeJevClient,
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
      settings: { maxPages: 1, pacingMinMs: 120, pacingMaxMs: 160, maxDetailVisits: 0 },
      sourceFactory: async () => fakeSource(),
      // Judging is part of a run now, and the real client needs an API key, so
      // the live-path tests inject a client the same way they inject a source.
      judgeClientFactory: fakeJevClient,
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
      settings: { maxPages: 1, pacingMinMs: 400, pacingMaxMs: 500, maxDetailVisits: 0 },
      sourceFactory: async () => fakeSource(),
      // Judging is part of a run now, and the real client needs an API key, so
      // the live-path tests inject a client the same way they inject a source.
      judgeClientFactory: fakeJevClient,
    })

    expect(() => startRun(db, { searchId: search.id })).toThrowError(/already in progress/)
    await waitForIdle()
  })

  it('ends a run cancelled just before the challenge asked it to wait', { timeout: 15000 }, async () => {
    // The window this pins: the Cancel click lands after the page loop's own
    // `isCancelled()` check and before the challenge arm calls `pause`. The
    // release `cancelRun` sends arrives when nothing is waiting yet, so if the
    // wait is installed anyway nothing will ever release it — the run stays
    // `paused` and holds the one-job lock. The cancel has to win, because that
    // is what the person asked for.
    const db = openDatabase(':memory:')
    const search = createSearch(db, { name: 't', keyword: 'thinkpad', criteriaText: '' })
    let runId = 0
    let cancelledOnPage2 = false

    const challenging: PageSource = {
      async goto(url) {
        if (url.includes('_pgn=2')) {
          cancelledOnPage2 = true
          // Exactly the race: cancelled by the click, not by the pipeline.
          cancelRun(runId)
          return { status: 503 }
        }
        return { status: 200 }
      },
      async title() {
        return 'Pardon Our Interruption'
      },
      async readCards() {
        return [card('111111111')]
      },
      async readListing() {
        return {
          title: 'Lenovo ThinkPad T14s Gen 6',
          price: 1200,
          shipping: 0,
          condition: 'Open Box',
          sellerName: 'store',
          sellerFeedback: '99% positive',
          specifics: {},
          rawText: [],
        }
      },
      async screenshot() {},
      async close() {},
    }

    runId = startRun(db, {
      searchId: search.id,
      settings: { maxPages: 3, pacingMinMs: 1, pacingMaxMs: 2, maxDetailVisits: 0 },
      sourceFactory: async () => challenging,
      judgeClientFactory: fakeJevClient,
    })

    // Short: a cancelled run ends in milliseconds. Waiting longer only hides
    // the bug behind the clock.
    await waitForIdle(3000)
    expect(cancelledOnPage2).toBe(true)
    expect(getRun(db, runId)?.status).toBe('cancelled')
    expect(isRunning()).toBe(false)
  })

  it('wakes a run that is already waiting when it is cancelled', async () => {
    // The other ordering: the run is genuinely paused, then the Cancel click
    // arrives. This is the direction `cancelRun`'s release call exists for — the
    // wait resolves on a cancel as well as a resume, or a cancelled run would
    // hold the one-job lock forever (spec decision 4).
    const db = openDatabase(':memory:')
    const search = createSearch(db, { name: 't', keyword: 'thinkpad', criteriaText: '' })

    const challenging: PageSource = {
      async goto(url) {
        return url.includes('_pgn=2') ? { status: 503 } : { status: 200 }
      },
      async title() {
        return 'Pardon Our Interruption'
      },
      async readCards() {
        return [card('111111111')]
      },
      async readListing() {
        return {
          title: 'Lenovo ThinkPad T14s Gen 6',
          price: 1200,
          shipping: 0,
          condition: 'Open Box',
          sellerName: 'store',
          sellerFeedback: '99% positive',
          specifics: {},
          rawText: [],
        }
      },
      async screenshot() {},
      async close() {},
    }

    const runId = startRun(db, {
      searchId: search.id,
      settings: { maxPages: 3, pacingMinMs: 1, pacingMaxMs: 2, maxDetailVisits: 0 },
      sourceFactory: async () => challenging,
      judgeClientFactory: fakeJevClient,
    })

    // Wait for the run to actually be waiting before cancelling it.
    const started = Date.now()
    while (!isPaused() && Date.now() - started < 3000) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(isPaused()).toBe(true)
    expect(getRun(db, runId)?.status).toBe('paused')

    // A paused run keeps the one-job lock: its visible browser holds the
    // persistent profile, so a second run would be two Chromium profiles on one
    // directory (spec decision 3).
    expect(() => startRun(db, { searchId: search.id })).toThrowError(/already in progress/)

    expect(cancelRun(runId)).toBe(true)
    await waitForIdle(3000)
    expect(getRun(db, runId)?.status).toBe('cancelled')
    expect(isPaused()).toBe(false)
    expect(isRunning()).toBe(false)
  })
})
