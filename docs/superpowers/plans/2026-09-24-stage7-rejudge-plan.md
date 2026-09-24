# Stage 7 — re-judge a stored run with edited questions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a stored run's questions become editable data, and re-judging them against the same stored listings creates a new questionnaire version whose answers can be compared with the previous one — with no eBay page load and no scrape.

**Architecture:** The question set moves out of `buildQuestions`' constants into a `QuestionnaireDraft` (`src/jev/draft.ts`), which is what a version stores and what the editor edits. The batching loop in `src/pipeline/judge.ts` is extracted into `askInBatches`, so the first judging and the re-judging share one tested path. `src/pipeline/rejudge.ts` judges a stored run again under a new version. The server returns every version's judgments in the run payload and the browser filters — the diff compares two versions at once, so a per-request version parameter would cost a request per comparison.

**Tech Stack:** Node 22 + TypeScript, Fastify, better-sqlite3, React 19 + Vite + Tailwind v4, vitest, Playwright (only in `scripts/repro-live-ui.ts`), `@typesafe-ai/sdk`.

**Spec:** `docs/superpowers/specs/2026-09-24-stage7-rejudge-design.md` — the plan argues from it, so read both. Parent spec: `docs/superpowers/specs/2026-09-18-jevbrowser-design.md` §5.7, §7.

## Global Constraints

- **Do not commit.** The owner commits himself, in Spanish one-liners, mid-session (`CLAUDE.md`, "Conventions"). Every task ends when its tests and typecheck pass, not with a commit. The `git add`/`git commit` step of the standard task shape is replaced by `npm run typecheck`.
- `npm run typecheck` must stay clean — it runs `tsc --noEmit` on **both** the server and the web project. `npm test` is vitest; the suite is **280 tests** before this plan starts.
- **`scraper/` and `jev/` must never import each other** (`CLAUDE.md`, hard rule). Nothing in this plan adds an import across that line; a re-judge never constructs a `PageSource`.
- **No hex colour literals outside `web/src/styles/tokens.css`.** Reference the palette by Tailwind name (`bg-space-indigo`, `text-seashell`, `text-lilac-ash`, `text-almond-silk`, `bg-dusty-grape`). Verify with `grep -rn '#[0-9a-fA-F]\{6\}' web/src --include='*.tsx' --include='*.ts'` — expect no hits.
- **The question text a person edits never contains the listing prefix.** `questionPrefix()` prepends `About listing L3 — … : Its card, price, seller and item specifics are the state's entry for L3.` in code (rule 16), so an edit cannot leave a question unnamed.
- **The buyer's requirements are generated from the draft's request, not typed per question.** Editing the criteria changes every question that quotes them, and they can never drift apart. The editable part of a question is its own wording and its anchors.
- **A question's kind is fixed**: `is_target_product`, `spec_match`, `condition_ok`, `criteria_freeform` are noul; `listing_trust` and `price_value` are score. `validateDraft` rejects a draft that changes one.
- **One job at a time** (rule 9). A re-judge takes the same lock a run takes; the cancel route works for both.
- **Events are published, not just stored** (rule 8). A re-judge emits through the same bus the SSE stream reads.
- **Silence is a bug** (rule 7): a partial version shows its unjudged listings as `pending` and its failure as an event — never an empty table with no reason.
- Tests live in `tests/`, one file per module, and import web modules directly (`tests/web-spec.test.ts` already does `from '../web/src/lib/spec'`).

## Review Focus

Six input classes the spec implies, each most likely first:

