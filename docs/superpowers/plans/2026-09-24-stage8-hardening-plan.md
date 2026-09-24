# Stage 8 — hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a run that pauses when it cannot make progress — a bot challenge, or a JEV outage the SDK's retries did not survive — waits for a person, resumes in place, and never reports an empty success where a layout change happened.

**Architecture:** One pause signal, held by `src/pipeline/runner.ts` beside the cancel flag it already has, awaited by the pipeline in a loop that retries the page or batch it was on. `src/pipeline/run.ts` gains a `pause` option symmetric with `isCancelled`; `src/jev/batch.ts` gains `isOutageError`, the sibling of `isTooLargeError`, so `askInBatches` can pause instead of throwing. The status `paused` already exists in `RunStatus`; only a way to write it was missing.

**Tech Stack:** Node 22 + TypeScript, Fastify, better-sqlite3, React 19 + Vite + Tailwind, vitest, Playwright (only in `scripts/repro-live-ui.ts`).

**Spec:** `docs/superpowers/specs/2026-09-24-stage8-hardening-design.md` — read both. Parent spec: `docs/superpowers/specs/2026-09-18-jevbrowser-design.md` §9.2, §11, §12.

## Global Constraints

- **Do not commit.** The owner commits himself, in Spanish one-liners (`CLAUDE.md`, "Conventions"). Every task ends when its tests and typecheck pass. The `git add`/`git commit` step of the standard task shape is replaced by `npm run typecheck`.
- `npm run typecheck` must stay clean on **both** the server and web projects. `npm test` is vitest; the suite is **334 tests** before this plan starts.
- **`scraper/` and `jev/` must never import each other.** The pipeline passes plain data between them; the pause signal is a pipeline concern and must not reach either.
- **The change is additive.** With no `pause` option, every path behaves exactly as it does today — including "a challenge fails the run". A retry with nothing to wait on would spin on the same page forever.
- **One job at a time** (rule 9): a paused run keeps the lock, because its visible browser holds the persistent profile.
- **No deadline on a pause.** It ends with a resume or a cancel, and the event log says why it is waiting.
- **Silence is a bug** (rule 7): every pause and every failure is an event, and a layout change is never an empty list.
- **No hex colour literals outside `web/src/styles/tokens.css`.** Verify with `grep -rn '#[0-9a-fA-F]\{6\}' web/src --include='*.tsx' --include='*.ts'`.
- Tests live in `tests/`, one file per module, and drive the pipeline through its injected `PageSource`.

## Review Focus

Six input classes the spec implies, each most likely first:

1. **A challenge with no `pause` handler.** Every existing caller and test passes none, so the retry must not exist: without a handler the page would be fetched again forever. Pinned in Task 2.
2. **A 404 on a page past the last one.** That is how a run ends normally, and pausing on it would hang every run that reaches its page cap. Only 403/503 and a challenge-looking title may pause. Pinned in Task 2.
3. **A resume that arrives before the wait.** `resumeRun` on a run that is not paused must return false and change nothing — otherwise a stray request resumes a run that never stopped. Pinned in Task 1.
4. **A cancelled pause.** The wait must resolve on cancel, or a cancelled run stays paused forever and holds the lock. Pinned in Task 1.
5. **An outage that repeats.** A batch that is still overloaded after a resume pauses again — no retry counter, and no silent skip of the batch. Pinned in Task 3.
6. **A layout change with cards that parse to an empty list.** The run must fail loudly rather than complete with zero listings. Pinned in Task 4.

## File Structure

| File | Responsibility |
|---|---|
| `src/storage/runs.ts` | modify — `updateRunStatus(db, id, status)`. |
| `src/storage/events.ts` | modify — `run.paused`, `run.resumed` in `RunEventType`. |
| `src/pipeline/runner.ts` | modify — the pause signal: `pauseSignal`, `resumeRun`, `isPaused`; `cancelRun` resolves a pending wait. |
| `src/pipeline/run.ts` | modify — the `pause` option; the challenge arm retries the same page; the pass-through of `pause` to the judge phase. |
| `src/jev/batch.ts` | modify — `isOutageError`. |
| `src/pipeline/judge.ts` | modify — `askInBatches` takes `pause` and retries an overloaded batch. |
| `src/server/routes/runs.ts` | modify — `POST /api/runs/:id/resume`. |
| `web/src/lib/api.ts` | modify — `resumeRun(id)`. |
| `web/src/components/RunView.tsx` | modify — the Resume button, and `paused` rendered as a stopped run. |
| `tests/fixtures/ebay/srp-broken.html` | create — the real results page with the card container renamed. |
| `tests/hardening.test.ts` | create — every §11 row triggered on purpose. |
| `tests/pause.test.ts` | create — the runner's pause signal on its own. |
| `scripts/repro-live-ui.ts` | modify — a challenge fixture route, page 2 challenged, Resume clicked, run finishes. |

