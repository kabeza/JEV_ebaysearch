import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/storage/db'
import { createSearch } from '../src/storage/searches'
import { createRun, getRun } from '../src/storage/runs'
import { insertCards, listListings } from '../src/storage/listings'
import { listJudgments, listQuestionnaires } from '../src/storage/judgments'
import { listEvents } from '../src/storage/events'
import { askInBatches, judgeSurvivors } from '../src/pipeline/judge'
import { createFakeJevClient, type JevAnswer, type JevResult } from '../src/jev/client'
import {
  QUESTION_KEYS,
  buildFromDraft,
  buildState,
  type QuestionListing,
  type SearchRequest,
} from '../src/jev/questions'
import type { JevRequest } from '../src/jev/client'
import type { RawCard } from '../src/scraper/cards'
import { defaultDraft } from '../src/jev/draft'

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

  it('halves the batch for the refusal the service actually sends', async () => {
    // Measured 2026-09-25: an oversized batch comes back as a 400 carrying the
    // service's own `max_tokens_exceeded` marker, not as a 422. `tests/jev-batch`
    // proves the predicate recognises it; this proves the pipeline then halves
    // instead of failing the run, which is what rule 17 promises a person and what
    // the 422-only case above could never see.
    const { db, run } = setup(12)
    const sizes: number[] = []
    const client = {
      async systemOne(req: JevRequest): Promise<JevResult> {
        const count = Object.keys(req.questions).length / QUESTION_KEYS.length
        sizes.push(count)
        if (count > 5) {
          throw Object.assign(new Error('400 {"detail":{"error_type":"max_tokens_exceeded"}}'), {
            status: 400,
            body: { detail: { error_type: 'max_tokens_exceeded' } },
          })
        }
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

    expect(sizes).toEqual([10, 5, 5, 2])
    expect(outcome.judged).toBe(12)
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

describe('askInBatches', () => {
  const labelled = [1, 2, 3, 4].map((i) => ({
    label: `L${i}`,
    title: `Listing ${i}`,
    price: 100 * i,
    shipping: 0,
    conditionLabel: 'Open Box',
    sellerName: 'seller',
    sellerFeedback: '100% positive (45)',
    detail: null,
  }))
  const listingIds = [101, 102, 103, 104]
  const draft = defaultDraft({
    keyword: 'k',
    criteria_text: 'c',
    spec: {},
    max_price: undefined,
    accepted_conditions: ['Open Box'],
  })
  const questionsFor = (batch: QuestionListing[]) => ({
    state: buildState(draft.request, batch),
    questions: buildFromDraft(draft, batch),
  })

  /** Every answer for the questions asked, so a batch always comes back complete. */
  const completeAnswers = (questions: Record<string, unknown>) =>
    Object.fromEntries(
      Object.keys(questions).map((key) => [
        key,
        key.includes('listing_trust') || key.includes('price_value')
          ? {
              type: 'score',
              score: 3,
              confidence: 0.5,
              legend: { '0': 'a', '4': 'e' },
              probabilities: { '0': 0.1, '4': 0.9 },
            }
          : { type: 'noul', noul: 0.9 },
      ]),
    )

  it('asks one call per batch and hands each batch’s answers back with its listing', async () => {
    const calls: number[] = []
    const client = {
      systemOne: async ({ questions }: { questions: Record<string, unknown> }) => {
        const labels = new Set(Object.keys(questions).map((k) => k.split('.')[0]))
        calls.push(labels.size)
        return {
          model: 'fake',
          answers: completeAnswers(questions),
          usage: { input_tokens: 100, output_tokens: 0 },
        }
      },
    } as never

    const stored: { label: string; id: number; keys: number }[] = []
    const outcome = await askInBatches({
      client,
      batchSize: 2,
      emit: () => {},
      labelled,
      listingIds,
      questionKeys: [...QUESTION_KEYS],
      questionsFor,
      onBatch: (results) => {
        for (const r of results) {
          stored.push({ label: r.listing.label, id: r.listingId, keys: Object.keys(r.answers).length })
        }
      },
    })

    expect(calls).toEqual([2, 2])
    expect(outcome.batches).toBe(2)
    expect(outcome.judged).toBe(4)
    expect(stored).toEqual([
      { label: 'L1', id: 101, keys: 6 },
      { label: 'L2', id: 102, keys: 6 },
      { label: 'L3', id: 103, keys: 6 },
      { label: 'L4', id: 104, keys: 6 },
    ])
  })

  it('halves the batch on a refusal and stays halved for the job', async () => {
    const sizes: number[] = []
    const client = {
      systemOne: async ({ questions }: { questions: Record<string, unknown> }) => {
        const labels = new Set(Object.keys(questions).map((k) => k.split('.')[0]))
        sizes.push(labels.size)
        if (labels.size > 1) throw new Error('422: request too large')
        return {
          model: 'fake',
          answers: Object.fromEntries(
            [...labels].map((label) => [`${label}.condition_ok`, { type: 'noul', noul: 0.9 }]),
          ),
          usage: { input_tokens: 10, output_tokens: 0 },
        }
      },
    } as never

    const outcome = await askInBatches({
      client,
      batchSize: 2,
      emit: () => {},
      labelled,
      listingIds,
      questionKeys: ['condition_ok'],
      questionsFor,
      onBatch: () => {},
    })

    expect(sizes).toEqual([2, 1, 1, 1, 1])
    expect(outcome.batches).toBe(4)
    expect(outcome.judged).toBe(4)
  })

  it('counts an answer JEV did not return instead of pretending it arrived', async () => {
    const client = {
      systemOne: async () => ({
        model: 'fake',
        answers: { 'L1.condition_ok': { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 10, output_tokens: 0 },
      }),
    } as never

    const outcome = await askInBatches({
      client,
      batchSize: 1,
      emit: () => {},
      labelled: labelled.slice(0, 1),
      listingIds: listingIds.slice(0, 1),
      questionKeys: ['condition_ok', 'price_value'],
      questionsFor,
      onBatch: () => {},
    })

    expect(outcome.missingAnswers).toBe(1)
  })

  it('stops between batches when cancelled, keeping what arrived', async () => {
    let batches = 0
    const client = {
      systemOne: async ({ questions }: { questions: Record<string, unknown> }) => {
        batches++
        return {
          model: 'fake',
          answers: completeAnswers(questions),
          usage: { input_tokens: 10, output_tokens: 0 },
        }
      },
    } as never

    const outcome = await askInBatches({
      client,
      batchSize: 2,
      emit: () => {},
      labelled,
      listingIds,
      questionKeys: ['condition_ok'],
      isCancelled: () => batches >= 1,
      questionsFor,
      onBatch: () => {},
    })

    expect(batches).toBe(1)
    expect(outcome.cancelled).toBe(true)
    expect(outcome.judged).toBe(2)
  })
})

describe('the questionnaire a run stores', () => {
  it('holds the questions it asked, with the label each listing was given', () => {
    // §5.7 promises "the exact question definitions used". Storing only
    // `{request, questionKeys}` broke that promise for the whole first-judging
    // path: the wording lived in code, so a later edit to it would silently
    // rewrite what an old run claims to have asked.
    const { db, run } = setup(2)
    return judgeSurvivors({
      db,
      runId: run.id,
      request,
      client: answeringClient() as never,
      batchSize: 10,
      emit: () => {},
    }).then(() => {
      const [questionnaire] = listQuestionnaires(db, run.id)
      const definition = questionnaire!.definition as {
        questions: { key: string; instructions: string }[]
        labels: Record<string, string>
      }
      expect(definition.questions.map((q) => q.key)).toEqual([...QUESTION_KEYS])
      for (const question of definition.questions) {
        expect(question.instructions.trim().length).toBeGreaterThan(0)
      }
      const listings = listListings(db, run.id)
      expect(definition.labels[String(listings[0]!.id)]).toBe('L1')
      expect(definition.labels[String(listings[1]!.id)]).toBe('L2')
    })
  })
})
