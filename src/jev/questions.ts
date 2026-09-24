import { noul, score, type JsonValue, type Question, type ScoreCriteria } from '@typesafe-ai/sdk'
import type { RawDetail } from '../scraper/listing'
import type { SearchSpec } from '../storage/searches'
import {
  defaultDraft,
  questionPrefix,
  requirementsText,
  type QuestionnaireDraft,
} from './draft'

/**
 * The six questions JEV answers per listing (spec §8.4).
 *
 * Two rules shape everything here:
 *
 * 1. **Question keys are for code only — the model never sees them.** So every
 *    question has to carry its whole meaning in its text, including which listing
 *    it is about. That is why each opens by naming the listing rather than
 *    relying on the key.
 * 2. **The rubric is the answer.** A score question with vague levels gets a
 *    vague score, so the five levels are written out concretely and are
 *    mirrored by code in Stage 6 rather than reinterpreted there.
 */

export const QUESTION_KEYS = [
  'is_target_product',
  'spec_match',
  'condition_ok',
  'listing_trust',
  'price_value',
  'criteria_freeform',
] as const

export type QuestionKey = (typeof QUESTION_KEYS)[number]

/**
 * The SDK's own question type, built through its `noul` and `score` helpers.
 * Using them rather than hand-rolled objects means a change in what JEV accepts
 * breaks the build instead of a run.
 */
export type JevQuestion = Question

/**
 * Conditions the buyer accepts, written out in full because the model has to be
 * told which labels qualify. Used/parts are absent on purpose: eBay's own
 * condition vocabulary is not a filter the URL can express (see the build plan),
 * so it is expressed here instead.
 */
export const DEFAULT_ACCEPTED_CONDITIONS = [
  'Brand New',
  'Open Box',
  'Certified - Refurbished',
  'Excellent - Refurbished',
  'Very Good - Refurbished',
  'Good - Refurbished',
  'eBay Refurbished',
  'Manufacturer refurbished',
  'Seller refurbished',
]

/**
 * What the buyer asked for: the shared half of the state, sent once rather than
 * repeated per listing. Named to keep it distinct from `JevRequest` in
 * `client.ts`, which is the state-and-questions envelope for one API call.
 */
export interface SearchRequest {
  keyword: string
  criteria_text: string
  spec: SearchSpec
  max_price?: number
  accepted_conditions: string[]
}

/** One listing as the questions see it. */
export interface QuestionListing {
  label: string
  title: string
  price: number | null
  shipping: number | null
  conditionLabel: string | null
  sellerName: string | null
  sellerFeedback: string | null
  detail: RawDetail | null
}

/**
 * The spec as a JSON value. Only primitives travel: the stored spec carries an
 * open-ended `unknown` index signature, and sending something non-JSON would be
 * a request the API rejects at best and misreads at worst.
 */
export function toJsonSpec(spec: SearchSpec): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(spec)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    } else if (value === null) {
      out[key] = null
    }
  }
  return out
}

/**
 * The questions one batch will ask, from a draft rather than from the constants.
 *
 * This is where the SDK's `noul`/`score` helpers are used, which is why it lives
 * here and not in `draft.ts`: the browser's question editor reads the defaults
 * and the validation from that module, and building questions is a server job.
 */
export function buildFromDraft(
  draft: QuestionnaireDraft,
  listings: QuestionListing[],
): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {}

  for (const l of listings) {
    const prefix = questionPrefix(l)

    for (const question of draft.questions) {
      const text = `${prefix}${requirementsText(question.key, draft.request)}${question.instructions}`
      out[`${l.label}.${question.key}`] =
        question.kind === 'noul'
          ? noul(text, question.anchors)
          : // The SDK types the levels as a tuple of at least two; a draft's
            // levels are a plain array, and `validateDraft` is what guarantees
            // three to seven of them before anything gets here.
            score(text, question.levels as unknown as ScoreCriteria)
    }
  }

  return out
}

/**
 * The six shipped questions for one batch. A thin wrapper now: the text lives in
 * `draft.ts`, because a run has to be able to store and edit it (§5.7), and one
 * source means the shipped constants and the editor cannot disagree about what is
 * asked.
 */
export function buildQuestions(
  request: SearchRequest,
  listings: QuestionListing[],
): Record<string, JevQuestion> {
  return buildFromDraft(defaultDraft(request), listings)
}

/** The state half of the request: the search once, then the listings. */
export function buildState(request: SearchRequest, listings: QuestionListing[]) {
  return {
    // Spelled out rather than passed through, so the request is a JSON value by
    // construction — the stored spec's index signature is `unknown`.
    request: {
      keyword: request.keyword,
      criteria_text: request.criteria_text,
      spec: toJsonSpec(request.spec),
      max_price: request.max_price ?? null,
      accepted_conditions: request.accepted_conditions,
    },
    listings: listings.map((l) => ({
      label: l.label,
      title: l.title,
      price: l.price,
      shipping: l.shipping,
      card_condition: l.conditionLabel,
      seller: l.sellerName,
      seller_feedback: l.sellerFeedback,
      listing_page_condition: l.detail?.condition ?? null,
      item_specifics: l.detail?.specifics ?? null,
      // `item_specifics: null` alone cannot say whether the page had nothing to
      // state or was never opened, and only one of those licenses a guess. The
      // questions no longer say it in words, so the state says it here.
      listing_page_opened: l.detail !== null,
    })),
  }
}

/** "L3" — short, stable, and cheap to repeat in every question text. */
export function labelFor(index: number): string {
  return `L${index + 1}`
}