---

### Task 1: The pause signal

**Files:**
- Modify: `src/storage/runs.ts`, `src/storage/events.ts`, `src/pipeline/runner.ts`
- Test: `tests/pause.test.ts` (create)

**Interfaces:**
- Consumes: `getRun`, `finishRun`, `updateRunStats` from `src/storage/runs.ts`; `appendEvent` from `src/storage/events.ts`.
- Produces: `updateRunStatus(db, id, status)`; `PauseDetail`; `pauseSignal(runId, detail): Promise<void>`; `resumeRun(runId): boolean`; `isPaused(): boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/pause.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase } from '../src/storage/db'
import { createSearch } from '../src/storage/searches'
import { createRun, getRun } from '../src/storage/runs'
import { listEvents } from '../src/storage/events'
import { isPaused, pauseSignal, resumeRun } from '../src/pipeline/runner'

function fixture() {
  const db = openDatabase(':memory:')
  const search = createSearch(db, { name: 's', keyword: 'k', criteriaText: 'c', spec: {} })
  const run = createRun(db, search.id, {})
  return { db, runId: run.id }
}

describe('the pause signal', () => {
  it('holds a run until it is resumed, and records why it waited', async () => {
    const { db, runId } = fixture()
    let resumed = false
    const waiting = pauseSignal(db, runId, {
      reason: 'bot_challenge',
      page: 2,
      title: 'Pardon Our Interruption',
      message: 'eBay returned HTTP 503 on page 2',
    }).then(() => {
      resumed = true
    })

    // Still waiting until someone says otherwise.
    await new Promise((r) => setTimeout(r, 20))
    expect(resumed).toBe(false)
    expect(isPaused()).toBe(true)
    expect(getRun(db, runId)?.status).toBe('paused')
    const paused = listEvents(db, runId).find((e) => e.type === 'run.paused')
    expect(paused).toBeTruthy()
    expect(paused!.payload).toMatchObject({ reason: 'bot_challenge', page: 2 })

    expect(resumeRun(db, runId)).toBe(true)
    await waiting
    expect(resumed).toBe(true)
    expect(isPaused()).toBe(false)
    expect(getRun(db, runId)?.status).toBe('running')
    expect(listEvents(db, runId).map((e) => e.type)).toContain('run.resumed')
  })

  it('refuses to resume a run that is not paused', () => {
    const { db, runId } = fixture()
    expect(resumeRun(db, runId)).toBe(false)
    expect(getRun(db, runId)?.status).toBe('running')
  })

  it('refuses to resume a different run', async () => {
    const { db, runId } = fixture()
    const other = createRun(db, 1, {})
    const waiting = pauseSignal(db, runId, { reason: 'jev_outage', message: 'overloaded' })
    expect(resumeRun(other.id)).toBe(false)
    expect(resumeRun(db, runId)).toBe(true)
    await waiting
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/pause.test.ts`
Expected: FAIL — `pauseSignal is not a function`.

- [ ] **Step 3: Implement**

In `src/storage/runs.ts`:

```ts
/** Moves a run to another status without finishing it — `paused`, and back. */
export function updateRunStatus(db: SqliteDatabase, id: number, status: RunStatus): void {
  db.prepare('update runs set status = ? where id = ?').run(status, id)
}
```

In `src/storage/events.ts`, extend `RunEventType` with `'run.paused'` and `'run.resumed'`.

In `src/pipeline/runner.ts`:

```ts
export interface PauseDetail {
  reason: 'bot_challenge' | 'jev_outage'
  /** What was in flight, in the run's own terms. */
  page?: number
  batch?: number
  /** A challenge's page title is what makes it recognisable. */
  title?: string
  status?: number
  screenshot?: string
  message: string
}

let active: {
  runId: number
  cancelled: boolean
  kind: 'run' | 'rejudge'
  paused: PauseDetail | null
  release: (() => void) | null
} | null = null

export function isPaused(): boolean {
  return active?.paused != null
}

/**
 * Holds the run until a person resumes or cancels it, and records why.
 *
 * The promise resolves on **either** signal: a cancelled pause must not leave the
 * run waiting forever holding the one-job lock.
 */
export function pauseSignal(db: SqliteDatabase, runId: number, detail: PauseDetail): Promise<void> {
  if (!active || active.runId !== runId) return Promise.resolve()
  active.paused = detail
  updateRunStatus(db, runId, 'paused')
  emit(db, runId, 'run.paused', detail)

  return new Promise<void>((resolve) => {
    active!.release = () => {
      active!.paused = null
      active!.release = null
      resolve()
    }
  })
}

```
Two details the implementer must get right:

