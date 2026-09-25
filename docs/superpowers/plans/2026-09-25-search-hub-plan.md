# The search list as the hub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make every stored run reachable and readable from the search list, and let the owner delete
a search with everything under it.

**Architecture:** The search list becomes the hub. `GET /api/searches` grows each search's runs
(one aggregate query, no N+1); a new `DELETE /api/searches/:id` refuses while a run of that search
holds the one-job lock and cascades otherwise; `App.tsx` renders a run's status and actions per
search, opening the `RunView` that already exists. Phase 2 adds RAM and storage as sortable report
columns, derived at read time from the title with the pre-filter's own parsers.

**Tech Stack:** Node 22 + TypeScript, Fastify, better-sqlite3, React 19 + Vite + Tailwind, vitest,
Playwright (only in `scripts/repro-live-ui.ts`).

**Spec:** `docs/superpowers/specs/2026-09-25-search-hub-design.md` — read it. Every task below argues
from it.

## Global Constraints

- **Do not commit.** The owner commits himself, in Spanish one-liners. Every task ends with
  `npm run typecheck && npm test`, not with a `git commit`.
- `npm run typecheck` must stay clean on **both** projects (`tsc --noEmit && tsc --noEmit -p web`).
  `npm test` is vitest; the suite is **376 tests** before this plan starts.
- **Deleting is irreversible.** The cascade is the schema's (`on delete cascade`), and the only guard
  is the 409 plus the second click. Never add a path that deletes without both.
- **No hex colour literals outside `web/src/styles/tokens.css`.** Verify with
  `grep -rn '#[0-9a-fA-F]\{6\}' web/src --include='*.tsx' --include='*.ts'`.
- **A missing value is `—`, never `0`.** This applies to the new capacity columns and to every count.
- **The scraper and the JEV client never import each other.** Nothing here touches either, but a new
  module must not be the first to break it.
- Tests live in `tests/`, one file per module. The API gets route tests; pure functions get unit
  tests; anything the browser alone can prove goes in `scripts/repro-live-ui.ts`.

## Review Focus

Six input classes the spec implies, each most likely first. Each has its test named in the task that
owns the code.

1. **A search whose only run is still active.** Deleting it would remove rows the running job is
   writing to. The route must answer 409, and the cascade must not run at all — pinned in Task 3.
2. **A search with no runs at all.** The ordinary case for a freshly saved search. It must delete
   cleanly rather than reporting "active" because nothing matched — pinned in Task 3.
3. **A run that exists but has never been judged** (run 9 is exactly this). The row must not offer a
   report as if there were one, and must offer the way to produce it — pinned in Task 5.
4. **A listing whose title states no capacity.** The pre-filter treats a missing capacity as
   *survivable*, not as a contradiction; the column must show `—` and sort last, in both directions —
   pinned in Tasks 7 and 8.
5. **A title that states a capacity the buyer's floor rejects** (16 GB against a 32 GB floor). The
   column and the pre-filter must agree, because they read the same function — pinned in Task 7.
6. **Deleting a search twice, or one that never existed.** A double click must not 500 — pinned in
   Task 3.

---

## Phase 1 — the hub

### Task 1: Run summaries per search

**Files:**
- Modify: `src/storage/runs.ts` (append)
- Test: `tests/storage.test.ts` (append)

**Interfaces:**
- Consumes: `RunStatus` and the existing `runs`/`listings`/`judgments` tables.
- Produces: `RunSummary`, `listRunSummaries(db): RunSummary[]` — later tasks group by `searchId`.

- [ ] **Step 1: Write the failing test**

Append to `tests/storage.test.ts`. It needs `createRun`, `listRunSummaries`, `insertCards` and
`saveJudgments`, so extend its imports with:

```ts
import { createRun, finishRun, listRunSummaries } from '../src/storage/runs'
import { insertCards } from '../src/storage/listings'
import { saveJudgments, saveQuestionnaire } from '../src/storage/judgments'
import type { RawCard } from '../src/scraper/cards'
```

