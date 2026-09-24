import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { openDatabase } from '../src/storage/db'
import { createSearch } from '../src/storage/searches'
import { createRun, getRun } from '../src/storage/runs'
import { listEvents } from '../src/storage/events'
import { listListings } from '../src/storage/listings'
import { executeRun } from '../src/pipeline/run'
import { createPause, type PauseDetail } from '../src/pipeline/pause'
import { updateRunStatus } from '../src/storage/runs'
import { appendEvent } from '../src/storage/events'
import { cardCount } from '../src/scraper/cards'
import type { PageSource } from '../src/scraper/browser'
import type { RawCard } from '../src/scraper/cards'
import { DEFAULTS, type RunSettings } from '../src/shared/config'

/**
 * Every row of the spec's §11 table, triggered on purpose (spec §11, and the
 * stage's acceptance: an event, a screenshot where relevant, and never a silent
 * empty result).
 *
 * The tests that matter most are the ones where a broken scraper and a search
 * with no matches would otherwise look identical: that is the failure §11 calls
 * the one that matters most.
 */

const settings: RunSettings = { ...DEFAULTS, maxPages: 3, pacingMinMs: 1, pacingMaxMs: 2 }

const card = (itemId: string): RawCard => ({
  itemId,
  title: `Lenovo ThinkPad T14s Gen 6 32GB ${itemId}`,
  url: `https://www.ebay.com/itm/${itemId}`,
  price: 1200,
  shipping: 0,
  currency: 'USD',
  conditionLabel: 'Open Box',
  sellerName: 'store',
  sellerFeedback: '100% positive (450)',
  watchers: null,
  buyingFormat: 'Buy It Now',
  sponsoredMarker: false,
  rawText: [],
})

/**
 * A source whose page 2 is a challenge **once**: the first attempt gets a 503
 * with a challenge title, the second — after the run is resumed — serves the page
 * normally. One resume is enough, which is what makes it a usable test.
 */
function challengingSource() {
  const state = { page: 1, challengesServed: 0, closed: false, screenshots: [] as string[] }
  const source: PageSource = {
    async goto(url: string) {
      if (url.includes('_pgn=2')) {
        state.page = 2
        if (state.challengesServed === 0) {
          state.challengesServed++
          return { status: 503 }
        }
        return { status: 200 }
      }
      state.page = 1
      return { status: 200 }
    },
    async title() {
      return state.page === 2 && state.challengesServed === 1
        ? 'Pardon Our Interruption'
        : 'ThinkPad T14s Gen 6 for sale | eBay'
    },
    async readCards() {
      return state.page === 1 ? [card('111111111')] : [card('222222222')]
    },
    async readListing() {
      return {
        title: 'Lenovo ThinkPad T14s Gen 6',
        price: 1200,
        shipping: 0,
        condition: 'Open Box',
        sellerName: 'store',
        sellerFeedback: '100% positive (450)',
        specifics: { Brand: 'Lenovo' },
        rawText: [],
      }
    },
    async screenshot(path: string) {
      state.screenshots.push(path)
    },
    async close() {
      state.closed = true
    },
  }
  return { state, source }
}

/**
 * The same two pages with no challenge on either — including no 503, because the
 * pipeline treats a 503 as a challenge whatever the title says. For tests about
 * something else.
 */
function plainSource() {
  const { state, source } = challengingSource()
  const plain: PageSource = {
    ...source,
    async goto(url: string) {
      state.page = url.includes('_pgn=2') ? 2 : 1
      return { status: 200 }
    },
    async title() {
      return 'ThinkPad T14s Gen 6 for sale | eBay'
    },
  }
  return { state, source: plain }
}

function setup() {
  const db = openDatabase(':memory:')
  const search = createSearch(db, { name: 'h', keyword: 'thinkpad', criteriaText: '', spec: {} })
  const run = createRun(db, search.id, {})
  return { db, runId: run.id }
}