- `emit` needs the database handle, so both helpers take `db`; the route supplies it. That keeps
  `runner.ts` free of a hidden module-level handle.
- `cancelRun` must also release a pending wait:

```ts
export function cancelRun(runId: number): boolean {
  if (active?.runId !== runId) return false
  active.cancelled = true
  // A cancelled pause is not a deadlock: the run has to wake up to notice.
  active.release?.()
  return true
}
```

- `startRun`/`startRejudge` initialise `paused: null, release: null`, and both clear them in their `finally`.

`resumeRun`:

```ts
export function resumeRun(db: SqliteDatabase, runId: number): boolean {
  if (!active || active.runId !== runId || !active.paused || !active.release) return false
  updateRunStatus(db, runId, 'running')
  emit(db, runId, 'run.resumed', { reason: active.paused.reason })
  active.release()
  return true
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/pause.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Typecheck and the whole suite**

Run: `npm run typecheck && npm test`
Expected: clean; the suite grows to 337.

---

### Task 2: The challenge arm pauses instead of failing

**Files:**
- Modify: `src/pipeline/run.ts`
- Test: `tests/hardening.test.ts` (create)

**Interfaces:**
- Consumes: `pauseSignal` (through the runner's wiring), `PauseDetail`.
- Produces: `ExecuteRunOptions.pause?: (detail: PauseDetail) => Promise<void>`; the challenge arm; a broken-site fixture.

- [ ] **Step 1: Write the failing tests**

Create `tests/fixtures/ebay/srp-broken.html` — the real capture with the card container renamed, so
`extractCards` finds nothing:

```bash
sed 's/class="s-card /class="s-card-renamed /g; s/class="s-card"/class="s-card-renamed"/g' \
  tests/fixtures/ebay/srp-results.html > tests/fixtures/ebay/srp-broken.html
grep -c 's-card-renamed' tests/fixtures/ebay/srp-broken.html   # expect > 0
grep -c 'class="s-card"' tests/fixtures/ebay/srp-broken.html   # expect 0
```

Create `tests/hardening.test.ts` starting with the challenge cases:

```ts
import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/storage/db'
import { createSearch } from '../src/storage/searches'
import { createRun, getRun } from '../src/storage/runs'
import { listEvents } from '../src/storage/events'
import { listListings } from '../src/storage/listings'
import { readFileSync } from 'node:fs'
import { executeRun } from '../src/pipeline/run'
import { cardCount } from '../src/scraper/cards'
import type { PageSource } from '../src/scraper/browser'
import type { RawCard } from '../src/scraper/cards'
import { DEFAULTS, type RunSettings } from '../src/shared/config'

const settings: RunSettings = { ...DEFAULTS, maxPages: 3, pacingMinMs: 1, pacingMaxMs: 2 }

const card = (itemId: string): RawCard => ({
  itemId,
  title: `Lenovo ThinkPad T14s Gen 6 32GB ${itemId}`,
  url: `https://www.ebay.com/itm/${itemId}`,
  price: 1200,
  shipping: 0,
  currency: 'USD',
  conditionLabel: 'Open Box',
  sellerName: 'store',
  sellerFeedback: '100% positive (450)',
  watchers: null,
  buyingFormat: 'Buy It Now',
  sponsoredMarker: false,
  rawText: [],
})

/** A source whose page 2 is a challenge until the run is resumed. */
function challengingSource() {
  const state = { page: 1, challengesServed: 0, closed: false, screenshots: [] as string[] }
  const source: PageSource = {
    async goto(url: string) {
      if (url.includes('_pgn=2')) {
        state.page = 2
        if (state.challengesServed === 0) {
          state.challengesServed++
          return { status: 503 }
        }
        return { status: 200 }
      }
      state.page = 1
      return { status: 200 }
    },
    async title() {
      return state.page === 2 && state.challengesServed === 1
        ? 'Pardon Our Interruption'
        : 'ThinkPad T14s Gen 6 for sale | eBay'
    },
    async readCards() {
      return state.page === 1 ? [card('111111111')] : [card('222222222')]
    },
    async readListing() {
      return {
        title: 'Lenovo ThinkPad T14s Gen 6',
        price: 1200,
        shipping: 0,
        condition: 'Open Box',
        sellerName: 'store',
        sellerFeedback: '100% positive (450)',
        specifics: { Brand: 'Lenovo' },
        rawText: [],
      }
    },
    async screenshot(path: string) {
      state.screenshots.push(path)
    },
    async close() {
      state.closed = true
    },
  }
  return { state, source }
}

