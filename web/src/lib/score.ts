import type { JevAnswer, Judgment, Listing } from './api'
import { parseSellerFeedback, sellerTrust, type SellerTrust } from './sellerTrust'

/**
 * The composition, in code rather than in the model (spec §8.5).
 *
 * Two facts drive everything here. A noul answer is a probability on 0…1, while
 * a score answer is a probability-weighted value on the scale of its legend — a
 * five-level answer can read 2.18 — so a score is normalised by its own legend
 * length (CLAUDE.md rule 12). And a missing answer is not a mediocre answer: it
 * is excluded and the remaining weights renormalise, because inventing a 0.5 out
 * of silence is the same mistake `matchCondition` already refuses to make.
 */

/** Gates: absolute, never rescued by a good price. */
export const GATE_SIGNALS = ['is_target_product', 'condition_ok'] as const
export type GateSignal = (typeof GATE_SIGNALS)[number]

/** Weighted signals, in the order the controls show them. */
export const WEIGHTED_SIGNALS = [
  'spec_match',
  'price_value',
  'listing_trust',
  'criteria_freeform',
  'seller_feedback',
  'shipping',
] as const
export type WeightedSignal = (typeof WEIGHTED_SIGNALS)[number]

/** The best a paid shipping rate can score; free shipping is strictly above it. */
export const PAID_SHIPPING_CEILING = 0.9

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * One answer on 0…1, or null when there is nothing usable in it.
 *
 * For a score answer the legend length *is* the scale: four levels normalise
 * against four, not against five. One level is not a scale at all, so it is null.
 */
export function normaliseAnswer(answer: JevAnswer | undefined): number | null {
  if (!answer) return null
  if (typeof answer.noul === 'number') return clamp01(answer.noul)
  if (typeof answer.score === 'number') {
    const levels = answer.legend ? Object.keys(answer.legend).length : 0
    if (levels < 2) return null
    return clamp01(answer.score / (levels - 1))
  }
  return null
}

export interface Scale {
  min: number
  max: number
}

/** The range a run's own values span, so a slider stays meaningful on $0–$20 and $0–$200. */
export function scaleOf(values: number[]): Scale | null {
  const known = values.filter((v) => Number.isFinite(v))
  if (known.length === 0) return null
  return { min: Math.min(...known), max: Math.max(...known) }
}

/**
 * Shipping in absolute dollars, inverted and bounded (spec §5.6.2).
 *
 * `null` is "nobody knows what this costs" and stays null — it must never fall
 * through to the free-shipping branch, which is the best score there is.
 * The scale includes free rows, so a run whose cheapest option is free has
 * `min === 0` and its cheapest *paid* row lands just under the ceiling.
 */
export function shippingScore(shipping: number | null, scale: Scale | null): number | null {
  if (shipping === null) return null
  if (shipping === 0) return 1
  if (!scale) return null
  if (scale.max === scale.min) return 0.5
  return PAID_SHIPPING_CEILING * (1 - (shipping - scale.min) / (scale.max - scale.min))
}

/**
 * Seller feedback as a rank within the run: the best seller present is 1, the
 * worst is 0, and a tied group shares its rank.
 *
 * Ranked rather than rescaled between the run's minimum and maximum, because
 * real data contains records that are not sellers at all: 13 stored listings
 * carry `0% positive (0)`. Under a min-max rescale that one outlier set the
 * floor and compressed every real seller into 0.961–1.000, so the weight moved
 * almost nothing — the exact failure the rescale was introduced to avoid
 * (spec §3.2). A rank cannot be dragged by an outlier, and "better than the
 * other sellers in this run" is what the report is ranking on.
 */
export function feedbackRank(pct: number | null, values: number[]): number | null {
  if (pct === null) return null
  if (values.length < 2) return 0.5
  const sorted = [...values].sort((a, b) => a - b)
  let first = -1
  let last = -1
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== pct) continue
    if (first === -1) first = i
    last = i
  }
  // A percentage that is not in the run's own set has no rank among it.
  if (first === -1) return 0.5
  return clamp01((first + last) / 2 / (sorted.length - 1))
}

export type SortColumn = 'blend' | 'price' | 'shipping' | 'title' | 'seller' | 'trust'
export interface Sort {
  column: SortColumn
  direction: 'asc' | 'desc'
}