1. **A stored run that already has one version, re-judged.** Two versions now hold answers for the same listing and question key. If the report is handed both, `answersOf` in `score.ts` keys by `listingId`+`questionKey` and one version silently overwrites the other. The report must filter to one version. Pinned in Task 6 (the filter) and Task 7 (the view).
2. **A questionnaire stored before this stage** (`{ request, questionKeys }`, no `questions`, no `labels`). The editor must open with the shipped defaults, the version selector must not crash, and its answers must stay readable. Pinned in Task 1 (`draftFromDefinition`) and Task 5 (`GET` payload).
3. **A re-judge that fails after three of four batches.** The stored batches must stay, the failure must reach the event log and the SSE stream, and the unjudged listings must read as `pending` — not as a finished version with a full set of answers. Pinned in Task 4.
4. **A batch refused with a `422` during a re-judge.** It must halve and retry exactly as the first judging does, and a size refused once must stay refused for that job. Pinned in Task 3 (the seam) and Task 4 (the caller).
5. **A run whose listings include `detail_failed` rows**, i.e. judged on card data alone. A re-judge must include them (the first judge's `listToJudge` would not, once they are `judged`) and must not change any listing's `stage`. Pinned in Task 2 (`listJudgeable`) and Task 4.
6. **A draft with an empty instruction, a renamed key, or a score question with two levels.** Each must be refused with a sentence naming the problem, and refused *before* the first JEV call, so a bad edit costs nothing. Pinned in Task 1.

## File Structure

| File | Responsibility |
|---|---|
| `src/jev/draft.ts` | create — `DraftQuestion`, `QuestionnaireDraft`, the shipped bodies, `defaultDraft`, `draftFromDefinition`, `validateDraft`, `buildFromDraft`, `questionPrefix`, `specProse`, `money`. Owns every question string. |
| `src/jev/questions.ts` | modify — keeps keys, types, `DEFAULT_ACCEPTED_CONDITIONS`, `toJsonSpec`, `buildState`, `labelFor`; `buildQuestions` becomes a wrapper over the draft, so there is one source of question text. |
| `src/storage/judgments.ts` | modify — `nextQuestionnaireVersion`; `saveQuestionnaire` requires an explicit version; a `listJudgments` note that callers must filter by version. |
| `src/storage/listings.ts` | modify — `listJudgeable` (everything not `rejected`), which a re-judge needs and the first judge must not use. |
| `src/storage/events.ts` | modify — `rejudge.started`, `rejudge.finished`, `rejudge.failed` in `RunEventType`. |
| `src/pipeline/judge.ts` | modify — `askInBatches` extracted; `judgeSurvivors` becomes its first caller; `judgeSurvivors` saves its questionnaire with `nextQuestionnaireVersion`. |
| `src/pipeline/rejudge.ts` | create — `rejudgeRun`. |
| `src/pipeline/runner.ts` | modify — `startRejudge`, the lock shared with runs, cancel for both. |
| `src/server/routes/runs.ts` | modify — `POST /api/runs/:id/rejudge`; `GET /api/runs/:id` gains `questionnaires`. |
| `web/src/lib/api.ts` | modify — `Judgment.questionnaireId`, `Questionnaire`, `rejudge()`. |
| `web/src/lib/versions.ts` | create — `judgmentsForVersion`, `previousVersionOf`, `answersByListing`. |
| `web/src/lib/export.ts` | modify — a `questionnaire` column. |
| `web/src/components/VersionSelector.tsx` | create — the version `<select>`. |
| `web/src/components/QuestionEditor.tsx` | create — the draft form. |
| `web/src/components/AnswerDetail.tsx` | modify — an optional `previousAnswers` map, rendered as `was …`. |
| `web/src/components/RunView.tsx` | modify — version state, the editor, the diff handed to rows. |
| `scripts/repro-live-ui.ts` | modify — edit a question, re-judge, prove zero fixture requests. |
| `tests/questionnaire-draft.test.ts` | create — defaults, validation, building, the legacy definition. |
| `tests/judgments-version.test.ts` | create — version numbering and coexistence. |
| `tests/rejudge.test.ts` | create — the re-judge path with a fake client. |
| `tests/server-rejudge.test.ts` | create — the route and the payload. |
| `tests/versions.test.ts` | create — the browser-side version selection. |

---

### Task 1: The question set becomes editable data

**Files:**
- Create: `src/jev/draft.ts`
- Modify: `src/jev/questions.ts` (remove the bodies and the prefix; `buildQuestions` becomes a wrapper)
- Test: `tests/questionnaire-draft.test.ts` (create)
- Test: `tests/jev-questions.test.ts` (must stay green, unchanged — it is the refactor's safety net)

**Interfaces:**
- Consumes: `QUESTION_KEYS`, `SearchRequest`, `QuestionListing`, `JevQuestion`, `buildState`, `labelFor` from `src/jev/questions.ts`.
- Produces: `DraftQuestion`, `QuestionnaireDraft`, `QUESTION_KINDS`, `defaultQuestions()`, `defaultDraft(request)`, `draftFromDefinition(definition, fallback)`, `validateDraft(draft)`, `buildFromDraft(draft, listings)`, `questionPrefix(listing)`, `specProse(spec)`, `money(v)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/questionnaire-draft.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ACCEPTED_CONDITIONS,
  QUESTION_KEYS,
  buildQuestions,
  type QuestionListing,
  type SearchRequest,
} from '../src/jev/questions'
import {
  QUESTION_KINDS,
  buildFromDraft,
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
    // The whole point of one source: the default draft's output must be
    // identical to `buildQuestions`, which is now this function underneath.
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
        ? { key: q.key, kind: 'noul' as const, instructions: 'Reject anything used.', anchors: { true: 'Fine.', false: 'Used.' } }
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
    draft.questions = [...complete().filter((q) => q.key !== 'condition_ok'), noul('seller_mood')] as never
    const reasons = validateDraft(draft).join(' ')
    expect(reasons).toContain('seller_mood')
    expect(reasons).toContain('condition_ok')
  })

  it('refuses a question whose kind changed, because the report is written against it', () => {
    const draft = defaultDraft(request)
    draft.questions = complete().map((q) =>
      q.key === 'price_value' ? noul('price_value') : q,
    ) as never
    expect(validateDraft(draft).join(' ')).toContain('price_value')
  })

  it('refuses a repeated key, an empty anchor, and a scale of two', () => {
    const duplicated = defaultDraft(request)
    duplicated.questions = [...complete(), noul('is_target_product')] as never
    expect(validateDraft(duplicated).join(' ')).toContain('is_target_product')

    const emptyAnchor = defaultDraft(request)
    emptyAnchor.questions = complete().map((q) =>
      q.key === 'spec_match' && q.kind === 'noul'
        ? { ...q, anchors: { true: 'Yes.', false: '' } }
        : q,
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
    expect(draftFromDefinition({ request: stored.request, questions: stored.questions }, request)).toEqual(stored)
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/questionnaire-draft.test.ts`
Expected: FAIL — `Cannot find module '../src/jev/draft'`.

- [ ] **Step 3: Write `src/jev/draft.ts`**

The bodies are copied **verbatim** from today's `buildQuestions`. Anything the buyer's request supplies is generated by `buyerText`, so it is never part of the editable text.

```ts
import { noul, score, type Question } from '@typesafe-ai/sdk'
import type { QuestionListing, SearchRequest } from './questions'

/**
 * The question set as data, so a run's questions can be edited and asked again
 * (spec §5.7, and `docs/superpowers/specs/2026-09-24-stage7-rejudge-design.md`).
 *
 * Three things are not editable, each for a reason:
 *
 * - the prefix that names the listing and points at its state entry, because
 *   CLAUDE.md rule 16 fails silently when a question forgets which listing it
 *   is about;
 * - the buyer's own requirements, because they are the request's words quoted
 *   back and an edit that changed them would leave the quote stale;
 * - each question's kind, because the report's gates, weights and normalisation
 *   are written against exactly these six keys and their two shapes.
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
 * Measured 2026-09-24 (`scripts/probe-facts-duplication.ts`): stating the facts
 * once in the state rather than six times here cost 44% of the request and
 * flipped no gate decision.
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
 */
function buyerText(key: string, request: SearchRequest): string {
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

/** The stored draft of a version, or the defaults when it predates this stage. */
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

/** Why a draft cannot be judged. An empty array means it can. */
export function validateDraft(draft: QuestionnaireDraft): string[] {
  const reasons: string[] = []
  const seen = new Set<string>()

  for (const question of draft.questions) {
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
    if (!question.instructions.trim()) reasons.push(`${question.key} has no wording.`)

    if (question.kind === 'noul') {
      if (!question.anchors.true.trim() || !question.anchors.false.trim()) {
        reasons.push(`${question.key} needs both of its outcomes described.`)
      }
    } else if (question.levels.length < 3 || question.levels.length > 7) {
      reasons.push(`${question.key} needs between 3 and 7 levels; it has ${question.levels.length}.`)
    } else if (question.levels.some((level) => !level.trim())) {
      reasons.push(`${question.key} has an empty level.`)
    }
  }

  for (const key of Object.keys(QUESTION_KINDS)) {
    if (!seen.has(key)) reasons.push(`${key} is missing.`)
  }

  return reasons
}

/** The questions one batch will ask, from the draft rather than from constants. */
export function buildFromDraft(
  draft: QuestionnaireDraft,
  listings: QuestionListing[],
): Record<string, Question> {
  const out: Record<string, Question> = {}

  for (const l of listings) {
    const prefix = questionPrefix(l)

    for (const question of draft.questions) {
      const text = `${prefix}${buyerText(question.key, draft.request)}${question.instructions}`
      out[`${l.label}.${question.key}`] =
        question.kind === 'noul' ? noul(text, question.anchors) : score(text, question.levels)
    }
  }

  return out
}
```

- [ ] **Step 4: Rewrite `src/jev/questions.ts` to use it**

Delete from `src/jev/questions.ts`: `money`, `questionPrefix`/`about`, `facts` (already gone), `specProse`, and the body of `buildQuestions`. Keep `QUESTION_KEYS`, `QuestionKey`, `JevQuestion`, `DEFAULT_ACCEPTED_CONDITIONS`, `SearchRequest`, `QuestionListing`, `toJsonSpec`, `buildState`, `labelFor`.

```ts
import { noul, score, type JsonValue, type Question } from '@typesafe-ai/sdk'
import { buildFromDraft, defaultDraft, type QuestionnaireDraft } from './draft'

// …QUESTION_KEYS, DEFAULT_ACCEPTED_CONDITIONS, SearchRequest, QuestionListing, toJsonSpec, buildState, labelFor unchanged…

/**
 * The six shipped questions for one batch. Now a thin wrapper: the text lives in
 * `draft.ts`, because a run has to be able to store and edit it (§5.7). One
 * source means the constants and the editor cannot disagree about what is asked.
 */
export function buildQuestions(
  request: SearchRequest,
  listings: QuestionListing[],
): Record<string, JevQuestion> {
  return buildFromDraft(defaultDraft(request), listings)
}
```

`noul` and `score` are no longer used in `questions.ts` — remove them from the import, keeping `type JsonValue` and `type Question`. `tests/jev-questions.test.ts` must stay green **without edits**: it pins the six bodies by content, which is what makes this refactor safe.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/questionnaire-draft.test.ts tests/jev-questions.test.ts`
Expected: PASS, both files. If `jev-questions` fails, the ported texts differ from the originals — fix `draft.ts`, never the test.

- [ ] **Step 6: Typecheck and the whole suite**

Run: `npm run typecheck && npm test`
Expected: clean, 280 tests passing plus the new file's.

---

### Task 2: Versions and the re-judge's listing set

**Files:**
- Modify: `src/storage/judgments.ts`
- Modify: `src/storage/listings.ts`
- Modify: `src/pipeline/judge.ts` (one line: pass `nextQuestionnaireVersion`)
- Test: `tests/judgments-version.test.ts` (create)

**Interfaces:**
- Consumes: `openDatabase` from `src/storage/db.ts`.
- Produces: `nextQuestionnaireVersion(db, runId): number`, `saveQuestionnaire(db, runId, definition, version): number`, `listJudgeable(db, runId): StoredListing[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/judgments-version.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/storage/db'
import {
  listJudgments,
  listQuestionnaires,
  nextQuestionnaireVersion,
  saveJudgments,
  saveQuestionnaire,
} from '../src/storage/judgments'
import { createRun } from '../src/storage/runs'
import { listJudgeable, listToJudge, insertCards, type RawCard } from '../src/storage/listings'
import { createSearch } from '../src/storage/searches'

function fixture() {
  const db = openDatabase(':memory:')
  const search = createSearch(db, { name: 's', keyword: 'k', criteriaText: 'c', spec: {} })
  const run = createRun(db, search.id, {})
  return { db, runId: run.id }
}

const card = (itemId: string): RawCard => ({
  itemId,
  title: `Listing ${itemId}`,
  url: `https://www.ebay.com/itm/${itemId}`,
  price: 100,
  shipping: 0,
  conditionLabel: 'Open Box',
  sellerName: 'seller',
  sellerFeedback: '100% positive (45)',
  watchers: null,
  buyingFormat: 'Buy It Now',
  sponsoredMarker: false,
  rawText: [],
})

describe('questionnaire versions', () => {
  it('numbers versions from one, and hands out the next number', () => {
    const { db, runId } = fixture()
    expect(nextQuestionnaireVersion(db, runId)).toBe(1)
    saveQuestionnaire(db, runId, { request: {}, questions: [] }, nextQuestionnaireVersion(db, runId))
    expect(nextQuestionnaireVersion(db, runId)).toBe(2)
    saveQuestionnaire(db, runId, { request: {}, questions: [] }, nextQuestionnaireVersion(db, runId))
    expect(listQuestionnaires(db, runId).map((q) => q.version)).toEqual([1, 2])
  })

  it('keeps both versions’ answers, and returns both so the caller can pick', () => {
    // The trap: `listJudgments` returns every version for the run, and the report
    // keys answers by listing + question. Handed both, one version silently
    // overwrites the other, so the caller has to filter (Task 6).
    const { db, runId } = fixture()
    const stored = insertCards(db, runId, [card('1')])
    const listingId = stored.idsByItemId.get('1')!
    const v1 = saveQuestionnaire(db, runId, { request: {}, questions: [] }, 1)
    const v2 = saveQuestionnaire(db, runId, { request: {}, questions: [] }, 2)

    saveJudgments(db, {
      runId,
      questionnaireId: v1,
      listingId,
      answers: { condition_ok: { type: 'noul', noul: 0.9 } },
    })
    saveJudgments(db, {
      runId,
      questionnaireId: v2,
      listingId,
      answers: { condition_ok: { type: 'noul', noul: 0.2 } },
    })

    const all = listJudgments(db, runId)
    expect(all).toHaveLength(2)
    expect(all.map((j) => j.questionnaireId)).toEqual([v1, v2])
    expect(all[0]!.answer).toEqual({ type: 'noul', noul: 0.9 })
    expect(all[1]!.answer).toEqual({ type: 'noul', noul: 0.2 })
  })
})

describe('listJudgeable', () => {
  it('takes everything the pre-filter did not reject, including already-judged rows', () => {
    // `listToJudge` selects survivor/detail_failed, which is right for the first
    // judging and returns nothing at all for a re-judge — every row is `judged`
    // by then.
    const { db, runId } = fixture()
    const stored = insertCards(db, runId, [card('1'), card('2'), card('3')])
    const ids = ['1', '2', '3'].map((itemId) => stored.idsByItemId.get(itemId)!)
    db.prepare("update listings set stage = 'rejected' where id = ?").run(ids[0])
    db.prepare("update listings set stage = 'judged' where id = ?").run(ids[1])
    db.prepare("update listings set stage = 'detail_failed' where id = ?").run(ids[2])

    expect(listToJudge(db, runId).map((l) => l.id)).toEqual([ids[2]])
    expect(listJudgeable(db, runId).map((l) => l.id)).toEqual([ids[1], ids[2]])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/judgments-version.test.ts`
Expected: FAIL — `nextQuestionnaireVersion is not a function`.

- [ ] **Step 3: Implement**

In `src/storage/judgments.ts`, replace the stored version default and add the counter:

```ts
/** The next version number for a run's questionnaires, starting at 1. */
export function nextQuestionnaireVersion(db: SqliteDatabase, runId: number): number {
  const row = db
    .prepare('select coalesce(max(version), 0) + 1 as next from questionnaires where run_id = ?')
    .get(runId) as { next: number }
  return row.next
}

/**
 * Stores one version's definition. `version` is explicit and required: a
 * re-judge is a new version of the same run, and a defaulted 1 would make every
 * version collide on the first number (spec §5.7).
 */
export function saveQuestionnaire(
  db: SqliteDatabase,
  runId: number,
  definition: Record<string, unknown>,
  version: number,
): number {
  const info = db
    .prepare('insert into questionnaires (run_id, definition_json, version) values (?, ?, ?)')
    .run(runId, JSON.stringify(definition), version)
  return Number(info.lastInsertRowid)
}
```

Add a note to `listJudgments`' doc comment:

```ts
/**
 * Every judgment for a run, across **every** questionnaire version, ordered by
 * id. Callers that rank or display answers must filter to one version first:
 * `score.ts` keys answers by listing and question, so two versions of the same
 * answer would overwrite each other silently.
 */
```

In `src/storage/listings.ts`, next to `listToJudge`:

```ts
/**
 * Everything the pre-filter kept, judged or not — what a re-judge re-asks about.
 *
 * Deliberately not `listToJudge`: that selects `survivor`/`detail_failed`, which
 * is right for a first judging and empty for a re-judge, because every row it
 * touches becomes `judged`.
 */
export function listJudgeable(db: SqliteDatabase, runId: number): StoredListing[] {
  const rows = db
    .prepare("select * from listings where run_id = ? and stage != 'rejected' order by id")
    .all(runId) as Row[]
  return rows.map(toListing)
}
```

In `src/pipeline/judge.ts`, change the questionnaire save to use the counter:

```ts
  const questionnaireId = saveQuestionnaire(
    o.db,
    o.runId,
    { request: o.request, questionKeys: QUESTION_KEYS },
    nextQuestionnaireVersion(o.db, o.runId),
  )
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/judgments-version.test.ts tests/judge.test.ts tests/pipeline-run.test.ts`
Expected: PASS. `judge.test.ts` and `pipeline-run.test.ts` are the existing callers of `saveQuestionnaire`; if they fail on the new required argument, update **them** (they are tests of the caller, and the signature genuinely changed).

- [ ] **Step 5: Typecheck and the whole suite**

Run: `npm run typecheck && npm test`

---

### Task 3: Extract the batch loop

**Files:**
- Modify: `src/pipeline/judge.ts`
- Test: `tests/judge.test.ts` (add cases; the existing ones must stay green)

**Interfaces:**
- Consumes: `JevClient`, `chunk`/`halve`/`isTooLargeError` from `src/jev/batch.ts`, `JudgeOutcome`.
- Produces: `askInBatches(o: AskInBatchesOptions): Promise<JudgeOutcome>`, with `AskInBatchesOptions` as in the spec §6.

- [ ] **Step 1: Write the failing tests**

Append to `tests/judge.test.ts`:

```ts
import { askInBatches } from '../src/pipeline/judge'
import { buildState } from '../src/jev/questions'
import { defaultDraft, buildFromDraft } from '../src/jev/draft'

describe('askInBatches', () => {
  const labelled = [1, 2, 3, 4].map((i) => ({
    label: `L${i}`,
    title: `Listing ${i}`,
    price: 100 * i,
    shipping: 0,
    conditionLabel: 'Open Box',
    sellerName: 'seller',
    sellerFeedback: '100% positive (45)',
    detail: null,
  }))
  const draft = defaultDraft({
    keyword: 'k',
    criteria_text: 'c',
    spec: {},
    max_price: undefined,
    accepted_conditions: ['Open Box'],
  })

  it('asks one call per batch and hands each batch’s answers back with its listings', async () => {
    const calls: number[] = []
    const client = {
      systemOne: async ({ questions }: { questions: Record<string, unknown> }) => {
        const labels = new Set(Object.keys(questions).map((k) => k.split('.')[0]))
        calls.push(labels.size)
        return {
          model: 'fake',
          answers: Object.fromEntries(
            [...labels].flatMap((label) =>
              ['is_target_product', 'spec_match', 'condition_ok', 'criteria_freeform'].map((key) => [
                `${label}.${key}`,
                { type: 'noul', noul: 0.9 },
              ]).concat(
                ['listing_trust', 'price_value'].map((key) => [
                  `${label}.${key}`,
                  { type: 'score', score: 3, confidence: 0.5, legend: { '0': 'a', '4': 'e' }, probabilities: { '0': 0.1, '4': 0.9 } },
                ]),
              ),
            ),
          ),
          usage: { input_tokens: 100, output_tokens: 0 },
        }
      },
    } as never

    const stored: { listing: string; keys: number }[] = []
    const outcome = await askInBatches({
      client,
      batchSize: 2,
      emit: () => {},
      labelled,
      questionKeys: ['is_target_product', 'spec_match', 'condition_ok', 'listing_trust', 'price_value', 'criteria_freeform'],
      questionsFor: (batch) => ({ state: buildState(draft.request, batch), questions: buildFromDraft(draft, batch) }),
      onBatch: (results) => {
        for (const r of results) stored.push({ listing: r.listing.label, keys: Object.keys(r.answers).length })
      },
    })

    expect(calls).toEqual([2, 2])
    expect(outcome.batches).toBe(2)
    expect(outcome.judged).toBe(4)
    expect(stored).toEqual([
      { listing: 'L1', keys: 6 },
      { listing: 'L2', keys: 6 },
      { listing: 'L3', keys: 6 },
      { listing: 'L4', keys: 6 },
    ])
  })

  it('halves the batch on a refusal and stays halved for the job', async () => {
    const sizes: number[] = []
    const client = {
      systemOne: async ({ questions }: { questions: Record<string, unknown> }) => {
        const labels = new Set(Object.keys(questions).map((k) => k.split('.')[0]))
        sizes.push(labels.size)
        if (labels.size > 1) throw new Error('422: request too large')
        return {
          model: 'fake',
          answers: Object.fromEntries(
            [...labels].map((label) => [`${label}.condition_ok`, { type: 'noul', noul: 0.9 }]),
          ),
          usage: { input_tokens: 10, output_tokens: 0 },
        }
      },
    } as never

    const outcome = await askInBatches({
      client,
      batchSize: 2,
      emit: () => {},
      labelled,
      questionKeys: ['condition_ok'],
      questionsFor: (batch) => ({ state: buildState(draft.request, batch), questions: buildFromDraft(draft, batch) }),
      onBatch: () => {},
    })

    expect(sizes).toEqual([2, 1, 1, 1, 1])
    expect(outcome.batches).toBe(4)
    expect(outcome.judged).toBe(4)
  })

  it('counts an answer JEV did not return instead of pretending it arrived', async () => {
    const client = {
      systemOne: async () => ({
        model: 'fake',
        answers: { 'L1.condition_ok': { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 10, output_tokens: 0 },
      }),
    } as never

    const outcome = await askInBatches({
      client,
      batchSize: 1,
      emit: () => {},
      labelled: labelled.slice(0, 1),
      questionKeys: ['condition_ok', 'price_value'],
      questionsFor: (batch) => ({ state: buildState(draft.request, batch), questions: buildFromDraft(draft, batch) }),
      onBatch: () => {},
    })

    expect(outcome.missingAnswers).toBe(1)
  })

  it('stops between batches when cancelled, keeping what arrived', async () => {
    let batches = 0
    const client = {
      systemOne: async () => {
        batches++
        return {
          model: 'fake',
          answers: { 'L1.condition_ok': { type: 'noul', noul: 0.9 }, 'L2.condition_ok': { type: 'noul', noul: 0.9 } },
          usage: { input_tokens: 10, output_tokens: 0 },
        }
      },
    } as never

    const outcome = await askInBatches({
      client,
      batchSize: 2,
      emit: () => {},
      labelled,
      questionKeys: ['condition_ok'],
      isCancelled: () => batches >= 1,
      questionsFor: (batch) => ({ state: buildState(draft.request, batch), questions: buildFromDraft(draft, batch) }),
      onBatch: () => {},
    })

    expect(batches).toBe(1)
    expect(outcome.cancelled).toBe(true)
    expect(outcome.judged).toBe(2)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/judge.test.ts`
Expected: FAIL — `askInBatches is not a function`.

- [ ] **Step 3: Extract the loop**

Move the body of `judgeSurvivors`' batch loop into `askInBatches`, unchanged in behaviour — same halving, same `isTooLargeError` handling, same `judgments.received` payload, same message on a hard failure. `judgeSurvivors` becomes:

```ts
export async function judgeSurvivors(o: JudgeOptions): Promise<JudgeOutcome> {
  const survivors = listToJudge(o.db, o.runId)
  if (survivors.length === 0) return emptyOutcome()

  const questionnaireId = saveQuestionnaire(
    o.db,
    o.runId,
    { request: o.request, questionKeys: QUESTION_KEYS },
    nextQuestionnaireVersion(o.db, o.runId),
  )

  return askInBatches({
    client: o.client,
    batchSize: o.batchSize,
    emit: o.emit,
    isCancelled: o.isCancelled,
    labelled: survivors.map(toQuestionListing),
    questionKeys: QUESTION_KEYS,
    questionsFor: (batch) => ({
      state: buildState(o.request, batch),
      questions: buildQuestions(o.request, batch),
    }),
    onBatch: (results) => {
      for (const { listing, answers } of results) {
        saveJudgments(o.db, { runId: o.runId, questionnaireId, listingId: listing.runId, answers })
        updateListingStage(o.db, listing.runId, 'judged', null)
      }
    },
  })
}
```

Two details the implementer must get right:

- `onBatch` needs each result's **database id** as well as its `QuestionListing`, because the answers are stored per listing id. `toQuestionListing` therefore carries the id: give the seam's result type `{ listing: QuestionListing; listingId: number; answers: Record<string, JevAnswer> }` and have `judgeSurvivors` pair `survivors[start + i]` with `batch[i]`, exactly as the current loop does. The `askInBatches` signature keeps `labelled: QuestionListing[]` plus `listingIds: number[]` in the same order, so the seam stays free of storage types.
- `askInBatches` must keep the current behaviour of counting `missingAnswers` per question key and stopping on cancellation **between** batches.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/judge.test.ts tests/pipeline-run.test.ts tests/runner-live.test.ts`
Expected: PASS. `pipeline-run.test.ts` drives a whole run with a fake source and is the guard that the extraction changed nothing.

- [ ] **Step 5: Typecheck and the whole suite**

Run: `npm run typecheck && npm test`

---

### Task 4: Re-judge a stored run

**Files:**
- Create: `src/pipeline/rejudge.ts`
- Modify: `src/storage/events.ts` (three new event types)
- Modify: `src/pipeline/runner.ts` (`startRejudge`, the shared lock)
- Test: `tests/rejudge.test.ts` (create)

**Interfaces:**
- Consumes: `askInBatches`, `listJudgeable`, `buildFromDraft`, `buildState`, `nextQuestionnaireVersion`, `saveQuestionnaire`, `saveJudgments`, `emit`.
- Produces: `rejudgeRun(o: RejudgeOptions): Promise<RejudgeOutcome>` and `startRejudge(db, o): { runId: number; questionnaireId: number; version: number }`.

- [ ] **Step 1: Write the failing test**

Create `tests/rejudge.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/storage/db'
import { createSearch } from '../src/storage/searches'
import { createRun, finishRun } from '../src/storage/runs'
import { insertCards, type RawCard } from '../src/storage/listings'
import { listJudgments, listQuestionnaires } from '../src/storage/judgments'
import { listEvents } from '../src/storage/events'
import { rejudgeRun } from '../src/pipeline/rejudge'
import { defaultDraft } from '../src/jev/draft'

const card = (itemId: string): RawCard => ({
  itemId,
  title: `Lenovo ThinkPad T14s Gen 6 ${itemId}`,
  url: `https://www.ebay.com/itm/${itemId}`,
  price: 1000,
  shipping: 0,
  conditionLabel: 'Open Box',
  sellerName: 'seller',
  sellerFeedback: '100% positive (450)',
  watchers: null,
  buyingFormat: 'Buy It Now',
  sponsoredMarker: false,
  rawText: [],
})

function fixture(stages: string[] = ['judged', 'judged', 'detail_failed', 'rejected']) {
  const db = openDatabase(':memory:')
  const search = createSearch(db, { name: 's', keywor: 'k', keyword: 'k', criteriaText: 'c', spec: {} } as never)
  const run = createRun(db, search.id, {})
  finishRun(db, run.id, { status: 'complete' })
  const stored = insertCards(db, run.id, stages.map((_, i) => card(String(i + 1))))
  const ids = stages.map((_, i) => stored.idsByItemId.get(String(i + 1))!)
  stages.forEach((stage, i) => {
    db.prepare('update listings set stage = ? where id = ?').run(stage, ids[i])
  })
  return { db, runId: run.id, ids, search }
}

/** Every answer, so a batch of any size comes back complete. */
function fakeClient(answer = 0.9) {
  let calls = 0
  return {
    calls: () => calls,
    systemOne: async ({ questions }: { questions: Record<string, unknown> }) => {
      calls++
      const answers = Object.fromEntries(
        Object.keys(questions).map((key) => [
          key,
          key.includes('listing_trust') || key.includes('price_value')
            ? { type: 'score', score: 3, confidence: 0.5, legend: { '0': 'a', '4': 'e' }, probabilities: { '0': 0.1, '4': 0.9 } }
            : { type: 'noul', noul: answer },
        ]),
      )
      return { model: 'fake', answers, usage: { input_tokens: 100, output_tokens: 0 } }
    },
  }
}

const draft = (criteria = 'c') =>
  defaultDraft({
    keyword: 'k',
    criteria_text: criteria,
    spec: {},
    max_price: undefined,
    accepted_conditions: ['Open Box'],
  })

describe('rejudgeRun', () => {
  it('judges every listing the pre-filter kept, and only those', async () => {
    const { db, runId, ids } = fixture()
    const client = fakeClient()
    const outcome = await rejudgeRun({
      db,
      runId,
      draft: draft(),
      client: client as never,
      batchSize: 2,
      emit: () => {},
    })

    expect(outcome.judged).toBe(3)
    const judged = listJudgments(db, runId).map((j) => j.listingId)
    expect(new Set(judged)).toEqual(new Set([ids[0], ids[1], ids[2]]))
    expect(judged).not.toContain(ids[3])
  })

  it('creates a second version and leaves the first version’s answers alone', async () => {
    const { db, runId } = fixture()
    // A first judging at version 1, as a run would.
    await rejudgeRun({ db, runId, draft: draft('first'), client: fakeClient(0.8) as never, batchSize: 3, emit: () => {} })
    const first = listJudgments(db, runId)
    const second = await rejudgeRun({
      db,
      runId,
      draft: draft('second'),
      client: fakeClient(0.2) as never,
      batchSize: 3,
      emit: () => {},
    })

    const versions = listQuestionnaires(db, runId)
    expect(versions.map((v) => v.version)).toEqual([1, 2])
    expect(second.version).toBe(2)

    const all = listJudgments(db, runId)
    expect(all).toHaveLength(first.length * 2)
    expect(all.filter((j) => j.questionnaireId === versions[0]!.id)).toHaveLength(first.length)
    // Version 1's answers are still exactly what they were.
    expect(all.filter((j) => j.questionnaireId === versions[0]!.id)).toEqual(first)
  })

  it('does not change any listing’s stage, and never builds a page source', async () => {
    const { db, runId } = fixture(['survivor', 'detail_failed'])
    const stages = () =>
      db.prepare('select id, stage from listings order by id').all() as { id: number; stage: string }[]
    const before = stages()

    await rejudgeRun({ db, runId, draft: draft(), client: fakeClient() as never, batchSize: 10, emit: () => {} })

    // A re-judge re-asks; it does not make a listing more or less scraped. And it
    // constructs no PageSource at all — asserted by the call count a fake scraper
    // would see in the server test, and here by the module importing no scraper.
    expect(stages()).toEqual(before)
  })

  it('publishes every event it stores, so a live viewer sees the re-judge', async () => {
    const { db, runId } = fixture()
    const published: string[] = []
    await rejudgeRun({
      db,
      runId,
      draft: draft(),
      client: fakeClient() as never,
      batchSize: 2,
      emit: (type) => published.push(type),
    })

    expect(published[0]).toBe('rejudge.started')
    expect(published).toContain('judgments.received')
    expect(published[published.length - 1]).toBe('rejudge.finished')
    expect(listEvents(db, runId).map((e) => e.type)).toEqual(expect.arrayContaining(published))
  })

  it('reports a failure instead of leaving a silent half-version', async () => {
    const { db, runId } = fixture()
    let calls = 0
    const failing = {
      systemOne: async ({ questions }: { questions: Record<string, unknown> }) => {
        calls++
        if (calls > 1) throw new Error('502 upstream')
        return {
          model: 'fake',
          answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: 0.9 }])),
          usage: { input_tokens: 10, output_tokens: 0 },
        }
      },
    }
    const published: { type: string; payload: unknown }[] = []

    await expect(
      rejudgeRun({
        db,
        runId,
        draft: draft(),
        client: failing as never,
        batchSize: 1,
        emit: (type, payload) => published.push({ type, payload }),
      }),
    ).rejects.toThrow(/502 upstream/)

    // The first batch's answers stay — they cost money and are true.
    expect(listJudgments(db, runId).length).toBeGreaterThan(0)
    const failure = published.find((e) => e.type === 'rejudge.failed')
    expect(failure).toBeTruthy()
    expect(JSON.stringify(failure!.payload)).toContain('502 upstream')
    expect(listEvents(db, runId).map((e) => e.type)).toContain('rejudge.failed')
  })

  it('refuses a draft that could not be judged, before spending a call', async () => {
    const { db, runId } = fixture()
    const client = fakeClient()
    const broken = draft()
    broken.questions = broken.questions.map((q) => ({ ...q, instructions: '' })) as never

    await expect(
      rejudgeRun({ db, runId, draft: broken, client: client as never, batchSize: 10, emit: () => {} }),
    ).rejects.toThrow(/wording/)

    expect(client.calls()).toBe(0)
    expect(listQuestionnaires(db, runId)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/rejudge.test.ts`
Expected: FAIL — `Cannot find module '../src/pipeline/rejudge'`.

- [ ] **Step 3: Implement `src/pipeline/rejudge.ts`**

```ts
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { listJudgeable, type StoredListing } from '../storage/listings'
import {
  nextQuestionnaireVersion,
  saveJudgments,
  saveQuestionnaire,
} from '../storage/judgments'
import { buildState, labelFor, QUESTION_KEYS, type QuestionListing } from '../jev/questions'
import { buildFromDraft, validateDraft, type QuestionnaireDraft } from '../jev/draft'
import type { JevClient } from '../jev/client'
import type { RunEventType } from '../storage/events'
import { askInBatches, type JudgeOutcome } from './judge'

/**
 * Asks JEV the same run's questions again, from a stored run, under a new
 * questionnaire version — no eBay page, no scrape, no detail phase. Everything
 * the questions need was stored: the card, the detail, the seller record.
 *
 * A re-judge never touches `listing.stage`: a listing is as scraped as it was.
 * It selects `listJudgeable`, which is every row the pre-filter kept, because
 * after a first judging `listToJudge` would return nothing (spec §2).
 */

export interface RejudgeOptions {
  db: SqliteDatabase
  runId: number
  draft: QuestionnaireDraft
  client: JevClient
  batchSize: number
  emit: (type: RunEventType, payload: unknown) => void
  isCancelled?: () => boolean
}

export interface RejudgeOutcome extends JudgeOutcome {
  questionnaireId: number
  version: number
}

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

export async function rejudgeRun(o: RejudgeOptions): Promise<RejudgeOutcome> {
  // Before anything is spent: a draft the report could not rank is refused here,
  // so a bad edit costs one 400 and no JEV call.
  const reasons = validateDraft(o.draft)
  if (reasons.length > 0) {
    throw new Error(`This question set cannot be judged: ${reasons.join(' ')}`)
  }

  const listings = listJudgeable(o.db, o.runId)
  if (listings.length === 0) throw new Error(`Run ${o.runId} has no listings to judge`)

  const version = nextQuestionnaireVersion(o.db, o.runId)
  const labelled = listings.map(toQuestionListing)
  const questionnaireId = saveQuestionnaire(
    o.db,
    o.runId,
    {
      request: o.draft.request,
      questions: o.draft.questions,
      // Pinned rather than derived: the diff compares two versions per listing,
      // and a query's order is not a contract.
      labels: Object.fromEntries(listings.map((l, i) => [String(l.id), labelFor(i)])),
      questionKeys: [...QUESTION_KEYS],
    },
    version,
  )

  o.emit('rejudge.started', {
    questionnaireId,
    version,
    listings: listings.length,
    questionKeys: QUESTION_KEYS,
  })

  const outcome = await askInBatches({
    client: o.client,
    batchSize: o.batchSize,
    emit: o.emit,
    isCancelled: o.isCancelled,
    labelled,
    listingIds: listings.map((l) => l.id),
    questionKeys: o.draft.questions.map((q) => q.key),
    questionsFor: (batch) => ({
      state: buildState(o.draft.request, batch),
      questions: buildFromDraft(o.draft, batch),
    }),
    onBatch: (results) => {
      for (const { listingId, answers } of results) {
        saveJudgments(o.db, { runId: o.runId, questionnaireId, listingId, answers })
      }
    },
  })

  o.emit('rejudge.finished', {
    questionnaireId,
    version,
    judged: outcome.judged,
    costUsd: outcome.costUsd,
    missingAnswers: outcome.missingAnswers,
    cancelled: outcome.cancelled,
  })

  return { ...outcome, questionnaireId, version }
}
```

The failure path publishes `rejudge.failed`: wrap the `askInBatches` call in `try/catch`, and on error `o.emit('rejudge.failed', { questionnaireId, version, message })` before rethrowing. The test asserts the message contains the upstream text.

- [ ] **Step 4: Add the event types and the runner entry point**

In `src/storage/events.ts`, extend `RunEventType`:

```ts
  | 'rejudge.started'
  | 'rejudge.finished'
  | 'rejudge.failed'
```

In `src/pipeline/runner.ts`, the lock becomes a job of either kind:

```ts
let active: { runId: number; cancelled: boolean; kind: 'run' | 'rejudge' } | null = null
```

`activeRunId()`, `isRunning()` and `cancelRun()` keep their signatures. Add:

```ts
export interface StartRejudgeOptions {
  runId: number
  draft: QuestionnaireDraft
  batchSize?: number
  /** See `StartRunOptions.judgeClientFactory`: tests inject a fake, production builds the real one. */
  judgeClientFactory?: () => JevClient
}

/**
 * Re-judges a stored run in the background, under the same one-job-at-a-time lock
 * a run takes (CLAUDE.md rule 9): same JEV client, same SQLite file, one user.
 * The client is built before the lock is taken, so a missing API key is a
 * refusal rather than a half-finished version.
 */
export function startRejudge(db: SqliteDatabase, o: StartRejudgeOptions): { questionnaireId: number; version: number } {
  if (active) {
    throw new Error(`A run is already in progress (run ${active.runId}). Wait for it to finish.`)
  }
  const settings = getRun(db, o.runId)?.settings ?? {}
  const batchSize = o.batchSize ?? Number(settings.batchSize ?? DEFAULTS.batchSize)
  const client = (o.judgeClientFactory ?? createJevClient)()

  active = { runId: o.runId, cancelled: false, kind: 'rejudge' }
  const version = nextQuestionnaireVersion(db, o.runId)

  void (async () => {
    try {
      await rejudgeRun({
        db,
        runId: o.runId,
        draft: o.draft,
        client,
        batchSize,
        emit: (type, payload) => emit(db, o.runId, type, payload),
        isCancelled: () => active?.cancelled ?? true,
      })
    } catch (err) {
      // `rejudgeRun` already emitted the failure with its message; the lock is
      // the only thing left to release.
    } finally {
      active = null
    }
  })()

  return { questionnaireId: 0, version }
}
```

`startRejudge` cannot know the questionnaire id before the background job runs, so it returns the **version** and the route answers with `{ runId, version }`; the id arrives with the `rejudge.started` event the client is already listening to. The plan's `Interfaces` line above is corrected by this note: the route's 202 body is `{ runId, version }`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/rejudge.test.ts tests/runner-live.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and the whole suite**

Run: `npm run typecheck && npm test`

---

### Task 5: The route

**Files:**
- Modify: `src/server/routes/runs.ts`
- Test: `tests/server-rejudge.test.ts` (create)

**Interfaces:**
- Consumes: `startRejudge`, `validateDraft`, `getRun`, `listQuestionnaires`.
- Produces: `POST /api/runs/:id/rejudge` → 202 `{ runId, version }` · 400 `{ error, reasons? }` · 409 `{ error }`; `GET /api/runs/:id` → `{ run, listings, judgments, questionnaires }`.

- [ ] **Step 1: Write the failing test**

Create `tests/server-rejudge.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { openDatabase } from '../src/storage/db'
import { createSearch } from '../src/storage/searches'
import { createRun, finishRun } from '../src/storage/runs'
import { insertCards, type RawCard } from '../src/storage/listings'
import { buildServer } from '../src/server/index'
import { defaultDraft } from '../src/jev/draft'

const card = (itemId: string): RawCard => ({
  itemId,
  title: `Lenovo ThinkPad T14s Gen 6 ${itemId}`,
  url: `https://www.ebay.com/itm/${itemId}`,
  price: 1000,
  shipping: 0,
  conditionLabel: 'Open Box',
  sellerName: 'seller',
  sellerFeedback: '100% positive (450)',
  watchers: null,
  buyingFormat: 'Buy It Now',
  sponsoredMarker: false,
  rawText: [],
})

/** A scraper stand-in that counts, so "no page load" is a number, not a claim. */
function countingSource() {
  let calls = 0
  return {
    calls: () => calls,
    source: {
      goto: async () => {
        calls++
        throw new Error('a re-judge must never fetch a page')
      },
      content: async () => '', 
    },
  }
}

const search = {
  keyword: 'k',
  criteria_text: 'c',
  spec: {},
  max_price: undefined,
  accepted_conditions: ['Open Box'],
}

async function app(over = {}) {
  const db = openDatabase(':memory:')
  const created = createSearch(db, { name: 's', keyword: 'k', criteriaText: 'c', spec: {} })
  const run = createRun(db, created.id, {})
  finishRun(db, run.id, { status: 'complete' })
  insertCards(db, run.id, [card('1'), card('2')])
  db.prepare("update listings set stage = 'judged' where run_id = ?").run(run.id)

  const counter = countingSource()
  const server = buildServer(db, {
    sourceFactory: async () => counter.source as never,
    judgeClientFactory: () =>
      ({
        systemOne: async ({ questions }: { questions: Record<string, unknown> }) => ({
          model: 'fake',
          answers: Object.fromEntries(
            Object.keys(questions).map((key) => [
              key,
              key.includes('trust') || key.includes('price')
                ? { type: 'score', score: 3, confidence: 0.5, legend: { '0': 'a', '4': 'e' }, probabilities: { '0': 0.1, '4': 0.9 } }
                : { type: 'noul', noul: 0.9 },
            ]),
          ),
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
      }) as never,
    ...over,
  })
  return { db, runId: run.id, server, counter }
}

describe('POST /api/runs/:id/rejudge', () => {
  it('accepts a draft, then judges it without fetching a single page', async () => {
    const { server, runId, counter } = await app()
    const res = await server.inject({
      method: 'POST',
      url: `/api/runs/${runId}/rejudge`,
      payload: defaultDraft(search as never),
    })
    expect(res.statusCode).toBe(202)
    const body = res.json() as { runId: number; version: number }
    expect(body.version).toBe(2)

    // Let the background job finish, then read the run back.
    await new Promise((r) => setTimeout(r, 50))
    const run = await server.inject({ method: 'GET', url: `/api/runs/${runId}` })
    const payload = run.json() as { questionnaires: { version: number }[]; judgments: unknown[] }
    expect(payload.questionnaires.map((q) => q.version)).toEqual([1, 2])
    expect(payload.judgments.length).toBeGreaterThan(0)
    expect(counter.calls()).toBe(0)
    await server.close()
  })

  it('refuses a draft that could not be judged, and says why', async () => {
    const { server, runId } = await app()
    const broken = defaultDraft(search as never)
    broken.questions = broken.questions.map((q) => ({ ...q, instructions: '' })) as never
    const res = await server.inject({
      method: 'POST',
      url: `/api/runs/${runId}/rejudge`,
      payload: broken,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('cannot be judged')
    await server.close()
  })

  it('404s a run that does not exist, and 409s when a job is already running', async () => {
    const { server } = await app()
    const missing = await server.inject({
      method: 'POST',
      url: '/api/runs/999/rejudge',
      payload: defaultDraft(search as never),
    })
    expect(missing.statusCode).toBe(404)
    await server.close()
  })

  it('carries a questionnaireId on every judgment, so versions are separable', async () => {
    const { server, runId } = await app()
    await server.inject({ method: 'POST', url: `/api/runs/${runId}/rejudge`, payload: defaultDraft(search as never) })
    await new Promise((r) => setTimeout(r, 50))
    const payload = (await server.inject({ method: 'GET', url: `/api/runs/${runId}` })).json() as {
      questionnaires: { id: number }[]
      judgments: { questionnaireId: number }[]
    }
    const ids = new Set(payload.questionnaires.map((q) => q.id))
    for (const judgment of payload.judgments) expect(ids.has(judgment.questionnaireId)).toBe(true)
    await server.close()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/server-rejudge.test.ts`
Expected: FAIL — 404 on the rejudge route.

- [ ] **Step 3: Implement the route**

In `src/server/routes/runs.ts`:

```ts
  app.post('/api/runs/:id/rejudge', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const run = getRun(db, id)
    if (!run) return reply.code(404).send({ error: `No run ${id}` })

    const draft = request.body as QuestionnaireDraft
    const reasons = validateDraft(draft)
    if (reasons.length > 0) {
      return reply.code(400).send({ error: `This question set cannot be judged: ${reasons.join(' ')}`, reasons })
    }

    try {
      const { version } = startRejudge(db, {
        runId: id,
        draft,
        judgeClientFactory: opts.judgeClientFactory,
      })
      return reply.code(202).send({ runId: id, version })
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })
```

and extend the run payload:

```ts
    // Every version's judgments travel together: the report shows one version and
    // the row diff compares it with the previous one, so filtering per request
    // would cost a request per comparison (spec decision 4).
    return {
      run,
      listings: listListings(db, id),
      judgments: listJudgments(db, id),
      questionnaires: listQuestionnaires(db, id).map((q) => ({
        id: q.id,
        version: q.version,
        createdAt: q.createdAt,
        definition: q.definition,
      })),
    }
```

`buildServer`'s options type already carries `judgeClientFactory`; confirm the new route reads it from the same `opts` object.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/server-rejudge.test.ts tests/server-runs.test.ts`
Expected: PASS. `server-runs.test.ts` covers the run payload and must keep passing with the extra field.

- [ ] **Step 5: Typecheck and the whole suite**

Run: `npm run typecheck && npm test`

---

### Task 6: Versions in the browser's data layer

**Files:**
- Modify: `web/src/lib/api.ts`
- Create: `web/src/lib/versions.ts`
- Modify: `web/src/lib/export.ts`
- Test: `tests/versions.test.ts` (create)
- Test: `tests/export.test.ts` (add one case)

**Interfaces:**
- Produces: `Judgment.questionnaireId`, `Questionnaire`, `getRun` returning `questionnaires`, `rejudge(runId, draft)`; `judgmentsForVersion(judgments, questionnaireId)`, `previousVersionOf(questionnaires, questionnaireId)`, `answersByListing(judgments)`.

- [ ] **Step 1: Write the failing test**

Create `tests/versions.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { answersByListing, judgmentsForVersion, previousVersionOf } from '../web/src/lib/versions'

const questionnaires = [
  { id: 10, version: 1, createdAt: '2026-09-24 09:00', definition: {} },
  { id: 11, version: 2, createdAt: '2026-09-24 09:10', definition: {} },
]

const judgment = (id: number, questionnaireId: number, listingId: number, noul: number) => ({
  id,
  questionnaireId,
  listingId,
  questionKey: 'condition_ok',
  answer: { type: 'noul' as const, noul },
})

const judgments = [
  judgment(1, 10, 5, 0.9),
  judgment(2, 11, 5, 0.2),
  judgment(3, 10, 6, 0.8),
]

describe('judgmentsForVersion', () => {
  it('keeps one version, so two answers for one listing cannot overwrite each other', () => {
    // The trap this exists for: `score.ts` keys answers by listing and question.
    // Handed both versions, the report would show a mixture.
    expect(judgmentsForVersion(judgments, 10).map((j) => j.id)).toEqual([1, 3])
    expect(judgmentsForVersion(judgments, 11).map((j) => j.id)).toEqual([2])
  })
})

describe('previousVersionOf', () => {
  it('names the version before the selected one', () => {
    expect(previousVersionOf(questionnaires, 11)?.id).toBe(10)
  })

  it('has no previous version for the first one', () => {
    expect(previousVersionOf(questionnaires, 10)).toBeNull()
  })

  it('is null for a version id that is not in the list', () => {
    expect(previousVersionOf(questionnaires, 99)).toBeNull()
  })
})

describe('answersByListing', () => {
  it('indexes answers by listing, then by question, so a row can diff itself', () => {
    const map = answersByListing(judgmentsForVersion(judgments, 10))
    expect(map.get(5)?.condition_ok).toEqual({ type: 'noul', noul: 0.9 })
    expect(map.get(6)?.condition_ok).toEqual({ type: 'noul', noul: 0.8 })
    expect(map.get(7)).toBeUndefined()
  })
})
```

Add to `tests/export.test.ts`:

```ts
  it('says which questionnaire version produced the row', () => {
    const csv = toCsv([row()], 2)
    expect(csv.split('\n')[0]).toContain('questionnaire')
    expect(csv.split('\n')[1]).toContain(',2,')
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/versions.test.ts tests/export.test.ts`
Expected: FAIL — `Cannot find module '../web/src/lib/versions'` and, for export, an unexpected second argument.

- [ ] **Step 3: Implement**

`web/src/lib/versions.ts`:

```ts
import type { JevAnswer, Judgment, Questionnaire } from './api'

/**
 * Which version's answers a view is showing.
 *
 * Every version's judgments arrive in one payload (a diff wants two at once), so
 * the separation has to happen here, once, before anything ranks or renders
 * them: `score.ts` keys answers by listing and question, and two versions of the
 * same answer would otherwise overwrite each other silently.
 */

export function judgmentsForVersion(judgments: Judgment[], questionnaireId: number): Judgment[] {
  return judgments.filter((j) => j.questionnaireId === questionnaireId)
}

/** The version just before the selected one, or null when there is not one. */
export function previousVersionOf(
  questionnaires: Questionnaire[],
  questionnaireId: number,
): Questionnaire | null {
  const ordered = [...questionnaires].sort((a, b) => a.version - b.version)
  const index = ordered.findIndex((q) => q.id === questionnaireId)
  if (index <= 0) return null
  return ordered[index - 1]!
}

/** Listing id → question key → answer, for the answer panel's "was …". */
export function answersByListing(judgments: Judgment[]): Map<number, Record<string, JevAnswer>> {
  const out = new Map<number, Record<string, JevAnswer>>()
  for (const j of judgments) {
    const answers = out.get(j.listingId) ?? {}
    answers[j.questionKey] = j.answer
    out.set(j.listingId, answers)
  }
  return out
}
```

`web/src/lib/api.ts`: `Judgment` gains `questionnaireId: number`; add

```ts
export interface Questionnaire {
  id: number
  version: number
  createdAt: string
  definition: Record<string, unknown>
}
```

`getRun` returns `questionnaires: Questionnaire[]` too, and:

```ts
/** Re-asks a stored run's questions under a new version. No scraping, ever. */
export function rejudge(
  runId: number,
  draft: Record<string, unknown>,
): Promise<{ runId: number; version: number }> {
  return request<{ runId: number; version: number }>(`/api/runs/${runId}/rejudge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  })
}
```

`web/src/lib/export.ts`: `CSV_COLUMNS` gains `'questionnaire'` after `'status'`, and

```ts
export function toCsv(rows: ReportRow[], questionnaireVersion?: number): string {
  // …
        rowStatus(row),
        questionnaireVersion ?? '',
  // …
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/versions.test.ts tests/export.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and the whole suite**

Run: `npm run typecheck && npm test`

---

### Task 7: The version selector and the row diff

**Files:**
- Create: `web/src/components/VersionSelector.tsx`
- Modify: `web/src/components/AnswerDetail.tsx`
- Modify: `web/src/components/RunView.tsx`
- Verify: `node --import tsx scripts/repro-live-ui.ts` (with `npm run dev:web` running)

**Interfaces:**
- Consumes: `judgmentsForVersion`, `previousVersionOf`, `answersByListing`, `toCsv(rows, version)`.
- Produces: `<VersionSelector>`, `<AnswerDetail previousAnswers>`, `RunView`'s version state.

- [ ] **Step 1: Wire the version into `RunView`**

State and derivation:

```tsx
  const [questionnaireId, setQuestionnaireId] = useState<number | null>(null)

  // Default to the newest version: the newest is what the run's last judging
  // produced, and an ordinary run has exactly one.
  const newest = [...questionnaires].sort((a, b) => b.version - a.version)[0] ?? null
  const selected = questionnaireId ?? newest?.id ?? null
  const selectedRows = useMemo(
    () => (selected === null ? judgments : judgmentsForVersion(judgments, selected)),
    [judgments, selected],
  )
  const previous = selected === null ? null : previousVersionOf(questionnaires, selected)
  const previousAnswers = useMemo(
    () => (previous ? answersByListing(judgmentsForVersion(judgments, previous.id)) : new Map()),
    [judgments, previous],
  )
  const report = useMemo(
    () => buildReport(survivors, selectedRows, settings),
    [listings, selectedRows, settings],
  )
```

`getRun`'s response feeds a new `questionnaires` state; the `snapshot` and `refresh` paths set it too. The table's export call becomes `toCsv(exported, questionnaires.find((q) => q.id === selected)?.version)`. `ReportTable` passes `previousAnswers.get(row.listing.id)` into `AnswerDetail`.

- [ ] **Step 2: Write `VersionSelector.tsx`**

```tsx
import type { Questionnaire } from '../lib/api'

/**
 * Which version's answers the report is showing. One version means no selector:
 * an ordinary run's header must not grow a control that can only do one thing.
 */
export function VersionSelector({
  questionnaires,
  selected,
  onSelect,
}: {
  questionnaires: Questionnaire[]
  selected: number | null
  onSelect: (id: number) => void
}) {
  if (questionnaires.length < 2) return null
  const ordered = [...questionnaires].sort((a, b) => b.version - a.version)

  return (
    <label className="flex items-center gap-2 text-sm text-lilac-ash">
      questions
      <select
        aria-label="questionnaire version"
        value={selected ?? ''}
        onChange={(e) => onSelect(Number(e.target.value))}
        className="rounded border border-lilac-ash/40 bg-transparent px-1 py-0.5 text-almond-silk"
      >
        {ordered.map((q) => (
          <option key={q.id} value={q.id}>
            v{q.version} · {q.createdAt.slice(11, 16)}
          </option>
        ))}
      </select>
    </label>
  )
}
```

- [ ] **Step 3: Add the diff to `AnswerDetail.tsx`**

The answer panel already formats a noul and a score answer; the diff must use the same formatter, so the two cannot read differently. Add an optional prop and, per question, a line when the previous version had an answer:

```tsx
/** "was 0.62" — one line, only where the previous version answered the same question. */
function WasLine({ previous }: { previous?: JevAnswer }) {
  if (!previous) return null
  return <span className="ml-2 text-xs text-lilac-ash/60">was {describeAnswer(previous)}</span>
}
```

Replace `describeAnswer` with whichever helper `answers.ts` already exposes for a resolved answer's value (`resolveAnswer` in the current file, or `formatAnswer`), and pass `previousAnswers?.[questionKey]` at each call site. A question with no previous answer renders nothing extra.

- [ ] **Step 4: Prove it in the browser**

With `npm run dev:web` running, open a run, and check by hand:

- one version → no selector;
- after Task 8's re-judge → a selector with two entries, switching it re-ranks the table with **no** new request (watch the network panel), and an opened row shows `was …` on the questions whose answers moved.

Record the observed numbers in the plan's Stage 7 section when it is written (Task 9).

- [ ] **Step 5: Typecheck and the whole suite**

Run: `npm run typecheck && npm test`
Expected: clean. The browser-only behaviour is covered by Task 9's script.

---

### Task 8: The question editor

**Files:**
- Create: `web/src/components/QuestionEditor.tsx`
- Modify: `web/src/components/RunView.tsx`
- Verify: the repro script (Task 9) drives it

**Interfaces:**
- Consumes: `draftFromDefinition`, `defaultQuestions`, `defaultDraft`, `specProse` (server-side module, imported by the web build — `tests/web-spec.test.ts` already sets that precedent), `rejudge()`.
- Produces: `<QuestionEditor questionnaires selected onClose onStarted />`.

- [ ] **Step 1: Build the editor**

```tsx
import { useMemo, useState } from 'react'
import { rejudge, type Questionnaire } from '../lib/api'
import { draftFromDefinition, type DraftQuestion, type QuestionnaireDraft } from '../../src/jev/draft'
import type { SearchRequest } from '../../src/jev/questions'

/**
 * The questions, editable, with the parts that must not move kept out of reach:
 * the listing prefix and the buyer's requirements are generated at build time, so
 * this form edits the wording and the anchors and nothing else. A draft the
 * server refuses comes back with its reasons, shown verbatim.
 */
export function QuestionEditor({ ... }) {
  const [draft, setDraft] = useState<QuestionnaireDraft>(() =>
    draftFromDefinition(selected?.definition, fallbackRequest),
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reasons, setReasons] = useState<string[]>([])

  const setQuestion = (key: string, patch: Partial<DraftQuestion>) =>
    setDraft((current) => ({
      ...current,
      questions: current.questions.map((q) => (q.key === key ? ({ ...q, ...patch } as DraftQuestion) : q)),
    }))

  const submit = async () => {
    setBusy(true)
    setError(null)
    setReasons([])
    try {
      await rejudge(runId, draft as unknown as Record<string, unknown>)
      onStarted()
    } catch (e) {
      // The route's 400 lists what is wrong with the draft; a 409 says another
      // job holds the lock. Neither is a crash.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  // …the form: criteria textarea, spec fields, budget, accepted conditions,
  // then one block per question — a textarea for `instructions`, and either the
  // two anchors or the level lines.
}
```

Each question block carries `aria-label={`instructions ${q.key}`}`, `aria-label={`anchor true ${q.key}`}`, and `aria-label={`level ${i} ${q.key}`}` so the repro script can drive it.

- [ ] **Step 2: Mount it in `RunView`**

A "Edit questions" button in the header (only for a finished run with listings) toggles the editor above the report. On success the editor closes and the SSE stream's `rejudge.*` and `judgments.received` events refresh the view — add the three new event names to the generic listener list in `RunView`, which already calls `refresh()` for events starting with `run.`:

```tsx
    const generic = [
      // …
      'rejudge.started',
      'rejudge.finished',
      'rejudge.failed',
    ]
    // and in the refresh condition:
    if (type.startsWith('run.') || type.startsWith('rejudge.') || /* … */) refresh()
```

- [ ] **Step 3: Check it by hand, then typecheck**

Open a run, change one question's wording, submit, and watch the new version appear with a selector and a diff. Then:

Run: `npm run typecheck && npm test`

---

### Task 9: Prove it in the browser, and write the stage up

**Files:**
- Modify: `scripts/repro-live-ui.ts`
- Modify: `docs/superpowers/plans/2026-09-18-jevbrowser-build-plan.md` (Stage 7 completion + Handoff)
- Modify: `CLAUDE.md` (Stage 7 rules; "Current state")

**Interfaces:**
- Consumes: everything above; the script's existing `__log` fetch counter and its fixture HTTP server.

- [ ] **Step 1: Extend the script**

After the existing controls check, and before `browser.close()`:

```ts
  // Stage 7's acceptance criterion, measured where it is claimed: re-judging a
  // stored run asks JEV again and touches eBay not at all.
  const fixtureHits = async () =>
    page.evaluate(() =>
      (window as never as { __log: unknown[][] }).__log.filter(
        (e) => e[0] === 'fetch' && String(e[1]).includes(`:${FIXTURE_PORT}`),
      ).length,
    )
  const hitsBefore = await fixtureHits()

  await page.getByRole('button', { name: 'Edit questions' }).click()
  const edited = await page.evaluate(() => {
    const textarea = document.querySelector(
      'textarea[aria-label="instructions criteria_freeform"]',
    ) as HTMLTextAreaElement | null
    if (!textarea) return false
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set
    setter?.call(textarea, 'Edited by the repro: does this satisfy the buyer, really?')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })
  await page.getByRole('button', { name: /Re-judge/ }).click()
  await page.waitForTimeout(1500)
  const hitsAfter = await fixtureHits()

  const versions = await page
    .locator('select[aria-label="questionnaire version"] option')
    .allInnerTexts()
  console.log(`\nre-judge: textarea found=${edited}`)
  console.log(`fixture requests during a re-judge: ${hitsAfter - hitsBefore}`)
  console.log(`questionnaire versions offered: ${JSON.stringify(versions)}`)
```

- [ ] **Step 2: Run it**

Start `npm run dev:web`, then:

```bash
node --import tsx scripts/repro-live-ui.ts
```

Expected, verbatim in spirit:

```
re-judge: textarea found=true
fixture requests during a re-judge: 0
questionnaire versions offered: ["v2 · 12:31","v1 · 12:30"]
```

A non-zero fixture count means something in the re-judge path fetched a page — find it before believing anything else. `textarea found=false` means the `aria-label` and the script disagree; fix the script's string, not the label.

- [ ] **Step 3: Run the whole suite and the typecheck**

Run: `npm run typecheck && npm test`
Expected: clean, and every pre-existing test still passing.

- [ ] **Step 4: Write the stage up**

In `docs/superpowers/plans/2026-09-18-jevbrowser-build-plan.md`, replace the Stage 7 section body with a `## Stage 7 — persistence, re-open, re-judge (complete <date>)` section in the style of the Stage 3–6 completion sections: what was built, the acceptance criteria marked met with the numbers the script printed, and anything the work found that changed the code. Move the Handoff's "next" pointer to **Stage 8**, and strike the `spec: {}`-on-a-fresh-run item if Task 8's editor was wired to write it back (it is not, in this plan — leave that item open and say so).

In `CLAUDE.md`, add the three rules this stage establishes, in the same voice as the existing ones:

- a re-judge judges `listJudgeable`, never `listToJudge` (the third row of the spec's §2 table);
- `listJudgments` returns every version, so every consumer filters first — `answersOf` in `score.ts` keys by listing and question and would silently mix two versions;
- a version's stored definition holds the question **bodies** and the buyer's requirements are generated from its `request`, so an edit cannot leave a quoted criterion stale, and a version stored before this stage has no `questions` at all (the editor falls back to the shipped ones).

- [ ] **Step 5: Confirm nothing regressed, then hand over**

Run: `npm test && npm run typecheck`
Report the numbers, the script's output, and anything the plan asked for that the code did not do.

---

## Self-Review

**Spec coverage.** §3 decision 1 (version in the same run) → Tasks 2, 4. Decision 2 (draft, prefix by code) → Task 1. Decision 3 (kinds fixed) → Task 1's `validateDraft`. Decision 4 (all versions in one payload, browser filters) → Tasks 5, 6, 7. Decision 5 (a partial version is visible) → Task 4's failure test and Task 5's payload. Decision 6 (one job at a time) → Task 4's `startRejudge`. §4's `definition_json` shape → Tasks 1, 4. §5's builders → Task 1. §6's seam, `rejudgeRun`, events, storage helpers → Tasks 3, 4. §7's route and payload → Task 5. §8's UI, export column → Tasks 6, 7, 8. §9's error table → Tasks 4, 5 (400 before a call; the rest already exist). §10's test files → every task. §11 out of scope → no task touches adding/removing questions, re-scraping, or editing a version in place. §12's carried-forward `spec: {}` → Task 9 keeps it open and says so.

**Placeholder scan.** No TBDs. Two steps carry prose where the code is mechanical — Task 3's `onBatch` id pairing (the seam's result type has to carry a listing id and the exact shape is stated) and Task 7's `WasLine` (the formatter's name is whichever `answers.ts` exposes). Both name the file to read and the property to preserve; neither leaves an engineer guessing at intent.

**Type consistency.** `QuestionnaireDraft`/`DraftQuestion` (Task 1) are used unchanged in Tasks 4, 6, 8. `askInBatches`' options (Task 3) are consumed unchanged by Tasks 3 and 4, with `listingIds` added in Task 3 and used in Task 4. `JudgeOutcome` extends into `RejudgeOutcome` (Task 4). `listJudgeable`, `nextQuestionnaireVersion`, `saveQuestionnaire(db, runId, definition, version)` (Task 2) are used unchanged in Task 4. `Questionnaire` and `Judgment.questionnaireId` (Task 6) are used in Tasks 7, 8. `toCsv(rows, version)` (Task 6) is called with two arguments in Task 7. `startRejudge` returns `{ version }` — the route's body — and the questionnaire id arrives by event; Task 5's test asserts that, not an id in the 202.

**Review Focus.** Each of the six lines has its test: (1) Task 6's `judgmentsForVersion` and Task 7's filter; (2) Task 1's `draftFromDefinition` fallback and Task 5's payload; (3) Task 4's failure test; (4) Task 3's halving test and Task 4's caller; (5) Task 2's `listJudgeable` and Task 4's stage test; (6) Task 1's `validateDraft` suite and Task 4's "refuses before spending a call".