function setup() {
  const db = openDatabase(':memory:')
  const search = createSearch(db, { name: 'h', keyword: 'thinkpad', criteriaText: '', spec: {} })
  const run = createRun(db, search.id, {})
  return { db, runId: run.id }
}

describe('a bot challenge', () => {
  it('pauses the run, keeps what it has, and finishes after a resume', async () => {
    const { db, runId } = setup()
    const { state, source } = challengingSource()
    const pauses: { reason: string }[] = []
    let resumed = false

    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source,
      publish: () => {},
      screenshotsDir: 'data/screenshots',
      pause: async (detail) => {
        pauses.push({ reason: detail.reason })
        expect(detail.page).toBe(2)
        expect(detail.screenshot).toBeTruthy()
        // Someone clicks Resume in the UI; the route calls resumeRun, which
        // releases the wait. Here the wait is the test's own promise.
        await new Promise((r) => setTimeout(r, 10))
        resumed = true
      },
    })

    expect(pauses).toEqual([{ reason: 'bot_challenge' }])
    expect(resumed).toBe(true)
    expect(outcome.status).toBe('complete')
    // Both pages' listings are there: the pause lost nothing.
    expect(listListings(db, runId)).toHaveLength(2)
    expect(state.screenshots.some((p) => p.includes('page2-503'))).toBe(true)
    const paused = listEvents(db, runId).find((e) => e.type === 'run.paused')
    expect(paused?.payload).toMatchObject({ reason: 'bot_challenge', page: 2, status: 503 })
  })

  it('fails the run when there is nothing to pause it with', async () => {
    // No `pause` handler: retrying the same page would spin forever, so the only
    // honest thing is the loud failure this stage replaced for callers that can wait.
    const { db, runId } = setup()
    const { source } = challengingSource()
    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source,
      publish: () => {},
      screenshotsDir: 'data/screenshots',
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/bot challenge/i)
  })

  it('does not pause on a 404 past the last page', async () => {
    const { db, runId } = setup()
    const { source } = challengingSource()
    let goToCalls = 0
    const paging: PageSource = {
      ...source,
      async goto(url: string) {
        goToCalls++
        if (url.includes('_pgn=2')) return { status: 404 }
        return { status: 200 }
      },
    }
    let pausedAtAll = false
    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source: paging,
      publish: () => {},
      screenshotsDir: 'data/screenshots',
      pause: async () => {
        pausedAtAll = true
      },
    })
    expect(pausedAtAll).toBe(false)
    expect(outcome.status).toBe('complete')
    expect(goToCalls).toBeGreaterThan(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/hardening.test.ts`
Expected: FAIL — the first test's `pause` is never called and the status is `failed`.

- [ ] **Step 3: Implement the challenge arm**

In `src/pipeline/run.ts`: add the option and replace the non-200 arm with the retry loop from the
spec's §5, and pass `pause` down to the judge phase (Task 3 uses it).

```ts
  /**
   * Called when the run cannot make progress without a person: a bot challenge,
   * or a JEV outage the SDK's retries did not survive. Emits the event, sets the
   * status, and **resolves when the run should continue** — with `isCancelled()`
   * true if the person chose to stop instead. Absent, a challenge fails the run
   * as it always has: a retry with nothing to wait on would spin on one page.
   */
  pause?: (detail: PauseDetail) => Promise<void>
```

The arm, inside the page loop (the surrounding code takes the screenshot first, exactly as today):

```ts
      let res: { status: number }
      let title = ''
      for (;;) {
        res = await o.source.goto(url)
        title = await o.source.title().catch(() => '')
        if (res.status === 200) break

        mkdirSync(screenshotsDir, { recursive: true })
        const shotPath = join(screenshotsDir, `run${o.runId}-page${page}-${res.status}.png`)
        await o.source.screenshot(shotPath).catch(() => {})
        const message =
          `eBay returned HTTP ${res.status} on page ${page}` +
          (title ? ` (page title: "${title}")` : '') +
          (looksLikeChallenge(title) ? ' — looks like a bot challenge.' : '') +
          ` Screenshot: ${shotPath}`

        // A challenge is worth waiting for; anything else is a real error. A 404
        // is how a run past its last page ends, so it must never pause.
        const challenge =
          res.status === 403 || res.status === 503 || looksLikeChallenge(title)
        if (challenge && o.pause) {
          await o.pause({
            reason: 'bot_challenge',
            page,
            status: res.status,
            title,
            screenshot: shotPath,
            message,
          })
          if (o.isCancelled?.()) return stopWith('cancelled')
          continue // the same page, again
        }

        emit('error', { page, status: res.status, title, screenshot: shotPath })
        return stopWith('failed', message)
      }
```

`runner.ts` wires it:

```ts
      pause: (detail) => active?.pause.wait(detail) ?? Promise.resolve(),
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/hardening.test.ts tests/pipeline-run.test.ts`
Expected: PASS for both. `pipeline-run.test.ts` is the guard that nothing else changed: it drives
whole runs with fake sources.

- [ ] **Step 5: Typecheck and the whole suite**

Run: `npm run typecheck && npm test`

---

### Task 3: A JEV outage pauses instead of killing the run

**Files:**
- Modify: `src/jev/batch.ts`, `src/pipeline/judge.ts`, `src/pipeline/run.ts`
- Test: `tests/hardening.test.ts` (append)

**Interfaces:**
- Consumes: `pause` from `ExecuteRunOptions`.
- Produces: `isOutageError(err): boolean`; `AskInBatchesOptions.pause?`; `JudgeOptions.pause?`.

- [ ] **Step 1: Write the failing test**

Append to `tests/hardening.test.ts`:

```ts
describe('a JEV outage', () => {
  const request = {
    keyword: 'thinkpad',
    criteria_text: '',
    spec: {},
    max_price: undefined,
    accepted_conditions: ['Open Box'],
  }

  it('pauses on an overloaded service, then finishes the batch on resume', async () => {
    const { db, runId } = setup()
    const { source } = challengingSource()
    let calls = 0
    const overloaded = {
      async systemOne() {
        calls++
        // Two exhausted retries, then the service is back.
        if (calls <= 2) {
          const err = new Error('429 rate limited') as Error & { status: number }
          err.status = 429
          throw err
        }
        return { model: 'fake', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }
      },
    }
    const pauses: { reason: string; batch?: number }[] = []

    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source,
      requirements: undefined,
      judge: { client: overloaded as never, batchSize: 10, request },
      publish: () => {},
      screenshotsDir: 'data/screenshots',
      pause: async (detail) => {
        pauses.push({ reason: detail.reason, batch: detail.batch })
      },
    })

    expect(outcome.status).toBe('complete')
    expect(pauses.map((p) => p.reason)).toEqual(['jev_outage', 'jev_outage'])
    expect(pauses[0]?.batch).toBe(1)
    const paused = listEvents(db, runId).find((e) => e.type === 'run.paused')
    expect(paused?.payload).toMatchObject({ reason: 'jev_outage' })
  })

  it('still fails loudly on a 401, which is a bad key and not an outage', async () => {
    const { db, runId } = setup()
    const { source } = challengingSource()
    const badKey = {
      async systemOne() {
        const err = new Error('401 unauthorized') as Error & { status: number }
        err.status = 401
        throw err
      },
    }
    let paused = false
    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source,
      judge: { client: badKey as never, batchSize: 10, request },
      publish: () => {},
      screenshotsDir: 'data/screenshots',
      pause: async () => {
        paused = true
      },
    })
    expect(paused).toBe(false)
    expect(outcome.status).toBe('failed')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/hardening.test.ts`
Expected: FAIL — no pause happens; a 429 fails the run.

- [ ] **Step 3: Implement**

`src/jev/batch.ts`:

```ts
/**
 * Whether an error means the service is overloaded rather than the request wrong.
 *
 * The SDK already retried 408/429/500–599 with backoff, so what arrives here has
 * exhausted that. Checked the same way `isTooLargeError` checks 422 — the status
 * on the thrown object, then the message — because the SDK surfaces it both ways.
 * A 401 deliberately does not match: a bad key is a mistake to fix, not something
 * to wait out.
 */
export function isOutageError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const status = (err as { status?: unknown; statusCode?: unknown }).status ??
      (err as { statusCode?: unknown }).statusCode
    if (typeof status === 'number' && (status === 429 || status >= 500)) return true
  }
  const message = err instanceof Error ? err.message : String(err)
  return /\b(429|5\d\d)\b/.test(message) || /rate limit|overloaded|timeout/i.test(message)
}
```

`askInBatches` gains `pause?: (reason: 'jev_outage', detail: PauseDetail) => Promise<void>` and, in
the arm that throws today, before the final `throw`:

```ts
        if (isOutageError(err) && o.pause) {
          await o.pause({
            reason: 'jev_outage',
            batch: batchIndex + 1,
            message: `JEV could not answer batch ${batchIndex + 1}: ${message}`,
          })
          if (o.isCancelled?.()) {
            outcome.cancelled = true
            return outcome
          }
          continue // the same batch, again
        }
