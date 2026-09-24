import { describe, it, expect } from 'vitest'
import {
  TRUSTED_MIN_COUNT,
  parseSellerFeedback,
  sellerTrust,
  trustRowText,
} from '../web/src/lib/sellerTrust'

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
    expect(sellerTrust('100% positive (17K)')).toMatchObject({
      pct: 100,
      count: 17000,
      tier: 'trusted',
    })
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
    expect(sellerTrust('PowerSeller')).toEqual({
      raw: 'PowerSeller',
      pct: null,
      count: null,
      tier: 'not_marked',
    })
    expect(sellerTrust(null)).toEqual({ raw: null, pct: null, count: null, tier: 'not_marked' })
  })
})

describe('trustRowText', () => {
  it('shows the count in the tier with no badge, as spec §6 says it always does', () => {
    // The count is what tells 99.1% of 17,000 apart from 99.1% of 3 — and this is
    // the tier where the percentage is worst, so it is the last place to drop it.
    expect(trustRowText(sellerTrust('99.1% positive (17K)'))).toBe('99.1% · 17,000')
    expect(trustRowText(sellerTrust('97.1% positive (1.2M)'))).toBe('97.1% · 1,200,000')
  })

  it('leaves a badged seller to the badge, which already carries the count', () => {
    expect(trustRowText(sellerTrust('100% positive (17K)'))).toBeNull()
    expect(trustRowText(sellerTrust('100% positive (45)'))).toBeNull()
  })

  it('keeps a percentage with no count to pair it with, and says nothing where there is nothing', () => {
    // Built by hand: the parser drops the whole string when the count will not
    // read, so this branch is defensive — a percentage with no count is still
    // more than a dash.
    expect(trustRowText({ raw: 'x', pct: 99.1, count: null, tier: 'not_marked' })).toBe('99.1%')
    expect(trustRowText(sellerTrust('PowerSeller'))).toBe('—')
    expect(trustRowText(sellerTrust(null))).toBe('—')
  })
})
