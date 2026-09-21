import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ACCEPTED_CONDITIONS,
  QUESTION_KEYS,
  buildQuestions,
  buildState,
  type QuestionListing,
  type SearchRequest,
} from '../src/jev/questions'

const request: SearchRequest = {
  keyword: 'Thinkpad T14s gen 6',
  criteria_text: '32gb ram, Ryzen, 1tb, touch screen, under u$s 1600',
  spec: { cpu_family: 'AMD Ryzen', ram_gb: 32, storage_gb: 1024, touch: true },
  max_price: 1600,
  accepted_conditions: DEFAULT_ACCEPTED_CONDITIONS,
}

function listing(over: Partial<QuestionListing> = {}): QuestionListing {
  return {
    label: 'L1',
    title: 'Lenovo ThinkPad T14s Gen 6 32GB RAM 1TB SSD AMD Ryzen 7',
    price: 1200,
    shipping: 0,
    conditionLabel: 'Open Box',
    sellerName: 'store',
    sellerFeedback: '99.1% positive',
    detail: null,
    ...over,
  }
}

describe('buildQuestions', () => {
  it('asks all six questions for every listing, keyed for code and prefixed by the listing label', () => {
    const q = buildQuestions(request, [listing({ label: 'L1' }), listing({ label: 'L2' })])
    expect(Object.keys(q)).toHaveLength(12)
    for (const label of ['L1', 'L2']) {
      for (const key of QUESTION_KEYS) expect(q).toHaveProperty(`${label}.${key}`)
    }
  })

  it('gives each question the type the design calls for', () => {
    const q = buildQuestions(request, [listing()])
    expect(q['L1.is_target_product']).toMatchObject({ type: 'noul' })
    expect(q['L1.spec_match']).toMatchObject({ type: 'noul' })
    expect(q['L1.condition_ok']).toMatchObject({ type: 'noul' })
    expect(q['L1.criteria_freeform']).toMatchObject({ type: 'noul' })
    expect(q['L1.listing_trust']).toMatchObject({ type: 'score' })
    expect(q['L1.price_value']).toMatchObject({ type: 'score' })
  })

  // Keys are for code only: the model never sees them, so a question that does
  // not name its listing is asking about ten listings at once.
  it('names the listing in the question text, because the key is invisible to the model', () => {
    const q = buildQuestions(request, [listing({ title: 'Lenovo ThinkPad T14s Gen 6 14" WUXGA' })])
    for (const key of QUESTION_KEYS) {
      expect(q[`L1.${key}`]!.instructions).toContain('L1')
      expect(q[`L1.${key}`]!.instructions).toContain('Lenovo ThinkPad T14s Gen 6 14" WUXGA')
    }
  })

  it('quotes the buyer criteria verbatim where the design says to', () => {
    const q = buildQuestions(request, [listing()])
    expect(q['L1.criteria_freeform']!.instructions).toContain(
      '"32gb ram, Ryzen, 1tb, touch screen, under u$s 1600"',
    )
    expect(q['L1.spec_match']!.instructions).toContain(
      '"32gb ram, Ryzen, 1tb, touch screen, under u$s 1600"',
    )
  })

  it('spells out every accepted condition rather than saying "refurbished"', () => {
    const q = buildQuestions(request, [listing()])
    for (const condition of DEFAULT_ACCEPTED_CONDITIONS) {
      expect(q['L1.condition_ok']!.instructions).toContain(condition)
    }
    expect(q['L1.condition_ok']!.instructions).toMatch(/used, pre-owned/)
  })

  it('gives score questions five rubric levels', () => {
    const q = buildQuestions(request, [listing()])
    expect(q['L1.price_value']!.criteria).toHaveLength(5)
    expect(q['L1.listing_trust']!.criteria).toHaveLength(5)
  })

  it('describes both outcomes of every noul question, so a probability has anchors', () => {
    const q = buildQuestions(request, [listing()])
    for (const key of ['is_target_product', 'spec_match', 'condition_ok', 'criteria_freeform']) {
      const criteria = q[`L1.${key}`]!.criteria as { true?: string; false?: string }
      expect(criteria.true).toBeTruthy()
      expect(criteria.false).toBeTruthy()
    }
  })

  it('says when the listing page was never read, so the model does not invent specifics', () => {
    const withPage = buildQuestions(request, [listing({ detail: null })])
    expect(withPage['L1.spec_match']!.instructions).toMatch(/no listing page/i)

    const withSpecs = buildQuestions(request, [
      listing({
        detail: {
          title: 't',
          price: 1,
          shipping: 0,
          condition: 'New',
          sellerName: 's',
          sellerFeedback: 'f',
          specifics: { 'RAM Size': '32 GB' },
          rawText: [],
        },
      }),
    ])
    expect(withSpecs['L1.spec_match']!.instructions).toContain('RAM Size')
  })

  it('keeps the question text free of the key name, which means nothing to the model', () => {
    const q = buildQuestions(request, [listing()])
    expect(q['L1.is_target_product']!.instructions).not.toContain('is_target_product')
  })
})

describe('buildState', () => {
  it('sends the shared request once and the listings as data', () => {
    const state = buildState(request, [listing({ label: 'L1' }), listing({ label: 'L2' })]) as {
      request: unknown
      listings: { label: string }[]
    }
    expect(state.request).toEqual(request)
    expect(state.listings.map((l) => l.label)).toEqual(['L1', 'L2'])
  })

  it('carries the item specifics when the listing page was read', () => {
    const state = buildState(request, [
      listing({
        detail: {
          title: 't',
          price: 1,
          shipping: 0,
          condition: 'New',
          sellerName: 's',
          sellerFeedback: 'f',
          specifics: { 'RAM Size': '32 GB', 'SSD Capacity': '512 GB' },
          rawText: [],
        },
      }),
    ]) as { listings: { item_specifics: Record<string, string> | null }[] }
    expect(state.listings[0]?.item_specifics).toEqual({ 'RAM Size': '32 GB', 'SSD Capacity': '512 GB' })
  })

  it('lists the accepted conditions once, in the request', () => {
    expect(DEFAULT_ACCEPTED_CONDITIONS).toContain('eBay Refurbished')
    expect(DEFAULT_ACCEPTED_CONDITIONS).not.toContain('Used')
    expect(DEFAULT_ACCEPTED_CONDITIONS).not.toContain('For parts or not working')
  })
})
