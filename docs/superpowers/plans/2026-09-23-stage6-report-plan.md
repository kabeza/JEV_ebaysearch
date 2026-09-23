# Stage 6 — the report and controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn stored JEV judgments into a ranked, re-weightable report of matching eBay listings, with the URL, the raw answers and CSV/JSON export — all in the browser, over data already on the page.

**Architecture:** Ranking lives in three pure modules under `web/src/lib/` (`score.ts`, `sellerTrust.ts`, `export.ts`), unit-tested with vitest from `tests/`. Four presentational components under `web/src/components/` render them. `RunView.tsx` keeps owning the SSE stream and hands its survivor table to `ReportTable`, so one table serves both the live view and the finished report.

**Tech Stack:** React 19 + TypeScript, Vite, Tailwind v4 (palette in `web/src/styles/tokens.css`), vitest, Playwright (only in `scripts/repro-live-ui.ts`).

**Spec:** `docs/superpowers/specs/2026-09-23-stage6-report-design.md` — the plan argues from it, so read both. Parent spec: `docs/superpowers/specs/2026-09-18-jevbrowser-design.md` §5.6, §5.6.1, §5.6.2, §8.5.

## Global Constraints

- **Do not commit.** The owner commits himself, in Spanish one-liners, mid-session (see `CLAUDE.md`, "Conventions"). Every task ends when its tests and typecheck pass, not with a commit. The `git add`/`git commit` step in the standard task shape is replaced by `npm run typecheck`.
- `npm run typecheck` must stay clean — it runs `tsc --noEmit` on **both** the server and the web project. `npm test` runs vitest; the suite is 211 tests before this plan starts.
- **No hex colour literals outside `web/src/styles/tokens.css`.** Reference the palette by Tailwind name (`bg-space-indigo`, `text-seashell`, `text-lilac-ash`, `text-almond-silk`, `bg-dusty-grape`). Verify with `grep -rn '#[0-9a-fA-F]\{6\}' web/src --include='*.tsx' --include='*.ts'` — expect no hits.
- All ranking, weighting and thresholding happens in the browser over stored data. **No new endpoint, no server change, no fetch when a control moves.**
- The API key never reaches the browser; nothing in this plan touches it.
- A missing judgment is never a mediocre answer: it is excluded and the remaining weights renormalise (spec §3.3). A missing **gate** answer cannot pass a gate.
- Silence is a bug (`CLAUDE.md` rule 7), at the UI layer too: every empty or unavailable state prints a line saying so.
- Tests live in `tests/`, one file per module, and import the web modules directly (`tests/web-spec.test.ts` already does `from '../web/src/lib/spec'`).

## Review Focus

Five input classes the spec implies and the tests must pin, each most likely first:

1. **`shipping: null` (unknown) must not behave like `shipping: 0` (free).** One is no information, the other is the best possible rate; conflating them hands free-shipping's bonus to a listing nobody knows the cost of. Pinned in Task 2.
2. **A listing with partial judgments.** A survivor past `maxDetailVisits`, or one whose batch returned without an answer, has some signals and not others. It must be ranked on what it has, show which signal is missing, and **not** be pushed to the bottom as if it scored badly. Pinned in Task 3.
3. **A gate with no answer.** `is_target_product` missing is not a pass. The row must land in the discarded list with the reason, not in the matching list. Pinned in Task 3.
4. **A run in flight.** Rows appear before any judgment does; they must render with `not judged yet` and sort last on blend rather than at 0, which would be a rank the data does not support. Pinned in Task 3.
5. **Sellers whose feedback string is absent, `"PowerSeller"`, or `"99.8% positive (19K)"`.** The first two must produce no badge and no score (not a zero), the third must parse to 99.8 / 19000 and the trusted tier. Pinned in Task 1.

## File Structure

| File | Responsibility |
|---|---|
| `web/src/lib/sellerTrust.ts` | create — parse `"99.8% positive (19K)"`; classify the three tiers. No JSX, no fetch. |
| `web/src/lib/score.ts` | create — normalise answers, derive the shipping and feedback scales from the run, gates, weighted blend, sorting into buckets. |
| `web/src/lib/export.ts` | create — `toCsv`, `toJson`, `download`. |
| `tests/seller-trust.test.ts` | create — the parser and the tiers. |
| `tests/score.test.ts` | create — normalisation, scales, blend, gate and bucket behaviour. |
| `tests/export.test.ts` | create — CSV shape and JSON round-trip. |
| `web/src/components/SellerBadge.tsx` | create — the badge and its count. |
| `web/src/components/AnswerDetail.tsx` | create — `Answers` and `ListingDetailPanel`, moved out of `RunView.tsx` unchanged so the feed and a report row share one panel. |
| `web/src/components/WeightControls.tsx` | create — every control, one panel. |
| `web/src/components/ReportTable.tsx` | create — the ranked table: sorting, expansion, badges, highlight, discarded toggle, empty states. |
| `web/src/components/RunView.tsx` | modify — keep SSE/feed/header/cancel; survivor table becomes `<ReportTable>`; add the export buttons. |
| `scripts/repro-live-ui.ts` | modify — count fetches across a weight change; print `requests during a weight change: 0`. |

---

### Task 1: Seller trust parsing and tiers

**Files:**
- Create: `web/src/lib/sellerTrust.ts`
- Test: `tests/seller-trust.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TRUSTED_MIN_COUNT: number` (100), `type TrustTier = 'trusted' | 'flawless_new' | 'not_marked'`, `interface ParsedFeedback { pct: number; count: number }`, `interface SellerTrust { raw: string | null; pct: number | null; count: number | null; tier: TrustTier }`, `parseSellerFeedback(raw: string | null | undefined): ParsedFeedback | null`, `sellerTrust(raw: string | null | undefined): SellerTrust`.

- [ ] **Step 1: Write the failing test**

Real strings from 539 stored listings are the cases; `"PowerSeller"` is the shape eBay uses when it states no numbers.

```ts
import { describe, it, expect } from 'vitest'
import { parseSellerFeedback, sellerTrust, TRUSTED_MIN_COUNT } from '../web/src/lib/sellerTrust'

describe('parseSellerFeedback', () => {
  it('reads the percentage and a thousands-suffixed count', () => {
    expect(parseSellerFeedback('99.8% positive (19K)')).toEqual({ pct: 99.8, count: 19000 })
    expect(parseSellerFeedback('97.1% positive (969.9K)')).toEqual({ pct: 97.1, count: 969900 })
    expect(parseSellerFeedback('99.7% positive (346.5K)')).toEqual({ pct: 99.7, count: 346500 })
  })

  it('reads a small count and a decorated one', () => {
    expect(parseSellerFeedback('100% positive (45)')).toEqual({ pct: 100, count: 45 })
    expect(parseSellerFeedback('100% positive (1,234)')).toEqual({ pct: 100, count: 1234 })
  })

  it('reads millions', () => {
    expect(parseSellerFeedback('97.1% positive (1.2M)')).toEqual({ pct: 97.1, count: 1200000 })
  })

  it('returns null rather than guessing', () => {
    expect(parseSellerFeedback('PowerSeller')).toBeNull()
    expect(parseSellerFeedback('99.8% positive')).toBeNull()
    expect(parseSellerFeedback('')).toBeNull()
    expect(parseSellerFeedback(null)).toBeNull()
    expect(parseSellerFeedback(undefined)).toBeNull()
  })
})

describe('sellerTrust', () => {
  it('marks a flawless seller with a real record as trusted', () => {
    expect(sellerTrust('100% positive (17K)')).toMatchObject({ pct: 100, count: 17000, tier: 'trusted' })
  })

  it('keeps 100% of very few reviews in its own tier', () => {
    // 100% positive (45) is a real stored string, and it is not 100% of 17,000.
    expect(sellerTrust('100% positive (45)')).toMatchObject({ tier: 'flawless_new' })
    expect(sellerTrust('100% positive (99)')).toMatchObject({ tier: 'flawless_new' })
    expect(TRUSTED_MIN_COUNT).toBe(100)
  })

  it('does not mark below 100%, however large the count', () => {
    expect(sellerTrust('99.9% positive (92.1K)')).toMatchObject({ tier: 'not_marked' })
  })

  it('carries the raw string through and never invents numbers', () => {
    expect(sellerTrust('PowerSeller')).toEqual({ raw: 'PowerSeller', pct: null, count: null, tier: 'not_marked' })
    expect(sellerTrust(null)).toEqual({ raw: null, pct: null, count: null, tier: 'not_marked' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/seller-trust.test.ts`