```ts
describe('listRunSummaries', () => {
  const card = (itemId: string): RawCard => ({
    itemId,
    title: `Lenovo ThinkPad T14s ${itemId}`,
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

  it('counts what a run found, what the pre-filter stopped and what it answered', () => {
    const db = openDatabase(':memory:')
    const search = createSearch(db, input)
    const run = createRun(db, search.id, {})
    const stored = insertCards(db, run.id, [card('1'), card('2'), card('3')])
    db.prepare("update listings set stage = 'rejected' where id = ?").run(stored.idsByItemId.get('3'))

    const questionnaireId = saveQuestionnaire(
      db,
      run.id,
      { request: input, questionKeys: ['is_target_product'] },
      1,
    )
    saveJudgments(db, {
      runId: run.id,
      questionnaireId,
      listingId: stored.idsByItemId.get('1')!,
      answers: { is_target_product: { type: 'noul', noul: 0.9 } },
    })

    const [summary] = listRunSummaries(db)
    expect(summary).toMatchObject({
      id: run.id,
      searchId: search.id,
      status: 'running',
      listings: 3,
      rejected: 1,
      judged: 1,
      finishedAt: null,
    })
  })

  it('returns every run newest first, including one with nothing under it', () => {
    const db = openDatabase(':memory:')
    const search = createSearch(db, input)
    const first = createRun(db, search.id, {})
    const second = createRun(db, search.id, {})
    finishRun(db, first.id, { status: 'cancelled' })

    const summaries = listRunSummaries(db)
    expect(summaries.map((s) => s.id)).toEqual([second.id, first.id])
    expect(summaries[1]).toMatchObject({ listings: 0, rejected: 0, judged: 0, status: 'cancelled' })
    // A cancelled run keeps the moment it ended, which is how the row dates it.
    expect(summaries[1]!.finishedAt).toBeTruthy()
  })

  it('counts a listing once however many versions answered it', () => {
    // `listJudgments` returns every version, so a naive count would report twice
    // the listings once a run has been re-judged.
    const db = openDatabase(':memory:')
    const search = createSearch(db, input)
    const run = createRun(db, search.id, {})
    const stored = insertCards(db, run.id, [card('1')])
    const listingId = stored.idsByItemId.get('1')!

    for (const version of [1, 2]) {
      const questionnaireId = saveQuestionnaire(
        db,
        run.id,
        { request: input, questionKeys: ['is_target_product'] },
        version,
      )
      saveJudgments(db, {
        runId: run.id,
        questionnaireId,
        listingId,
        answers: { is_target_product: { type: 'noul', noul: 0.9 } },
      })
    }

    expect(listRunSummaries(db)[0]!.judged).toBe(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/storage.test.ts`
Expected: FAIL — `listRunSummaries is not a function`.

- [ ] **Step 3: Implement**

Append to `src/storage/runs.ts`:

```ts
/**
 * One row per run, with what the row needs to offer its report: how much it found,
 * how much the pre-filter stopped, and how many listings have an answer.
 *
 * `judged` counts distinct listings across every questionnaire version, not rows:
 * a re-judged run has two versions answering the same listings, and counting rows
 * would report twice the truth.
 */
export interface RunSummary {
  id: number
  searchId: number
  status: RunStatus
  startedAt: string | null
  finishedAt: string | null
  listings: number
  rejected: number
  judged: number
}

export function listRunSummaries(db: SqliteDatabase): RunSummary[] {
  const rows = db
    .prepare(
      `select r.id, r.search_id, r.status, r.started_at, r.finished_at,
              (select count(*) from listings l where l.run_id = r.id) as listings,
              (select count(*) from listings l where l.run_id = r.id and l.stage = 'rejected')
                as rejected,
              (select count(distinct j.listing_id) from judgments j where j.run_id = r.id)
                as judged
         from runs r
        order by r.id desc`,
    )
    .all() as {
    id: number
    search_id: number
    status: RunStatus
    started_at: string | null
    finished_at: string | null
    listings: number
    rejected: number
    judged: number
  }[]

  return rows.map((row) => ({
    id: row.id,
    searchId: row.search_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    listings: row.listings,
    rejected: row.rejected,
    judged: row.judged,
  }))
}
```

- [ ] **Step 4: Run the tests, then the suite and typecheck**

Run: `npx vitest run tests/storage.test.ts && npm run typecheck && npm test`
Expected: PASS; the suite grows to 379.

---

### Task 2: `GET /api/searches` carries each search's runs

**Files:**
- Modify: `src/server/routes/searches.ts:6`
- Test: `tests/server-searches.test.ts` (append)

**Interfaces:**
- Consumes: `listRunSummaries` (Task 1).
- Produces: every `GET /api/searches` element gains `runs: RunSummary[]`, its own, newest first.

- [ ] **Step 1: Write the failing test**

Add to the top of `tests/server-searches.test.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/storage/db'
import { createSearch } from '../src/storage/searches'
import { createRun, finishRun } from '../src/storage/runs'
```

The server's database is not exposed on the Fastify instance, so seed a **file** database and build
the server over it — `:memory:` would give the app a different, empty one.

```ts
describe('a search carries its own runs', () => {
  it('lists each search’s runs newest first, and only its own', async () => {
    // The door this closes: the page could not reach a run it had not just
    // started, so a finished report was unreachable from the UI.
    const dir = mkdtempSync(join(tmpdir(), 'jevbrowser-hub-'))
    const dbPath = join(dir, 'hub.db')

    const seed = openDatabase(dbPath)
    const mine = createSearch(seed, { ...body, spec: {} })
    const other = createSearch(seed, { ...body, name: 'other', spec: {} })
    const older = createRun(seed, mine.id, {})
    finishRun(seed, older.id, { status: 'cancelled' })
    const newer = createRun(seed, mine.id, {})
    createRun(seed, other.id, {})
    seed.close()

    const app = buildServer({ dbPath })
    const res = await app.inject({ method: 'GET', url: '/api/searches' })
    const searches = res.json() as { id: number; runs: { id: number; status: string }[] }[]
    await app.close()

    const found = searches.find((s) => s.id === mine.id)!
    expect(found.runs.map((r) => r.id)).toEqual([newer.id, older.id])
    expect(found.runs[1]!.status).toBe('cancelled')
    expect(found.runs[0]).toMatchObject({ listings: 0, rejected: 0, judged: 0 })
    // The other search's run is not on this search's row.
    expect(searches.find((s) => s.id === other.id)!.runs).toHaveLength(1)
  })

  it('gives a search with no runs an empty list rather than omitting the field', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    await app.inject({ method: 'POST', url: '/api/searches', payload: body })
    const res = await app.inject({ method: 'GET', url: '/api/searches' })
    expect(res.json()[0].runs).toEqual([])
    await app.close()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/server-searches.test.ts`
