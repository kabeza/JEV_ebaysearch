import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ACCEPTED_CONDITIONS,
  QUESTION_KEYS,
  buildFromDraft,
  buildQuestions,
  type QuestionListing,
  type SearchRequest,
} from '../src/jev/questions'
import {
  QUESTION_KINDS,
  defaultDraft,
  defaultQuestions,
  draftFromDefinition,
  validateDraft,
} from '../src/jev/draft'

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

describe('defaultQuestions', () => {
  it('offers every key once, with the kind the report expects', () => {
    const questions = defaultQuestions()
    expect(questions.map((q) => q.key)).toEqual([...QUESTION_KEYS])
    for (const q of questions) expect(q.kind).toBe(QUESTION_KINDS[q.key])
  })

  it('keeps the buyer’s requirements out of the editable text', () => {
    // They are generated from the draft's request at build time, so editing the
    // criteria changes every question that quotes them and the two cannot drift.
    for (const q of defaultQuestions()) {
      expect(q.instructions).not.toContain('32gb ram')
      expect(q.instructions).not.toContain('eBay Refurbished')
    }
  })

  it('gives the six bodies, anchors and levels the shipped questions have', () => {
    const byKey = new Map(defaultQuestions().map((q) => [q.key, q]))
    const trust = byKey.get('listing_trust')!
    expect(trust.kind === 'score' && trust.levels).toHaveLength(5)
    const target = byKey.get('is_target_product')!
    expect(target.kind === 'noul' && target.anchors.true.length).toBeGreaterThan(0)
    expect(target.kind === 'noul' && target.anchors.false.length).toBeGreaterThan(0)
  })
})

describe('buildFromDraft', () => {
  it('builds exactly what the shipped questions build, so the two cannot drift', () => {
    const listings = [listing(), listing({ label: 'L2', price: 999 })]
    expect(buildFromDraft(defaultDraft(request), listings)).toEqual(
      buildQuestions(request, listings),
    )
  })

  it('names the listing and points at the state, whatever the editable text says', () => {
    const draft = defaultDraft(request)
    draft.questions = draft.questions.map((q) => ({ ...q, instructions: 'Anything at all.' }))
    const built = buildFromDraft(draft, [listing()])
    for (const key of QUESTION_KEYS) {
      const text = built[`L1.${key}`]!.instructions
      expect(text).toContain('L1')
      expect(text).toContain('Lenovo ThinkPad T14s Gen 6 32GB RAM 1TB SSD AMD Ryzen 7')
      expect(text).toContain("state's entry for L1")
    }
  })

  it('generates the buyer’s requirements from the draft’s request, not from the text', () => {
    const draft = defaultDraft({ ...request, criteria_text: 'must have a backlit keyboard' })
    const built = buildFromDraft(draft, [listing()])
    expect(built['L1.criteria_freeform']!.instructions).toContain('"must have a backlit keyboard"')
    expect(built['L1.spec_match']!.instructions).toContain('32GB of RAM or more')
    expect(built['L1.condition_ok']!.instructions).toContain('eBay Refurbished')
    expect(built['L1.price_value']!.instructions).toContain('$1600')
  })

  it('honours edited instructions and anchors', () => {
    const draft = defaultDraft(request)
    draft.questions = draft.questions.map((q) =>
      q.key === 'condition_ok'
        ? {
            key: q.key,
            kind: 'noul' as const,
            instructions: 'Reject anything used.',
            anchors: { true: 'Fine.', false: 'Used.' },
          }
        : q,
    )
    const built = buildFromDraft(draft, [listing()])
    expect(built['L1.condition_ok']!.instructions).toContain('Reject anything used.')
  })
})

