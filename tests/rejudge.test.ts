import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/storage/db'
import { createSearch, getSearch } from '../src/storage/searches'
import { createRun, finishRun } from '../src/storage/runs'
import { insertCards } from '../src/storage/listings'
import type { RawCard } from '../src/scraper/cards'
import { listJudgments, listQuestionnaires } from '../src/storage/judgments'
import { appendEvent, listEvents } from '../src/storage/events'
import { rejudgeRun } from '../src/pipeline/rejudge'
import { isRunning, startRejudge } from '../src/pipeline/runner'
import { defaultDraft } from '../src/jev/draft'

const card = (itemId: string): RawCard => ({
  itemId,
  title: `Lenovo ThinkPad T14s Gen 6 ${itemId}`,
  url: `https://www.ebay.com/itm/${itemId}`,
  price: 1000,
  shipping: 0,
  currency: 'USD',
  conditionLabel: 'Open Box',
  sellerName: 'seller',
  sellerFeedback: '100% positive (450)',
  watchers: null,
  buyingFormat: 'Buy It Now',
  sponsoredMarker: false,
  rawText: [],
})

function fixture(stages: string[] = ['judged', 'judged', 'detail_failed', 'rejected']) {
  const db = openDatabase(':memory:')
  const search = createSearch(db, { name: 's', keyword: 'k', criteriaText: 'c', spec: {} })
  const run = createRun(db, search.id, {})
  finishRun(db, run.id, { status: 'complete' })
  const stored = insertCards(db, run.id, stages.map((_, i) => card(String(i + 1))))
  const ids = stages.map((_, i) => stored.idsByItemId.get(String(i + 1))!)
  stages.forEach((stage, i) => {
    db.prepare('update listings set stage = ? where id = ?').run(stage, ids[i])
  })
  return { db, runId: run.id, ids, search }
}

/** Every answer, so a batch of any size comes back complete. */
function fakeClient(answer = 0.9) {
  let calls = 0
  return {
    calls: () => calls,
    systemOne: async ({ questions }: { questions: Record<string, unknown> }) => {
      calls++
      const answers = Object.fromEntries(
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
            : { type: 'noul', noul: answer },
        ]),
      )
      return { model: 'fake', answers, usage: { input_tokens: 100, output_tokens: 0 } }
    },
  }
}

const draft = (criteria = 'c') =>
  defaultDraft({
    keyword: 'k',
    criteria_text: criteria,
    spec: {},
    max_price: undefined,
    accepted_conditions: ['Open Box'],
  })

