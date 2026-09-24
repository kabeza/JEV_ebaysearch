import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/storage/db'
import {
  listJudgments,
  listQuestionnaires,
  nextQuestionnaireVersion,
  saveJudgments,
  saveQuestionnaire,
} from '../src/storage/judgments'
import { createRun } from '../src/storage/runs'
import { insertCards, listJudgeable, listToJudge } from '../src/storage/listings'
import { createSearch } from '../src/storage/searches'
import type { RawCard } from '../src/scraper/cards'

function fixture() {
  const db = openDatabase(':memory:')
  const search = createSearch(db, { name: 's', keyword: 'k', criteriaText: 'c', spec: {} })
  const run = createRun(db, search.id, {})
  return { db, runId: run.id }
}

const card = (itemId: string): RawCard => ({
  itemId,
  title: `Listing ${itemId}`,
  url: `https://www.ebay.com/itm/${itemId}`,
  price: 100,
  shipping: 0,
  currency: 'USD',
  conditionLabel: 'Open Box',
  sellerName: 'seller',
  sellerFeedback: '100% positive (45)',
  watchers: null,
  buyingFormat: 'Buy It Now',
  sponsoredMarker: false,
  rawText: [],
})

describe('questionnaire versions', () => {
  it('numbers versions from one, and hands out the next number', () => {
    const { db, runId } = fixture()
    expect(nextQuestionnaireVersion(db, runId)).toBe(1)
    saveQuestionnaire(db, runId, { request: {}, questions: [] }, nextQuestionnaireVersion(db, runId))
    expect(nextQuestionnaireVersion(db, runId)).toBe(2)
    saveQuestionnaire(db, runId, { request: {}, questions: [] }, nextQuestionnaireVersion(db, runId))
    expect(listQuestionnaires(db, runId).map((q) => q.version)).toEqual([1, 2])
  })

  it('keeps both versions’ answers, and returns both so the caller can pick', () => {
    // The trap: `listJudgments` returns every version for the run, and the report
    // keys answers by listing + question. Handed both, one version silently
    // overwrites the other, so the caller has to filter (Task 6).
    const { db, runId } = fixture()
    const stored = insertCards(db, runId, [card('1')])
    const listingId = stored.idsByItemId.get('1')!
    const v1 = saveQuestionnaire(db, runId, { request: {}, questions: [] }, 1)
    const v2 = saveQuestionnaire(db, runId, { request: {}, questions: [] }, 2)

    saveJudgments(db, {
      runId,
      questionnaireId: v1,
      listingId,
      answers: { condition_ok: { type: 'noul', noul: 0.9 } },
    })
    saveJudgments(db, {
      runId,
      questionnaireId: v2,
      listingId,
      answers: { condition_ok: { type: 'noul', noul: 0.2 } },
    })

    const all = listJudgments(db, runId)
    expect(all).toHaveLength(2)
    expect(all.map((j) => j.questionnaireId)).toEqual([v1, v2])
    expect(all[0]!.answer).toEqual({ type: 'noul', noul: 0.9 })
    expect(all[1]!.answer).toEqual({ type: 'noul', noul: 0.2 })
  })
})

describe('listJudgeable', () => {
  it('takes everything the pre-filter did not reject, including already-judged rows', () => {
    // `listToJudge` selects survivor/detail_failed, which is right for the first
    // judging and returns nothing at all for a re-judge — every row is `judged`
    // by then.
    const { db, runId } = fixture()
    const stored = insertCards(db, runId, [card('1'), card('2'), card('3')])
    const ids = ['1', '2', '3'].map((itemId) => stored.idsByItemId.get(itemId)!)
    db.prepare("update listings set stage = 'rejected' where id = ?").run(ids[0])
    db.prepare("update listings set stage = 'judged' where id = ?").run(ids[1])
    db.prepare("update listings set stage = 'detail_failed' where id = ?").run(ids[2])

    expect(listToJudge(db, runId).map((l) => l.id)).toEqual([ids[2]])
    expect(listJudgeable(db, runId).map((l) => l.id)).toEqual([ids[1], ids[2]])
  })
})
