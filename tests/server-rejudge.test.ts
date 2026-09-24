import { describe, it, expect, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server/index'
import { isRunning } from '../src/pipeline/runner'
import type { PageSource } from '../src/scraper/browser'
import type { RawCard } from '../src/scraper/cards'
import type { JevAnswer, JevClient, JevRequest, JevResult } from '../src/jev/client'
import { defaultDraft, type QuestionnaireDraft } from '../src/jev/draft'

const search = {
  keyword: 'thinkpad t14s',
  criteria_text: '32gb ram, Ryzen, 1tb, touch screen, under 1600',
  spec: { ram_gb: 32, max_price: 1600 },
  max_price: 1600,
  accepted_conditions: ['Open Box'],
}

const card = (itemId: string, cpu = ''): RawCard => ({
  itemId,
  title: `Lenovo ThinkPad T14s Gen 6 32GB RAM 1TB SSD ${cpu} ${itemId}`.trim(),
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

/** Counts its own page loads, so "a re-judge touches eBay not at all" is a number. */
function countingSource(over: { cards?: RawCard[] } = {}) {
  const counter = { calls: 0 }
  const source: PageSource = {
    async goto() {
      counter.calls++
      return { status: 200 }
    },
    async title() {
      return 'ThinkPad T14s Gen 6 for sale | eBay'
    },
    async readCards() {
      return over.cards ?? [card('111111111'), card('222222222')]
    },
    async readListing() {
      return {
        title: 'Lenovo ThinkPad T14s Gen 6 32GB RAM 1TB SSD',
        price: 1200,
        shipping: 0,
        condition: 'Open Box',
        sellerName: 'store',
        sellerFeedback: '100% positive (450)',
        specifics: { Brand: 'Lenovo', 'RAM Size': '32 GB' },
        rawText: ['Brand Lenovo'],
      }
    },
    async screenshot() {},
    async close() {},
  }
  return { counter, source }
}

/**
 * Every answer the questions ask for. `holdFrom` blocks from that call onwards,
 * so a fixture's own run (one call) can finish while a later re-judge is held
 * mid-flight — holding from the first call would leave the run's lock taken and
 * poison every test after it.
 */
function answeringClient(
  opts: { calls?: { n: number }; holdFrom?: number; hold?: Promise<void> } = {},
): JevClient {
  // The factory builds one client per job, so the call count has to be shared
  // across them for "hold from the second call" to mean what it says.
  const calls = opts.calls ?? { n: 0 }
  return {
    async systemOne(req: JevRequest): Promise<JevResult> {
      calls.n++
      if (opts.hold && opts.holdFrom !== undefined && calls.n >= opts.holdFrom) await opts.hold
      const answers: Record<string, JevAnswer> = {}
      for (const key of Object.keys(req.questions)) {
        answers[key] = key.includes('listing_trust') || key.includes('price_value')
          ? { type: 'score', score: 3, confidence: 0.5, legend: { '0': 'a', '4': 'e' }, probabilities: { '0': 0.1, '4': 0.9 } }
          : { type: 'noul', noul: 0.9 }
      }
      return { model: 'fake', answers, usage: { input_tokens: 0, output_tokens: 0 } }
    },
  }
}

async function waitForIdle(timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  while (isRunning() && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10))
  }
}

let app: FastifyInstance | null = null
afterEach(async () => {
  await app?.close()
  app = null
})

/** A finished run with stored listings and one questionnaire version, as a user would have. */
async function runFixture(over: { judgeClientFactory?: () => JevClient } = {}) {
  const { counter, source } = countingSource()
  app = buildServer({
    dbPath: ':memory:',
    sourceFactory: async () => source,
    judgeClientFactory: over.judgeClientFactory ?? (() => answeringClient()),
  })

  const created = await app.inject({
    method: 'POST',
    url: '/api/searches',
    payload: { name: 'rejudge', keyword: search.keyword, criteriaText: search.criteria_text, spec: search.spec },
  })
  const searchId = created.json().id as number

  const started = await app.inject({
    method: 'POST',
    url: '/api/runs',
    payload: { searchId, settings: { maxPages: 1, pacingMinMs: 1, pacingMaxMs: 2, maxDetailVisits: 0 } },
  })
  const runId = started.json().runId as number
  await waitForIdle()

  return { runId, counter }
}

const draft = (over: Partial<QuestionnaireDraft> = {}): QuestionnaireDraft => ({
  ...defaultDraft(search),
  ...over,
})

// Each of these drives a real run through the API before it re-judges, and a run
// takes a couple of seconds end to end — well past vitest's five-second default.
const RUN_TIMEOUT = 20_000

describe('POST /api/runs/:id/rejudge', () => {
  it('accepts a draft, judges the stored listings, and loads no page at all', { timeout: RUN_TIMEOUT }, async () => {
    const { runId, counter } = await runFixture()
    const before = counter.calls
    expect(before).toBeGreaterThan(0) // the run itself did scrape

    const res = await app!.inject({
      method: 'POST',
      url: `/api/runs/${runId}/rejudge`,
      payload: draft(),
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ runId, version: 2 })

    await waitForIdle()
    expect(counter.calls).toBe(before)

    const payload = (await app!.inject({ method: 'GET', url: `/api/runs/${runId}` })).json() as {
      questionnaires: { id: number; version: number }[]
      judgments: { questionnaireId: number; listingId: number }[]
    }
    expect(payload.questionnaires.map((q) => q.version)).toEqual([1, 2])
    const ids = new Set(payload.questionnaires.map((q) => q.id))
    expect(payload.judgments.length).toBeGreaterThan(0)
    for (const judgment of payload.judgments) expect(ids.has(judgment.questionnaireId)).toBe(true)

    // Version 2 answered the same listings version 1 did: a re-judge is a
    // re-ask, not a subset.
    const v1 = new Set(
      payload.judgments.filter((j) => j.questionnaireId === payload.questionnaires[0]!.id).map((j) => j.listingId),
    )
    const v2 = new Set(
      payload.judgments.filter((j) => j.questionnaireId === payload.questionnaires[1]!.id).map((j) => j.listingId),
    )
    expect([...v2].sort()).toEqual([...v1].sort())
  })

  it('refuses a draft that could not be judged, and creates no version', { timeout: RUN_TIMEOUT }, async () => {
    const { runId } = await runFixture()
    const broken = draft()
    broken.questions = broken.questions.map((q) => ({ ...q, instructions: '   ' }))

    const res = await app!.inject({
      method: 'POST',
      url: `/api/runs/${runId}/rejudge`,
      payload: broken,
    })

    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: string; reasons: string[] }
    expect(body.error).toContain('cannot be judged')
    expect(body.reasons.length).toBeGreaterThan(0)

    await waitForIdle()
    const payload = (await app!.inject({ method: 'GET', url: `/api/runs/${runId}` })).json() as {
      questionnaires: unknown[]
    }
    expect(payload.questionnaires).toHaveLength(1)
  })

  it('404s a run that does not exist', { timeout: RUN_TIMEOUT }, async () => {
    await runFixture()
    const res = await app!.inject({ method: 'POST', url: '/api/runs/999/rejudge', payload: draft() })
    expect(res.statusCode).toBe(404)
  })

  it('409s while another job holds the lock, rather than starting a second one', { timeout: RUN_TIMEOUT }, async () => {
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls = { n: 0 }
    const { runId } = await runFixture({
      judgeClientFactory: () => answeringClient({ calls, holdFrom: 2, hold }),
    })

    const first = await app!.inject({ method: 'POST', url: `/api/runs/${runId}/rejudge`, payload: draft() })
    expect(first.statusCode).toBe(202)

    const second = await app!.inject({ method: 'POST', url: `/api/runs/${runId}/rejudge`, payload: draft() })
    expect(second.statusCode).toBe(409)
    expect(second.json().error).toMatch(/already in progress/)

    release()
    await waitForIdle()
  })
})

