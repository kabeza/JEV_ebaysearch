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
 *   node --env-file=.env --import tsx scripts/probe-batch-size.ts [runId] [sizes] [--pool-repeat]
 *
 * `sizes` is a comma-separated list, defaulting to `1,5,10,20`.
 *
 * `--pool-repeat` is for the second question this probe had to answer on
 * 2026-09-25: **how large a batch fits now that the questions got cheaper?** The
 * only run with item specifics stored is run 8, and it has 20 listings — so a
 * larger size has no honest data behind it. Repeating the pool to fill the batch
 * measures exactly the right thing (tokens, and where JEV refuses) and the wrong
 * thing to read anything else from: the listings are the same ones, so the output
 * says so and the answer quality is not a result.
 *
 * Delete once `batchSize` is settled: the numbers it prints belong in the plan.
 */
import { openDatabase } from '../src/storage/db'
import { listListings, type StoredListing } from '../src/storage/listings'
import { listJudgments } from '../src/storage/judgments'
import { getSearch } from '../src/storage/searches'
import { createJevClient } from '../src/jev/client'
import {
  acceptedConditionsFrom,
  buildQuestions,
  buildState,
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
  accepted_conditions: acceptedConditionsFrom(search.spec),
}

/**
 * The listings to measure: those with answers behind them, from the run's own
 * judging or from a re-judge.
 *
 * Not `stage === 'judged'` — a re-judge never changes a listing's stage (rule 18),
 * so a run that the editor re-judged is still `card_only` and would be invisible
 * here. Run 8's pipeline-judged listings and run 7's re-judged ones are both found
 * this way, and a listing whose page was never read carries `detail: null`, which
 * is what makes its state the lower bound it is.
 */
const judgedIds = new Set(listJudgments(db, runId).map((j) => j.listingId))
const listings = listListings(db, runId)
  .filter((l) => judgedIds.has(l.id))
  .map((l, i) => toQuestionListing(l, i))

const poolRepeats = process.argv.includes('--pool-repeat')
const sizes = (process.argv[3] ?? '1,5,10,20')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)

console.log(`run ${runId} — search "${search.name}"`)
console.log(`${listings.length} judged listings available`)
console.log(`sizes: ${sizes.join(', ')}${poolRepeats ? ' (pool repeated to fill)' : ''}\n`)

/**
 * The batch for a size. With `--pool-repeat`, a size larger than the pool is
 * filled by repeating it, and the relabelled copies are counted so no reader
 * mistakes the row for a batch of distinct listings.
 */
function batchFor(size: number): { batch: QuestionListing[]; duplicated: number } {
  if (listings.length === 0) throw new Error('no judged listings to measure')
  if (!poolRepeats) return { batch: listings.slice(0, size), duplicated: 0 }

  const batch: QuestionListing[] = []
  for (let i = 0; i < size; i++) {
    const source = listings[i % listings.length]!
    batch.push({ ...source, label: labelFor(i) })
  }
  return { batch, duplicated: Math.max(0, size - listings.length) }
}

const client = createJevClient()

interface Measurement {
  shape: 'full' | 'one'
  size: number
  tokens: number
  costUsd: number
  answers: number
  duplicated: number
}

async function measure(shape: 'full' | 'one', size: number): Promise<Measurement> {
  const { batch, duplicated } = batchFor(size)
  const all = buildQuestions(request, batch)
  const questions =
    shape === 'full'
      ? all
      : { [`${batch[0]!.label}.spec_match`]: all[`${batch[0]!.label}.spec_match`]! }
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
    duplicated,
  }
}

const results: Measurement[] = []
const refused: { shape: string; size: number; message: string }[] = []
for (const size of sizes) {
  for (const shape of ['full', 'one'] as const) {
    try {
      results.push(await measure(shape, size))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      refused.push({ shape, size, message })
      console.log(
        `${shape.padEnd(4)} n=${String(size).padStart(2)}  REFUSED: ${message}`,
      )
    }
  }
}

console.log('\nshape size  input_tokens   cost_usd   per_listing  pct_of_context  duplicated')
for (const r of results) {
  const pct = ((r.tokens / LIMITS.contextTokens) * 100).toFixed(0)
  console.log(
    `${r.shape.padEnd(5)} ${String(r.size).padStart(3)}  ${String(r.tokens).padStart(12)}   ` +
      `${r.costUsd.toFixed(7)}   ${(r.tokens / r.size).toFixed(0).padStart(6)}` +
      `  ${pct.padStart(13)}%  ${String(r.duplicated).padStart(10)}`,
  )
}

// Where the run's own halving rule would land: the largest size that came back.
const largest = results.reduce((max, r) => Math.max(max, r.size), 0)
console.log(`\nlargest size that came back: ${largest > 0 ? largest : 'none'}`)
for (const r of refused) {
  console.log(`first refusal: ${r.shape} n=${r.size} — ${r.message.slice(0, 160)}`)
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