describe('rejudgeRun', () => {
  it('judges every listing the pre-filter kept, and only those', async () => {
    const { db, runId, ids } = fixture()
    const outcome = await rejudgeRun({
      db,
      runId,
      draft: draft(),
      client: fakeClient() as never,
      batchSize: 2,
      emit: () => {},
    })

    expect(outcome.judged).toBe(3)
    const judged = new Set(listJudgments(db, runId).map((j) => j.listingId))
    expect(judged).toEqual(new Set([ids[0], ids[1], ids[2]]))
    expect(judged.has(ids[3]!)).toBe(false)
  })

  it('creates a second version and leaves the first version’s answers alone', async () => {
    const { db, runId } = fixture(['judged', 'judged'])
    await rejudgeRun({
      db,
      runId,
      draft: draft('first'),
      client: fakeClient(0.8) as never,
      batchSize: 3,
      emit: () => {},
    })
    const first = listJudgments(db, runId)

    const second = await rejudgeRun({
      db,
      runId,
      draft: draft('second'),
      client: fakeClient(0.2) as never,
      batchSize: 3,
      emit: () => {},
    })

    const versions = listQuestionnaires(db, runId)
    expect(versions.map((v) => v.version)).toEqual([1, 2])
    expect(second.version).toBe(2)

    const all = listJudgments(db, runId)
    expect(all).toHaveLength(first.length * 2)
    expect(all.filter((j) => j.questionnaireId === versions[0]!.id)).toEqual(first)
  })

  it('remembers which listing each label was, so two versions line up', async () => {
    const { db, runId } = fixture(['judged', 'judged'])
    await rejudgeRun({ db, runId, draft: draft(), client: fakeClient() as never, batchSize: 3, emit: () => {} })
    const definition = listQuestionnaires(db, runId)[0]!.definition as {
      labels: Record<string, string>
      questions: { key: string }[]
    }
    const ids = listJudgments(db, runId).map((j) => j.listingId)
    const first = [...new Set(ids)][0]!
    expect(Object.keys(definition.labels)).toEqual(expect.arrayContaining([String(first)]))
    expect(definition.questions.map((q) => q.key)).toHaveLength(6)
  })

  it('does not change any listing’s stage', async () => {
    const { db, runId } = fixture(['survivor', 'detail_failed'])
    const stages = () =>
      db.prepare('select id, stage from listings order by id').all() as {
        id: number
        stage: string
      }[]
    const before = stages()

    await rejudgeRun({
      db,
      runId,
      draft: draft(),
      client: fakeClient() as never,
      batchSize: 10,
      emit: () => {},
    })

    // A re-judge re-asks; it does not make a listing more or less scraped.
    expect(stages()).toEqual(before)
  })

  it('publishes every event it stores, so a live viewer sees the re-judge', async () => {
    // `rejudgeRun` publishes; storing is the runner's job. The fixture's emit is
    // therefore the production one — append, then hand to the bus — so this
    // asserts the sequence and that a storing emit receives all of it.
    const { db, runId } = fixture(['judged', 'judged'])
    const published: string[] = []
    const emit = (type: Parameters<typeof appendEvent>[2], payload: unknown) => {
      appendEvent(db, runId, type, payload)
      published.push(type)
    }
    await rejudgeRun({
      db,
      runId,
      draft: draft(),
      client: fakeClient() as never,
      batchSize: 1,
      emit,
    })

    expect(published[0]).toBe('rejudge.started')
    expect(published).toContain('judgments.received')
    expect(published[published.length - 1]).toBe('rejudge.finished')
    expect(listEvents(db, runId).map((e) => e.type)).toEqual(expect.arrayContaining(published))
  })

  it('reports a failure instead of leaving a silent half-version', async () => {
    const { db, runId } = fixture(['judged', 'judged'])
    let calls = 0
    const failing = {
      systemOne: async ({ questions }: { questions: Record<string, unknown> }) => {
        calls++
        if (calls > 1) throw new Error('502 upstream')
        return {
          model: 'fake',
          answers: Object.fromEntries(
            Object.keys(questions).map((k) => [k, { type: 'noul', noul: 0.9 }]),
          ),
          usage: { input_tokens: 10, output_tokens: 0 },
        }
      },
    }
    const published: { type: string; payload: unknown }[] = []

    await expect(
      rejudgeRun({
        db,
        runId,
        draft: draft(),
        client: failing as never,
        batchSize: 1,
        emit: (type, payload) => {
          appendEvent(db, runId, type, payload)
          published.push({ type, payload })
        },
      }),
    ).rejects.toThrow(/502 upstream/)

    // The first batch's answers stay — they cost money and they are true.
    expect(listJudgments(db, runId).length).toBeGreaterThan(0)
    const failure = published.find((e) => e.type === 'rejudge.failed')
    expect(failure).toBeTruthy()
    expect(JSON.stringify(failure!.payload)).toContain('502 upstream')
    expect(listEvents(db, runId).map((e) => e.type)).toContain('rejudge.failed')
  })

  it('refuses a draft that could not be judged, before spending a call', async () => {
    const { db, runId } = fixture(['judged'])
    const client = fakeClient()
    const broken = draft()
    broken.questions = broken.questions.map((q) => ({ ...q, instructions: '' })) as never

    await expect(
      rejudgeRun({ db, runId, draft: broken, client: client as never, batchSize: 10, emit: () => {} }),
    ).rejects.toThrow(/wording/)

    expect(client.calls()).toBe(0)
    expect(listQuestionnaires(db, runId)).toHaveLength(0)
  })

  it('writes the buyer’s half back onto the run’s search, so the next fresh run filters on it', async () => {
    // Until this existed, every stored search had `spec: {}`: the editor wrote the
    // draft's request into the questionnaire and never back onto the search, so a
    // fresh run pre-filtered on nothing and `spec_match` asked JEV about "no
    // particular specification".
    const { db, runId, search } = fixture(['judged', 'judged'])
    await rejudgeRun({
      db,
      runId,
      draft: defaultDraft({
        keyword: 'k',
        criteria_text: '32gb ram, Ryzen, touch',
        spec: { ram_gb: 32, cpu_family: 'AMD Ryzen' },
        max_price: 1600,
        accepted_conditions: ['Open Box', 'Certified - Refurbished'],
      }),
      client: fakeClient() as never,
      batchSize: 3,
      emit: () => {},
    })

    const after = getSearch(db, search.id)!
    expect(after.criteriaText).toBe('32gb ram, Ryzen, touch')
    // The budget is mirrored into `spec`, which is where the pre-filter and the
    // eBay URL read it — the editor only edits the top-level one.
    expect(after.spec).toEqual({
      ram_gb: 32,
      cpu_family: 'AMD Ryzen',
      max_price: 1600,
      accepted_conditions: ['Open Box', 'Certified - Refurbished'],
    })
    // The name and keyword belong to the search; the editor does not edit them.
    expect(after.name).toBe('s')
    expect(after.keyword).toBe('k')
  })

  it('writes nothing back when the draft is refused', async () => {
    const { db, runId, search } = fixture(['judged'])
    const broken = defaultDraft({
      keyword: 'k',
      criteria_text: 'should never land',
      spec: { ram_gb: 64 },
      max_price: 999,
      accepted_conditions: ['Used'],
    })
    broken.questions = broken.questions.map((q) => ({ ...q, instructions: '' })) as never

    await expect(
      rejudgeRun({ db, runId, draft: broken, client: fakeClient() as never, batchSize: 10, emit: () => {} }),
    ).rejects.toThrow(/wording/)

    const after = getSearch(db, search.id)!
    expect(after.criteriaText).toBe('c')
    expect(after.spec).toEqual({})
  })

  it('keeps the written request when the judging itself fails', async () => {
    // The request is complete the moment its version exists: it is data, not an
    // answer. Writing it only on success would leave the newest version and the
    // search disagreeing after a failure — which is the gap this closes.
    const { db, runId, search } = fixture(['judged', 'judged'])
    let calls = 0
    const failing = {
      systemOne: async () => {
        calls++
        throw new Error('502 upstream')
      },
    }

    await expect(
      rejudgeRun({
        db,
        runId,
        draft: defaultDraft({
          keyword: 'k',
          criteria_text: 'written before the failure',
          spec: { ram_gb: 16 },
          max_price: undefined,
          accepted_conditions: ['Open Box'],
        }),
        client: failing as never,
        batchSize: 10,
        emit: () => {},
      }),
    ).rejects.toThrow(/502 upstream/)

    expect(calls).toBeGreaterThan(0)
    expect(getSearch(db, search.id)!.criteriaText).toBe('written before the failure')
    expect(getSearch(db, search.id)!.spec).toEqual({
      ram_gb: 16,
      accepted_conditions: ['Open Box'],
    })
  })
})

