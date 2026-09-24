import type { Database as SqliteDatabase } from 'better-sqlite3'
import { listJudgeable, type StoredListing } from '../storage/listings'
import { nextQuestionnaireVersion, saveJudgments, saveQuestionnaire } from '../storage/judgments'
import {
  buildFromDraft,
  buildState,
  labelFor,
  QUESTION_KEYS,
  type QuestionListing,
} from '../jev/questions'
import { validateDraft, type QuestionnaireDraft } from '../jev/draft'
import type { JevClient } from '../jev/client'
import type { RunEventType } from '../storage/events'
import { askInBatches, type JudgeOutcome } from './judge'

/**
 * Asks JEV a stored run's questions again, under a new questionnaire version —
 * no eBay page, no scrape, no detail phase. Everything the questions need was
 * stored: the card, the detail, the seller record (spec §5.7).
 *
 * A re-judge never touches `listing.stage`: a listing is as scraped as it was.
 * It selects `listJudgeable` — everything the pre-filter kept — because after a
 * first judging `listToJudge` would return nothing at all, every row being
 * `judged` by then.
 */

export interface RejudgeOptions {
  db: SqliteDatabase
  runId: number
  draft: QuestionnaireDraft
  client: JevClient
  batchSize: number
  emit: (type: RunEventType, payload: unknown) => void
  isCancelled?: () => boolean
}

export interface RejudgeOutcome extends JudgeOutcome {
  questionnaireId: number
  version: number
}

function toQuestionListing(listing: StoredListing, index: number): QuestionListing {
  return {
    label: labelFor(index),
    title: listing.title,
    price: listing.price,
    shipping: listing.shipping,
    conditionLabel: listing.conditionLabel,
    sellerName: listing.sellerName,
    sellerFeedback: listing.sellerFeedback,
    detail: listing.detail,
  }
}

export async function rejudgeRun(o: RejudgeOptions): Promise<RejudgeOutcome> {
  // Before anything is spent: a draft the report could not rank is refused here,
  // so a bad edit costs one 400 and no JEV call.
  const reasons = validateDraft(o.draft)
  if (reasons.length > 0) {
    throw new Error(`This question set cannot be judged: ${reasons.join(' ')}`)
  }

  const listings = listJudgeable(o.db, o.runId)
  if (listings.length === 0) throw new Error(`Run ${o.runId} has no listings to judge`)

  const version = nextQuestionnaireVersion(o.db, o.runId)
  const labelled = listings.map(toQuestionListing)
  const questionnaireId = saveQuestionnaire(
    o.db,
    o.runId,
    {
      request: o.draft.request,
      questions: o.draft.questions,
      // Pinned rather than derived: the row diff compares two versions per
      // listing, and a query's order is not a contract.
      labels: Object.fromEntries(listings.map((l, i) => [String(l.id), labelFor(i)])),
      questionKeys: [...QUESTION_KEYS],
    },
    version,
  )

  o.emit('rejudge.started', {
    questionnaireId,
    version,
    listings: listings.length,
    questionKeys: QUESTION_KEYS,
  })

  try {
    const outcome = await askInBatches({
      client: o.client,
      batchSize: o.batchSize,
      emit: o.emit,
      isCancelled: o.isCancelled,
      labelled,
      listingIds: listings.map((l) => l.id),
      questionKeys: o.draft.questions.map((q) => q.key),
      questionsFor: (batch) => ({
        state: buildState(o.draft.request, batch),
        questions: buildFromDraft(o.draft, batch),
      }),
      onBatch: (results) => {
        for (const { listingId, answers } of results) {
          saveJudgments(o.db, { runId: o.runId, questionnaireId, listingId, answers })
        }
      },
    })

    o.emit('rejudge.finished', {
      questionnaireId,
      version,
      judged: outcome.judged,
      costUsd: outcome.costUsd,
      missingAnswers: outcome.missingAnswers,
      cancelled: outcome.cancelled,
    })

    return { ...outcome, questionnaireId, version }
  } catch (err) {
    // A half-finished version is visible, never silent: the rows already stored
    // stay (they cost money and they are true), and this event is why the rest
    // are missing. The report shows them as `pending`.
    o.emit('rejudge.failed', {
      questionnaireId,
      version,
      message: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}
