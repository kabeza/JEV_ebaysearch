import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/storage/db'
import { createSearch } from '../src/storage/searches'
import { createRun, getRun } from '../src/storage/runs'
import { listEvents } from '../src/storage/events'
import { listListings, countListings } from '../src/storage/listings'
import { executeRun } from '../src/pipeline/run'
import { DEFAULTS } from '../src/shared/config'
import type { PageSource } from '../src/scraper/browser'
import type { RawCard } from '../src/scraper/cards'

function card(itemId: string, price: number): RawCard {
  return {
    itemId,
    title: `Lenovo ThinkPad T14s Gen 6 ${itemId}`,
    url: `https://www.ebay.com/itm/${itemId}`,
    price,
    shipping: 0,
    currency: 'USD',
    conditionLabel: 'Brand New',
    sellerName: 'someone',
    sellerFeedback: '99% positive (1K)',
    watchers: 3,
    buyingFormat: 'Buy It Now',
    sponsoredMarker: false,
    rawText: ['$' + price, 'Buy It Now'],
  }
}

/** A PageSource that serves canned pages, so no browser and no network. */
function fakeSource(
  pages: Array<RawCard[] | Error>,
  status = 200,
  pageTitle = 'ThinkPad T14s Gen 6 for sale | eBay',
): PageSource & { visited: string[]; screenshots: string[] } {
  let i = 0
  const visited: string[] = []
  const screenshots: string[] = []
  return {
    visited,
    screenshots,
    async goto(url: string) {
      visited.push(url)
      return { status }
    },
    async title() {
      return pageTitle
    },
    async readCards() {
      const next = pages[i++]
      if (next === undefined) return []
      if (next instanceof Error) throw next
      return next
    },
    async screenshot(path: string) {
      screenshots.push(path)
    },
    async close() {},
  }
}

const noSleep = async () => {}

function setup(settings = {}) {
  const db = openDatabase(':memory:')
  const search = createSearch(db, {
    name: 'test',
    keyword: 'Thinkpad T14s gen 6',
    criteriaText: '',
  })
  const run = createRun(db, search.id, settings)
  return { db, search, run }
}