Expected: FAIL — `Failed to resolve import "../web/src/lib/sellerTrust"`.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Seller feedback arrives as raw text on every card — `"99.8% positive (19K)"` —
 * so marking a seller costs no scraping and no JEV call (spec §5.6.1).
 *
 * The tier is split at the count because 100% of 3 reviews is not 100% of 17,000.
 * A binary "100%" badge would lend both the same confidence, so the count travels
 * with the badge and the reader judges for themselves.
 */

/** Below this many reviews, "100% positive" is not yet a record. */
export const TRUSTED_MIN_COUNT = 100

export type TrustTier = 'trusted' | 'flawless_new' | 'not_marked'

export interface ParsedFeedback {
  pct: number
  count: number
}

export interface SellerTrust {
  raw: string | null
  pct: number | null
  count: number | null
  tier: TrustTier
}

/** `17K`, `2.8K`, `1.2M`, `1,234`, `45` — the forms eBay actually writes. */
function parseCount(text: string): number | null {
  const cleaned = text.replace(/,/g, '')
  const match = /^(\d+(?:\.\d+)?)([KM])?$/.exec(cleaned)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  const suffix = match[2]
  if (suffix === 'K') return Math.round(value * 1_000)
  if (suffix === 'M') return Math.round(value * 1_000_000)
  return Math.round(value)
}

/**
 * `"99.1% positive (17K)"` -> `{ pct: 99.1, count: 17000 }`. Anything else is
 * null: a feedback string this code does not recognise is not a feedback score.
 */
export function parseSellerFeedback(raw: string | null | undefined): ParsedFeedback | null {
  if (!raw) return null
  const match = /^\s*(\d+(?:\.\d+)?)%\s+positive\s+\(([^)]+)\)\s*$/.exec(raw)
  if (!match) return null
  const pct = Number(match[1])
  const count = parseCount(match[2]!.trim())
  if (!Number.isFinite(pct) || count === null) return null
  return { pct, count }
}

