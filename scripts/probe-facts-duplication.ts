/**
 * Probe: do the questions need the listing's facts restated in every one of them?
 *
 * Measured on 2026-09-23 (rule 11b): a full request costs ~2,414–2,809 input
 * tokens per listing, of which 47,919 of 56,186 at n=20 are question text —
 * because `buildQuestions` writes the same facts paragraph into all six
 * questions, while `buildState` already carries the same fields once per listing.
 *
 * So this asks the only question that matters before touching `questions.ts`:
 * **does the model answer the same when the facts are stated once, in the state,
 * and each question refers to its listing by label?**
 *
 * Result (2026-09-24): the `facts` shape shipped — facts in the state, each question naming its
 * listing — at 44% fewer tokens and no gate flips. `current` below is now that shape, so the
 * comparison is a historical record of the change, not a live one: it stays as the harness for the
 * next person who edits the questions. Responses are cached in
 * `data/probe-facts-duplication.json`; `--force` pays for four fresh calls.
 *
 * Four calls, same listings, answers compared key by key:
 *
 *   current  today's questions (facts + the buyer's requirements in every one)
 *   repeat   `current` again — the noise floor. Without it a delta cannot be
 *            read as an effect, and a first pass mistook one for the other
 *   facts    the listing's facts paragraph removed; the buyer's words kept
 *   minimal  `facts`, and the buyer's requirements left to the state's request
 *
 * Run with:
 *   node --env-file=.env --import tsx scripts/probe-facts-duplication.ts [runId]
 *
 * Delete once the answer is settled: the numbers belong in the plan.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { noul, score, type Question } from '@typesafe-ai/sdk'
import { openDatabase } from '../src/storage/db'
import { listListings, type StoredListing } from '../src/storage/listings'
import { getSearch } from '../src/storage/searches'
import { createJevClient } from '../src/jev/client'
import {
  buildQuestions,
  buildState,
  DEFAULT_ACCEPTED_CONDITIONS,
  labelFor,
  type QuestionListing,
  type SearchRequest,
} from '../src/jev/questions'
import { estimateCostUsd, MODEL_ALIAS } from '../src/shared/config'
import { normaliseAnswer } from '../web/src/lib/score'
import type { JevAnswer } from '../web/src/lib/api'

const runId = Number(process.argv[2] ?? 8)

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

function money(v: number | null): string {
  return v === null ? 'unknown' : `$${v.toFixed(2)}`
}

/** `facts()` from `questions.ts`, copied so the probe can withhold it. */
function facts(l: QuestionListing): string {
  const bits = [
    `Card condition: ${l.conditionLabel ?? 'not stated'}.`,
    l.detail?.condition ? `Listing page condition: ${l.detail.condition}.` : null,
    l.price === null ? null : `Price ${money(l.price)} plus ${money(l.shipping)} shipping.`,
    l.sellerName ? `Seller: ${l.sellerName}, feedback ${l.sellerFeedback ?? 'unknown'}.` : null,
    l.detail
      ? `Item specifics from the listing page: ${JSON.stringify(l.detail.specifics)}.`
      : 'No listing page was opened for this item; only the search card is available.',
  ]
  return bits.filter(Boolean).join(' ')
}

function specProse(spec: SearchRequest['spec']): string {
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
 * The questions with two things that can be withheld independently: the
 * listing's own facts, and the buyer's requirements.
 *
 * A first pass withheld both at once and `price_value` moved on 15 of 20
 * listings, which says nothing about which of the two the model was using.
 */
function buildVariants(
  request: SearchRequest,
  listings: QuestionListing[],
  opts: { facts: boolean; buyerText: boolean },
): Record<string, Question> {
  const out: Record<string, Question> = {}
  const criteria = request.criteria_text

  for (const l of listings) {
    const head = `About listing ${l.label} — "${l.title}" at ${money(l.price)}: `
    const prefix = `${head}${opts.facts ? `${facts(l)} ` : `Its card, price, seller and item specifics are the state's entry for ${l.label}. `}`

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
        (opts.buyerText
          ? `The buyer wants: ${specProse(request.spec)}. The buyer's own words were: "${criteria}". `
          : '') +
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
        (opts.buyerText
          ? `The buyer accepts only these conditions: ${request.accepted_conditions.join(', ')}. `
          : '') +
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
        (opts.buyerText
          ? request.max_price === undefined
            ? ''
            : `The buyer's budget is $${request.max_price} including shipping. `
          : '') +
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
        (opts.buyerText ? `The buyer's own written criteria, quoted verbatim: "${criteria}". ` : '') +
        'Does this listing satisfy them? This question catches anything the other questions miss.',
      {
        true: 'The listing satisfies the buyer, including anything the other questions miss.',
        false: 'Something in those criteria is not met.',
      },
    )
  }

  return out
}

const db = openDatabase('data/jevbrowser.db')
const run = db.prepare('select search_id from runs where id = ?').get(runId) as
  | { search_id: number }
  | undefined
if (!run) throw new Error(`No run ${runId}`)