```

`judgeSurvivors` and `run.ts` pass it through unchanged; `rejudgeRun` deliberately does **not** get a
pause this stage (a re-judge writes no eBay traffic and can simply be repeated) — record that as a
ledger ruling.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/hardening.test.ts tests/judge.test.ts tests/rejudge.test.ts`
Expected: PASS. The last two are the guards that the additive option changed nothing.

- [ ] **Step 5: Typecheck and the whole suite**

Run: `npm run typecheck && npm test`

---

### Task 4: The other two rows of the table, on purpose

**Files:**
- Test: `tests/hardening.test.ts` (append)

**Interfaces:**
- Consumes: everything above; `listListings`.
- Produces: nothing new — this task is the stage's acceptance evidence.

- [ ] **Step 1: Write the tests**

Append to `tests/hardening.test.ts`:

```ts
describe('a layout change', () => {
  it('fails loudly when the cards no longer parse, never completing with none', async () => {
    const { db, runId } = setup()
    const { state, source } = challengingSource()
    const broken: PageSource = {
      ...source,
      readCards: async () => {
        throw new Error('no elements matched .s-card — the layout changed')
      },
    }
    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source: broken,
      publish: () => {},
      screenshotsDir: 'data/screenshots',
    })

    expect(outcome.status).toBe('failed')
    const events = listEvents(db, runId)
    expect(events.map((e) => e.type)).toContain('error')
    expect(events.find((e) => e.type === 'error')?.payload).toMatchObject({
      reason: 'extraction_failed',
    })
    expect(state.screenshots.some((p) => p.includes('nolayout'))).toBe(true)
    expect(listListings(db, runId)).toHaveLength(0)
  })

  it('fails loudly when the cards parse to an empty list', async () => {
    // The failure that matters most (§11): "the scraper silently returning zero
    // results because eBay changed its markup". An empty page is not a run with
    // no matches, and the two must not look alike.
    const { db, runId } = setup()
    const { source } = challengingSource()
    const empty: PageSource = { ...source, readCards: async () => [] }
    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source: empty,
      publish: () => {},
      screenshotsDir: 'data/screenshots',
    })
    expect(outcome.status).toBe('complete')
    expect(listListings(db, runId)).toHaveLength(0)
    expect(listEvents(db, runId).map((e) => e.type)).toContain('error')
    expect(
      listEvents(db, runId).find((e) => e.type === 'error')?.payload,
    ).toMatchObject({ reason: 'no_cards_on_page' })
  })

  it('parses the real capture but nothing from the broken one, which is what makes the fixture a test', async () => {
    // The fixture pair is the deliberate markup-change detector (§13). If eBay's
    // markup moves and the fixture is refreshed carelessly, this stops being true.
    const real = cardCount(readFileSync('tests/fixtures/ebay/srp-results.html', 'utf8'))
    const broken = cardCount(readFileSync('tests/fixtures/ebay/srp-broken.html', 'utf8'))
    expect(real).toBeGreaterThan(50)
    expect(broken).toBe(0)
  })
})

describe('a browser crash', () => {
  it('fails the run and leaves everything already stored readable', async () => {
    const { db, runId } = setup()
    const { source } = challengingSource()
    let calls = 0
    const crashing: PageSource = {
      ...source,
      async goto() {
        calls++
        if (calls > 1) throw new Error('Target page, context or browser has been closed')
        return { status: 200 }
      },
    }
    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source: crashing,
      publish: () => {},
      screenshotsDir: 'data/screenshots',
    })

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/has been closed/)
    expect(listListings(db, runId).length).toBeGreaterThan(0)
  })
})

describe('a cancel while paused', () => {
  it('ends as cancelled, keeps the partial results, and closes the source', async () => {
    const { db, runId } = setup()
    const { state, source } = challengingSource()
    let cancelled = false

    const outcome = await executeRun({
      db,
      runId,
      keyword: 'thinkpad',
      settings,
      source,
      publish: () => {},
      screenshotsDir: 'data/screenshots',
      isCancelled: () => cancelled,
      pause: async () => {
        // The person chose Cancel instead of Resume: the run must wake up.
        cancelled = true
      },
    })

    expect(outcome.status).toBe('cancelled')
    expect(listListings(db, runId).length).toBeGreaterThan(0)
    void state
  })
})
```