describe('validateDraft', () => {
  const noul = (key: string) => ({
    key,
    kind: 'noul' as const,
    instructions: 'Something specific.',
    anchors: { true: 'Yes.', false: 'No.' },
  })
  const scoreQ = (key: string, levels = 5) => ({
    key,
    kind: 'score' as const,
    instructions: 'Something specific.',
    levels: Array.from({ length: levels }, (_, i) => `Level ${i}`),
  })

  const complete = () => [
    noul('is_target_product'),
    noul('spec_match'),
    noul('condition_ok'),
    scoreQ('listing_trust'),
    scoreQ('price_value'),
    noul('criteria_freeform'),
  ]

  it('accepts the default draft', () => {
    expect(validateDraft(defaultDraft(request))).toEqual([])
  })

  it('refuses a question with no wording', () => {
    const draft = defaultDraft(request)
    draft.questions = draft.questions.map((q) =>
      q.key === 'condition_ok' ? { ...q, instructions: '   ' } : q,
    )
    expect(validateDraft(draft).join(' ')).toContain('condition_ok')
  })

  it('refuses a key that is not one of the six', () => {
    const draft = defaultDraft(request)
    draft.questions = [
      ...complete().filter((q) => q.key !== 'condition_ok'),
      noul('seller_mood'),
    ] as never
    const reasons = validateDraft(draft).join(' ')
    expect(reasons).toContain('seller_mood')
    expect(reasons).toContain('condition_ok')
  })

  it('refuses a question whose kind changed, because the report is written against it', () => {
    const draft = defaultDraft(request)
    draft.questions = complete().map((q) => (q.key === 'price_value' ? noul('price_value') : q)) as never
    expect(validateDraft(draft).join(' ')).toContain('price_value')
  })

  it('refuses a repeated key, an empty anchor, and a scale of two', () => {
    const duplicated = defaultDraft(request)
    duplicated.questions = [...complete(), noul('is_target_product')] as never
    expect(validateDraft(duplicated).join(' ')).toContain('is_target_product')

    const emptyAnchor = defaultDraft(request)
    emptyAnchor.questions = complete().map((q) =>
      q.key === 'spec_match' && q.kind === 'noul' ? { ...q, anchors: { true: 'Yes.', false: '' } } : q,
    ) as never
    expect(validateDraft(emptyAnchor).join(' ')).toContain('spec_match')

    const twoLevels = defaultDraft(request)
    twoLevels.questions = complete().map((q) =>
      q.key === 'listing_trust' ? scoreQ('listing_trust', 2) : q,
    ) as never
    expect(validateDraft(twoLevels).join(' ')).toContain('listing_trust')
  })
})

describe('draftFromDefinition', () => {
  it('reads back a stored draft', () => {
    const stored = defaultDraft({ ...request, criteria_text: 'edited words' })
    expect(
      draftFromDefinition({ request: stored.request, questions: stored.questions }, request),
    ).toEqual(stored)
  })

  it('falls back to the shipped questions for a version stored before this stage', () => {
    // Run 8's questionnaire is `{ request, questionKeys }` — no question text at
    // all. Its answers stay readable; the editor opens on today's wording.
    const legacy = { request, questionKeys: [...QUESTION_KEYS] }
    const draft = draftFromDefinition(legacy, request)
    expect(draft.questions.map((q) => q.key)).toEqual([...QUESTION_KEYS])
    expect(draft.questions).toEqual(defaultQuestions())
  })

  it('survives a definition that is not even an object', () => {
    expect(draftFromDefinition(null, request).questions).toEqual(defaultQuestions())
  })
})

describe('validateDraft on the buyer’s half', () => {
  it('refuses a draft whose request is missing what the questions quote', () => {
    // The questions generate their buyer-side text from the request at build
    // time, so a request missing a field fails *later* — after the version row
    // has been written, leaving an empty newest version the report lands on.
    const draft = defaultDraft(request)
    const withRequest = (patch: Record<string, unknown>) =>
      validateDraft({ ...draft, request: { ...request, ...patch } } as never).join(' ')

    expect(withRequest({ spec: undefined })).toContain('spec')
    expect(withRequest({ accepted_conditions: undefined })).toContain('accepted conditions')
    expect(withRequest({ accepted_conditions: [] })).toContain('accepted conditions')
    expect(withRequest({ criteria_text: 42 })).toContain('criteria')
  })

  it('accepts a request whose criteria are empty — a search may have none', () => {
    const draft = defaultDraft({ ...request, criteria_text: '' })
    expect(validateDraft(draft)).toEqual([])
  })

  it('refuses garbage instead of throwing, so the route can answer 400', () => {
    expect(validateDraft(null as never).length).toBeGreaterThan(0)
    expect(validateDraft({} as never).join(' ')).toContain('request')
    expect(validateDraft({ request, questions: [] } as never).join(' ')).toContain('no questions')
    expect(
      validateDraft({
        request,
        questions: [{ key: 'price_value', kind: 'score', instructions: 'x' }],
      } as never).join(' '),
    ).toContain('price_value')
    expect(
      validateDraft({
        request,
        questions: [{ key: 'condition_ok', kind: 'noul', instructions: 'x' }],
      } as never).join(' '),
    ).toContain('condition_ok')
  })
})
