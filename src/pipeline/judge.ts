import type { Database as SqliteDatabase } from 'better-sqlite3'
import { listToJudge, updateListingStage, type StoredListing } from '../storage/listings'
import { nextQuestionnaireVersion, saveJudgments, saveQuestionnaire } from '../storage/judgments'
import { chunk, halve, isTooLargeError } from '../jev/batch'
import {
  buildQuestions,
  buildState,
  labelFor,
  QUESTION_KEYS,
  type JevQuestion,
  type SearchRequest,
  type QuestionListing,
} from '../jev/questions'
import { defaultDraft } from '../jev/draft'
import type { JevAnswer, JevClient } from '../jev/client'
import { estimateCostUsd } from '../shared/config'
import type { RunEventType } from '../storage/events'

/**
 * Asks JEV about every survivor, in batches, and stores every answer.
 *
 * The whole run's survivors are judged in one pass after the scraping and detail
 * phases, because the questions need the item specifics that the detail phase
 * fetched. Answers are stored as they arrive and published as they arrive: a
 * browser watching the run sees probabilities appear, and a browser that
 * refreshes gets them replayed from the event log.
 */

export interface JudgeOptions {
  db: SqliteDatabase
  runId: number
  request: SearchRequest
  client: JevClient
  batchSize: number
  emit: (type: RunEventType, payload: unknown) => void
  isCancelled?: () => boolean
}

export interface JudgeOutcome {
  judged: number
  batches: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  /** Question answers JEV did not return. Reported, never glossed over. */
  missingAnswers: number
  cancelled: boolean
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

/**
 * The batching loop, shared by a run's first judging and by a re-judge.
 *
 * It knows nothing about storage: it asks JEV about the listings it is given, in
 * batches, and hands each batch's answers back to its caller through `onBatch`,
 * which is where they are stored and where a caller's own bookkeeping (marking a
 * listing judged, say) belongs. A `422` halves the batch size **permanently for
 * the job**, because the limit is a property of the request size, not of the
 * listings in it — a size refused once will be refused again.
 */
export interface AskInBatchesOptions {
  client: JevClient
  batchSize: number
  emit: (type: RunEventType, payload: unknown) => void
  isCancelled?: () => boolean
  /** The listings, already labelled in their run's order. */
  labelled: QuestionListing[]
  /** Database ids, in the same order as `labelled`. */
  listingIds: number[]
  /** Which keys to read out of each answer map; the rest are counted missing. */
  questionKeys: readonly string[]
  questionsFor: (batch: QuestionListing[]) => {
    state: ReturnType<typeof buildState>
    questions: Record<string, JevQuestion>
  }
  onBatch: (
    results: { listing: QuestionListing; listingId: number; answers: Record<string, JevAnswer> }[],
  ) => void
}

function emptyOutcome(): JudgeOutcome {
  return {
    judged: 0,
    batches: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    missingAnswers: 0,
    cancelled: false,
  }
}

export async function askInBatches(o: AskInBatchesOptions): Promise<JudgeOutcome> {
  const outcome = emptyOutcome()
  if (o.labelled.length === 0) return outcome

  let batchIndex = 0
  let batchSize = o.batchSize

  for (let start = 0; start < o.labelled.length; ) {
    if (o.isCancelled?.()) {
      outcome.cancelled = true
      return outcome
    }

    let size = Math.min(batchSize, o.labelled.length - start)
    let batch = o.labelled.slice(start, start + size)

    let result: Awaited<ReturnType<JevClient['systemOne']>>
    for (;;) {
      try {
        const { state, questions } = o.questionsFor(batch)
        result = await o.client.systemOne({ state, questions })
        break
      } catch (err) {
        if (isTooLargeError(err) && size > 1) {
          size = halve(size)
          batchSize = size
          batch = o.labelled.slice(start, start + size)
          continue
        }
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(
          `A batch of ${size} listing${size === 1 ? '' : 's'} could not be judged: ${message}`,
        )
      }
    }

    outcome.inputTokens += result.usage.input_tokens
    outcome.outputTokens += result.usage.output_tokens
    batchIndex++

    const judged: { listing: QuestionListing; listingId: number; answers: Record<string, JevAnswer> }[] =
      []
    for (let i = 0; i < batch.length; i++) {
      const question = batch[i]!
      const listingId = o.listingIds[start + i]
      if (listingId === undefined) continue

      const answers: Record<string, JevAnswer> = {}
      for (const key of o.questionKeys) {
        const answer = result.answers[`${question.label}.${key}`]
        if (answer === undefined) {
          outcome.missingAnswers++
          continue
        }
        answers[key] = answer
      }
      judged.push({ listing: question, listingId, answers })
      outcome.judged++
    }
    o.onBatch(judged)

    outcome.batches++
    outcome.costUsd = estimateCostUsd({
      input_tokens: outcome.inputTokens,
      output_tokens: outcome.outputTokens,
    })

    o.emit('judgments.received', {
      batch: batchIndex,
      listings: batch.length,
      questionKeys: o.questionKeys,
      costUsd: outcome.costUsd,
      ...(outcome.missingAnswers > 0 ? { missingAnswers: outcome.missingAnswers } : {}),
    })

    start += batch.length
  }

  return outcome
}

export async function judgeSurvivors(o: JudgeOptions): Promise<JudgeOutcome> {
  // Survivors *and* listings whose detail page failed: both are judged, the
  // second on card data alone (run.ts, CLAUDE.md rule 17).
  const survivors = listToJudge(o.db, o.runId)
  if (survivors.length === 0) return emptyOutcome()

  // The questions are stored, not just their keys: a run has to be able to say
  // what it asked, and a later change to the shipped wording must not rewrite
  // what an old run claims to have asked (spec §5.7).
  const draft = defaultDraft(o.request)
  const questionnaireId = saveQuestionnaire(
    o.db,
    o.runId,
    {
      request: o.request,
      questions: draft.questions,
      labels: Object.fromEntries(survivors.map((l, i) => [String(l.id), labelFor(i)])),
      questionKeys: QUESTION_KEYS,
    },
    nextQuestionnaireVersion(o.db, o.runId),
  )

  return askInBatches({
    client: o.client,
    batchSize: o.batchSize,
    emit: o.emit,
    isCancelled: o.isCancelled,
    labelled: survivors.map(toQuestionListing),
    listingIds: survivors.map((l) => l.id),
    questionKeys: QUESTION_KEYS,
    questionsFor: (batch) => ({
      state: buildState(o.request, batch),
      questions: buildQuestions(o.request, batch),
    }),
    onBatch: (results) => {
      for (const { listingId, answers } of results) {
        saveJudgments(o.db, { runId: o.runId, questionnaireId, listingId, answers })
        // Judged: it now has answers, so it is no longer merely a survivor.
        updateListingStage(o.db, listingId, 'judged', null)
      }
    },
  })
}