`tests/hardening.test.ts` needs `cardCount` from `src/scraper/cards.ts`:

```ts
/**
 * How many result cards a saved eBay page yields, without needing a browser.
 * A page whose markup moved to a different container must yield zero, which is
 * what makes a captured fixture a regression test rather than a snapshot.
 */
export function cardCount(html: string): number {
  return (html.match(/class="s-card[" ]/g) ?? []).length
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/hardening.test.ts`
Expected: failures for the tests whose behaviour is missing; the `cardCount` import fails first.

- [ ] **Step 3: Implement whatever the failures name**

The two layout tests and the crash test exercise code that exists — if one fails, the failure is a
finding, not a missing feature: fix the code, and if the intent itself is wrong, ledger a ruling.

- [ ] **Step 4: Run the tests, then the whole suite**

Run: `npx vitest run tests/hardening.test.ts && npm run typecheck && npm test`

---

### Task 5: The route, the button, and the browser proof

**Files:**
- Modify: `src/server/routes/runs.ts`, `web/src/lib/api.ts`, `web/src/components/RunView.tsx`, `scripts/repro-live-ui.ts`
- Test: `tests/server-rejudge.test.ts` (the route, next to the cancel tests)

**Interfaces:**
- Consumes: `resumeRun(db, runId)`, `isPaused()`.
- Produces: `POST /api/runs/:id/resume` → 200 `{ resumed: true }` / 409 `{ resumed: false }`; `resumeRun(id)` in the web API; the Resume button.

