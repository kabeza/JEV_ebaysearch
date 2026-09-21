import type { Database as SqliteDatabase } from 'better-sqlite3'
import { listSurvivors, updateListingStage, type StoredListing } from '../storage/listings'
import { saveJudgments, saveQuestionnaire } from '../storage/judgments'
import { chunk, halve, isTooLargeError } from '../jev/batch'
import {
  buildQuestions,
  buildState,
  labelFor,
  QUESTION_KEYS,
  type SearchRequest,
  type QuestionListing,
} from '../jev/questions'
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

export async function judgeSurvivors(o: JudgeOptions): Promise<JudgeOutcome> {
  const survivors = listSurvivors(o.db, o.runId)
  const outcome: JudgeOutcome = {
    judged: 0,
    batches: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    missingAnswers: 0,
    cancelled: false,
  }

  if (survivors.length === 0) return outcome

  const questionnaireId = saveQuestionnaire(o.db, o.runId, {
    request: o.request,
    questionKeys: QUESTION_KEYS,
  })

  const labelled = survivors.map(toQuestionListing)
  let batchIndex = 0
  // Reduced permanently by a refusal: the limit is a property of the request
  // size, not of the listings in it, so a size that was refused once will be
  // refused again. Retrying it per batch would spend calls to learn nothing.
  let batchSize = o.batchSize

  for (let start = 0; start < labelled.length; ) {
    if (o.isCancelled?.()) {
      outcome.cancelled = true
      return outcome
    }

    let size = Math.min(batchSize, labelled.length - start)
    let batch = labelled.slice(start, start + size)

    let result: Awaited<ReturnType<JevClient['systemOne']>>
    for (;;) {
      try {
        const state = buildState(o.request, batch)
        const questions = buildQuestions(o.request, batch)
        result = await o.client.systemOne({ state, questions })
        break
      } catch (err) {
        if (isTooLargeError(err) && size > 1) {
          // The request was too big: ask about fewer listings at once and try
          // again. This is the recovery the design asked for, and it makes an
          // oversized request a settings problem rather than a lost run.
          size = halve(size)
          batchSize = size
          batch = labelled.slice(start, start + size)
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

    for (let i = 0; i < batch.length; i++) {
      const question = batch[i]!
      const listing = survivors[start + i]
      if (!listing) continue

      const answers: Record<string, JevAnswer> = {}
      for (const key of QUESTION_KEYS) {
        const answer = result.answers[`${question.label}.${key}`]
        if (answer === undefined) {
          outcome.missingAnswers++
          continue
        }
        answers[key] = answer
      }
      saveJudgments(o.db, {
        runId: o.runId,
        questionnaireId,
        listingId: listing.id,
        answers,
      })
      // Judged: it now has answers, so it is no longer merely a survivor.
      updateListingStage(o.db, listing.id, 'judged', null)
      outcome.judged++
    }

    outcome.batches++
    outcome.costUsd = estimateCostUsd({
      input_tokens: outcome.inputTokens,
      output_tokens: outcome.outputTokens,
    })

    o.emit('judgments.received', {
      batch: batchIndex,
      listings: batch.length,
      questionKeys: QUESTION_KEYS,
      costUsd: outcome.costUsd,
      ...(outcome.missingAnswers > 0 ? { missingAnswers: outcome.missingAnswers } : {}),
    })

    start += batch.length
  }

  return outcome
}