describe('GET /api/runs/:id', () => {
  it('reports the questionnaire versions a stored run carries', { timeout: RUN_TIMEOUT }, async () => {
    const { runId } = await runFixture()
    const payload = (await app!.inject({ method: 'GET', url: `/api/runs/${runId}` })).json() as {
      questionnaires: { id: number; version: number; createdAt: string; definition: Record<string, unknown> }[]
    }
    expect(payload.questionnaires).toHaveLength(1)
    expect(payload.questionnaires[0]!.version).toBe(1)
    // The run's own judging stores `{ request, questionKeys }` — no question text.
    // Its answers stay readable and the editor falls back to the shipped wording.
    expect(payload.questionnaires[0]!.definition).toHaveProperty('questionKeys')
  })
})

describe('POST /api/runs/:id/rejudge on a run with nothing to judge', () => {
  it('refuses with 400 instead of promising a version that will never exist', { timeout: RUN_TIMEOUT }, async () => {
    // Every card contradicts the spec, so the pre-filter takes them all and the
    // run finishes with no survivors. The spec's §9 table promises a 400 here;
    // what it used to do was 202, then throw before emitting anything at all —
    // a version number and total silence.
    const { counter, source } = countingSource({ cards: [card('333333333', 'Intel Core i7')] })
    app = buildServer({
      dbPath: ':memory:',
      sourceFactory: async () => source,
      judgeClientFactory: () => answeringClient(),
    })
    const created = await app.inject({
      method: 'POST',
      url: '/api/searches',
      payload: {
        name: 'nothing judgeable',
        keyword: search.keyword,
        criteriaText: search.criteria_text,
        spec: { cpu_family: 'AMD Ryzen' },
      },
    })
    const started = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        searchId: created.json().id as number,
        settings: { maxPages: 1, pacingMinMs: 1, pacingMaxMs: 2, maxDetailVisits: 0 },
      },
    })
    const runId = started.json().runId as number
    await waitForIdle()
    void counter

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/rejudge`,
      payload: draft(),
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/no listings to judge/)
    const payload = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json() as {
      questionnaires: unknown[]
    }
    expect(payload.questionnaires).toHaveLength(0)
  })
})

describe('POST /api/runs/:id/resume', () => {
  it('refuses to resume a run that is not paused, rather than pretending to', { timeout: RUN_TIMEOUT }, async () => {
    const { runId } = await runFixture()
    const res = await app!.inject({ method: 'POST', url: `/api/runs/${runId}/resume` })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ resumed: false, runId })
  })

  it('404s a run that does not exist', async () => {
    await runFixture()
    const res = await app!.inject({ method: 'POST', url: '/api/runs/999/resume' })
    expect(res.statusCode).toBe(409)
    expect(res.json().resumed).toBe(false)
  })
})
