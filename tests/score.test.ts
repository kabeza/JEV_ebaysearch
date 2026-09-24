import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SETTINGS,
  PAID_SHIPPING_CEILING,
  WEIGHTED_SIGNALS,
  buildReport,
  feedbackRank,
  normaliseAnswer,
  scaleOf,
  shippingScore,
  type ReportSettings,
} from '../web/src/lib/score'
import type { JevAnswer, Judgment, Listing } from '../web/src/lib/api'

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

describe('feedbackRank', () => {
  it('ranks the run, so a junk record at the bottom cannot compress the rest', () => {
    // Found on real data: 13 stored rows carry `0% positive (0)`, and with a
    // min-max rescale that single outlier left every real seller inside
    // 0.961–1.000 — a weight over it moved almost nothing, which is the exact
    // failure the rescale was introduced to fix.
    const values = [0, 97.1, 99.8, 100]
    expect(feedbackRank(97.1, values)).toBeCloseTo(1 / 3)
    expect(feedbackRank(99.8, values)).toBeCloseTo(2 / 3)
    expect(feedbackRank(100, values)).toBeCloseTo(1)
    expect(feedbackRank(0, values)).toBe(0)
  })

  it('gives a tied group the same rank rather than an arbitrary order', () => {
    expect(feedbackRank(100, [97.1, 100, 100])).toBeCloseTo(1.5 / 2)
  })

  it('is neutral when there is nothing to compare against', () => {
    expect(feedbackRank(100, [100])).toBe(0.5)
    expect(feedbackRank(100, [])).toBe(0.5)
  })

  it('is null for a seller with no parseable record', () => {
    expect(feedbackRank(null, [97.1, 100])).toBeNull()
  })
})

function listing(over: Partial<Listing>): Listing {
  return {
    id: 1,
    itemId: '1',
    title: 'Lenovo ThinkPad T14s',
    url: 'https://www.ebay.com/itm/1',
    price: 1200,
    shipping: 0,
    conditionLabel: 'Certified - Refurbished',
    sellerName: 'themaxmart',
    sellerFeedback: '100% positive (19K)',
    watchers: null,
    buyingFormat: 'Buy It Now',
    sponsoredMarker: false,
    stage: 'judged',
    rejectReason: null,
    detail: null,
    ...over,
  }
}

