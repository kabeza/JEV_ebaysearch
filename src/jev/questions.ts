import { noul, score, type JsonValue, type Question } from '@typesafe-ai/sdk'
import type { RawDetail } from '../scraper/listing'
import type { SearchSpec } from '../storage/searches'

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

function money(v: number | null): string {
  return v === null ? 'unknown' : `$${v.toFixed(2)}`
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

/** The buyer's spec in words, for questions that need to state it. */
function specProse(spec: SearchSpec): string {
  const parts: string[] = []
  if (typeof spec.ram_gb === 'number') parts.push(`${spec.ram_gb}GB of RAM or more`)
  if (typeof spec.storage_gb === 'number') {
    const gb = spec.storage_gb
    parts.push(`${gb % 1024 === 0 ? `${gb / 1024}TB` : `${gb}GB`} of storage or more`)
  }
  if (typeof spec.cpu_family === 'string' && spec.cpu_family.trim()) {
    parts.push(`an ${spec.cpu_family.trim()} processor`)
  }
  if (spec.touch === true) parts.push('a touchscreen')
  return parts.length > 0 ? parts.join(', ') : 'no particular specification'
}

/**
 * Everything known about one listing, as one paragraph. Stated once and reused
 * by all six questions: the model needs the same facts to answer each of them,
 * and repeating a different subset per question would invite inconsistent
 * answers.
 */
function facts(l: QuestionListing): string {
  const bits = [
    `Card condition: ${l.conditionLabel ?? 'not stated'}.`,
    l.detail?.condition ? `Listing page condition: ${l.detail.condition}.` : null,
    l.price === null ? null : `Price ${money(l.price)} plus ${money(l.shipping)} shipping.`,
    l.sellerName
      ? `Seller: ${l.sellerName}, feedback ${l.sellerFeedback ?? 'unknown'}.`
      : null,
    l.detail
      ? `Item specifics from the listing page: ${JSON.stringify(l.detail.specifics)}.`
      : 'No listing page was opened for this item; only the search card is available.',
  ]
  return bits.filter(Boolean).join(' ')
}

/** "About listing L3 — "Lenovo ThinkPad…" at $1,299.99: " */
function about(l: QuestionListing): string {
  return `About listing ${l.label} — "${l.title}" at ${money(l.price)}: `
}

export function buildQuestions(
  request: SearchRequest,
  listings: QuestionListing[],
): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {}
  const criteria = request.criteria_text

  for (const l of listings) {
    const prefix = `${about(l)}${facts(l)} `

    out[`${l.label}.is_target_product`] = noul(
        prefix +
        'Is this listing for the complete product itself — a working laptop computer — rather ' +
        'than an accessory, case, bag, charger, dock, cable, replacement keyboard, palmrest, ' +
        'screen panel, motherboard, battery, or a lot of parts? Answer whether it is the ' +
        'product, regardless of its condition, price or specification.',
      {
        true: 'A complete, working laptop computer.',
        false: 'Anything else: an accessory, a part, a consumable, or a lot of parts.',
      },
    )

    out[`${l.label}.spec_match`] = noul(
        prefix +
        `The buyer wants: ${specProse(request.spec)}. The buyer's own words were: "${criteria}". ` +
        "Does this listing's stated specification (processor family, memory, storage, screen, " +
        'touch) satisfy what the buyer asked for? Judge the specification only — not condition, ' +
        'price or trustworthiness. If the listing does not state something the buyer requires, ' +
        'do not assume it is satisfied.',
      {
        true: 'Everything the buyer requires is stated and satisfied.',
        false: 'Something required is contradicted by the listing, or is not stated at all.',
      },
    )

    out[`${l.label}.condition_ok`] = noul(
        prefix +
        `The buyer accepts only these conditions: ${request.accepted_conditions.join(', ')}. ` +
        'Anything used, pre-owned, or sold for parts is not acceptable. ' +
        'Is this listing in a condition the buyer accepts?',
      {
        true: 'The condition is one the buyer listed as acceptable.',
        false: 'Used, pre-owned, for parts, or a condition the buyer did not accept.',
      },
    )

    out[`${l.label}.listing_trust`] = score(
        prefix +
        'How trustworthy is this listing — judging the seller record, the wording of the ' +
        'listing, and whether the price or the detail looks evasive or contradictory?',
      [
        'Clear warning signs: an implausible price, contradictory wording, or a seller record that suggests risk.',
        'Something is off: a thin seller record, an evasive description, or details that do not add up.',
        'Ordinary: nothing reassuring and nothing alarming.',
        'Solid: an established seller with a good record and a clear, detailed listing.',
        'Fully reassuring: a strong seller record and complete, specific, consistent detail.',
      ],
    )

    out[`${l.label}.price_value`] = score(
        prefix +
        (request.max_price === undefined
          ? ''
          : `The buyer's budget is $${request.max_price} including shipping. `) +
        'How good is the value for money at this price, for this specification?',
      [
        'Well above the budget, or very poor value for the specification.',
        'Slightly above the budget, or mediocre value.',
        'At the top of the budget with fair value.',
        'Comfortably within budget with good value.',
        'Well below budget for this specification — unusually good value.',
      ],
    )

    out[`${l.label}.criteria_freeform`] = noul(
        prefix +
        `The buyer's own written criteria, quoted verbatim: "${criteria}". ` +
        'Does this listing satisfy them? This question catches anything the other questions miss.',
      {
        true: 'The listing satisfies the buyer, including anything the other questions miss.',
        false: 'Something in those criteria is not met.',
      },
    )
  }

  return out
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
    })),
  }
}

/** "L3" — short, stable, and cheap to repeat in every question text. */
export function labelFor(index: number): string {
  return `L${index + 1}`
}