describe('executeRun', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jevbrowser-test-'))
  })

  it('stores every card across pages and finishes complete', async () => {
    const { db, run } = setup()
    const source = fakeSource([[card('111111111', 100), card('222222222', 200)], [card('333333333', 300)]])

    const outcome = await executeRun({
      db,
      runId: run.id,
      keyword: 'Thinkpad T14s gen 6',
      settings: { ...DEFAULTS, maxPages: 2 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
    })

    expect(outcome.status).toBe('complete')
    expect(outcome.pagesFetched).toBe(2)
    expect(outcome.cardsSeen).toBe(3)
    expect(countListings(db, run.id)).toBe(3)
    expect(getRun(db, run.id)?.status).toBe('complete')
  })

  it('stops at the page cap', async () => {
    const { db, run } = setup()
    const source = fakeSource([Array.from({ length: 25 }, (_, i) => card(`10000000${i}`, 100))])

    const outcome = await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: { ...DEFAULTS, maxPages: 2 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
    })

    expect(outcome.pagesFetched).toBe(2)
    expect(source.visited).toHaveLength(2)
  })

  it('stops when the time cap is reached', async () => {
    const { db, run } = setup()
    const source = fakeSource([Array.from({ length: 10 }, (_, i) => card(`20000000${i}`, 100))])
    let clock = 0
    const outcome = await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: { ...DEFAULTS, maxPages: 10, maxMinutes: 1 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
      now: () => (clock += 61_000),
    })
    expect(outcome.status).toBe('complete')
    expect(outcome.pagesFetched).toBeLessThan(10)
  })

  it('will not store the same eBay item twice, even if a page repeats', async () => {
    const { db, run } = setup()
    const same = card('999999999', 100)
    const source = fakeSource([[same], [same]])

    await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: { ...DEFAULTS, maxPages: 2 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
    })

    expect(countListings(db, run.id)).toBe(1)
  })

  it('fails loudly with a screenshot when eBay returns a non-200', async () => {
    const { db, run } = setup()
    const source = fakeSource([[]], 403, 'Error Page | eBay')

    const outcome = await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: DEFAULTS,
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
    })

    expect(outcome.status).toBe('failed')
    expect(getRun(db, run.id)?.error).toContain('403')
    const events = listEvents(db, run.id)
    expect(events.some((e) => e.type === 'error')).toBe(true)
    // A 403 must leave evidence on disk, not just a log line.
    expect(source.screenshots).toEqual([join(tmp, `run${run.id}-page1-403.png`)])
    expect(getRun(db, run.id)?.error).toContain('bot challenge')
  })

  it('fails loudly when the cards cannot be read, rather than reporting no results', async () => {
    const { db, run } = setup()
    const source = fakeSource([new Error('No .s-card elements found')])

    const outcome = await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: DEFAULTS,
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
    })

    expect(outcome.status).toBe('failed')
    expect(getRun(db, run.id)?.error).toContain('Could not read result cards')
  })

  it('fails when a page yields no listings at all', async () => {
    const { db, run } = setup()
    const source = fakeSource([[]])

    const outcome = await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: DEFAULTS,
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
    })

    expect(outcome.status).toBe('failed')
    expect(getRun(db, run.id)?.error).toContain('no readable listings')
  })

  it('cancels between pages and keeps what it already stored', async () => {
    const { db, run } = setup()
    const source = fakeSource([[card('555555555', 100)], [card('666666666', 100)]])
    let cancelled = false

    const outcome = await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: { ...DEFAULTS, maxPages: 5 },
      source,
      sleep: async () => {
        cancelled = true
      },
      screenshotsDir: tmp,
      isCancelled: () => cancelled,
    })

    expect(outcome.status).toBe('cancelled')
    expect(countListings(db, run.id)).toBe(1)
    expect(getRun(db, run.id)?.status).toBe('cancelled')
  })

  it('records a replayable event log', async () => {
    const { db, run } = setup()
    const source = fakeSource([[card('777777777', 100)]])
    await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: { ...DEFAULTS, maxPages: 1 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
    })

    const types = listEvents(db, run.id).map((e) => e.type)
    expect(types).toContain('page.fetched')
    expect(types).toContain('cards.extracted')
    expect(types[types.length - 1]).toBe('run.finished')
  })

  it('asks eBay for the shipping ZIP, and never for a condition filter', async () => {
    const { db, run } = setup()
    const source = fakeSource([[]])
    await executeRun({
      db,
      runId: run.id,
      keyword: 'Thinkpad T14s gen 6',
      settings: { ...DEFAULTS, zhomeZip: '10001', maxPages: 1 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
      maxPrice: 1600,
    })
    expect(source.visited[0]).toContain('_stpos=10001')
    expect(source.visited[0]).toContain('_udhi=1600')
    expect(source.visited[0]).not.toContain('LH_ItemCondition')
  })

  it('publishes every event live, not just to the database', async () => {
    // Regression: executeRun used to write events only to SQLite, so a browser
    // watching a run live saw nothing until it reconnected and replayed.
    const { db, run } = setup()
    const source = fakeSource([[card('123123123', 100)]])
    const published: string[] = []

    await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: { ...DEFAULTS, maxPages: 1 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
      publish: (e) => published.push(e.type),
    })

    const stored = listEvents(db, run.id).map((e) => e.type)
    expect(published).toEqual(stored)
    expect(published).toContain('page.fetched')
    expect(published).toContain('cards.extracted')
    expect(published).toContain('run.finished')
  })

  it('publishes the failure path too, so a live viewer sees why it stopped', async () => {
    const { db, run } = setup()
    const source = fakeSource([[]], 403, 'Error Page | eBay')
    const published: string[] = []

    await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: DEFAULTS,
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
      publish: (e) => published.push(e.type),
    })

    expect(published).toContain('error')
    expect(published).toContain('run.failed')
    expect(published).toEqual(listEvents(db, run.id).map((e) => e.type))
  })

  it('stores listings read back with their fields intact', async () => {
    const { db, run } = setup()
    const source = fakeSource([[card('888888888', 1234.56)]])
    await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: { ...DEFAULTS, maxPages: 1 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
    })
    const [stored] = listListings(db, run.id)
    expect(stored?.itemId).toBe('888888888')
    expect(stored?.price).toBe(1234.56)
    expect(stored?.conditionLabel).toBe('Brand New')
    expect(stored?.stage).toBe('card_only')
  })
})