Expected: FAIL — `expected undefined to deeply equal []`, because the route returns the storage rows
with no `runs` field.

- [ ] **Step 3: Implement**

Replace the `GET` in `src/server/routes/searches.ts`:

```ts
  /**
   * Every search with its own runs, newest first. Composed here rather than in
   * `storage/searches.ts`: the repository owns searches, and the join belongs
   * where the response is shaped.
   *
   * One query for all the runs, not one per search — the list refetches after
   * every action, and this is the request it makes.
   */
  app.get('/api/searches', async () => {
    const summaries = listRunSummaries(db)
    return listSearches(db).map((search) => ({
      ...search,
      runs: summaries.filter((run) => run.searchId === search.id),
    }))
  })
```

and its import:

```ts
import { listRunSummaries } from '../../storage/runs'
```

- [ ] **Step 4: Run the tests, then the suite and typecheck**

Run: `npx vitest run tests/server-searches.test.ts && npm run typecheck && npm test`
Expected: PASS. Existing assertions (`toEqual([])`, `.keyword`, `.id`) are unaffected: the field is
additive.

---

### Task 3: `DELETE /api/searches/:id`

**Files:**
- Modify: `src/server/routes/searches.ts` (append after the `POST`)
- Test: `tests/server-searches.test.ts` (append)

**Interfaces:**
- Consumes: `activeRunId()` and `isRunning()` from `src/pipeline/runner.ts`; `getSearch` from storage.
- Produces: `DELETE /api/searches/:id` → `204` (no body) · `404 {error}` unknown · `409 {error}` while
  one of its runs is active.

- [ ] **Step 1: Write the failing test**

```ts
describe('DELETE /api/searches/:id', () => {
  it('removes the search and everything under it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevbrowser-del-'))
    const dbPath = join(dir, 'del.db')

    const seed = openDatabase(dbPath)
    const search = createSearch(seed, { ...body, spec: {} })
    const run = createRun(seed, search.id, {})
    const stored = insertCards(seed, run.id, [card('1'), card('2')])
    const questionnaireId = saveQuestionnaire(
      seed,
      run.id,
      { request: body, questionKeys: ['is_target_product'] },
      1,
    )
    saveJudgments(seed, {
      runId: run.id,
      questionnaireId,
      listingId: stored.idsByItemId.get('1')!,
      answers: { is_target_product: { type: 'noul', noul: 0.9 } },
    })
    seed.close()

    const app = buildServer({ dbPath })
    const res = await app.inject({ method: 'DELETE', url: `/api/searches/${search.id}` })
    expect(res.statusCode).toBe(204)

    // The cascade is the schema's, so the proof is that nothing is left behind.
    const after = openDatabase(dbPath)
    expect(after.prepare('select count(*) c from searches').get()).toMatchObject({ c: 0 })
    expect(after.prepare('select count(*) c from runs').get()).toMatchObject({ c: 0 })
    expect(after.prepare('select count(*) c from listings').get()).toMatchObject({ c: 0 })
    expect(after.prepare('select count(*) c from judgments').get()).toMatchObject({ c: 0 })
    expect(after.prepare('select count(*) c from questionnaires').get()).toMatchObject({ c: 0 })
    after.close()
    await app.close()
  })

  it('refuses while a run of that search is working, and removes nothing', async () => {
    // A run holds the one-job lock and is writing to the very rows a delete would
    // remove under it (rule 9). 409 rather than 500, and nothing deleted.
    const dir = mkdtempSync(join(tmpdir(), 'jevbrowser-busy-'))
    const dbPath = join(dir, 'busy.db')

    const seed = openDatabase(dbPath)
    const search = createSearch(seed, { ...body, spec: {} })
    seed.close()

    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const blocking = {
      async goto() {
        await held
        return { status: 200 }
      },
      async title() {
        return 'eBay'
      },
      async readCards() {
        return []
      },
      async readListing() {
        return null
      },
      async screenshot() {},
      async close() {},
    }

    const app = buildServer({
      dbPath,
      sourceFactory: async () => blocking as never,
      judgeClientFactory: () => ({ systemOne: async () => ({ model: 'fake', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }) }) as never,
    })

    const started = await app.inject({ method: 'POST', url: '/api/runs', payload: { searchId: search.id } })
    expect(started.statusCode).toBe(202)

    const refused = await app.inject({ method: 'DELETE', url: `/api/searches/${search.id}` })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toMatch(/in progress/i)

    const still = openDatabase(dbPath)
    expect(still.prepare('select count(*) c from searches').get()).toMatchObject({ c: 1 })
    still.close()

    release()
    await app.close()
  })

  it('answers 404 for a search that does not exist, twice over', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    expect((await app.inject({ method: 'DELETE', url: '/api/searches/999' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: '/api/searches/999' })).statusCode).toBe(404)
    await app.close()
  })

  it('deletes a search that has never had a run', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    const created = await app.inject({ method: 'POST', url: '/api/searches', payload: body })
    const id = created.json().id as number
    expect((await app.inject({ method: 'DELETE', url: `/api/searches/${id}` })).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/api/searches' })).json()).toEqual([])
    await app.close()
  })
})
```