const search = getSearch(db, run.search_id)
if (!search) throw new Error(`No search ${run.search_id}`)

const request: SearchRequest = {
  keyword: search.keyword,
  criteria_text: search.criteriaText,
  spec: search.spec ?? {},
  max_price: typeof search.spec?.max_price === 'number' ? search.spec.max_price : undefined,
  accepted_conditions: DEFAULT_ACCEPTED_CONDITIONS,
}

const listings = listListings(db, runId)
  .filter((l) => l.stage === 'judged')
  .map(toQuestionListing)

console.log(`run ${runId} — search "${search.name}"`)
console.log(`${listings.length} judged listings, ${listings.length * 6} questions per shape\n`)

const client = createJevClient()
const state = buildState(request, listings)

interface Shape {
  name: string
  questions: Record<string, Question>
}

const shapes: Shape[] = [
  { name: 'current', questions: buildQuestions(request, listings) },
  { name: 'repeat', questions: buildQuestions(request, listings) },
  { name: 'facts', questions: buildVariants(request, listings, { facts: false, buyerText: true }) },
  {
    name: 'minimal',
    questions: buildVariants(request, listings, { facts: false, buyerText: false }),
  },
]

type Answers = Record<string, JevAnswer>
type Result = { tokens: number; costUsd: number; answers: Answers }
const results = new Map<string, Result>()

/** Four calls cost $0.007 and answer one question; the analysis is free to redo. */
const CACHE = 'data/probe-facts-duplication.json'

if (existsSync(CACHE) && !process.argv.includes('--force')) {
  const cached = JSON.parse(readFileSync(CACHE, 'utf8')) as Record<string, Result>
  for (const [name, result] of Object.entries(cached)) results.set(name, result)
  console.log(`reusing ${CACHE} — pass --force to pay for four fresh calls\n`)
} else {
  for (const shape of shapes) {
    const res = await client.systemOne({ state, questions: shape.questions, model: MODEL_ALIAS })
    results.set(shape.name, {
      tokens: res.usage.input_tokens,
      costUsd: estimateCostUsd(res.usage),
      answers: res.answers as unknown as Answers,
    })
  }
  writeFileSync(CACHE, JSON.stringify(Object.fromEntries(results), null, 2))
}

console.log('shape     tokens    cost_usd  answers')
for (const [name, r] of results) {
  console.log(
    `${name.padEnd(8)}  ${String(r.tokens).padStart(6)}  $${r.costUsd.toFixed(6)}  ` +
      `${String(Object.keys(r.answers).length).padStart(6)}`,
  )
}
const current = results.get('current')!
console.log(
  `\nspent this probe: $${[...results.values()].reduce((s, r) => s + r.costUsd, 0).toFixed(6)}`,
)

const norm = (a: JevAnswer | undefined) => normaliseAnswer(a as unknown as JevAnswer | undefined)

function compare(from: Answers, to: Answers, fromName: string, toName: string) {
  const perQuestion = new Map<string, { n: number; sum: number; max: number; moved: number }>()
  let moved = 0
  let missing = 0
  let gateFlips = 0

  for (const [key, answerBefore] of Object.entries(from)) {
    const a = norm(answerBefore)
    const b = norm(to[key])
    if (b === null) {
      missing++
      continue
    }
    if (a === null) continue
    const delta = Math.abs(a - b)
    const question = key.split('.').slice(1).join('.')
    const stat = perQuestion.get(question) ?? { n: 0, sum: 0, max: 0, moved: 0 }
    stat.n++
    stat.sum += delta
    stat.max = Math.max(stat.max, delta)
    if (delta > 0.05) stat.moved++
    perQuestion.set(question, stat)
    if (delta > 0.05) moved++

    if (/\.(is_target_product|condition_ok)$/.test(key)) {
      const flip = (v: number | null) => (v === null ? null : v >= 0.5)
      if (flip(a) !== flip(b)) gateFlips++
    }
  }

  const tokensFrom = results.get(fromName)!.tokens
  const tokensTo = results.get(toName)!.tokens
  console.log(
    `\n${fromName} vs ${toName}  — ${tokensFrom} → ${tokensTo} tokens ` +
      `(${(100 * (tokensFrom - tokensTo)) / tokensFrom > 0 ? '-' : '+'}${Math.abs((100 * (tokensFrom - tokensTo)) / tokensFrom).toFixed(1)}%)`,
  )
  console.log('question                 n   mean  max   moved>0.05')
  for (const [question, s] of perQuestion) {
    console.log(
      `${question.padEnd(22)} ${String(s.n).padStart(3)}   ${(s.sum / s.n).toFixed(3)}  ` +
        `${s.max.toFixed(3)}   ${String(s.moved).padStart(3)}`,
    )
  }
  console.log(`moved more than 0.05: ${moved} of ${Object.keys(from).length} · missing: ${missing} · gate flips: ${gateFlips}`)
}

compare(current.answers, results.get('repeat')!.answers, 'current', 'repeat')
compare(current.answers, results.get('facts')!.answers, 'current', 'facts')
compare(current.answers, results.get('minimal')!.answers, 'current', 'minimal')