describe('a bot challenge', () => {
  it('pauses the run, keeps what it has, and finishes after a resume', async () => {
    const { db, runId } = setup()
    const { state, source } = challengingSource()
    // The real signal, as the runner builds it: the pause must write its event
    // and its status, not only hold the pipeline.
    const signal = createPause({
      db,
      runId,
      setStatus: (status) => updateRunStatus(db, runId, status),
      emit: (type, payload) => appendEvent(db, runId, type, payload),
    })
    const pauses: PauseDetail[] = []
    let resumeScheduled = false

    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source,
      publish: () => {},
      screenshotsDir: 'data/screenshots',
      pause: (detail) => {
        pauses.push(detail)
        const waiting = signal.wait(detail)
        if (!resumeScheduled) {
          resumeScheduled = true
          // "Someone clicks Resume" — which is what the route does.
          setTimeout(() => signal.resume(), 10)
        }
        return waiting
      },
    })

    expect(pauses.map((p) => p.reason)).toEqual(['bot_challenge'])
    expect(pauses[0]?.page).toBe(2)
    expect(pauses[0]?.screenshot).toBeTruthy()
    expect(outcome.status).toBe('complete')
    // Both pages' listings are there: waiting lost nothing.
    expect(listListings(db, runId)).toHaveLength(2)
    expect(state.screenshots.some((p) => p.includes('page2-503'))).toBe(true)
    const paused = listEvents(db, runId).find((e) => e.type === 'run.paused')
    expect(paused?.payload).toMatchObject({ reason: 'bot_challenge', page: 2, status: 503 })
    expect(listEvents(db, runId).map((e) => e.type)).toContain('run.resumed')
  })

  it('fails the run when there is nothing to pause it with', async () => {
    // No `pause` handler: retrying the same page would fetch it forever, so the
    // loud failure this stage replaced is still the right answer for callers
    // that cannot wait.
    const { db, runId } = setup()
    const { source } = challengingSource()
    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source,
      publish: () => {},
      screenshotsDir: 'data/screenshots',
    })

    expect(outcome.status).toBe('failed')
    expect(getRun(db, runId)?.error).toMatch(/bot challenge/i)
  })

  it('does not pause on a 404 past the last page', async () => {
    // A 404 is how a run past its last page ends. Pausing on it would hang every
    // run that reaches its page cap.
    const { db, runId } = setup()
    const { source } = challengingSource()
    const paging: PageSource = {
      ...source,
      async goto(url: string) {
        return url.includes('_pgn=2') ? { status: 404 } : { status: 200 }
      },
    }
    let pausedAtAll = false
    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source: paging,
      publish: () => {},
      screenshotsDir: 'data/screenshots',
      pause: async () => {
        pausedAtAll = true
      },
    })

    expect(pausedAtAll).toBe(false)
    expect(outcome.status).toBe('complete')
    // The listings from page 1 are kept, and the end of the results is an event
    // rather than a failure.
    expect(listListings(db, runId).length).toBeGreaterThan(0)
    const progress = listEvents(db, runId).filter((e) => e.type === 'run.progress')
    expect(JSON.stringify(progress.map((e) => e.payload))).toContain('no more result pages')
  })

  it('still fails on a 404 on the first page, which is a search URL that is wrong', async () => {
    const { db, runId } = setup()
    const { source } = challengingSource()
    const noFirstPage: PageSource = { ...source, async goto() { return { status: 404 } } }
    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source: noFirstPage,
      publish: () => {},
      screenshotsDir: 'data/screenshots',
      pause: async () => {
        throw new Error('a 404 must never pause')
      },
    })
    expect(outcome.status).toBe('failed')
    expect(getRun(db, runId)?.error).toMatch(/HTTP 404 on page 1/)
  })

  it('pauses again when the challenge repeats, so a person decides each time', async () => {
    const { db, runId } = setup()
    const { source } = challengingSource()
    const always: PageSource = {
      ...source,
      async goto(url: string) {
        return url.includes('_pgn=2') ? { status: 503 } : { status: 200 }
      },
      async title() {
        return 'Pardon Our Interruption'
      },
    }
    const pauses: number[] = []
    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source: always,
      publish: () => {},
      screenshotsDir: 'data/screenshots',
      pause: async () => {
        pauses.push(1)
        // Two challenge attempts, then let it through so the test ends.
        if (pauses.length >= 2) throw new Error('give up')
      },
    })

    expect(pauses).toHaveLength(2)
    expect(outcome.status).toBe('failed')
    expect(getRun(db, runId)?.error).toMatch(/give up/)
  })
})

describe('a layout change', () => {
  it('fails the run when the card selector matches nothing, with a screenshot', async () => {
    // What `extractCards` does with the broken fixture: it throws that exact
    // error rather than returning [], because an empty list would be reported as
    // "no results" — the failure §11 calls the one that matters most.
    const { db, runId } = setup()
    const { state, source } = challengingSource()
    const broken: PageSource = {
      ...source,
      async readCards() {
        throw new Error(
          'No .s-card elements found on the results page. eBay markup may have changed, ' +
            'or the page did not load. Refusing to report this as "no results".',
        )
      },
    }

    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source: broken,
      publish: () => {},
      screenshotsDir: 'data/screenshots',
    })

    expect(outcome.status).toBe('failed')
    expect(getRun(db, runId)?.error).toMatch(/markup may have changed/)
    const error = listEvents(db, runId).find((e) => e.type === 'error')
    expect(error?.payload).toMatchObject({ reason: 'extraction_failed' })
    expect(state.screenshots.some((p) => p.includes('nolayout'))).toBe(true)
    expect(listListings(db, runId)).toHaveLength(0)
  })

  it('fails the run when the page yields no listings at all', async () => {
    const { db, runId } = setup()
    const { source } = challengingSource()
    const empty: PageSource = { ...source, async readCards() { return [] } }

    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source: empty,
      publish: () => {},
      screenshotsDir: 'data/screenshots',
    })

    expect(outcome.status).toBe('failed')
    expect(getRun(db, runId)?.error).toMatch(/no readable listings/i)
    expect(listEvents(db, runId).find((e) => e.type === 'error')?.payload).toMatchObject({
      reason: 'no_cards_on_page',
    })
  })

  it('detects a markup change from the fixture pair, with no browser', () => {
    // The deliberate markup-change detector (§13). If eBay's markup moves and the
    // fixtures are refreshed carelessly, this pair stops being one broken and one
    // whole — which is the moment to look at them.
    const real = cardCount(readFileSync('tests/fixtures/ebay/srp-results.html', 'utf8'))
    const broken = cardCount(readFileSync('tests/fixtures/ebay/srp-broken.html', 'utf8'))
    expect(real).toBe(60)
    expect(broken).toBe(0)
  })
})