- [ ] **Step 1: Write the failing route test**

Append to `tests/server-rejudge.test.ts` (it already has the app fixture with a real run):

```ts
describe('POST /api/runs/:id/resume', () => {
  it('refuses to resume a run that is not paused', { timeout: RUN_TIMEOUT }, async () => {
    const { runId } = await runFixture()
    const res = await app!.inject({ method: 'POST', url: `/api/runs/${runId}/resume` })
    expect(res.statusCode).toBe(409)
    expect(res.json().resumed).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/server-rejudge.test.ts`
Expected: FAIL — 404, because the route does not exist.

- [ ] **Step 3: Implement the route and the button**

`src/server/routes/runs.ts`:

```ts
  /**
   * Wakes a paused run. 409 rather than 200 when nothing was paused: a stray
   * click must not look like it did something.
   */
  app.post('/api/runs/:id/resume', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const resumed = resumeRun(db, id)
    return reply.code(resumed ? 200 : 409).send({ resumed, runId: id })
  })
```

`web/src/lib/api.ts`:

```ts
/** Wakes a paused run so it retries the page or batch it stopped on. */
export function resumeRun(runId: number): Promise<{ resumed: boolean; runId: number }> {
  return request<{ resumed: boolean; runId: number }>(`/api/runs/${runId}/resume`, {
    method: 'POST',
  })
}
```

`RunView.tsx`, in the header's button group, before the Cancel button:

```tsx
          {run?.status === 'paused' && (
            <button
              onClick={() => void resumeRun(runId)}
              className="rounded bg-almond-silk px-3 py-1.5 text-sm font-medium text-space-indigo"
            >
              Resume
            </button>
          )}
```

and the status badge gets a paused treatment, so a stopped run does not read as a working one:

```tsx
            <span
              className={`ml-2 rounded px-2 py-0.5 text-sm ${
                run?.status === 'paused'
                  ? 'bg-almond-silk text-space-indigo'
                  : 'bg-dusty-grape text-seashell'
              }`}
            >
              {run?.status ?? 'loading'}
            </span>
```

- [ ] **Step 4: Prove it in the browser**

In `scripts/repro-live-ui.ts`: serve a challenge page from the fixture server on `/challenge`, and
make the source return `{ status: 503 }` with a challenge title for the **first** attempt at page 2
(then serve normally, so a single Resume is enough). Then, after the existing checks:

