/**
 * Probe: how large a JEV batch actually fits?
 *
 * The handoff's open question after the first real run (2026-09-23): `batchSize`
 * is 10 by default, and one real batch of 10 listings consumed 32,048 input
 * tokens — the same number as the agreed `state` limit. So the question is not
 * "is 10 too small" but "how much of the limit is state, and how much is the
 * questions the state is repeated into".
 *
 * Answering it needs no eBay page loads: it re-judges listings already stored,
 * and a JEV call costs a fraction of a cent. Two shapes per size —
 * `full` (the six real questions per listing) and `one` (a single question) —
 * so the difference between them isolates the state from the question text.
 *
 * Run with:
 *   node --env-file=.env --import tsx scripts/probe-batch-size.ts [runId]
 *
 * Delete once `batchSize` is settled: the numbers it prints belong in the plan.
 */
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
import { estimateCostUsd, LIMITS, MODEL_ALIAS } from '../src/shared/config'

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

/** Judged listings are the ones with a listing page behind them, so the state
 *  is the size a run really produces — not a card-only lower bound. */
const listings = listListings(db, runId)
  .filter((l) => l.stage === 'judged')
  .map(toQuestionListing)

console.log(`run ${runId} — search "${search.name}"`)
console.log(`${listings.length} judged listings available\n`)

const client = createJevClient()

interface Measurement {
  shape: 'full' | 'one'
  size: number
  tokens: number
  costUsd: number
  answers: number
}

async function measure(shape: 'full' | 'one', size: number): Promise<Measurement> {
  const batch = listings.slice(0, size)
  const all = buildQuestions(request, batch)
  const questions = shape === 'full' ? all : { [`${batch[0]!.label}.spec_match`]: all[`${batch[0]!.label}.spec_match`]! }
  const result = await client.systemOne({
    state: buildState(request, batch),
    questions,
    model: MODEL_ALIAS,
  })
  return {
    shape,
    size,
    tokens: result.usage.input_tokens,
    costUsd: estimateCostUsd(result.usage),
    answers: Object.keys(result.answers).length,
  }
}

const sizes = [1, 5, 10, 20].filter((n) => n <= listings.length)
const results: Measurement[] = []
for (const size of sizes) {
  for (const shape of ['full', 'one'] as const) {
    try {
      results.push(await measure(shape, size))
    } catch (err) {
      console.log(`${shape.padEnd(4)} n=${String(size).padStart(2)}  REFUSED: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

console.log('\nshape size  input_tokens   cost_usd   per_listing')
for (const r of results) {
  console.log(
    `${r.shape.padEnd(5)} ${String(r.size).padStart(3)}  ${String(r.tokens).padStart(12)}   ` +
      `${r.costUsd.toFixed(7)}   ${(r.tokens / r.size).toFixed(0).padStart(6)}`,
  )
}

const full20 = results.find((r) => r.shape === 'full' && r.size === 20)
const one20 = results.find((r) => r.shape === 'one' && r.size === 20)
const one10 = results.find((r) => r.shape === 'one' && r.size === 10)
const full10 = results.find((r) => r.shape === 'full' && r.size === 10)

console.log(`\nlimits: state ${LIMITS.stateTokens} tokens, context ${LIMITS.contextTokens}`)
if (one20 && one10) {
  const statePerListing = (one20.tokens - one10.tokens) / 10
  console.log(`state per listing (from one-question delta): ~${statePerListing.toFixed(0)} tokens`)
  console.log(`  => ${LIMITS.stateTokens} state budget leaves room for ~${Math.floor(LIMITS.stateTokens / statePerListing)} listings`)
}
if (full20 && one20) {
  const questionOverhead = full20.tokens - one20.tokens
  console.log(`question text for 20 listings x 6 questions: ~${questionOverhead} tokens`)
}
if (full10 && full20) {
  const perListing = (full20.tokens - full10.tokens) / 10
  console.log(`full request, per extra listing: ~${perListing.toFixed(0)} tokens`)
  console.log(`  => ${LIMITS.contextTokens} context leaves room for ~${Math.floor((LIMITS.contextTokens - full10.tokens) / perListing) + 10} listings per call`)
}
console.log(`total spent this probe: $${results.reduce((s, r) => s + r.costUsd, 0).toFixed(6)}`)