describe('startRejudge', () => {
  const idle = async (timeoutMs = 5000) => {
    const started = Date.now()
    while (isRunning() && Date.now() - started < timeoutMs) await new Promise((r) => setTimeout(r, 10))
  }

  it('publishes a failure when the job cannot start at all', async () => {
    // A throw before the pipeline's own emit used to leave no trace whatsoever:
    // no event, no row, no message — the caller had a version number and nothing
    // else. Rule 7: silence is a bug.
    const { db, runId } = fixture(['rejected', 'rejected'])
    startRejudge(db, { runId, draft: draft(), judgeClientFactory: () => fakeClient() as never })
    await idle()

    expect(listEvents(db, runId).map((e) => e.type)).toContain('rejudge.failed')
    expect(listQuestionnaires(db, runId)).toHaveLength(0)
  })

  it('refuses a second job while one is in flight', async () => {
    const { db, runId } = fixture(['judged'])
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const holding = () => ({
      async systemOne() {
        await hold
        return { model: 'fake', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }
      },
    })

    startRejudge(db, { runId, draft: draft(), judgeClientFactory: () => holding() as never })
    expect(() =>
      startRejudge(db, { runId, draft: draft(), judgeClientFactory: () => fakeClient() as never }),
    ).toThrow(/already in progress/)

    release()
    await idle()
  })
})