export function sellerTrust(raw: string | null | undefined): SellerTrust {
  const parsed = parseSellerFeedback(raw)
  if (!parsed) return { raw: raw ?? null, pct: null, count: null, tier: 'not_marked' }
  const perfect = parsed.pct === 100
  const tier: TrustTier = !perfect
    ? 'not_marked'
    : parsed.count >= TRUSTED_MIN_COUNT
      ? 'trusted'
      : 'flawless_new'
  return { raw: raw ?? null, pct: parsed.pct, count: parsed.count, tier }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/seller-trust.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output from either project.

---

### Task 2: Normalising answers, and the two scales derived from the run

**Files:**
- Create: `web/src/lib/score.ts`
- Test: `tests/score.test.ts`

**Interfaces:**
- Consumes: `JevAnswer`, `Listing` from `./api`; `parseSellerFeedback`, `sellerTrust` (Task 1).
- Produces: `WEIGHTED_SIGNALS`, `GATE_SIGNALS`, `type WeightedSignal`, `type GateSignal`, `clamp01`, `normaliseAnswer`, `interface Scale`, `scaleOf`, `PAID_SHIPPING_CEILING` (0.9), `shippingScore`, `feedbackScore`.

- [ ] **Step 1: Write the failing test**

The two facts that make this non-trivial: a score answer is not an index (CLAUDE.md rule 12), and unknown shipping is not free shipping.

```ts
import { describe, it, expect } from 'vitest'
import {
  PAID_SHIPPING_CEILING,
  feedbackScore,
  normaliseAnswer,
  scaleOf,
  shippingScore,
} from '../web/src/lib/score'

describe('normaliseAnswer', () => {
  it('takes a noul at face value', () => {
    expect(normaliseAnswer({ type: 'noul', noul: 0.92 })).toBeCloseTo(0.92)
  })

  it('divides a score by its own legend, not by a hardcoded five', () => {
    const five = { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e' }
    const four = { '0': 'a', '1': 'b', '2': 'c', '3': 'd' }
    expect(normaliseAnswer({ type: 'score', score: 2.5, legend: five })).toBeCloseTo(0.625)
    expect(normaliseAnswer({ type: 'score', score: 3, legend: four })).toBeCloseTo(1)
  })

  it('returns null when there is no usable answer', () => {
    expect(normaliseAnswer(undefined)).toBeNull()
    expect(normaliseAnswer({ type: 'noul' })).toBeNull()
    expect(normaliseAnswer({ type: 'score', score: 2.5 })).toBeNull()
    expect(normaliseAnswer({ type: 'score', score: 2.5, legend: { '0': 'only' } })).toBeNull()
  })

  it('keeps a value inside 0…1 even if the API overshoots', () => {
    expect(normaliseAnswer({ type: 'noul', noul: 1.4 })).toBe(1)
    expect(normaliseAnswer({ type: 'noul', noul: -0.2 })).toBe(0)
  })
})

describe('scaleOf', () => {
  it('is null when nothing is known', () => {
    expect(scaleOf([])).toBeNull()
  })

  it('spans the known values', () => {
    expect(scaleOf([0, 8.18, 142.3])).toEqual({ min: 0, max: 142.3 })
  })
})

describe('shippingScore', () => {
  it('gives free shipping the top score', () => {
    expect(shippingScore(0, scaleOf([0, 40, 142.3]))).toBe(1)
  })

  it('puts the cheapest paid rate below free, never equal to it', () => {
    const paidOnly = shippingScore(8.18, scaleOf([0, 8.18, 142.3]))
    expect(paidOnly).toBeLessThan(1)
    expect(paidOnly).toBeCloseTo(PAID_SHIPPING_CEILING * (1 - 8.18 / 142.3))
  })

  it('scores the most expensive rate lowest', () => {
    expect(shippingScore(142.3, scaleOf([0, 142.3]))).toBe(0)
  })

  it('does not treat unknown shipping as free shipping', () => {
    expect(shippingScore(null, scaleOf([0, 142.3]))).toBeNull()
  })

  it('says nothing when every paid rate is identical', () => {
    expect(shippingScore(20, scaleOf([20, 20]))).toBe(0.5)
  })

  it('tops out at the ceiling when no listing ships free', () => {
    expect(shippingScore(5, scaleOf([5, 20]))).toBeCloseTo(PAID_SHIPPING_CEILING)
  })
})

describe('feedbackScore', () => {
  it('rescales to the run, not to the raw percentage', () => {
    const scale = scaleOf([97.1, 99.8, 100])
    expect(feedbackScore(100, scale)).toBeCloseTo(1)
    expect(feedbackScore(97.1, scale)).toBeCloseTo(0)
    expect(feedbackScore(99.8, scale)).toBeCloseTo((99.8 - 97.1) / (100 - 97.1))
  })

  it('is neutral when every seller is the same', () => {
    expect(feedbackScore(100, scaleOf([100, 100]))).toBe(0.5)
  })

  it('is null for a seller with no parseable record', () => {
    expect(feedbackScore(null, scaleOf([97.1, 100]))).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/score.test.ts`
Expected: FAIL — `Failed to resolve import "../web/src/lib/score"`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { JevAnswer } from './api'

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
 * Seller feedback rescaled to the run's own spread. Raw percentages sit in
 * 97–100% across 539 stored listings, so a slider over the raw value would move
 * nothing; rescaled, the best seller in the run is 1 and the worst is 0.
 */
export function feedbackScore(pct: number | null, scale: Scale | null): number | null {
  if (pct === null) return null
  if (!scale) return null
  if (scale.max === scale.min) return 0.5
  return clamp01((pct - scale.min) / (scale.max - scale.min))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/score.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

---

### Task 3: Gates, the blend, and the report's three buckets

**Files:**
- Modify: `web/src/lib/score.ts` (append; keep Task 2's exports untouched)
- Test: `tests/score.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: everything from Task 2; `Judgment`, `Listing` from `./api`; `sellerTrust`, `SellerTrust` from `./sellerTrust`.
- Produces:

```ts
export type SortColumn = 'blend' | 'price' | 'shipping' | 'title' | 'seller' | 'trust'
export interface Sort { column: SortColumn; direction: 'asc' | 'desc' }
export interface ReportSettings {
  weights: Record<WeightedSignal, number>
  gates: Record<GateSignal, number>
  matchThreshold: number
  highlightThreshold: number
  maxRows: number
  showDiscarded: boolean
  sort: Sort
}
export const DEFAULT_SETTINGS: ReportSettings
export interface ReportRow {
  listing: Listing
  answers: Record<string, JevAnswer>
  gates: Record<GateSignal, number | null>
  values: Record<WeightedSignal, number | null>
  blend: number | null
  passesGates: boolean
  matching: boolean
  highlighted: boolean
  /** Weighted signals this listing has no answer for. Shown in the row. */
  missing: WeightedSignal[]
  trust: SellerTrust
}
export interface Report {
  matching: ReportRow[]
  pending: ReportRow[]
  discarded: ReportRow[]
  matchingCount: number
  pendingCount: number
  discardedCount: number
  /** False when every weight is zero: there is no blend to show. */
  blendAvailable: boolean
}
export function buildReport(listings: Listing[], judgments: Judgment[], settings: ReportSettings): Report
```

- [ ] **Step 1: Write the failing test**

`pending` is the run-in-flight bucket: no judgments yet is not the same as rejected, and a `null` blend must sort last rather than at 0.

Extend the import block at the top of `tests/score.test.ts` (Task 2 put the `score` imports there)
rather than adding a second one:

```ts
import type { JevAnswer, Judgment, Listing } from '../web/src/lib/api'
import { buildReport, DEFAULT_SETTINGS, type ReportSettings } from '../web/src/lib/score'

function listing(over: Partial<Listing>): Listing {
  return {
    id: 1, itemId: '1', title: 'Lenovo ThinkPad T14s', url: 'https://www.ebay.com/itm/1',
    price: 1200, shipping: 0, conditionLabel: 'Certified - Refurbished',
    sellerName: 'themaxmart', sellerFeedback: '100% positive (19K)', watchers: null,
    buyingFormat: 'Buy It Now', sponsoredMarker: false, stage: 'judged', rejectReason: null,
    detail: null, ...over,
  }
}

const NOUL = (v: number): JevAnswer => ({ type: 'noul', noul: v })
const SCORE = (v: number): JevAnswer => ({
  type: 'score', score: v, confidence: 0.6,
  legend: { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e' },
  probabilities: { '0': 0.1, '1': 0.1, '2': 0.6, '3': 0.1, '4': 0.1 },
})

/** A fully judged listing: all six signals, all at 0.8 unless overridden. */
function judged(id: number, over: Partial<Record<string, JevAnswer>> = {}): Judgment[] {
  const answers: Record<string, JevAnswer> = {
    is_target_product: NOUL(0.9), condition_ok: NOUL(0.9), spec_match: NOUL(0.8),
    price_value: SCORE(3.2), listing_trust: SCORE(3.2), criteria_freeform: NOUL(0.8),
    ...over,
  }
  return Object.entries(answers).map(([questionKey, answer], i) => ({
    id: id * 100 + i, listingId: id, questionKey, answer,
  }))
}

function settings(over: Partial<ReportSettings> = {}): ReportSettings {
  return { ...DEFAULT_SETTINGS, ...over }
}

describe('buildReport gates', () => {
  it('keeps a listing that fails a gate out of the matching list, with its reason', () => {
    const listings = [listing({ id: 1 }), listing({ id: 2 })]
    const report = buildReport(listings, [
      ...judged(1),
      ...judged(2, { is_target_product: NOUL(0.02) }),
    ], settings())
    expect(report.matching.map((r) => r.listing.id)).toEqual([1])
    expect(report.discarded.map((r) => r.listing.id)).toEqual([2])
    expect(report.discarded[0]!.passesGates).toBe(false)
  })

  it('does not pass a gate that has no answer', () => {
    const listings = [listing({ id: 1 })]
    const judgments = judged(1).filter((j) => j.questionKey !== 'condition_ok')
    const report = buildReport(listings, judgments, settings())
    expect(report.matching).toHaveLength(0)
    expect(report.discarded).toHaveLength(1)
    expect(report.discarded[0]!.gates.condition_ok).toBeNull()
  })

  it('never highlights a listing that failed a gate, however low the highlight threshold', () => {
    const listings = [listing({ id: 1 })]
    const judgments = judged(1, { is_target_product: NOUL(0.4) })
    const report = buildReport(listings, judgments, settings({
      gates: { is_target_product: 0.9, condition_ok: 0 },
      highlightThreshold: 0,
    }))
    expect(report.matching).toHaveLength(0)
    expect(report.discarded[0]!.highlighted).toBe(false)
  })
})

describe('buildReport blend', () => {
  it('puts a listing with a missing signal above one that has it low, not below', () => {
    const partial = listing({ id: 1 })
    const low = listing({ id: 2 })
    const partialJudgments = judged(1).filter((j) => j.questionKey !== 'price_value')
    const lowJudgments = judged(2, { price_value: SCORE(0) })
    const report = buildReport([partial, low], [...partialJudgments, ...lowJudgments], settings())
    const ids = report.matching.map((r) => r.listing.id)
    expect(ids).toEqual([1, 2])
    expect(report.matching[0]!.missing).toEqual(['price_value'])
    expect(report.matching[1]!.missing).toEqual([])
  })

  it('renormalises rather than counting a missing signal as zero', () => {
    // One listing missing price_value, one with price_value at its worst.
    const missing = listing({ id: 1, shipping: 0 })
    const worst = listing({ id: 2, shipping: 0 })
    const a = judged(1).filter((j) => j.questionKey !== 'price_value')
    const b = judged(2, { price_value: SCORE(0) })
    const report = buildReport([missing, worst], [...a, ...b], settings())
    expect(report.matching[0]!.blend!).toBeGreaterThan(report.matching[1]!.blend!)
  })

  it('has no blend at all when every weight is zero', () => {
    const zero = Object.fromEntries(
      ['spec_match', 'price_value', 'listing_trust', 'criteria_freeform', 'seller_feedback', 'shipping']
        .map((k) => [k, 0]),
    ) as Record<string, number>
    const report = buildReport([listing({ id: 1 })], judged(1), settings({ weights: zero as never }))
    expect(report.blendAvailable).toBe(false)
    expect(report.matching[0]!.blend).toBeNull()
    // Unranked is not discarded: a row must not vanish for a reason nobody set.
    expect(report.discarded).toHaveLength(0)
  })

  it('honours the weights it is given', () => {
    const good = listing({ id: 1 })
    const tough = listing({ id: 2 })
    const a = judged(1, { spec_match: NOUL(1) })
    const b = judged(2, { spec_match: NOUL(0.1) })
    const report = buildReport([good, tough], [...a, ...b], settings({
      weights: { spec_match: 2, price_value: 0, listing_trust: 0, criteria_freeform: 0, seller_feedback: 0, shipping: 0 },
      matchThreshold: 0,
    }))
    expect(report.matching.map((r) => r.listing.id)).toEqual([1, 2])
    expect(report.matching[0]!.blend).toBeCloseTo(1)
    expect(report.matching[1]!.blend).toBeCloseTo(0.1)
  })
})

describe('buildReport buckets and order', () => {
  it('lists an unjudged survivor as pending, not discarded', () => {
    const report = buildReport([listing({ id: 1 })], [], settings())
    expect(report.pending.map((r) => r.listing.id)).toEqual([1])
    expect(report.matching).toHaveLength(0)
    expect(report.discarded).toHaveLength(0)
  })

  it('keeps an unjudged row out of the ranking entirely, not ranked at zero', () => {
    const report = buildReport(
      [listing({ id: 1 }), listing({ id: 2 })],
      judged(2),
      settings(),
    )
    expect(report.pending.map((r) => r.listing.id)).toEqual([1])
    expect(report.matching.map((r) => r.listing.id)).toEqual([2])
  })

  it('counts every bucket before the row limit is applied', () => {
    const listings = [listing({ id: 1 }), listing({ id: 2 }), listing({ id: 3 })]
    const report = buildReport(listings, [...judged(1), ...judged(2), ...judged(3)], settings({ maxRows: 1 }))
    expect(report.matching).toHaveLength(1)
    expect(report.matchingCount).toBe(3)
  })

  it('sorts by price ascending when asked, with unknown prices last', () => {
    const listings = [
      listing({ id: 1, price: 900 }),
      listing({ id: 2, price: null }),
      listing({ id: 3, price: 1500 }),
    ]
    const report = buildReport(listings, [...judged(1), ...judged(2), ...judged(3)], settings({
      sort: { column: 'price', direction: 'asc' },
    }))
    expect(report.matching.map((r) => r.listing.id)).toEqual([1, 3, 2])
  })
})

describe('buildReport derived signals', () => {
  it('reads the seller from the card and scales feedback across the run', () => {
    const listings = [
      listing({ id: 1, sellerFeedback: '97.1% positive (969.9K)' }),
      listing({ id: 2, sellerFeedback: '100% positive (19K)' }),
    ]
    const report = buildReport(listings, [...judged(1), ...judged(2)], settings())
    const byId = new Map(report.matching.map((r) => [r.listing.id, r]))
    expect(byId.get(2)!.values.seller_feedback).toBeCloseTo(1)
    expect(byId.get(1)!.values.seller_feedback).toBeCloseTo(0)
    expect(byId.get(2)!.trust.tier).toBe('trusted')
  })

  it('leaves an unparseable seller out of the blend instead of scoring it zero', () => {
    const listings = [
      listing({ id: 1, sellerFeedback: 'PowerSeller' }),
      listing({ id: 2, sellerFeedback: '100% positive (19K)' }),
    ]
    const report = buildReport(listings, [...judged(1), ...judged(2)], settings())
    const byId = new Map(report.matching.map((r) => [r.listing.id, r]))
    expect(byId.get(1)!.values.seller_feedback).toBeNull()
    expect(byId.get(1)!.missing).toContain('seller_feedback')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/score.test.ts`
Expected: FAIL — `buildReport` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `web/src/lib/score.ts`. The three new imports belong at the top of the file, beside the
`JevAnswer` import Task 2 already put there:

```ts
import type { JevAnswer, Judgment, Listing } from './api'
import { parseSellerFeedback, sellerTrust, type SellerTrust } from './sellerTrust'
```

Then the rest, appended below Task 2's code:

```ts
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

/** Everything a row needs that does not depend on the settings. */
function signalsFor(
  listing: Listing,
  answers: Record<string, JevAnswer>,
  shippingScale: Scale | null,
  feedbackScale: Scale | null,
): { gates: Record<GateSignal, number | null>; values: Record<WeightedSignal, number | null> } {
  const gates = {} as Record<GateSignal, number | null>
  for (const signal of GATE_SIGNALS) gates[signal] = normaliseAnswer(answers[signal])

  const parsed = parseSellerFeedback(listing.sellerFeedback ?? listing.detail?.sellerFeedback ?? null)
  const values = {
    spec_match: normaliseAnswer(answers.spec_match),
    price_value: normaliseAnswer(answers.price_value),
    listing_trust: normaliseAnswer(answers.listing_trust),
    criteria_freeform: normaliseAnswer(answers.criteria_freeform),
    seller_feedback: feedbackScore(parsed?.pct ?? null, feedbackScale),
    shipping: shippingScore(listing.shipping, shippingScale),
  } as Record<WeightedSignal, number | null>

  return { gates, values }
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
  const feedbackScale = scaleOf(
    listings
      .map((l) => parseSellerFeedback(l.sellerFeedback ?? null)?.pct)
      .filter((p): p is number => typeof p === 'number'),
  )

  const rows: ReportRow[] = listings.map((listing) => {
    const answers = byListing.get(listing.id) ?? {}
    const { gates, values } = signalsFor(listing, answers, shippingScale, feedbackScale)
    const missing = WEIGHTED_SIGNALS.filter((signal) => values[signal] === null)
    const passesGates = GATE_SIGNALS.every(
      (signal) => gates[signal] !== null && gates[signal]! >= settings.gates[signal],
    )
    const blend = blendOf(values, settings.weights)
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
      trust: sellerTrust(listing.sellerFeedback ?? listing.detail?.sellerFeedback ?? null),
    }
  })

  const judged = rows.filter((row) => Object.keys(row.answers).length > 0)
  const pending = rows.filter((row) => Object.keys(row.answers).length === 0)
  const matching = judged.filter((row) => row.matching).sort((a, b) => compare(a, b, settings.sort))
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/score.test.ts`
Expected: PASS. If the "all weights zero" case fails, check that `blendAvailable` is computed from `settings.weights` and not from the rows alone.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

---

### Task 4: Export

**Files:**
- Create: `web/src/lib/export.ts`
- Test: `tests/export.test.ts`

**Interfaces:**
- Consumes: `ReportRow` from `./score`.
- Produces: `toCsv(rows: ReportRow[]): string`, `toJson(rows: ReportRow[]): string`, `download(filename: string, contents: string, mime: string): void`, `CSV_COLUMNS`.

- [ ] **Step 1: Write the failing test**

The two properties that matter: the URL of every row is in both files, and the JSON still holds the raw answers so a run can be re-analysed without calling JEV again (spec §7).

```ts
import { describe, it, expect } from 'vitest'
import { toCsv, toJson, CSV_COLUMNS } from '../web/src/lib/export'
import type { ReportRow } from '../web/src/lib/score'
import type { JevAnswer, Listing } from '../web/src/lib/api'

const SCORE: JevAnswer = {
  type: 'score', score: 3.2, confidence: 0.6,
  legend: { '0': 'a', '4': 'e' }, probabilities: { '0': 0.1, '4': 0.9 },
}

function row(over: Partial<ReportRow> = {}): ReportRow {
  const listing: Listing = {
    id: 1, itemId: '205910982038', title: 'Lenovo ThinkPad T14s Gen 6, a "quoted" title',
    url: 'https://www.ebay.com/itm/205910982038', price: 1200, shipping: 0,
    conditionLabel: 'Certified - Refurbished', sellerName: 'themaxmart',
    sellerFeedback: '100% positive (19K)', watchers: 3, buyingFormat: 'Buy It Now',
    sponsoredMarker: false, stage: 'judged', rejectReason: null, detail: null,
  }
  return {
    listing,
    answers: { price_value: SCORE },
    gates: { is_target_product: 0.9, condition_ok: 0.9 },
    values: {
      spec_match: 0.8, price_value: 0.8, listing_trust: 0.8,
      criteria_freeform: 0.8, seller_feedback: 1, shipping: 1,
    },
    blend: 0.86, passesGates: true, matching: true, highlighted: true, missing: [],
    trust: { raw: '100% positive (19K)', pct: 100, count: 19000, tier: 'trusted' },
    ...over,
  }
}

describe('toCsv', () => {
  it('writes a header and one line per row', () => {
    const csv = toCsv([row(), row({ listing: { ...row().listing, id: 2, url: 'https://www.ebay.com/itm/2' } })])
    const lines = csv.trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('url')
    expect(lines[0]).toBe(CSV_COLUMNS.join(','))
  })

  it('carries the URL of every row', () => {
    expect(toCsv([row()])).toContain('https://www.ebay.com/itm/205910982038')
  })

  it('quotes a title containing a quote or a comma', () => {
    expect(toCsv([row()])).toContain('"Lenovo ThinkPad T14s Gen 6, a ""quoted"" title"')
  })

  it('writes the seller count and the trust tier as facts', () => {
    const csv = toCsv([row()])
    expect(csv).toContain('19000')
    expect(csv).toContain('trusted')
  })

  it('leaves a missing signal blank rather than writing zero', () => {
    const csv = toCsv([row({ values: { ...row().values, price_value: null } })])
    expect(csv.split('\n')[1]!.split(',')).toContain('')
    expect(csv.split('\n')[1]).not.toContain(',0,')
  })
})

describe('toJson', () => {
  it('keeps the raw answers, so a run can be re-analysed without JEV', () => {
    const parsed = JSON.parse(toJson([row()])) as { rows: ReportRow[] }[]
    expect(parsed).toHaveLength(1)
  })

  it('round-trips through JSON unchanged', () => {
    const rows = [row()]
    expect(JSON.parse(toJson(rows))).toEqual(JSON.parse(JSON.stringify(rows)))
  })

  it('keeps the legend and probabilities of a score answer', () => {
    const text = toJson([row()])
    expect(text).toContain('"probabilities"')
    expect(text).toContain('"legend"')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/export.test.ts`
Expected: FAIL — `Failed to resolve import "../web/src/lib/export"`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { ReportRow } from './score'
import { WEIGHTED_SIGNALS } from './score'

/**
 * What a run becomes once it leaves the browser.
 *
 * Two different jobs: the CSV is a table a person opens, so every answer is
 * resolved to one number and a missing answer is an empty cell. The JSON keeps
 * the answers exactly as JEV returned them — legend, probabilities, confidence —
 * because that is the file that can be re-analysed without paying for another
 * call (spec §7). Both carry the URL: a report of listings you cannot click
 * through to is not a report.
 */

export const CSV_COLUMNS = [
  'title',
  'url',
  'price',
  'shipping',
  'condition',
  'seller',
  'feedback',
  'trust',
  ...WEIGHTED_SIGNALS,
  'blend',
  'highlighted',
  'status',
] as const

function cell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function number(value: number | null): string {
  return value === null ? '' : value.toFixed(4)
}

export function toCsv(rows: ReportRow[]): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const row of rows) {
    lines.push(
      // Every field is escaped exactly once, by the `cell` at the end. Escaping
      // a field before building the row and again here doubles every quote —
      // which is what the first draft of this plan did, and the test caught.
      [
        row.listing.title,
        row.listing.url,
        row.listing.price === null ? '' : row.listing.price.toFixed(2),
        row.listing.shipping === null ? '' : row.listing.shipping.toFixed(2),
        row.listing.conditionLabel,
        row.listing.sellerName,
        row.trust.count,
        row.trust.tier,
        ...WEIGHTED_SIGNALS.map((signal) => number(row.values[signal])),
        number(row.blend),
        row.highlighted,
        row.matching ? 'matching' : 'discarded',
      ]
        .map(cell)
        .join(','),
    )
  }
  return `${lines.join('\n')}\n`
}

/** The rows as they stand, raw answers included. */
export function toJson(rows: ReportRow[]): string {
  return JSON.stringify(rows, null, 2)
}

/** Triggers a download from data already in the page — no endpoint (spec §7). */
export function download(filename: string, contents: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/export.test.ts`
Expected: PASS, 8 tests. The last `toJson` test asserts one object per row is preserved — if it fails, check `toJson` is not wrapping the array.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

---

### Task 5: SellerBadge, and moving the answer panels out of RunView

**Files:**
- Create: `web/src/components/SellerBadge.tsx`
- Create: `web/src/components/AnswerDetail.tsx`
- Modify: `web/src/components/RunView.tsx` (delete the two local components, import them)
- Test: none — components have no DOM test harness in this project (no jsdom, no testing-library, deliberately: see the spec §8). Verified by `npm run typecheck`, then by the repro script at the end of Task 8.

**Interfaces:**
- Consumes: `SellerTrust` (Task 1); `ListingAnswer` from `./lib/answers`; `Listing` from `./lib/api`.
- Produces: `SellerBadge({ trust }: { trust: SellerTrust })`, `Answers({ answers }: { answers: ListingAnswer[] })`, `ListingDetailPanel({ listing, answers }: { listing: Listing; answers: ListingAnswer[] })`.

- [ ] **Step 1: Create SellerBadge.tsx**

```tsx
import type { SellerTrust } from '../lib/sellerTrust'

/**
 * A seller's record, as three tiers rather than a binary (spec §5.6.1).
 *
 * The count is shown in every tier, including the solid one: 100% of 45 reviews
 * and 100% of 19,000 look identical if only the percentage is printed, and the
 * reader is the one who should decide what that is worth.
 */
export function SellerBadge({ trust }: { trust: SellerTrust }) {
  if (trust.tier === 'not_marked') return null
  const solid = trust.tier === 'trusted'
  return (
    <span
      title={
        solid
          ? `Flawless record over ${trust.count} reviews`
          : `Flawless, but only ${trust.count} reviews`
      }
      className={
        solid
          ? 'rounded bg-seashell px-1.5 py-0.5 text-xs text-space-indigo'
          : 'rounded border border-seashell/40 px-1.5 py-0.5 text-xs text-seashell/70'
      }
    >
      100%{trust.count === null ? '' : ` · ${trust.count.toLocaleString('en-US')}`}
    </span>
  )
}
```

Note: the count is formatted with an explicit locale so the string does not depend on the machine's ICU (the same reason `lib/spec.ts` groups digits by hand).

- [ ] **Step 2: Create AnswerDetail.tsx by moving code, not rewriting it**

Move `Answers` and `ListingDetailPanel` out of `RunView.tsx` verbatim — their bodies already render uncertainty honestly (`isUncertain`) and the item specifics. `AnswerDetail.tsx` starts with:

```tsx
import { summariseSpec } from '../lib/spec'
import {
  isUncertain,
  labelFor,
  levelFor,
  summariseAnswer,
  type ListingAnswer,
} from '../lib/answers'
import type { Listing } from '../lib/api'
```

then the two components exactly as they are in `RunView.tsx` today, with `export` added to each.
Delete them from `RunView.tsx` and import them instead. **Keep their bodies byte-for-byte**: they
already render noul-versus-score correctly and flag the fence with `isUncertain`, and rewriting them
is how the rule-12 trap gets reintroduced.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean. If it complains about an unused import in `RunView.tsx`, that import moved to `AnswerDetail.tsx`.

- [ ] **Step 4: Confirm the panels still render**

Start `npm run dev:web` in one terminal, then run `node --import tsx scripts/repro-live-ui.ts`.
Expected output is unchanged from before the move: `answers panel rendered: true`, a non-empty
`specifics panel:` block, and the same `final rows=` count. This is the only check the two moved
components get, so it is not optional.

---

### Task 6: The controls

**Files:**
- Create: `web/src/components/WeightControls.tsx`
- Modify: `web/src/components/RunView.tsx` (render it above the table)
- Test: none (no DOM harness); verified by typecheck and Task 9.

**Interfaces:**
- Consumes: `ReportSettings`, `WEIGHTED_SIGNALS`, `GATE_SIGNALS`, `DEFAULT_SETTINGS`, `type WeightedSignal`, `type GateSignal` (Task 3).
- Produces: `WeightControls({ settings, onChange, onReset, counts }: { settings: ReportSettings; onChange: (next: ReportSettings) => void; onReset: () => void; counts: { matching: number; discarded: number; pending: number } })`.

- [ ] **Step 1: Write the component**

Every control carries a stable `aria-label`, because that is what the browser-level check in Task 9 drives.

```tsx
import {
  DEFAULT_SETTINGS,
  GATE_SIGNALS,
  WEIGHTED_SIGNALS,
  type GateSignal,
  type ReportSettings,
  type WeightedSignal,
} from '../lib/score'
import { labelFor } from '../lib/answers'

/** Human names for the two signals that do not come from a question. */
const SIGNAL_LABELS: Record<string, string> = {
  seller_feedback: 'Seller feedback',
  shipping: 'Shipping cost',
}

function name(signal: string): string {
  return SIGNAL_LABELS[signal] ?? labelFor(signal)
}

interface Props {
  settings: ReportSettings
  onChange: (next: ReportSettings) => void
  onReset: () => void
  counts: { matching: number; discarded: number; pending: number }
}

/**
 * Every control in one panel, and every one of them local: moving a slider
 * re-sorts rows already in the page and costs no request (spec §5.6).
 */
export function WeightControls({ settings, onChange, onReset, counts }: Props) {
  // Typed by signal, not by string: the compiler then checks that a control
  // exists for every weighted signal and none that is not one.
  const setWeight = (signal: WeightedSignal, value: number) =>
    onChange({ ...settings, weights: { ...settings.weights, [signal]: value } })
  const setGate = (signal: GateSignal, value: number) =>
    onChange({ ...settings, gates: { ...settings.gates, [signal]: value } })

  return (
    <div className="mb-4 grid gap-4 rounded border border-lilac-ash/20 p-4 md:grid-cols-2">
      <div>
        <h3 className="mb-2 text-sm text-lilac-ash">Weights</h3>
        <ul className="space-y-1">
          {WEIGHTED_SIGNALS.map((signal) => (
            <li key={signal} className="flex items-center gap-3 text-sm">
              <span className="w-40 shrink-0 text-lilac-ash">{name(signal)}</span>
              <input
                type="range" min={0} max={2} step={0.1}
                aria-label={`weight ${signal}`}
                value={settings.weights[signal]}
                onChange={(e) => setWeight(signal, Number(e.target.value))}
                className="w-32"
              />
              <span className="font-mono text-almond-silk">{settings.weights[signal].toFixed(1)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="mb-2 text-sm text-lilac-ash">Gates — a listing below either is discarded</h3>
          <ul className="space-y-1">
            {GATE_SIGNALS.map((signal) => (
              <li key={signal} className="flex items-center gap-3 text-sm">
                <span className="w-40 shrink-0 text-lilac-ash">{name(signal)}</span>
                <input
                  type="range" min={0} max={1} step={0.05}
                  aria-label={`gate ${signal}`}
                  value={settings.gates[signal]}
                  onChange={(e) => setGate(signal, Number(e.target.value))}
                  className="w-32"
                />
                <span className="font-mono text-almond-silk">{settings.gates[signal].toFixed(2)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-sm text-lilac-ash">
          <label className="flex items-center gap-2">
            match
            <input
              type="range" min={0} max={1} step={0.05} aria-label="match threshold"
              value={settings.matchThreshold}
              onChange={(e) => onChange({ ...settings, matchThreshold: Number(e.target.value) })}
              className="w-28"
            />
            <span className="font-mono text-almond-silk">{settings.matchThreshold.toFixed(2)}</span>
          </label>
          <label className="flex items-center gap-2">
            highlight
            <input
              type="range" min={0} max={1} step={0.05} aria-label="highlight threshold"
              value={settings.highlightThreshold}
              onChange={(e) => onChange({ ...settings, highlightThreshold: Number(e.target.value) })}
              className="w-28"
            />
            <span className="font-mono text-almond-silk">{settings.highlightThreshold.toFixed(2)}</span>
          </label>
          <label className="flex items-center gap-2">
            max rows
            <input
              type="number" min={1} max={500} aria-label="max rows"
              value={settings.maxRows}
              onChange={(e) => onChange({ ...settings, maxRows: Math.max(1, Number(e.target.value)) })}
              className="w-16 rounded border border-lilac-ash/40 bg-transparent px-1 text-almond-silk"
            />
          </label>
        </div>

        <div className="flex items-center gap-4 text-sm">
          <label className="flex items-center gap-2 text-lilac-ash">
            <input
              type="checkbox" aria-label="show discarded"
              checked={settings.showDiscarded}
              onChange={(e) => onChange({ ...settings, showDiscarded: e.target.checked })}
            />
            show {counts.discarded} discarded
          </label>
          <button
            onClick={onReset}
            className="rounded border border-lilac-ash/50 px-2 py-1 text-xs text-lilac-ash"
          >
            reset to defaults
          </button>
          <span className="text-xs text-lilac-ash/60">defaults: {DEFAULT_SETTINGS.matchThreshold} match, {DEFAULT_SETTINGS.highlightThreshold} highlight</span>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire it into RunView**

In `RunView.tsx`: add `const [settings, setSettings] = useState<ReportSettings>(DEFAULT_SETTINGS)`, render `<WeightControls settings={settings} onChange={setSettings} onReset={() => setSettings(DEFAULT_SETTINGS)} counts={...} />` above the table, and pass `settings` down to the report (Task 7). `counts` comes from the report object built in Task 7 — render the control panel only once, above the table, so the numbers agree with the rows.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

---

### Task 7: The report table

**Files:**
- Create: `web/src/components/ReportTable.tsx`
- Modify: `web/src/components/RunView.tsx` (survivor table replaced by `<ReportTable>`)
- Test: none (no DOM harness); verified by typecheck and Task 9.

**Interfaces:**
- Consumes: `Report`, `ReportRow`, `ReportSettings`, `SortColumn` (Task 3); `SellerBadge` (Task 5); `ListingDetailPanel` (Task 5); `labelFor`, `summariseAnswer` from `./lib/answers`.
- Produces: `ReportTable({ report, settings, onSort, onToggleDiscarded }: { report: Report; settings: ReportSettings; onSort: (column: SortColumn) => void; onToggleDiscarded: (show: boolean) => void })`.

- [ ] **Step 1: Write the component**

```tsx
import { Fragment, useState } from 'react'
import { ListingDetailPanel } from './AnswerDetail'
import { SellerBadge } from './SellerBadge'
import { WEIGHTED_SIGNALS, type Report, type ReportSettings, type SortColumn } from '../lib/score'

function money(v: number | null): string {
  return v === null ? '—' : `$${v.toFixed(2)}`
}

const COLUMNS: { key: SortColumn; label: string; className?: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'price', label: 'Price', className: 'pr-3' },
  { key: 'shipping', label: 'Ship', className: 'pr-3' },
  { key: 'seller', label: 'Seller' },
  { key: 'trust', label: 'Feedback' },
  { key: 'blend', label: 'Blend' },
]

interface Props {
  report: Report
  settings: ReportSettings
  onSort: (column: SortColumn) => void
  onToggleDiscarded: (show: boolean) => void
}

/**
 * The report. Rows come in already scored and sorted — this component decides
 * nothing about ranking, which is why the controls above it can re-sort the
 * table without a request (spec §5.6).
 */
export function ReportTable({ report, settings, onSort, onToggleDiscarded }: Props) {
  const [openId, setOpenId] = useState<number | null>(null)

  const rows = [...report.matching, ...report.pending]
  const visible = settings.showDiscarded ? [...rows, ...report.discarded] : rows

  const header = (column: SortColumn, label: string, className?: string) => (
    <th key={column} className={`py-2 font-normal ${className ?? 'pr-3'}`}
        aria-sort={settings.sort.column === column
          ? settings.sort.direction === 'asc' ? 'ascending' : 'descending'
          : 'none'}>
      <button onClick={() => onSort(column)} className="text-lilac-ash hover:text-almond-silk">
        {label}
        {settings.sort.column === column ? (settings.sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  )

  return (
    <div className="overflow-x-auto">
      {!report.blendAvailable && (
        <p className="mb-2 rounded border border-almond-silk/40 bg-dusty-grape/30 p-2 text-sm text-almond-silk">
          Every weight is zero, so there is no blend and no order. Raise a weight to rank.
        </p>
      )}

      <table className="w-full text-left text-sm">
        <thead className="text-lilac-ash">
          <tr className="border-b border-lilac-ash/30">
            <th className="py-2 pr-1 font-normal" />
            {COLUMNS.map((c) => header(c.key, c.label, c.className))}
            <th className="py-2 font-normal">Condition</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => (
            <Fragment key={row.listing.id}>
              <tr
                className={`border-b border-lilac-ash/10 align-top ${
                  row.highlighted ? 'bg-seashell/10' : ''
                } ${row.matching ? '' : 'opacity-60'}`}
              >
                <td className="py-2 pr-1">
                  <button
                    onClick={() => setOpenId(openId === row.listing.id ? null : row.listing.id)}
                    aria-expanded={openId === row.listing.id}
                    aria-label={`answers for ${row.listing.title}`}
                    className="px-1 text-lilac-ash hover:text-almond-silk"
                  >
                    {openId === row.listing.id ? '▾' : '▸'}
                  </button>
                </td>
                <td className="py-2 pr-3">
                  <a href={row.listing.url} target="_blank" rel="noreferrer"
                     className="text-seashell hover:text-almond-silk">
                    {row.listing.title}
                  </a>
                  {row.highlighted && <span className="ml-2 text-xs text-almond-silk">best</span>}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap text-almond-silk">{money(row.listing.price)}</td>
                <td className="py-2 pr-3 whitespace-nowrap text-lilac-ash">{money(row.listing.shipping)}</td>
                <td className="py-2 pr-3 whitespace-nowrap text-lilac-ash">{row.listing.sellerName ?? '—'}</td>
                <td className="py-2 pr-3 whitespace-nowrap text-lilac-ash">
                  {row.trust.pct === null ? '—' : `${row.trust.pct}%`}{' '}
                  <SellerBadge trust={row.trust} />
                </td>
                <td className="py-2 pr-3 whitespace-nowrap font-mono text-almond-silk">
                  {row.blend === null ? '—' : row.blend.toFixed(3)}
                </td>
                <td className="py-2 whitespace-nowrap text-lilac-ash">
                  {row.listing.conditionLabel ?? '—'}
                </td>
              </tr>
              {openId === row.listing.id && (
                <tr className="border-b border-lilac-ash/10">
                  <td />
                  <td colSpan={7} className="py-3 pr-3">
                    <ListingDetailPanel
                      listing={row.listing}
                      answers={Object.entries(row.answers).map(([questionKey, answer]) => ({
                        questionKey,
                        answer,
                      }))}
                    />
                    {row.missing.length > 0 && (
                      <p className="mt-2 text-xs text-lilac-ash/70">
                        Not in the blend — no answer for{' '}
                        {row.missing.map((s) => s.replace(/_/g, ' ')).join(', ')}
                      </p>
                    )}
                    {Object.keys(row.answers).length === 0 && (
                      <p className="mt-2 text-xs text-lilac-ash/70">
                        Not judged yet — showing card data only, and it is not ranked.
                      </p>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}

          {visible.length === 0 && (
            <tr>
              <td colSpan={8} className="py-4 text-lilac-ash/70">
                {report.discardedCount > 0
                  ? `Nothing matched. ${report.discardedCount} judged listings were discarded — tick “show discarded” to inspect them.`
                  : report.pendingCount > 0
                    ? `${report.pendingCount} listings are waiting to be judged.`
                    : 'No listings yet.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <p className="mt-2 text-xs text-lilac-ash/70">
        {report.matchingCount} matching
        {report.matchingCount > settings.maxRows ? ` (showing ${settings.maxRows})` : ''} ·{' '}
        {report.discardedCount} discarded · {report.pendingCount} not judged yet
        {report.discardedCount > 0 && !settings.showDiscarded && (
          <>
            {' · '}
            <button
              onClick={() => onToggleDiscarded(true)}
              className="underline hover:text-almond-silk"
            >
              show discarded
            </button>
          </>
        )}
      </p>
      <p className="mt-1 text-xs text-lilac-ash/50">
        blend = weighted average of: {WEIGHTED_SIGNALS.join(', ')}
      </p>
    </div>
  )
}
```
Also import `ReportSettings` in the type imports (the skill's type-consistency check: it is referenced in `Props`).

- [ ] **Step 2: Replace RunView's table**

In `RunView.tsx`: build the report with `buildReport(survivors, judgments, settings)` (memoised with `useMemo` on `[listings, judgments, settings]`), drop the old `<table>` and its `openId` state, render `<ReportTable report={report} settings={settings} onSort={...} onToggleDiscarded={(show) => setSettings({ ...settings, showDiscarded: show })} />`, and pass `report`'s counts to `WeightControls`. `onSort` toggles direction when the column is already the sorted one, otherwise sets `{ column, direction: 'desc' }`.

The rejected-listings `<details>` block at the bottom stays exactly as it is: it is the pre-filter's audit trail, a different thing from the report's gates.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Colour-rule check**

Run: `grep -rn '#[0-9a-fA-F]\{6\}' web/src --include='*.tsx' --include='*.ts'`
Expected: no output.

---

### Task 8: The export buttons

**Files:**
- Modify: `web/src/components/RunView.tsx`
- Test: none (covered by `tests/export.test.ts`); verified by typecheck and Task 9.

**Interfaces:**
- Consumes: `toCsv`, `toJson`, `download` (Task 4).
- Produces: nothing later tasks use.

- [ ] **Step 1: Add the buttons to RunView's header**

Export writes **what the table is showing**: matching rows and, when the discarded toggle is on, the discarded ones too (spec §7).

```tsx
const exported = settings.showDiscarded ? [...report.matching, ...report.discarded] : report.matching

<button
  onClick={() => download(`run-${runId}-report.csv`, toCsv(exported), 'text/csv')}
  className="rounded border border-almond-silk/60 px-3 py-1.5 text-sm text-almond-silk"
>
  Export CSV ({exported.length})
</button>
<button
  onClick={() => download(`run-${runId}-report.json`, toJson(exported), 'application/json')}
  className="rounded border border-almond-silk/60 px-3 py-1.5 text-sm text-almond-silk"
>
  Export JSON
</button>
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Export by hand once**

Start `npm run dev:web`, open a stored run, click **Export CSV**, open the file, and confirm the URL column is populated for every row and that no cell reads `0` for a signal that was absent.

---

### Task 9: Prove the zero-request claim in the browser

**Files:**
- Modify: `scripts/repro-live-ui.ts`
- Test: the script itself is the test.

**Interfaces:**
- Consumes: the `aria-label`s from Task 6, the request log the script already installs, the run it already creates.
- Produces: a printed line `requests during a weight change: 0`.

- [ ] **Step 1: Extend the script**

The log already records every `fetch` (`window.__log` gains `['fetch', url, status]` in the init script). Append this after the existing answer-panel checks, before `await browser.close()`:

```ts
  // The acceptance criterion that cannot be tested without a browser: moving a
  // control re-sorts the table with zero network requests (spec §5.6).
  const fetchCount = async () =>
    page.evaluate(() =>
      (window as never as { __log: unknown[][] }).__log.filter((e) => e[0] === 'fetch').length,
    )
  const setRange = (label: string, value: string) =>
    page.evaluate(
      ({ label, value }) => {
        const input = document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null
        if (!input) return false
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      },
      { label, value },
    )

  const before = await fetchCount()
  const firstBefore = await page.locator('tbody tr >> nth=0').innerText()
  const moved = await setRange('weight spec_match', '0')
  await page.waitForTimeout(300)
  const after = await fetchCount()
  const firstAfter = await page.locator('tbody tr >> nth=0').innerText()
  const gateMoved = await setRange('gate condition_ok', '0.95')
  await page.waitForTimeout(300)
  const afterGate = await fetchCount()

  console.log(`\ncontrols: weight slider found=${moved} gate slider found=${gateMoved}`)
  console.log(`requests during a weight change: ${after - before}`)
  console.log(`requests during a gate change: ${afterGate - after}`)
  console.log(`first row changed by the weight: ${firstBefore !== firstAfter}`)
  console.log(`first row before: ${JSON.stringify(firstBefore.slice(0, 70))}`)
  console.log(`first row after:  ${JSON.stringify(firstAfter.slice(0, 70))}`)
```

- [ ] **Step 2: Run it**

Start `npm run dev:web` in another terminal, then:

```bash
node --import tsx scripts/repro-live-ui.ts
```

Expected, verbatim in spirit:
```
controls: weight slider found=true gate slider found=true
requests during a weight change: 0
requests during a gate change: 0
```

If `found=false`, the `aria-label` in `WeightControls.tsx` does not match the string in the script — fix the script, not the label.
If the request count is not 0, the control is triggering a refresh somewhere in `RunView`'s SSE handlers; a control must never call `refresh()`.

- [ ] **Step 3: Confirm the suite and the typecheck are still green**

Run: `npm test && npm run typecheck`
Expected: no failures (211 tests before this plan, plus roughly 44 new cases across the three new
test files) and a clean typecheck. The exact count is not the point — zero failures is.

- [ ] **Step 4: Update the parent plan**

In `docs/superpowers/plans/2026-09-18-jevbrowser-build-plan.md`, replace the Stage 6 section's body with a `## Stage 6 — report and controls (complete <date>)` section in the style of the Stage 3, 4 and 5 completion sections already there: what was built, what the probe or the browser check showed, and any finding that changed the code. Add the same summary to the **Handoff** section and move its "next" pointer to Stage 7. Do not delete the acceptance criteria that were written there — mark them met or unmet, as the earlier completion sections do.

## Self-Review

**Spec coverage.** §5.6 ranked list with URL → Tasks 3, 7. §5.6 weight sliders, match threshold, gate thresholds, sort by any column, max rows → Tasks 3, 6, 7. §5.6 row expansion with value, probabilities, confidence → Task 5 (moved unchanged) + Task 7. §5.6 CSV and JSON → Task 4, wired in Task 8. §5.6 no new scraping or JEV calls → Task 9 measures it. §5.6.1 three tiers, parse `17K`/`2.8K`/`1,234`, count always shown, null rather than a guess → Tasks 1, 5, 7. §5.6.2 gates first, weighted blend, highlight threshold, free shipping as a bonus, scale from the run's spread → Tasks 2, 3. §7 export shape → Task 4. §8 testing, and the deliberate absence of a DOM harness → Tasks 1–4 plus Task 9. §9 out of scope → no task touches re-judging, the sponsored marker, or a server endpoint.

**Placeholder scan.** No TBDs. Every code step carries the code. Task 5's instruction to move the two components is the one step that names code rather than reproducing it — that is deliberate: rewriting a panel that already renders noul-versus-score correctly is how the rule-12 trap gets reintroduced, and the source is in `RunView.tsx` at lines 38–120.

**Type consistency.** `SellerTrust`, `ParsedFeedback`, `TRUSTED_MIN_COUNT` (Task 1) are used unchanged in Tasks 3, 5, 7. `ReportRow`, `Report`, `ReportSettings`, `SortColumn`, `WEIGHTED_SIGNALS`, `GATE_SIGNALS`, `DEFAULT_SETTINGS` (Task 3) are used unchanged in Tasks 6, 7, 8. `toCsv`/`toJson`/`download`/`CSV_COLUMNS` (Task 4) are used unchanged in Task 8. `buildReport(listings, judgments, settings)` has the same signature in Task 3's tests and in Task 7's wiring.

**Review Focus.** The five input classes are each pinned by a named test in Tasks 1–3 (`shipping: null` versus `0`, partial judgments renormalising, a gate with no answer, an unjudged survivor in `pending`, unparseable feedback). Nothing in that list is left to a UI-level accident.
