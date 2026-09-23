import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/storage/db'
import { createSearch } from '../src/storage/searches'
import { createRun, getRun } from '../src/storage/runs'
import { insertCards, listListings } from '../src/storage/listings'
import { listJudgments, listQuestionnaires } from '../src/storage/judgments'
import { listEvents } from '../src/storage/events'
import { judgeSurvivors } from '../src/pipeline/judge'
import { createFakeJevClient, type JevAnswer, type JevResult } from '../src/jev/client'
import { QUESTION_KEYS, type SearchRequest } from '../src/jev/questions'
import type { JevRequest } from '../src/jev/client'
import type { RawCard } from '../src/scraper/cards'

const request: SearchRequest = {
  keyword: 'thinkpad',
  criteria_text: '32gb ram, Ryzen, 1tb, touch',
  spec: { ram_gb: 32 },
  max_price: 1600,
  accepted_conditions: ['Brand New'],
}

function card(itemId: string): RawCard {
  return {
    itemId,
    title: `Lenovo ThinkPad T14s Gen 6 32GB RAM 1TB SSD AMD Ryzen 7 ${itemId}`,
    url: `https://www.ebay.com/itm/${itemId}`,
    price: 1200,
    shipping: 0,
    currency: 'USD',
    conditionLabel: 'Brand New',
    sellerName: 'store',
    sellerFeedback: '99% positive (1K)',
    watchers: 1,
    buyingFormat: 'Buy It Now',
    sponsoredMarker: false,
    rawText: ['$1,200.00'],
  }
}

/** A client that answers every question, so a batch always comes back complete. */
function answeringClient(usage = { input_tokens: 1000, output_tokens: 50 }) {
  const calls: { count: number }[] = []
  const fake = createFakeJevClient({}, usage)
  const original = fake.systemOne.bind(fake)
  const client = {
    calls,
    async systemOne(req: JevRequest): Promise<JevResult> {
      calls.push({ count: Object.keys(req.questions).length / QUESTION_KEYS.length })
      const answers: Record<string, JevAnswer> = {}
      for (const key of Object.keys(req.questions)) {
        answers[key] = key.includes('price_value')
          ? { type: 'score', score: 3, confidence: 0.7, legend: {}, probabilities: {} }
          : { type: 'noul', noul: 0.9 }
      }
      return original({ ...req, questions: req.questions }).then(() => ({ model: 'fake', answers, usage }))
    },
  }
  return client
}

function setup(count: number) {
  const db = openDatabase(':memory:')
  const search = createSearch(db, { name: 't', keyword: 'thinkpad', criteriaText: '' })
  const run = createRun(db, search.id, {})
  insertCards(
    db,
    run.id,
    Array.from({ length: count }, (_, i) => card(`${100000000 + i}`)),
  )
  for (const l of listListings(db, run.id)) {
    db.prepare("update listings set stage = 'survivor' where id = ?").run(l.id)
  }
  return { db, run }
}