describe('a JEV outage', () => {
  const request = {
    keyword: 'thinkpad',
    criteria_text: '',
    spec: {},
    max_price: undefined,
    accepted_conditions: ['Open Box'],
  }

  const overloadedClient = (failures: number) => {
    let calls = 0
    return {
      calls: () => calls,
      async systemOne(req: { questions: Record<string, unknown> }) {
        calls++
        if (calls <= failures) {
          const err = new Error('429 rate limited') as Error & { status: number }
          err.status = 429
          throw err
        }
        return {
          model: 'fake',
          answers: Object.fromEntries(
            Object.keys(req.questions).map((key) => [key, { type: 'noul' as const, noul: 0.9 }]),
          ),
          usage: { input_tokens: 0, output_tokens: 0 },
        }
      },
    }
  }

  it('pauses on an overloaded service, then judges the batch on resume', async () => {
    const { db, runId } = setup()
    const { source } = plainSource()
    const client = overloadedClient(2)
    const signal = createPause({
      db,
      runId,
      setStatus: (status) => updateRunStatus(db, runId, status),
      emit: (type, payload) => appendEvent(db, runId, type, payload),
    })
    const pauses: PauseDetail[] = []

    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source,
      judge: { client: client as never, batchSize: 10, request },
      publish: () => {},
      screenshotsDir: 'data/screenshots',
      pause: (detail) => {
        pauses.push(detail)
        const waiting = signal.wait(detail)
        setTimeout(() => signal.resume(), 5)
        return waiting
      },
    })

    expect(pauses.map((p) => p.reason)).toEqual(['jev_outage', 'jev_outage'])
    expect(pauses[0]?.batch).toBe(1)
    expect(outcome.status).toBe('complete')
    expect(outcome.judged).toBe(2)
    const paused = listEvents(db, runId).find((e) => e.type === 'run.paused')
    expect(paused?.payload).toMatchObject({ reason: 'jev_outage' })
  })

  it('fails loudly on a 401, which is a bad key and not an outage', async () => {
    const { db, runId } = setup()
    const { source } = plainSource()
    const badKey = {
      async systemOne() {
        const err = new Error('401 unauthorized') as Error & { status: number }
        err.status = 401
        throw err
      },
    }
    let paused = false
    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source,
      judge: { client: badKey as never, batchSize: 10, request },
      publish: () => {},
      screenshotsDir: 'data/screenshots',
      pause: async () => {
        paused = true
      },
    })

    expect(paused).toBe(false)
    expect(outcome.status).toBe('failed')
    expect(getRun(db, runId)?.error).toMatch(/401/)
  })
})

describe('the pace a run was configured with', () => {
  it('paces with the run’s own settings, not with the defaults', async () => {
    // Found while writing this file: `sleep` ignored `settings.pacingMinMs` and
    // paced at the 1.5–3s defaults, so a search asking for a slower or faster
    // pace got neither — and pacing is the anti-403 mitigation (spec §9.2).
    const { db, runId } = setup()
    const { source } = plainSource()
    const started = Date.now()
    await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings: { ...settings, pacingMinMs: 30, pacingMaxMs: 35, maxPages: 2 },
      source,
      publish: () => {},
      screenshotsDir: 'data/screenshots',
    })
    const elapsed = Date.now() - started

    // Two page loads and two detail visits at ~30ms is well under 500ms; at the
    // defaults the same run takes six seconds or more.
    expect(elapsed).toBeLessThan(2000)
  })
})

describe('a browser crash', () => {
  it('fails the run and leaves everything already stored readable', async () => {
    const { db, runId } = setup()
    const { source } = challengingSource()
    let calls = 0
    const crashing: PageSource = {
      ...source,
      async goto() {
        calls++
        if (calls > 1) throw new Error('Target page, context or browser has been closed')
        return { status: 200 }
      },
    }

    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source: crashing,
      publish: () => {},
      screenshotsDir: 'data/screenshots',
    })

    expect(outcome.status).toBe('failed')
    expect(getRun(db, runId)?.error).toMatch(/has been closed/)
    expect(listListings(db, runId).length).toBeGreaterThan(0)
  })
})

describe('a cancel while paused', () => {
  it('ends as cancelled and keeps the partial results', async () => {
    const { db, runId } = setup()
    const { source } = challengingSource()
    let cancelled = false

    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source,
      publish: () => {},
      screenshotsDir: 'data/screenshots',
      isCancelled: () => cancelled,
      pause: async () => {
        // The person chose Cancel instead of Resume.
        cancelled = true
      },
    })

    expect(outcome.status).toBe('cancelled')
    expect(listListings(db, runId).length).toBeGreaterThan(0)
  })
})