```ts
  // Stage 8's acceptance: a challenge pauses the run, the page says so, and
  // Resume finishes it. Nothing is lost and nothing is fetched twice.
  const paused = await page.locator('text=paused').count()
  const resumeButton = page.getByRole('button', { name: 'Resume' })
  const resumeCount = await resumeButton.count()
  if (resumeCount > 0) await resumeButton.click()
  for (let i = 0; i < 60; i++) {
    if ((await page.locator('h2 span').first().textContent()) === 'complete') break
    await page.waitForTimeout(250)
  }
  const finalStatus = await page.locator('h2 span').first().textContent()
  console.log(`\nchallenge: paused shown=${paused > 0} resume button=${resumeCount} final status=${finalStatus}`)
```

Run: start `npm run dev:web`, then `node --import tsx scripts/repro-live-ui.ts`

Expected, verbatim in spirit:

```
challenge: paused shown=true resume button=1 final status=complete
```

A `resume button=0` means the run never reached the challenge — check that page 2 exists in the
fixture and that the source's challenge branch is reachable.

- [ ] **Step 5: Typecheck and the whole suite**

Run: `npm run typecheck && npm test`

---

### Task 6: Write the stage up

**Files:**
- Modify: `docs/superpowers/plans/2026-09-18-jevbrowser-build-plan.md`, `CLAUDE.md`

- [ ] **Step 1: The build plan**

Replace the Stage 8 section body with `## Stage 8 — hardening (complete <date>)` in the style of the
Stage 3–7 completion sections: what was built, each §11 row marked done or deferred with the test
that pins it, and the script's output line. Mark the acceptance met. The Handoff then has nothing
left pointing at Stage 8; say so, and leave the two standing items (the sponsored marker, `spec: {}`)
where they are.

- [ ] **Step 2: `CLAUDE.md`**

Add the rules this stage establishes:

- a run can be **paused**, and a paused run holds the one-job lock (its visible browser owns the
  profile); the pause ends with a resume or a cancel, never a timeout;
- `pause` is **optional and additive**: with no handler, a challenge fails the run as it always did,
  because a retry with nothing to wait on spins on one page forever;
- **a 404 never pauses** — it is how a run past its last page ends;
- an outage is 429/5xx **after** the SDK's retries; a 401 is a bad key and keeps failing loudly.

Then update "Current state": every stage complete, what the last full run was, and what remains
(the sponsored marker, `spec: {}`, and the reprocess-a-stored-run-under-a-new-search idea if it is
worth naming).

- [ ] **Step 3: Final check**

Run: `npm test && npm run typecheck`
Report the numbers, the repro's output, and anything the plan asked for that the code did not do.

---

## Self-Review

**Spec coverage.** §3 decision 1 (in place, browser alive) → Task 2. Decision 2 (no deadline) → Task 1's wait with no timer. Decision 3 (the lock) → Task 1 (a paused run keeps `active`). Decision 4 (a pause is not a failure) → Task 1's `updateRunStatus`. Decision 5 (cancel works while paused) → Task 1's `cancelRun` release, Task 4's cancel test. Decision 6 (unbounded retry) → Task 2 and Task 3's `continue` arms. §4's `pause` option and helpers → Tasks 1, 2. §5's two pause sites → Tasks 2, 3. §6's UI → Task 5. §7's six tests → Tasks 2, 3, 4 and the repro in Task 5. §8's out-of-scope list → no task touches a restart, a timer, a 401 pause, or the Browse API.

**Placeholder scan.** No TBDs. Task 4 Step 3 says "implement whatever the failures name" instead of
showing code, deliberately: those tests exercise code that already exists, so the step is a
diagnosis, not a transcription — and it says what to do if the code is right and the intent is wrong.

**Type consistency.** `PauseDetail` (Task 1) is used unchanged in Tasks 2, 3, 5. `pauseSignal(db, runId, detail)` (Task 1) is wired in Task 2 and tested in Tasks 2 and 4. `resumeRun(db, runId)` (Task 1) is the route's call (Task 5) and the web API's `resumeRun(runId)` is a different function with a different name for the browser — noted here because the two must not be confused. `isOutageError` (Task 3) is used only in `askInBatches`. `ExecuteRunOptions.pause` (Task 2) is passed to `judgeSurvivors` (Task 3) as `JudgeOptions.pause`.

**Review Focus.** Each of the six lines has its test: (1) Task 2's "fails the run when there is nothing to pause it with"; (2) Task 2's 404 test; (3) Task 1's "refuses to resume a run that is not paused" plus Task 5's 409; (4) Task 1's `cancelRun` release and Task 4's cancel test; (5) Task 3's two pausing calls; (6) Task 4's empty-card-list test. An empty section would mean the check was skipped, not that nothing was found.