describe('judgeSurvivors', () => {
  it('judges 25 survivors in batches of 10/10/5, storing six answers each', async () => {
    const { db, run } = setup(25)
    const client = answeringClient()

    const outcome = await judgeSurvivors({
      db,
      runId: run.id,
      request,
      client,
      batchSize: 10,
      emit: () => {},
    })

    expect(client.calls.map((c) => c.count)).toEqual([10, 10, 5])
    expect(outcome.judged).toBe(25)
    expect(outcome.batches).toBe(3)
    const judgments = listJudgments(db, run.id)
    expect(judgments).toHaveLength(150)
    expect(new Set(judgments.map((j) => j.questionKey))).toEqual(new Set(QUESTION_KEYS))
    for (const l of listListings(db, run.id)) expect(l.stage).toBe('judged')
  })

  it('records the token usage and the cost of the run', async () => {
    const { db, run } = setup(2)
    const outcome = await judgeSurvivors({
      db,
      runId: run.id,
      request,
      client: answeringClient({ input_tokens: 2_000_000, output_tokens: 10 }),
      batchSize: 10,
      emit: () => {},
    })
    // 2M input tokens at $0.042/Mtok, output free.
    expect(outcome.inputTokens).toBe(2_000_000)
    expect(outcome.costUsd).toBeCloseTo(0.084, 6)
  })

  it('stores the whole answer, so the report can show probabilities and confidence', async () => {
    const { db, run } = setup(1)
    await judgeSurvivors({
      db,
      runId: run.id,
      request,
      client: answeringClient(),
      batchSize: 10,
      emit: () => {},
    })
    const score = listJudgments(db, run.id).find((j) => j.questionKey === 'price_value')
    expect(score?.answer).toMatchObject({ type: 'score', score: 3, confidence: 0.7 })
  })

  it('keys judgments by listing and question, so a report can join them', async () => {
    const { db, run } = setup(1)
    await judgeSurvivors({
      db,
      runId: run.id,
      request,
      client: answeringClient(),
      batchSize: 10,
      emit: () => {},
    })
    const [listing] = listListings(db, run.id)
    const mine = listJudgments(db, run.id).filter((j) => j.listingId === listing?.id)
    expect(mine).toHaveLength(6)
    expect(mine.map((j) => j.questionKey).sort()).toEqual([...QUESTION_KEYS].sort())
  })

  it('creates one questionnaire for the run, recording what was asked', async () => {
    const { db, run } = setup(3)
    await judgeSurvivors({
      db,
      runId: run.id,
      request,
      client: answeringClient(),
      batchSize: 2,
      emit: () => {},
    })
    const questionnaires = listQuestionnaires(db, run.id)
    expect(questionnaires).toHaveLength(1)
    expect(questionnaires[0]?.version).toBe(1)
    expect(questionnaires[0]?.definition).toMatchObject({ request })
  })

  it('never judges a listing the pre-filter rejected', async () => {
    const { db, run } = setup(3)
    const [first] = listListings(db, run.id)
    db.prepare("update listings set stage = 'rejected', reject_reason = 'x' where id = ?").run(first!.id)
    const client = answeringClient()

    await judgeSurvivors({ db, runId: run.id, request, client, batchSize: 10, emit: () => {} })

    expect(client.calls[0]?.count).toBe(2)
    expect(listJudgments(db, run.id)).toHaveLength(12)
  })

  it('halves the batch and retries when the request is too large', async () => {
    const { db, run } = setup(12)
    const sizes: number[] = []
    const client = {
      async systemOne(req: JevRequest): Promise<JevResult> {
        const count = Object.keys(req.questions).length / QUESTION_KEYS.length
        sizes.push(count)
        if (count > 5) throw new Error('422 Unprocessable Entity')
        const answers: Record<string, JevAnswer> = {}
        for (const key of Object.keys(req.questions)) answers[key] = { type: 'noul', noul: 0.9 }
        return { model: 'fake', answers, usage: { input_tokens: 10, output_tokens: 1 } }
      },
    }

    const outcome = await judgeSurvivors({
      db,
      runId: run.id,
      request,
      client,
      batchSize: 10,
      emit: () => {},
    })

    // 10 refused, then 5 + 5, then 2 — every listing still judged.
    expect(sizes).toEqual([10, 5, 5, 2])
    expect(outcome.judged).toBe(12)
    expect(listJudgments(db, run.id)).toHaveLength(72)
  })

  it('gives up loudly when even a single listing is refused, rather than storing nothing quietly', async () => {
    const { db, run } = setup(3)
    const client = {
      async systemOne(): Promise<JevResult> {
        throw new Error('422 Unprocessable Entity')
      },
    }

    await expect(
      judgeSurvivors({ db, runId: run.id, request, client, batchSize: 3, emit: () => {} }),
    ).rejects.toThrowError(/could not be judged/i)
    expect(listJudgments(db, run.id)).toHaveLength(0)
  })

  it('reports answers the model did not return instead of pretending they arrived', async () => {
    const { db, run } = setup(1)
    const client = {
      async systemOne(): Promise<JevResult> {
        return {
          model: 'fake',
          answers: { 'L1.is_target_product': { type: 'noul', noul: 0.9 } },
          usage: { input_tokens: 10, output_tokens: 1 },
        }
      },
    }

    const outcome = await judgeSurvivors({
      db,
      runId: run.id,
      request,
      client,
      batchSize: 10,
      emit: () => {},
    })

    expect(outcome.judged).toBe(1)
    expect(outcome.missingAnswers).toBe(5)
    expect(listJudgments(db, run.id)).toHaveLength(1)
  })

  it('publishes the answers as they arrive, not just writes them', async () => {
    const { db, run } = setup(4)
    const published: string[] = []
    const seen: unknown[] = []

    await judgeSurvivors({
      db,
      runId: run.id,
      request,
      client: answeringClient(),
      batchSize: 2,
      emit: (type, payload) => {
        published.push(type)
        if (type === 'judgments.received') seen.push(payload)
      },
    })

    expect(published).toContain('judgments.received')
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ batch: 1, listings: 2 })
  })

  // Persisting the event is the pipeline's job, not this module's: the judge
  // calls `emit` and `run.ts` is the single writer. The run-level test that a
  // refresh can replay answers lives in pipeline-run.test.ts.

  it('stops between batches when the run is cancelled, keeping what it has', async () => {
    const { db, run } = setup(10)
    let cancelled = false
    const client = answeringClient()

    const outcome = await judgeSurvivors({
      db,
      runId: run.id,
      request,
      client,
      batchSize: 2,
      emit: () => {
        cancelled = true
      },
      isCancelled: () => cancelled,
    })

    expect(client.calls).toHaveLength(1)
    expect(outcome.judged).toBe(2)
    expect(outcome.cancelled).toBe(true)
  })

  it('does nothing at all when there are no survivors', async () => {
    const { db, run } = setup(2)
    for (const l of listListings(db, run.id)) {
      db.prepare("update listings set stage = 'rejected' where id = ?").run(l.id)
    }
    const client = answeringClient()
    const outcome = await judgeSurvivors({
      db,
      runId: run.id,
      request,
      client,
      batchSize: 10,
      emit: () => {},
    })
    expect(client.calls).toHaveLength(0)
    expect(outcome.judged).toBe(0)
    expect(listQuestionnaires(db, run.id)).toHaveLength(0)
  })
})

describe('judgeSurvivors and failed detail pages', () => {
  it('judges a listing whose detail page failed, on its card data', async () => {
    // run.ts and CLAUDE.md rule 17 both say a `detail_failed` listing still
    // reaches JEV on its card data. It has to: nothing else ever will, so the
    // report would otherwise list it as "not judged yet" on a finished run and
    // wait for a judgment that never comes.
    const { db, run } = setup(2)
    const [first] = listListings(db, run.id)
    db.prepare("update listings set stage = 'detail_failed' where id = ?").run(first!.id)

    const outcome = await judgeSurvivors({
      db,
      runId: run.id,
      request,
      client: answeringClient(),
      batchSize: 10,
      emit: () => {},
    })

    expect(outcome.judged).toBe(2)
    const failed = listListings(db, run.id).find((l) => l.id === first!.id)
    expect(failed?.stage).toBe('judged')
    expect(listJudgments(db, run.id).filter((j) => j.listingId === first!.id)).toHaveLength(6)
  })
})