Add to that file's imports:

```ts
import { insertCards } from '../src/storage/listings'
import { saveJudgments, saveQuestionnaire } from '../src/storage/judgments'
import type { RawCard } from '../src/scraper/cards'
```

and this helper next to the `body` constant:

```ts
const card = (itemId: string): RawCard => ({
  itemId,
  title: `Lenovo ThinkPad T14s ${itemId}`,
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/server-searches.test.ts`
Expected: FAIL — the first test gets `404`, because Fastify answers an unrouted method with 404 and
the search still exists.

- [ ] **Step 3: Implement**

Append to `src/server/routes/searches.ts`:

```ts
  /**
   * Removes a search and, by the schema's `on delete cascade`, its runs, listings,
   * judgments, questionnaires and events.
   *
   * Refused while one of its runs is the active job: that run holds the one-job
   * lock and is writing rows this would remove underneath it. Checked here rather
   * than in the repository because "active" is the runner's word, not a column.
   *
   * There is no undo, so the UI asks twice and says what it will destroy.
   */
  app.delete('/api/searches/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const search = getSearch(db, id)
    if (!search) return reply.code(404).send({ error: `No search ${id}` })

    const busy = activeRunId()
    if (busy !== null) {
      const isOurs = db.prepare('select 1 from runs where id = ? and search_id = ?').get(busy, id)
      if (isOurs) {
        return reply
          .code(409)
          .send({ error: `Run ${busy} of this search is in progress. Cancel it first.` })
      }
    }

    db.prepare('delete from searches where id = ?').run(id)
    return reply.code(204).send()
  })
```

and its imports:

```ts
import { createSearch, getSearch, listSearches } from '../../storage/searches'
import { activeRunId } from '../../pipeline/runner'
```

- [ ] **Step 4: Run the tests, then the suite and typecheck**

Run: `npx vitest run tests/server-searches.test.ts && npm run typecheck && npm test`
Expected: PASS. The suite grows to about 387.

---

### Task 4: Extract the status badge

**Files:**
- Create: `web/src/components/RunStatusBadge.tsx`
- Modify: `web/src/components/RunView.tsx:233-244`
- Test: `scripts/repro-live-ui.ts` (Step 4 — the badge is copy-plus-colour, and this repo verifies UI
  by browser; there is no DOM test harness and none is being added)

**Interfaces:**
- Produces: `<RunStatusBadge status={RunStatus | null} className?={string} />` — renders the same
  `<span>` RunView renders today, so Task 5 can use it on the search row without a second copy.

- [ ] **Step 1: Lift the status union into `web/src/lib/api.ts`**

The badge needs a status type, and the web API already spells that union inline for `Run`. Lifting it
here — rather than in Task 5, which also wants it — is what lets this task typecheck on its own: a
task that imports a name a later task introduces cannot pass its own gate.

In `web/src/lib/api.ts`, add above `Run`:

```ts
/** The six states a run can be in. `Run`, `RunSummary` and the badge share one name. */
export type RunStatus = 'queued' | 'running' | 'paused' | 'cancelled' | 'failed' | 'complete'
```

and change `Run`'s `status` line to `status: RunStatus`. Nothing else in that file changes; Task 5
consumes the name this task creates.

- [ ] **Step 2: Create the component**

It imports the status union from the web API rather than from `src/storage/runs`: reaching into
storage from a component would drag `better-sqlite3`'s types into the browser bundle's graph for a
string.

```tsx
import type { RunStatus } from '../lib/api'

/**
 * A run's status, in one place.
 *
 * Two places show it now — the run view's header and each run on the search row —
 * and two copies of a rendering drift: the Stage 6 review found the report and the
 * live view disagreeing about a row, and rule 22's defect was a page that said
 * `running` while the run was paused. A paused run must stop looking like a
 * working one wherever it appears.
 */
export function RunStatusBadge({
  status,
  className = '',
}: {
  status: RunStatus | null
  className?: string
}) {
  const paused = status === 'paused'
  return (
    <span
      className={`rounded px-2 py-0.5 text-sm ${
        paused ? 'bg-almond-silk text-space-indigo' : 'bg-dusty-grape text-seashell'
      } ${className}`}
    >
      {status ?? 'loading'}
    </span>
  )
}
```

- [ ] **Step 3: Use it in `RunView.tsx`**

Replace the `<span>` block inside the header's `h2` (the one carrying the paused treatment) with:

```tsx
            <RunStatusBadge status={run?.status ?? null} className="ml-2" />
```

and add its import at the top:

```tsx
import { RunStatusBadge } from './RunStatusBadge'
```

Remove the now-unused comment above the old span; its reasoning lives on the component.

- [ ] **Step 4: Typecheck and the suite**

