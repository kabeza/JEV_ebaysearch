import type { QuestionListing, SearchRequest } from './questions'

/**
 * The question set as data, so a run's questions can be stored, edited and asked
 * again (spec §5.7, and `docs/superpowers/specs/2026-09-24-stage7-rejudge-design.md`).
 *
 * Three things are deliberately **not** editable, each for a reason:
 *
 * - the prefix that names the listing and points at its state entry, because a
 *   question that forgets which listing it is about is asking about all of them
 *   at once, and it fails silently;
 * - the buyer's own requirements, because they are the request's words quoted
 *   back, generated on every build, so an edit cannot leave a stale quote;
 * - each question's kind, because the report's gates, weights and normalisation
 *   are written against exactly these six keys and their two shapes.
 *
 * This module imports no SDK: the browser's question editor reads the defaults
 * and the validation from here, and nothing client-side should pull the JEV
 * client in to read six strings. Building the questions — which does need the
 * SDK's `noul`/`score` helpers — lives in `questions.ts`.
 */

export type DraftQuestion =
  | { key: string; kind: 'noul'; instructions: string; anchors: { true: string; false: string } }
  | { key: string; kind: 'score'; instructions: string; levels: string[] }

export interface QuestionnaireDraft {
  request: SearchRequest
  questions: DraftQuestion[]
}

/** The kind each key must have. A draft that changes one is refused. */
export const QUESTION_KINDS: Record<string, 'noul' | 'score'> = {
  is_target_product: 'noul',
  spec_match: 'noul',
  condition_ok: 'noul',
  criteria_freeform: 'noul',
  listing_trust: 'score',
  price_value: 'score',
}

export function money(v: number | null): string {
  return v === null ? 'unknown' : `$${v.toFixed(2)}`
}

/**
 * "About listing L3 — "Lenovo ThinkPad…" at $1,299.99: Its card, price, seller
 * and item specifics are the state's entry for L3. "
 *
 * The facts used to be written out in all six questions, on top of the state
 * that already carried them. Measured on 2026-09-24
 * (`scripts/probe-facts-duplication.ts`, 20 listings, 120 questions): stating
 * them once cost **44% of the request** and flipped no gate decision, with five
 * of the six questions inside the model's own run-to-run noise. Only
 * `price_value` moved a little more (9 of 20 listings above 0.05, against 7 for
 * the same request twice) — the price the prefix names is what it is answering
 * about, so the title and price stay here.
 *
 * The facts live in `buildState` now. Nothing may be dropped from a question
 * without the state carrying it: that is why `listing_page_opened` exists.
 */
export function questionPrefix(l: QuestionListing): string {
  return (
    `About listing ${l.label} — "${l.title}" at ${money(l.price)}: ` +
    `Its card, price, seller and item specifics are the state's entry for ${l.label}. `
  )
}