const NOUL = (v: number): JevAnswer => ({ type: 'noul', noul: v })
const SCORE = (v: number): JevAnswer => ({
  type: 'score',
  score: v,
  confidence: 0.6,
  legend: { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e' },
  probabilities: { '0': 0.1, '1': 0.1, '2': 0.6, '3': 0.1, '4': 0.1 },
})

/** A fully judged listing: all six signals, all at 0.8 unless overridden. */
function judged(id: number, over: Partial<Record<string, JevAnswer>> = {}): Judgment[] {
  const answers: Record<string, JevAnswer> = {
    is_target_product: NOUL(0.9),
    condition_ok: NOUL(0.9),
    spec_match: NOUL(0.8),
    price_value: SCORE(3.2),
    listing_trust: SCORE(3.2),
    criteria_freeform: NOUL(0.8),
    ...over,
  }
  return Object.entries(answers).map(([questionKey, answer], i) => ({
    id: id * 100 + i,
    // One version: this file is about ranking, not about versions.
    questionnaireId: 1,
    listingId: id,
    questionKey,
    answer,
  }))
}

function settings(over: Partial<ReportSettings> = {}): ReportSettings {
  return { ...DEFAULT_SETTINGS, ...over }
}

/** Every weight at zero, typed as the settings field expects. */
function allZero(): ReportSettings['weights'] {
  return Object.fromEntries(WEIGHTED_SIGNALS.map((signal) => [signal, 0])) as ReportSettings['weights']
}

describe('buildReport gates', () => {
  it('keeps a listing that fails a gate out of the matching list, with its reason', () => {
    const listings = [listing({ id: 1 }), listing({ id: 2 })]
    const report = buildReport(
      listings,
      [...judged(1), ...judged(2, { is_target_product: NOUL(0.02) })],
      settings(),
    )
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
    const report = buildReport(
      listings,
      judgments,
      settings({ gates: { is_target_product: 0.9, condition_ok: 0 }, highlightThreshold: 0 }),
    )
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
    const missing = listing({ id: 1, shipping: 0 })
    const worst = listing({ id: 2, shipping: 0 })
    const a = judged(1).filter((j) => j.questionKey !== 'price_value')
    const b = judged(2, { price_value: SCORE(0) })
    const report = buildReport([missing, worst], [...a, ...b], settings())
    expect(report.matching[0]!.blend!).toBeGreaterThan(report.matching[1]!.blend!)
  })

  it('has no blend at all when every weight is zero', () => {
    const report = buildReport([listing({ id: 1 })], judged(1), settings({ weights: allZero() }))
    expect(report.matching[0]!.blend).toBeNull()
    // Unranked is not discarded: a row must not vanish for a reason nobody set.
    expect(report.discarded).toHaveLength(0)
  })

  it('reports every weight as zero only when every weight is zero', () => {
    const zero = buildReport([listing({ id: 1 })], judged(1), settings({ weights: allZero() }))
    expect(zero.allWeightsZero).toBe(true)

    const defaults = buildReport([listing({ id: 1 })], judged(1), settings())
    expect(defaults.allWeightsZero).toBe(false)
  })

  it('does not call the weights zero when there is simply nothing to blend yet', () => {
    // The banner used to fire here — at the start of every run, before the first
    // answer arrives — telling the reader their weights were zero when they were
    // not. Two different states were sharing one flag.
    const report = buildReport([listing({ id: 1 })], [], settings())
    expect(report.matching).toHaveLength(0)
    expect(report.pending).toHaveLength(1)
    expect(report.allWeightsZero).toBe(false)
  })

  it('names the signals kept out of a blend by a zero weight', () => {
    // A signal with a value is still not in the blend when its weight is zero,
    // and the row's note used to say only "no answer for" — so a reader could not
    // tell an answer that was never given from one they had just switched off.
    const report = buildReport(
      [listing({ id: 1 })],
      judged(1),
      settings({ weights: { ...DEFAULT_SETTINGS.weights, shipping: 0 } }),
    )
    const row = report.matching[0] ?? report.discarded[0]!
    expect(row.values.shipping).not.toBeNull()
    expect(row.missing).not.toContain('shipping')
    expect(row.zeroWeight).toEqual(['shipping'])
  })

  it('honours the weights it is given', () => {
    const good = listing({ id: 1 })
    const tough = listing({ id: 2 })
    const a = judged(1, { spec_match: NOUL(1) })
    const b = judged(2, { spec_match: NOUL(0.1) })
    const report = buildReport(
      [good, tough],
      [...a, ...b],
      settings({
        weights: {
          spec_match: 2,
          price_value: 0,
          listing_trust: 0,
          criteria_freeform: 0,
          seller_feedback: 0,
          shipping: 0,
        },
        matchThreshold: 0,
      }),
    )
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
    const report = buildReport([listing({ id: 1 }), listing({ id: 2 })], judged(2), settings())
    expect(report.pending.map((r) => r.listing.id)).toEqual([1])
    expect(report.matching.map((r) => r.listing.id)).toEqual([2])
  })

  it('counts every bucket before the row limit is applied', () => {
    const listings = [listing({ id: 1 }), listing({ id: 2 }), listing({ id: 3 })]
    const report = buildReport(
      listings,
      [...judged(1), ...judged(2), ...judged(3)],
      settings({ maxRows: 1 }),
    )
    expect(report.matching).toHaveLength(1)
    expect(report.matchingCount).toBe(3)
  })

  it('sorts by price ascending when asked, with unknown prices last', () => {
    const listings = [
      listing({ id: 1, price: 900 }),
      listing({ id: 2, price: null }),
      listing({ id: 3, price: 1500 }),
    ]
    const report = buildReport(
      listings,
      [...judged(1), ...judged(2), ...judged(3)],
      settings({ sort: { column: 'price', direction: 'asc' } }),
    )
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

describe('buildReport discard reasons and unjudged rows', () => {
  it('gives a row that has not been judged no blend at all', () => {
    // Mid-run the first batch is judged while later survivors are not. Those rows
    // have shipping and a seller, so a blend computed from those alone reads
    // 0.99+ and sorts above every judged listing — a rank the data cannot support.
    const report = buildReport([listing({ id: 9, shipping: 0 })], [], settings())
    expect(report.pending).toHaveLength(1)
    expect(report.pending[0]!.blend).toBeNull()
  })

  it('says which gate a discarded row failed, and by how much', () => {
    const report = buildReport(
      [listing({ id: 1 })],
      judged(1, { is_target_product: NOUL(0.02) }),
      settings(),
    )
    expect(report.discarded[0]!.discardReason).toBe(
      'failed the is_target_product gate: 0.02 below 0.50',
    )
  })

  it('says when a discarded row missed the match threshold instead', () => {
    const report = buildReport(
      [listing({ id: 1 })],
      judged(1, { spec_match: NOUL(0.2), criteria_freeform: NOUL(0.2) }),
      settings({ matchThreshold: 0.6 }),
    )
    const reason = report.discarded[0]!.discardReason ?? ''
    expect(reason).toMatch(/^below the match threshold: 0\.\d{3} below 0\.60$/)
  })

  it('says so when a row has no weighted answers to blend', () => {
    const zero = Object.fromEntries(
      ['spec_match', 'price_value', 'listing_trust', 'criteria_freeform', 'seller_feedback', 'shipping'].map(
        (k) => [k, 0],
      ),
    ) as Record<string, number>
    const report = buildReport([listing({ id: 1 })], judged(1), settings({ weights: zero as never }))
    expect(report.matching[0]!.discardReason).toBeNull()
  })
})