Run: `npm run typecheck && npm test`
Expected: clean and 387-ish passing. `RunView` has no unit test; the next step is its proof.

- [ ] **Step 5: Prove the badge still reads the same in the browser**

Start `npm run dev:web`, then run `node --import tsx scripts/repro-live-ui.ts` and confirm the line it
already prints is unchanged:

```
run1 t=4.5s status=paused rows=60 | pages 1 · …
```

Expected: `status=paused` still appears, and the run reaches `status=complete` after the Resume
click. A blank or `loading` badge here means the extraction broke the header.

---

### Task 5: The search row shows its runs

**Files:**
- Modify: `web/src/lib/api.ts` (the `Search` interface and two new functions)
- Modify: `web/src/App.tsx` (the saved-search list)
- Test: `scripts/repro-live-ui.ts` (Step 4)

**Interfaces:**
- Consumes: `RunStatusBadge` (Task 4), `RunSummary`-shaped data from `GET /api/searches` (Task 2),
  `DELETE /api/searches/:id` (Task 3), and the existing `resumeRun` / `cancelRun` / `RunView`.
- Produces: `Search.runs`, `deleteSearch(id)`, and a `RunSummary` type in the web API.

- [ ] **Step 1: Extend the web API**

`RunStatus` already exists by now (Task 4 lifted it out of `Run`). In `web/src/lib/api.ts`, add above
`Search`:

```ts
/** A run as the search list needs it: enough to date it, count it and open it. */
export interface RunSummary {
  id: number
  searchId: number
  status: RunStatus
  startedAt: string | null
  finishedAt: string | null
  listings: number
  rejected: number
  /** Listings with at least one answer. Zero means there is nothing to report yet. */
  judged: number
}
```

and add `runs: RunSummary[]` to the `Search` interface. Then append at the end of the file:

```ts
/** Removes a search and everything under it. Irreversible; the UI asks twice. */
export async function deleteSearch(id: number): Promise<void> {
  const res = await fetch(`/api/searches/${id}`, { method: 'DELETE' })
  if (res.status === 204) return
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  throw new Error(body.error ?? `DELETE /api/searches/${id} failed: ${res.status}`)
}
```

- [ ] **Step 2: Render the runs in `App.tsx`**

Add a component above `App` in `web/src/App.tsx`:

```tsx
const RUN_LABELS: Record<string, string> = {
  queued: 'en cola',
  running: 'corriendo',
  paused: 'en pausa',
  cancelled: 'cancelada',
  failed: 'falló',
  complete: 'completa',
}

const FINISHED = new Set(['cancelled', 'failed', 'complete'])

/**
 * One search's runs, and the only door to a stored report.
 *
 * Before this the page could not open a run it had not just started: the run view
 * was reachable only from `startRun`, so a finished report was unreachable from
 * the UI and a paused run offered its Resume button to nobody. Numbers are stated
 * as they are; a run with no answers says so rather than offering a report.
 */
function SearchRuns({
  search,
  onOpen,
  onChanged,
  onError,
}: {
  search: Search
  onOpen: (runId: number) => void
  onChanged: () => void
  onError: (message: string) => void
}) {
  const [confirming, setConfirming] = useState(false)

  if (search.runs.length === 0) {
    return <p className="mt-2 text-sm text-lilac-ash/50">Sin corridas todavía.</p>
  }

  const totals = search.runs.reduce(
    (acc, run) => ({
      listings: acc.listings + run.listings,
      judged: acc.judged + run.judged,
    }),
    { listings: 0, judged: 0 },
  )

  async function act(work: () => Promise<unknown>) {
    onError('')
    try {
      await work()
      onChanged()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <ul className="mt-3 space-y-2">
      {search.runs.map((run) => (
        <li
          key={run.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded border border-lilac-ash/20 px-3 py-2"
        >
          <div className="text-sm text-lilac-ash">
            <RunStatusBadge status={run.status} />
            <span className="ml-2">
              {RUN_LABELS[run.status] ?? run.status} · {run.listings} listings ·{' '}
              {run.judged > 0 ? `${run.judged} juzgados` : 'sin juzgar'}
            </span>
          </div>
          <div className="flex gap-2">
            {run.status === 'paused' && (
              <>
                <button
                  onClick={() => void act(() => resumeRun(run.id))}
                  className="rounded bg-almond-silk px-3 py-1 text-sm font-medium text-space-indigo"
                >
                  Resume
                </button>
                <button
                  onClick={() => void act(() => cancelRun(run.id))}
                  className="rounded bg-dusty-grape px-3 py-1 text-sm text-seashell"
                >
                  Cancel
                </button>
              </>
            )}
            {FINISHED.has(run.status) && (
              <button
                onClick={() => onOpen(run.id)}
                className="rounded bg-dusty-grape px-3 py-1 text-sm text-seashell"
              >
                {run.judged > 0 ? 'Ver reporte' : 'Re-judge'}
              </button>
            )}
          </div>
        </li>
      ))}

      <li className="pt-1">
        {confirming ? (
          <span className="flex flex-wrap items-center gap-2 text-sm text-almond-silk">
            Esto borra {search.runs.length} corrida(s), {totals.listings} listings y {totals.judged}{' '}
            respuestas. No se puede deshacer.
            <button
              onClick={() => void act(async () => deleteSearch(search.id))}
              className="rounded bg-almond-silk px-3 py-1 font-medium text-space-indigo"
            >
              Sí, borrar
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="rounded border border-lilac-ash/40 px-3 py-1"
            >
              No
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="rounded border border-almond-silk/50 px-3 py-1 text-sm text-almond-silk"
          >
            Borrar búsqueda
          </button>
        )}
      </li>
    </ul>
  )
}
```

