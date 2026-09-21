import type { JevAnswer, Judgment } from './api'

/**
 * Rendering the answers without misrepresenting them.
 *
 * Two facts about JEV answers drive this (both verified against jev-1.13.0):
 * a noul answer is a probability on 0…1, while a score answer is a
 * probability-weighted value on the scale of its legend — a five-level answer
 * comes back as 2.18, not as an index. Blending them is Stage 6's job; here the
 * only responsibility is to show each answer for what it is.
 */

/** Human names for the question keys. Keys themselves mean nothing to the model. */
export const QUESTION_LABELS: Record<string, string> = {
  is_target_product: 'Is the product itself',
  spec_match: 'Matches the spec',
  condition_ok: 'Condition acceptable',
  listing_trust: 'Listing trust',
  price_value: 'Value for money',
  criteria_freeform: 'Matches your criteria',
}

/** The order to show them in: gates first, then the qualities they qualify. */
export const QUESTION_ORDER = [
  'is_target_product',
  'spec_match',
  'condition_ok',
  'price_value',
  'listing_trust',
  'criteria_freeform',
]

export function labelFor(key: string): string {
  return QUESTION_LABELS[key] ?? key.replace(/_/g, ' ')
}

/** The nearest legend level to a weighted score, for readability. */
export function levelFor(answer: JevAnswer): string | null {
  if (answer.score === undefined || !answer.legend) return null
  const keys = Object.keys(answer.legend)
  if (keys.length === 0) return null
  let best = keys[0]!
  let bestDistance = Number.POSITIVE_INFINITY
  for (const key of keys) {
    const index = Number(key)
    if (!Number.isFinite(index)) continue
    const distance = Math.abs(index - answer.score)
    if (distance < bestDistance) {
      bestDistance = distance
      best = key
    }
  }
  return answer.legend[best] ?? null
}

/** "noul 0.91" -> "91%"; "score 2.18" -> "2.18/4". */
export function summariseAnswer(answer: JevAnswer): string {
  if (typeof answer.noul === 'number') return `${Math.round(answer.noul * 100)}%`
  if (typeof answer.score === 'number') {
    const levels = answer.legend ? Object.keys(answer.legend).length : 5
    return `${answer.score.toFixed(2)}/${levels - 1}`
  }
  return '—'
}

/**
 * Whether JEV is sitting on the fence. The design surfaces these rather than
 * hiding them: uncertainty is the thing this app exists to let the user inspect.
 */
export function isUncertain(answer: JevAnswer): boolean {
  if (typeof answer.noul === 'number') return answer.noul >= 0.35 && answer.noul <= 0.65
  if (typeof answer.score === 'number') {
    const levels = answer.legend ? Object.keys(answer.legend).length : 5
    const middle = (levels - 1) / 2
    return Math.abs(answer.score - middle) <= (levels - 1) * 0.15
  }
  return false
}

/** One listing's answers, each with the question it belongs to. */
export interface ListingAnswer {
  questionKey: string
  answer: JevAnswer
}

/** Judgments grouped by listing, in the order a reader wants them. */
export function answersByListing(judgments: Judgment[]): Map<number, ListingAnswer[]> {
  const byListing = new Map<number, ListingAnswer[]>()
  for (const judgment of judgments) {
    const list = byListing.get(judgment.listingId) ?? []
    list.push({ questionKey: judgment.questionKey, answer: judgment.answer })
    byListing.set(judgment.listingId, list)
  }
  for (const list of byListing.values()) {
    list.sort(
      (a, b) => QUESTION_ORDER.indexOf(a.questionKey) - QUESTION_ORDER.indexOf(b.questionKey),
    )
  }
  return byListing
}