export interface ReportSettings {
  weights: Record<WeightedSignal, number>
  gates: Record<GateSignal, number>
  matchThreshold: number
  highlightThreshold: number
  maxRows: number
  showDiscarded: boolean
  sort: Sort
}

/**
 * Equal weights on purpose: the user controls them (spec §5.6), and an
 * opinionated default would be the app guessing at a ranking nobody stated.
 * Gate and match thresholds are the ones spec §8.5 already fixed.
 */
export const DEFAULT_SETTINGS: ReportSettings = {
  weights: {
    spec_match: 1,
    price_value: 1,
    listing_trust: 1,
    criteria_freeform: 1,
    seller_feedback: 1,
    shipping: 1,
  },
  gates: { is_target_product: 0.5, condition_ok: 0.5 },
  matchThreshold: 0.6,
  highlightThreshold: 0.75,
  maxRows: 50,
  showDiscarded: false,
  sort: { column: 'blend', direction: 'desc' },
}

export interface ReportRow {
  listing: Listing
  answers: Record<string, JevAnswer>
  gates: Record<GateSignal, number | null>
  values: Record<WeightedSignal, number | null>
  blend: number | null
  passesGates: boolean
  matching: boolean
  highlighted: boolean
  missing: WeightedSignal[]
  trust: SellerTrust
  /**
   * Why this row is not in the matching list, in words, or null when it is.
   *
   * Without it a gate reject and a threshold miss look identical in the table,
   * and the discarded toggle exists precisely so the reader can tell which
   * reject is absolute and which one their own thresholds caused (spec §5).
   */
  discardReason: string | null
}

export interface Report {
  matching: ReportRow[]
  pending: ReportRow[]
  discarded: ReportRow[]
  matchingCount: number
  pendingCount: number
  discardedCount: number
  blendAvailable: boolean
}

function answersOf(judgments: Judgment[]): Map<number, Record<string, JevAnswer>> {
  const out = new Map<number, Record<string, JevAnswer>>()
  for (const j of judgments) {
    const current = out.get(j.listingId) ?? {}
    current[j.questionKey] = j.answer
    out.set(j.listingId, current)
  }
  return out
}

/**
 * The seller feedback string for a listing: the card's, falling back to the
 * listing page's. Both the run's scale and the row's value go through here, so
 * the two can never be computed over different sets.
 */
function feedbackOf(listing: Listing): string | null {
  return listing.sellerFeedback ?? listing.detail?.sellerFeedback ?? null
}

/** Everything a row needs that does not depend on the settings. */
function signalsFor(
  listing: Listing,
  answers: Record<string, JevAnswer>,
  shippingScale: Scale | null,
  feedbackValues: number[],
): { gates: Record<GateSignal, number | null>; values: Record<WeightedSignal, number | null> } {
  const gates = {} as Record<GateSignal, number | null>
  for (const signal of GATE_SIGNALS) gates[signal] = normaliseAnswer(answers[signal])

  const parsed = parseSellerFeedback(feedbackOf(listing))
  const values = {
    spec_match: normaliseAnswer(answers.spec_match),
    price_value: normaliseAnswer(answers.price_value),
    listing_trust: normaliseAnswer(answers.listing_trust),
    criteria_freeform: normaliseAnswer(answers.criteria_freeform),
    seller_feedback: feedbackRank(parsed?.pct ?? null, feedbackValues),
    shipping: shippingScore(listing.shipping, shippingScale),
  } as Record<WeightedSignal, number | null>

  return { gates, values }
}

/** Why a judged row is not matching — in the reader's words, not a code. */
function reasonFor(
  gates: Record<GateSignal, number | null>,
  blend: number | null,
  settings: ReportSettings,
): string | null {
  for (const signal of GATE_SIGNALS) {
    const value = gates[signal]
    if (value === null) return `failed the ${signal} gate: no answer`
    if (value < settings.gates[signal]) {
      return `failed the ${signal} gate: ${value.toFixed(2)} below ${settings.gates[signal].toFixed(2)}`
    }
  }
  if (blend === null) return 'no weighted answers to blend'
  if (blend < settings.matchThreshold) {
    return `below the match threshold: ${blend.toFixed(3)} below ${settings.matchThreshold.toFixed(2)}`
  }
  return null
}

/**
 * The blend: a weighted average over the signals this listing actually has.
 * Missing signals are dropped and the remaining weights renormalise, so a
 * listing is never punished for an answer JEV never gave (spec §3.3).
 */