In the list's `<li>`, after the requirements paragraph, add:

```tsx
                  <SearchRuns
                    search={s}
                    onOpen={(runId) => setActiveRun({ ...s, id: runId })}
                    onChanged={() => void refresh()}
                    onError={setError}
                  />
```

and extend `App.tsx`'s imports:

```tsx
import { RunStatusBadge } from './components/RunStatusBadge'
import { cancelRun, createSearch, deleteSearch, listSearches, resumeRun, startRun, type Search } from './lib/api'
```

(`Search` is already imported; keep the list to what is missing.)

- [ ] **Step 3: Typecheck and the suite**

Run: `npm run typecheck && npm test`
Expected: clean, suite unchanged (no unit test covers `App.tsx`).

- [ ] **Step 4: Prove the door in the browser**

Extend `scripts/repro-live-ui.ts`. After the existing checks, reload the page and assert that the
run the repro just finished is reachable from the list, and that its row is the door:

```ts
  // The defect this whole change exists for: the page could not open a run it had
  // not just started, so a finished report was unreachable and a paused run's
  // Resume button had no door to reach it through.
  await page.reload()
  await page.waitForSelector('text=/corrida|Sin corridas/', { timeout: 10_000 })
  const reportButtons = await page.getByRole('button', { name: /Ver reporte|Re-judge/ }).count()
  const firstReport = page.getByRole('button', { name: /Ver reporte|Re-judge/ }).first()
  if (reportButtons > 0) await firstReport.click()
  await page.waitForSelector('table', { timeout: 10_000 })
  const rowsAfterOpening = await page.locator('tbody tr').count()
  console.log(`\nruns listed on the search row: ${reportButtons > 0 ? 'yes' : 'no'}`)
  console.log(`rows in the report opened from the list: ${rowsAfterOpening}`)

  // And the delete is a two-click with real numbers before it commits.
  const deleteButton = page.getByRole('button', { name: 'Borrar búsqueda' }).first()
  await deleteButton.click()
  const warning = await page.locator('text=/Esto borra/').first().innerText()
  console.log(`delete warning: ${JSON.stringify(warning.slice(0, 90))}`)
  await page.getByRole('button', { name: 'No' }).first().click()
  const stillThere = await page.getByRole('button', { name: 'Borrar búsqueda' }).count()
  console.log(`search still present after declining: ${stillThere > 0}`)
```

Run: start `npm run dev:web`, then `node --import tsx scripts/repro-live-ui.ts`

Expected, verbatim in spirit:

```
runs listed on the search row: yes
rows in the report opened from the list: 58
delete warning: "Esto borra 2 corrida(s), 120 listings y 120 respuestas. No se puede deshacer."
search still present after declining: true
```

A `runs listed on the search row: no` means the runs came back empty — check that
`GET /api/searches` includes them and that `refresh()` runs after the repro's own run finished.

---

## Phase 2 — the report's capacity columns

### Task 6: RAM and storage per listing

**Files:**
- Create: `web/src/lib/capacity.ts`
- Test: `tests/web-spec.test.ts` (append)

**Interfaces:**
- Consumes: `parseRamGb` / `parseStorageGb` from `src/shared/parse.ts` — the pre-filter's own readers.
- Produces: `ramGbOf(listing: Listing): number | null`, `storageGbOf(listing: Listing): number | null`.

- [ ] **Step 1: Write the failing test**

Append to `tests/web-spec.test.ts`, with the imports:

```ts
import { ramGbOf, storageGbOf } from '../web/src/lib/capacity'
import type { Listing } from '../web/src/lib/api'
```