/** The buyer's spec in words, for the questions that restate it. */
export function specProse(spec: SearchRequest['spec']): string {
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
 * What the buyer asked for, in the words the question needs, generated from the
 * request every time. Empty for the questions that ask about the listing alone.
 *
 * Generated rather than stored per question: the criteria are quoted back
 * verbatim by `criteria_freeform`, and a stored copy could be edited into a
 * quote that no longer matches the criteria it claims to quote.
 */
export function requirementsText(key: string, request: SearchRequest): string {
  switch (key) {
    case 'spec_match':
      return `The buyer wants: ${specProse(request.spec)}. The buyer's own words were: "${request.criteria_text}". `
    case 'condition_ok':
      return `The buyer accepts only these conditions: ${request.accepted_conditions.join(', ')}. `
    case 'price_value':
      return request.max_price === undefined
        ? ''
        : `The buyer's budget is $${request.max_price} including shipping. `
    case 'criteria_freeform':
      return `The buyer's own written criteria, quoted verbatim: "${request.criteria_text}". `
    default:
      return ''
  }
}

/** The six questions as shipped, body text only, ready to edit. */
export function defaultQuestions(): DraftQuestion[] {
  return [
    {
      key: 'is_target_product',
      kind: 'noul',
      instructions:
        'Is this listing for the complete product itself — a working laptop computer — rather ' +
        'than an accessory, case, bag, charger, dock, cable, replacement keyboard, palmrest, ' +
        'screen panel, motherboard, battery, or a lot of parts? Answer whether it is the ' +
        'product, regardless of its condition, price or specification.',
      anchors: {
        true: 'A complete, working laptop computer.',
        false: 'Anything else: an accessory, a part, a consumable, or a lot of parts.',
      },
    },
    {
      key: 'spec_match',
      kind: 'noul',
      instructions:
        "Does this listing's stated specification (processor family, memory, storage, screen, " +
        'touch) satisfy what the buyer asked for? Judge the specification only — not condition, ' +
        'price or trustworthiness. If the listing does not state something the buyer requires, ' +
        'do not assume it is satisfied.',
      anchors: {
        true: 'Everything the buyer requires is stated and satisfied.',
        false: 'Something required is contradicted by the listing, or is not stated at all.',
      },
    },
    {
      key: 'condition_ok',
      kind: 'noul',
      instructions:
        'Anything used, pre-owned, or sold for parts is not acceptable. ' +
        'Is this listing in a condition the buyer accepts?',
      anchors: {
        true: 'The condition is one the buyer listed as acceptable.',
        false: 'Used, pre-owned, for parts, or a condition the buyer did not accept.',
      },
    },
    {
      key: 'listing_trust',
      kind: 'score',
      instructions:
        'How trustworthy is this listing — judging the seller record, the wording of the ' +
        'listing, and whether the price or the detail looks evasive or contradictory?',
      levels: [
        'Clear warning signs: an implausible price, contradictory wording, or a seller record that suggests risk.',
        'Something is off: a thin seller record, an evasive description, or details that do not add up.',
        'Ordinary: nothing reassuring and nothing alarming.',
        'Solid: an established seller with a good record and a clear, detailed listing.',
        'Fully reassuring: a strong seller record and complete, specific, consistent detail.',
      ],
    },
    {
      key: 'price_value',
      kind: 'score',
      instructions: 'How good is the value for money at this price, for this specification?',
      levels: [
        'Well above the budget, or very poor value for the specification.',
        'Slightly above the budget, or mediocre value.',
        'At the top of the budget with fair value.',
        'Comfortably within budget with good value.',
        'Well below budget for this specification — unusually good value.',
      ],
    },
    {
      key: 'criteria_freeform',
      kind: 'noul',
      instructions:
        'Does this listing satisfy them? This question catches anything the other questions miss.',
      anchors: {
        true: 'The listing satisfies the buyer, including anything the other questions miss.',
        false: 'Something in those criteria is not met.',
      },
    },
  ]
}

/** The draft a run starts from: the search's own request plus the shipped questions. */
export function defaultDraft(request: SearchRequest): QuestionnaireDraft {
  return { request, questions: defaultQuestions() }
}

/**
 * The stored draft of a version, or the shipped questions when it predates this
 * stage. Run 8's questionnaire is `{ request, questionKeys }` — no question text
 * at all; its answers stay readable and the editor opens on today's wording.
 */
export function draftFromDefinition(
  definition: unknown,
  fallback: SearchRequest,
): QuestionnaireDraft {
  const stored = definition as Partial<QuestionnaireDraft> | null | undefined
  const request = stored?.request ?? fallback
  const questions = stored?.questions
  return {
    request,
    questions: Array.isArray(questions) && questions.length > 0 ? questions : defaultQuestions(),
  }
}

/**
 * Why a draft cannot be judged. An empty array means it can.
 *
 * Every reason is a sentence the UI shows verbatim, and they are checked before
 * the first JEV call, so a bad edit costs nothing.
 */
export function validateDraft(draft: QuestionnaireDraft): string[] {
  const reasons: string[] = []

  // The buyer's half is checked too, and checked here rather than later: the
  // questions generate their buyer-side text from the request at build time, so a
  // request missing a field fails *after* the version row exists — leaving an
  // empty newest version, which is what the report then lands on.
  const request = draft?.request
  if (!request || typeof request !== 'object') {
    reasons.push('The draft has no request: the questions quote the buyer’s own words.')
  } else {
    if (typeof request.criteria_text !== 'string') {
      reasons.push('The buyer’s criteria text is missing; two questions quote it verbatim.')
    }
    if (!request.spec || typeof request.spec !== 'object') {
      reasons.push('The buyer’s spec is missing; spec_match reads it.')
    }
    if (!Array.isArray(request.accepted_conditions) || request.accepted_conditions.length === 0) {
      reasons.push('The accepted conditions are missing; condition_ok lists them in full.')
    }
  }

  const questions = Array.isArray(draft?.questions) ? draft.questions : []
  if (questions.length === 0) reasons.push('The draft has no questions.')
  const seen = new Set<string>()

  for (const question of questions) {
    if (seen.has(question.key)) reasons.push(`${question.key} appears more than once.`)
    seen.add(question.key)

    const expected = QUESTION_KINDS[question.key]
    if (!expected) {
      reasons.push(`${question.key} is not one of the six questions this report can rank.`)
      continue
    }
    if (question.kind !== expected) {
      reasons.push(`${question.key} must stay a ${expected} question; only its wording can change.`)
      continue
    }
    if (!question.instructions?.trim()) reasons.push(`${question.key} has no wording.`)

    if (question.kind === 'noul') {
      if (!question.anchors?.true?.trim() || !question.anchors?.false?.trim()) {
        reasons.push(`${question.key} needs both of its outcomes described.`)
      }
    } else {
      const levels = Array.isArray(question.levels) ? question.levels : []
      if (levels.length < 3 || levels.length > 7) {
        reasons.push(`${question.key} needs between 3 and 7 levels; it has ${levels.length}.`)
      } else if (levels.some((level) => !level?.trim())) {
        reasons.push(`${question.key} has an empty level.`)
      }
    }
  }

  for (const key of Object.keys(QUESTION_KINDS)) {
    if (!seen.has(key)) reasons.push(`${key} is missing.`)
  }

  return reasons
}