function blendOf(
  values: Record<WeightedSignal, number | null>,
  weights: Record<WeightedSignal, number>,
): number | null {
  let total = 0
  let weightsUsed = 0
  for (const signal of WEIGHTED_SIGNALS) {
    const value = values[signal]
    const weight = weights[signal]
    if (value === null || weight <= 0) continue
    total += weight * value
    weightsUsed += weight
  }
  return weightsUsed === 0 ? null : total / weightsUsed
}

function compare(a: ReportRow, b: ReportRow, sort: Sort): number {
  const flip = sort.direction === 'asc' ? 1 : -1
  switch (sort.column) {
    case 'blend':
      // Unknown is last whichever way the sort points: it is not a low score.
      if (a.blend === null && b.blend === null) return 0
      if (a.blend === null) return 1
      if (b.blend === null) return -1
      return (a.blend - b.blend) * flip
    case 'price':
    case 'shipping': {
      const av = a.listing[sort.column]
      const bv = b.listing[sort.column]
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      return (av - bv) * flip
    }
    case 'title':
      return a.listing.title.localeCompare(b.listing.title) * flip
    case 'seller':
      return (a.listing.sellerName ?? '').localeCompare(b.listing.sellerName ?? '') * flip
    case 'trust': {
      const rank = (pct: number | null): number => (pct === null ? -1 : pct)
      return (rank(a.trust.pct) - rank(b.trust.pct)) * flip
    }
  }
}

/**
 * Every survivor, sorted into the three things a reader needs to tell apart:
 * what matches, what has not been judged yet, and what a gate or the threshold
 * threw out. Nothing is dropped without a counter to say how many (CLAUDE.md
 * rule 7 — silence is a bug).
 */
export function buildReport(
  listings: Listing[],
  judgments: Judgment[],
  settings: ReportSettings,
): Report {
  const byListing = answersOf(judgments)
  const shippingScale = scaleOf(
    listings.map((l) => l.shipping).filter((s): s is number => typeof s === 'number'),
  )
  const feedbackValues = listings
    .map((l) => parseSellerFeedback(feedbackOf(l))?.pct)
    .filter((p): p is number => typeof p === 'number')

  const rows: ReportRow[] = listings.map((listing) => {
    const answers = byListing.get(listing.id) ?? {}
    const judged = Object.keys(answers).length > 0
    const { gates, values } = signalsFor(listing, answers, shippingScale, feedbackValues)
    const missing = WEIGHTED_SIGNALS.filter((signal) => values[signal] === null)
    const passesGates = GATE_SIGNALS.every(
      (signal) => gates[signal] !== null && gates[signal]! >= settings.gates[signal],
    )
    // A row nobody has judged has no blend: the signals left over (shipping, a
    // seller) would otherwise blend to 0.99 and outrank every judged listing on
    // the strength of two signals the questions have not spoken to yet.
    const blend = judged ? blendOf(values, settings.weights) : null
    // A row with no blend at all is neither matched nor discarded. Sending it to
    // the discarded list would hide it behind a counter for a reason the user
    // never chose, so it stays visible, unranked and last (see `compare`).
    const matching = passesGates && (blend === null || blend >= settings.matchThreshold)
    return {
      listing,
      answers,
      gates,
      values,
      blend,
      passesGates,
      matching,
      highlighted: matching && blend !== null && blend >= settings.highlightThreshold,
      missing,
      trust: sellerTrust(feedbackOf(listing)),
      discardReason: judged && !matching ? reasonFor(gates, blend, settings) : null,
    }
  })

  const judged = rows.filter((row) => Object.keys(row.answers).length > 0)
  const pending = rows.filter((row) => Object.keys(row.answers).length === 0)
  const matching = judged
    .filter((row) => row.matching)
    .sort((a, b) => compare(a, b, settings.sort))
  const discarded = judged
    .filter((row) => !row.matching)
    .sort((a, b) => compare(a, b, settings.sort))

  const blendAvailable = WEIGHTED_SIGNALS.some(
    (signal) => settings.weights[signal] > 0 && rows.some((row) => row.values[signal] !== null),
  )

  return {
    matching: matching.slice(0, settings.maxRows),
    pending,
    discarded: discarded.slice(0, settings.maxRows),
    matchingCount: matching.length,
    pendingCount: pending.length,
    discardedCount: discarded.length,
    blendAvailable,
  }
}