```ts
const listing = (over: Partial<Listing>): Listing => ({
  id: 1,
  itemId: '1',
  title: 'Lenovo ThinkPad T14s Gen 6',
  url: 'https://www.ebay.com/itm/1',
  price: 1200,
  shipping: 0,
  conditionLabel: 'Open Box',
  sellerName: 'store',
  sellerFeedback: '100% positive (450)',
  watchers: null,
  buyingFormat: 'Buy It Now',
  sponsoredMarker: false,
  stage: 'survivor',
  rejectReason: null,
  detail: null,
  ...over,
})

describe('capacity columns', () => {
  it('reads the capacity the title states', () => {
    const row = listing({ title: 'Lenovo ThinkPad T14s 32GB RAM 1TB SSD' })
    expect(ramGbOf(row)).toBe(32)
    expect(storageGbOf(row)).toBe(1024)
  })

  it('answers null, never zero, when the title states nothing', () => {
    // The pre-filter treats a missing capacity as survivable, not as a
    // contradiction; the column must not turn that silence into a `0`, which
    // would read as "no RAM at all".
    const row = listing({ title: 'Lenovo ThinkPad T14s Gen 6' })
    expect(ramGbOf(row)).toBeNull()
    expect(storageGbOf(row)).toBeNull()
  })

  it('agrees with the pre-filter about a title that contradicts a floor', () => {
    // Both read `parseRamGb`, which is the point: a row shown as 16GB is one the
    // pre-filter would have rejected against a 32GB floor.
    const row = listing({ title: 'Lenovo ThinkPad T14s 16GB RAM 512GB SSD' })
    expect(ramGbOf(row)).toBe(16)
    expect(storageGbOf(row)).toBe(512)
  })

  it('ignores item specifics on purpose', () => {
    // Rule 15: their labels vary per listing, and the pre-filter never reads them.
    // A column derived any other way could claim a capacity the filter disagreed
    // with. The specifics stay readable in the row's expanded panel.
    const row = listing({
      title: 'Lenovo ThinkPad T14s Gen 6',
      detail: {
        condition: 'Open Box',
        sellerName: 'store',
        sellerFeedback: '100% positive (450)',
        specifics: { 'RAM Size': '64 GB' },
        rawText: [],
      },
    })
    expect(ramGbOf(row)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/web-spec.test.ts`
Expected: FAIL — cannot resolve `../web/src/lib/capacity`.

- [ ] **Step 3: Implement**

Create `web/src/lib/capacity.ts`:

```ts
import { parseRamGb, parseStorageGb } from '../../src/shared/parse'
import type { Listing } from './api'

/**
 * A listing's capacity, as the table's columns show it.
 *
 * Read from the **title**, through the same two functions the pre-filter uses to
 * reject a contradiction (`src/pipeline/prefilter.ts`). Item specifics are
 * deliberately not consulted: their labels vary per listing (CLAUDE.md rule 15)
 * and the pre-filter never reads them either, so deriving the column any other way
 * would let the table claim a capacity the filter disagreed with. The consequence
 * is the useful property: a row showing `16 GB` is one the pre-filter would have
 * rejected had a floor been set.
 *
 * Null for a title that states nothing — never `0`, which would read as "none".
 */
export function ramGbOf(listing: Listing): number | null {
  return parseRamGb(listing.title)
}

export function storageGbOf(listing: Listing): number | null {
  return parseStorageGb(listing.title)
}
```

- [ ] **Step 4: Run the tests, then the suite and typecheck**

Run: `npx vitest run tests/web-spec.test.ts && npm run typecheck && npm test`
Expected: PASS.

---

### Task 7: The columns, and sorting by them

**Files:**
- Modify: `web/src/lib/score.ts` (`SortColumn`, `ReportRow`, `buildReport`, `compare`)
- Modify: `web/src/components/ReportTable.tsx` (`COLUMNS`, the row cells)
- Test: `tests/score.test.ts` (append)

**Interfaces:**
- Consumes: `ramGbOf` / `storageGbOf` (Task 6).
- Produces: `SortColumn` gains `'ram' | 'storage'`; `ReportRow` gains `ramGb: number | null` and
  `storageGb: number | null`.

- [ ] **Step 1: Write the failing test**

Append to `tests/score.test.ts` inside the `buildReport blend` describe, or a new describe below it:

```ts
describe('buildReport capacity columns', () => {
  it('carries the capacity each title states, and null when it states none', () => {
    const listings = [
      listing({ id: 1, title: 'Lenovo ThinkPad T14s 32GB RAM 1TB SSD' }),
      listing({ id: 2, title: 'Lenovo ThinkPad T14s Gen 6' }),
    ]
    const report = buildReport(listings, [...judged(1), ...judged(2)], settings())
    const byId = new Map(
      [...report.matching, ...report.discarded].map((r) => [r.listing.id, r]),
    )
    expect(byId.get(1)!.ramGb).toBe(32)
    expect(byId.get(1)!.storageGb).toBe(1024)
    expect(byId.get(2)!.ramGb).toBeNull()
    expect(byId.get(2)!.storageGb).toBeNull()
  })

  it('sorts unknowns last whichever way the sort points', () => {
    // Same rule the blend already follows: unknown is not a low value, so it does
    // not become the top of an ascending sort either.
    const listings = [
      listing({ id: 1, title: 'Lenovo ThinkPad T14s 32GB RAM 1TB SSD' }),
      listing({ id: 2, title: 'Lenovo ThinkPad T14s Gen 6' }),
      listing({ id: 3, title: 'Lenovo ThinkPad T14s 64GB RAM 2TB SSD' }),
    ]
    const judgments = [...judged(1), ...judged(2), ...judged(3)]
    for (const direction of ['asc', 'desc'] as const) {
      const report = buildReport(
        listings,
        judgments,
        settings({ sort: { column: 'ram', direction } }),
      )
      const ids = [...report.matching, ...report.discarded].map((r) => r.listing.id)
      expect(ids[ids.length - 1]).toBe(2)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/score.test.ts`
Expected: FAIL — `expected undefined to be 32`, and the `'ram'` sort column does not typecheck.

- [ ] **Step 3: Implement**

In `web/src/lib/score.ts`:

```ts
export type SortColumn =
  | 'blend'
  | 'price'
  | 'shipping'
  | 'title'
  | 'seller'
  | 'trust'
  | 'ram'
  | 'storage'
```

Add to `ReportRow`, after `values`:

```ts
  /**
   * Capacity, read from the title by the pre-filter's own parsers (see
   * `capacity.ts`). Null when the title states none, and rendered as `—`.
   */
  ramGb: number | null
  storageGb: number | null
```

Import at the top:

```ts
import { ramGbOf, storageGbOf } from './capacity'
```

In `buildReport`'s row literal, beside `values`:

```ts
      ramGb: ramGbOf(listing),
      storageGb: storageGbOf(listing),
```

In `compare`, a case sharing the null rule the numeric listing fields already use:

```ts
    case 'ram':
    case 'storage': {
      const key = sort.column === 'ram' ? 'ramGb' : 'storageGb'
      const av = a[key]
      const bv = b[key]
      // Unknown is last whichever way the sort points: an unstated capacity is not
      // a small one.
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      return (av - bv) * flip
    }
```

In `web/src/components/ReportTable.tsx`, add two columns to `COLUMNS` after `shipping`:

```tsx
  { key: 'ram', label: 'RAM', className: 'pr-3' },
  { key: 'storage', label: 'Storage', className: 'pr-3' },
```

and two cells in the row, in the same order as the headers — insert after the shipping cell
(`{money(row.listing.shipping)}`):

```tsx
                  <td className="py-2 pr-3">
                    {row.ramGb === null ? '—' : `${row.ramGb} GB`}
                  </td>
                  <td className="py-2 pr-3">
                    {row.storageGb === null
                      ? '—'
                      : row.storageGb % 1024 === 0
                        ? `${row.storageGb / 1024} TB`
                        : `${row.storageGb} GB`}
                  </td>
```

Two `colSpan`s must grow by two with the columns: `colSpan={7}` (the expanded row's panel) becomes
`colSpan={9}`, and `colSpan={8}` (the empty table's message) becomes `colSpan={10}`. A stale span
makes the expanded panel stop short of the table's width, which reads as a rendering bug.

- [ ] **Step 4: Run the tests, then the suite and typecheck**

Run: `npx vitest run tests/score.test.ts && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Prove the columns in the browser**

Add to `scripts/repro-live-ui.ts`, after the report is open:

```ts
  const ramHeader = await page.getByRole('columnheader', { name: 'RAM' }).count()
  const ramCells = await page.locator('tbody tr td:nth-child(4)').allInnerTexts()
  console.log(`\nRAM column present: ${ramHeader > 0}`)
  console.log(`first RAM cells: ${JSON.stringify(ramCells.slice(0, 5))}`)
```

Run: start `npm run dev:web`, then `node --import tsx scripts/repro-live-ui.ts`

Expected, verbatim in spirit:

```
RAM column present: true
first RAM cells: ["—","32 GB","16 GB","—","64 GB"]
```

Every cell is a capacity or `—`; a `0 GB` means the null rule was lost.

---

## Self-Review

**Spec coverage.** §2.1 per-run report → Task 5 (one entry per run, "Ver reporte" opens that run).
§2.2 inline hub → Task 5. §2.3 delete with the 409 guard and the two-click → Task 3 (the guard) and
Task 5 (the click). §2.4 title-read capacities, null not zero, unknown last → Tasks 6 and 7.
§3.1 `listRunSummaries` → Task 1. §3.2 the two routes → Tasks 2 and 3. §3.3 the row, the shared badge
and the `sin juzgar` case → Tasks 4 and 5. §3.4 the columns → Tasks 6 and 7. §4 out of scope → no task
touches an aggregate report, a list-side question editor, eBay, or a run-level delete. §5's testing
table → each row is a named step. §6's risks → the irreversibility guard is Task 3's 409 plus Task 5's
second click; the single-request list is Task 2.

**Placeholder scan.** No TBDs. Every code step carries the code. Task 4 Step 4 and Task 5 Step 4 are
browser proofs with expected output, not "verify it works".

**Type consistency.** `RunSummary` is defined once (Task 1, storage) and mirrored in the web API
(Task 5) with the same field names; `listRunSummaries` returns `searchId` as a number, which Task 2
filters on. `SortColumn` gains `'ram' | 'storage'` (Task 7), matching the `ramGb`/`storageGb` fields
`compare` reads off `ReportRow`. `RunStatus` is lifted once in `api.ts` (Task 5) and consumed by
`Run`, `RunSummary` and `RunStatusBadge` (Task 4) — one name, three readers, so a seventh state would
have to be added in one place. `deleteSearch` throws on anything but 204 (Task 5), which is what lets
`act()` surface the 409's message on the row instead of swallowing it.

**Verified against the code before writing, not assumed:** `saveQuestionnaire(db, runId, definition,
version): number`, `saveJudgments(db, {runId, questionnaireId, listingId, answers}): number`,
`insertCards` returning `idsByItemId`, `POST /api/runs` answering `202`, `Run.status` already being
the exact union above, and `colSpan={7}` / `colSpan={8}` at `ReportTable.tsx:160` and `:194`.
