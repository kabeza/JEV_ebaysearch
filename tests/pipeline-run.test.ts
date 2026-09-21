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
import { listJudgments } from '../src/storage/judgments'
import { createFakeJevClient, type JevAnswer } from '../src/jev/client'
import { QUESTION_KEYS, type SearchRequest } from '../src/jev/questions'
import { DEFAULTS } from '../src/shared/config'
import type { PageSource } from '../src/scraper/browser'
import type { RawCard } from '../src/scraper/cards'
import type { RawDetail } from '../src/scraper/listing'

/** What would be asked, in brief: the questions themselves have their own tests. */
const JUDGE_REQUEST: SearchRequest = {
  keyword: 'thinkpad',
  criteria_text: '32gb ram',
  spec: { ram_gb: 32 },
  max_price: 1600,
  accepted_conditions: ['Brand New'],
}

function card(itemId: string, price: number, title?: string): RawCard {
  return {
    itemId,
    title: title ?? `Lenovo ThinkPad T14s Gen 6 ${itemId}`,
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

/** What a listing page yields, in the shape `extractDetail` returns. */
function detail(overrides: Partial<RawDetail> = {}): RawDetail {
  return {
    title: 'Lenovo ThinkPad T14s Gen 6 32GB RAM 1TB SSD',
    price: 1200,
    shipping: 0,
    condition: 'Open Box',
    sellerName: 'store',
    sellerFeedback: '99% positive',
    specifics: { Brand: 'Lenovo', 'RAM Size': '32 GB' },
    rawText: ['Brand Lenovo', 'RAM Size 32 GB'],
    ...overrides,
  }
}

/**
 * A PageSource that serves canned pages, so no browser and no network.
 * `detailFn` decides what a listing page yields; by default every listing reads
 * back cleanly.
 */
function fakeSource(
  pages: Array<RawCard[] | Error>,
  status = 200,
  pageTitle = 'ThinkPad T14s Gen 6 for sale | eBay',
  detailFn?: (url: string) => RawDetail | Error,
): PageSource & { visited: string[]; screenshots: string[]; detailUrls: string[] } {
  let i = 0
  const visited: string[] = []
  const screenshots: string[] = []
  const detailUrls: string[] = []
  return {
    visited,
    screenshots,
    detailUrls,
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
    async readListing() {
      const url = visited[visited.length - 1] ?? ''
      detailUrls.push(url)
      const result = detailFn?.(url) ?? detail()
      if (result instanceof Error) throw result
      return result
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
    // The pre-filter runs on every card, so a survivor is stamped as such.
    expect(stored?.stage).toBe('survivor')
  })

  it('stamps each card with its pre-filter verdict and reason, before JEV ever sees it', async () => {
    const { db, run } = setup()
    const source = fakeSource([
      [
        card('111111111', 100, 'ThinkPad T14s Gen 6 16GB RAM 512GB SSD'),
        card('222222222', 100, 'ThinkPad T14s Gen 6 64GB RAM 1TB SSD'),
      ],
    ])
    const published: string[] = []

    const outcome = await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: { ...DEFAULTS, maxPages: 1 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
      requirements: { minRamGb: 32 },
      publish: (e) => published.push(e.type),
    })

    const byItem = new Map(listListings(db, run.id).map((l) => [l.itemId, l]))
    expect(byItem.get('111111111')).toMatchObject({
      stage: 'rejected',
      rejectReason: '16GB RAM, wanted at least 32GB',
    })
    expect(byItem.get('222222222')).toMatchObject({ stage: 'survivor', rejectReason: null })

    // A rejected listing is still stored — the reason has to survive a refresh.
    expect(countListings(db, run.id)).toBe(2)
    expect(outcome.rejected).toBe(1)
    expect(getRun(db, run.id)?.stats.rejected).toBe(1)

    const filtered = listEvents(db, run.id).find((e) => e.type === 'cards.filtered')
    expect(filtered?.payload).toMatchObject({ survivors: 1, rejected: 1 })
    expect(published).toContain('cards.filtered')
  })

  it('keeps a card whose title says nothing, even when the requirements are demanding', async () => {
    const { db, run } = setup()
    // No RAM, storage, touch or CPU mentioned anywhere.
    const source = fakeSource([[card('333333333', 100, 'Lenovo ThinkPad T14s Gen 6 Laptop 14"')]])

    await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: { ...DEFAULTS, maxPages: 1 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
      requirements: { minRamGb: 64, minStorageGb: 2048, requireTouch: true, cpuVendor: 'amd' },
    })

    const [stored] = listListings(db, run.id)
    expect(stored?.stage).toBe('survivor')
    expect(stored?.rejectReason).toBeNull()
  })

  it('visits each survivor and stores what the listing page said', async () => {
    const { db, run } = setup()
    const source = fakeSource([
      [card('111111111', 100), card('222222222', 200)],
    ])

    const outcome = await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: { ...DEFAULTS, maxPages: 1 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
      publish: () => {},
    })

    expect(outcome.status).toBe('complete')
    expect(outcome.detailsFetched).toBe(2)
    expect(source.detailUrls).toHaveLength(2)
    const [first] = listListings(db, run.id)
    expect(first?.detail?.specifics.Brand).toBe('Lenovo')
    expect(first?.stage).toBe('survivor')
    expect(listEvents(db, run.id).some((e) => e.type === 'listing.visited')).toBe(true)
  })

  it('never opens a listing the pre-filter rejected', async () => {
    const { db, run } = setup()
    const source = fakeSource([
      [
        card('111111111', 100, 'ThinkPad T14s Gen 6 16GB RAM 512GB SSD'),
        card('222222222', 200, 'ThinkPad T14s Gen 6 64GB RAM 1TB SSD'),
      ],
    ])

    await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: { ...DEFAULTS, maxPages: 1 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
      requirements: { minRamGb: 32 },
    })

    expect(source.detailUrls).toHaveLength(1)
    expect(source.detailUrls[0]).toContain('222222222')
  })

  it('stops visiting listings at the detail cap, leaving the rest judged on card data', async () => {
    const { db, run } = setup()
    const source = fakeSource([
      [card('111111111', 1), card('222222222', 2), card('333333333', 3)],
    ])

    const outcome = await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: { ...DEFAULTS, maxPages: 1, maxDetailVisits: 2 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
    })

    expect(outcome.detailsFetched).toBe(2)
    expect(countListings(db, run.id)).toBe(3)
    const visited = listListings(db, run.id).filter((l) => l.detail !== null)
    expect(visited).toHaveLength(2)
    // The unvisited one is still a survivor: JEV judges it on card data alone.
    expect(listListings(db, run.id).filter((l) => l.stage === 'survivor')).toHaveLength(3)
  })

  it('marks a listing detail_failed when its page will not read, and carries on', async () => {
    const { db, run } = setup()
    const source = fakeSource(
      [[card('111111111', 100), card('222222222', 200)]],
      200,
      'ThinkPad',
      (url) => (url.includes('111111111') ? new Error('page closed mid-read') : detail()),
    )

    const outcome = await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: { ...DEFAULTS, maxPages: 1 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
    })

    expect(outcome.status).toBe('complete')
    expect(outcome.detailsFailed).toBe(1)
    const failed = listListings(db, run.id).find((l) => l.itemId === '111111111')
    expect(failed?.stage).toBe('detail_failed')
    // Still not a rejection: JEV must see it on card data.
    expect(failed?.detail).toBeNull()
    expect(listEvents(db, run.id).some((e) => e.type === 'error')).toBe(true)
    expect(getRun(db, run.id)?.stats.detailsFailed).toBe(1)
  })

  it('fails the run when listing pages keep failing, because that is a markup change', async () => {
    const { db, run } = setup()
    const source = fakeSource(
      [[card('111111111', 1), card('222222222', 2), card('333333333', 3)]],
      200,
      'ThinkPad',
      () => new Error('no item specifics found'),
    )

    const outcome = await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: { ...DEFAULTS, maxPages: 1 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
    })

    expect(outcome.status).toBe('failed')
    expect(getRun(db, run.id)?.error).toMatch(/listing pages/i)
    // A screenshot is the evidence a markup change leaves behind.
    expect(source.screenshots.length).toBeGreaterThan(0)
  })

  it('judges the survivors and records the answers in the run event log', async () => {
    const { db, run } = setup()
    const source = fakeSource([[card('111111111', 100), card('222222222', 200)]])
    const answers: Record<string, JevAnswer> = {}
    for (const label of ['L1', 'L2']) {
      for (const key of QUESTION_KEYS) {
        answers[`${label}.${key}`] = { type: 'noul', noul: 0.91 }
      }
    }
    const client = createFakeJevClient(answers, { input_tokens: 1_000_000, output_tokens: 0 })

    const outcome = await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: { ...DEFAULTS, maxPages: 1 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
      judge: { client, batchSize: 10, request: JUDGE_REQUEST },
    })

    expect(outcome.judged).toBe(2)
    expect(outcome.costUsd).toBeCloseTo(0.042, 6)
    expect(getRun(db, run.id)?.stats.judged).toBe(2)
    // Stored as an event, so a browser that refreshes replays the answers.
    expect(listEvents(db, run.id).some((e) => e.type === 'judgments.received')).toBe(true)
    expect(listJudgments(db, run.id)).toHaveLength(12)
  })

  it('fails the run loudly when JEV refuses a listing outright', async () => {
    const { db, run } = setup()
    const source = fakeSource([[card('111111111', 100)]])
    const client = {
      async systemOne(): Promise<never> {
        throw new Error('422 Unprocessable Entity')
      },
    }

    const outcome = await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: { ...DEFAULTS, maxPages: 1 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
      judge: { client, batchSize: 10, request: JUDGE_REQUEST },
    })

    expect(outcome.status).toBe('failed')
    expect(getRun(db, run.id)?.error).toMatch(/could not be judged/i)
  })

  it('rejects on price when shipping is what pushes it over', async () => {
    const { db, run } = setup()
    const over = { ...card('444444444', 1190), shipping: 25 }
    const source = fakeSource([[over]])

    await executeRun({
      db,
      runId: run.id,
      keyword: 'x',
      settings: { ...DEFAULTS, maxPages: 1 },
      source,
      sleep: noSleep,
      screenshotsDir: tmp,
      requirements: { maxPrice: 1200 },
    })

    const [stored] = listListings(db, run.id)
    expect(stored?.stage).toBe('rejected')
    expect(stored?.rejectReason).toBe('$1,190.00 + $25.00 shipping is over the $1,200 limit')
  })
})
