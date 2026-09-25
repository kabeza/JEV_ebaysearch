import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ACCEPTED_CONDITIONS,
  QUESTION_KEYS,
  acceptedConditionsFrom,
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

  // Measured 2026-09-24 (`scripts/probe-facts-duplication.ts`): restating the
  // facts in all six questions cost 44% of the request and changed no gate
  // decision. The state carries them once.
  it('leaves the listing’s own facts to the state, naming the state entry instead', () => {
    const q = buildQuestions(request, [
      listing({
        price: 1200,
        shipping: 0,
        sellerFeedback: '99.1% positive',
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
    for (const key of QUESTION_KEYS) {
      const text = q[`L1.${key}`]!.instructions
      expect(text).toContain('state')
      expect(text).toContain('L1')
      // The item specifics and the seller record are the state's job. The title
      // and price stay in the prefix: that is the shape the probe measured.
      expect(text).not.toContain('32 GB')
      expect(text).not.toContain('99.1% positive')
    }
  })

  it('keeps the buyer’s own requirements in the question that asks about them', () => {
    // The other half of the measurement: the criteria quote is what makes
    // `criteria_freeform` work, and removing it (the `minimal` shape) degraded
    // that answer on 9 of 20 listings, up to 0.58.
    const q = buildQuestions(request, [listing()])
    expect(q['L1.criteria_freeform']!.instructions).toContain(
      '"32gb ram, Ryzen, 1tb, touch screen, under u$s 1600"',
    )
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

  it('says whether the listing page was opened, so an empty specifics map is not read as a full one', () => {
    // The questions used to state this in words. Now that they do not, the state
    // has to: `item_specifics: null` alone cannot tell "the page was never
    // opened" from "the page had nothing to say", and only one of those licenses
    // a guess.
    const state = buildState(request, [
      listing({ label: 'L1', detail: null }),
      listing({
        label: 'L2',
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
    ]) as {
      listings: { label: string; listing_page_opened: boolean; item_specifics: unknown }[]
    }
    expect(state.listings[0]).toMatchObject({ listing_page_opened: false, item_specifics: null })
    expect(state.listings[1]).toMatchObject({
      listing_page_opened: true,
      item_specifics: { 'RAM Size': '32 GB' },
    })
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

describe('acceptedConditionsFrom', () => {
  it('uses the conditions the editor wrote onto the search', () => {
    // `searches` has no column for them, so they live in the spec; before the
    // editor wrote back, a run always used the shipped default and an edit in the
    // editor was silently ignored by every fresh run.
    expect(acceptedConditionsFrom({ accepted_conditions: ['Open Box', 'Used'] })).toEqual([
      'Open Box',
      'Used',
    ])
  })

  it('falls back to the default when the search has none', () => {
    expect(acceptedConditionsFrom({})).toEqual(DEFAULT_ACCEPTED_CONDITIONS)
    expect(acceptedConditionsFrom(undefined)).toEqual(DEFAULT_ACCEPTED_CONDITIONS)
  })

  it('treats an empty or unusable list as absent rather than trusting it', () => {
    // `condition_ok` lists these conditions verbatim to JEV, so an empty list is
    // a question with no content — worse than the default it replaced.
    expect(acceptedConditionsFrom({ accepted_conditions: [] })).toEqual(DEFAULT_ACCEPTED_CONDITIONS)
    expect(acceptedConditionsFrom({ accepted_conditions: 'Open Box' })).toEqual(
      DEFAULT_ACCEPTED_CONDITIONS,
    )
    expect(acceptedConditionsFrom({ accepted_conditions: ['  ', 7] })).toEqual(
      DEFAULT_ACCEPTED_CONDITIONS,
    )
  })

  it('drops unusable entries and keeps the rest', () => {
    expect(acceptedConditionsFrom({ accepted_conditions: ['Open Box', '  ', 7] })).toEqual([
      'Open Box',
    ])
  })
})
