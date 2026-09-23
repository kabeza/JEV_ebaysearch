import { describe, it, expect } from 'vitest'
import { CSV_COLUMNS, toCsv, toJson } from '../web/src/lib/export'
import type { ReportRow } from '../web/src/lib/score'
import type { JevAnswer, Listing } from '../web/src/lib/api'

const SCORE: JevAnswer = {
  type: 'score',
  score: 3.2,
  confidence: 0.6,
  legend: { '0': 'a', '4': 'e' },
  probabilities: { '0': 0.1, '4': 0.9 },
}

function row(over: Partial<ReportRow> = {}): ReportRow {
  const listing: Listing = {
    id: 1,
    itemId: '205910982038',
    title: 'Lenovo ThinkPad T14s Gen 6, a "quoted" title',
    url: 'https://www.ebay.com/itm/205910982038',
    price: 1200,
    shipping: 0,
    conditionLabel: 'Certified - Refurbished',
    sellerName: 'themaxmart',
    sellerFeedback: '100% positive (19K)',
    watchers: 3,
    buyingFormat: 'Buy It Now',
    sponsoredMarker: false,
    stage: 'judged',
    rejectReason: null,
    detail: null,
  }
  return {
    listing,
    answers: { price_value: SCORE },
    gates: { is_target_product: 0.9, condition_ok: 0.9 },
    values: {
      spec_match: 0.8,
      price_value: 0.8,
      listing_trust: 0.8,
      criteria_freeform: 0.8,
      seller_feedback: 1,
      shipping: 1,
    },
    blend: 0.86,
    passesGates: true,
    matching: true,
    highlighted: true,
    missing: [],
    trust: { raw: '100% positive (19K)', pct: 100, count: 19000, tier: 'trusted' },
    ...over,
  }
}

describe('toCsv', () => {
  it('writes a header and one line per row', () => {
    const csv = toCsv([
      row(),
      row({ listing: { ...row().listing, id: 2, url: 'https://www.ebay.com/itm/2' } }),
    ])
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
