# The search list as the hub — design

**Date:** 2026-09-25
**Status:** awaiting review
**Parent:** `2026-09-18-jevbrowser-design.md`. Rules: `CLAUDE.md` 7 (silence is a bug), 9 (one job at a
time), 13 (the dev server does not hot-reload), 15 (labels vary per listing), 26 (a pause cannot
outlive its process).

## 1. Why

The page cannot open a run it did not just start. `RunView` is reachable only from
`startRun`, which lives on the search row's **Run search** button
(`web/src/App.tsx:174-182`); closing that view (`onClose`) is a one-way door, and the API's
`GET /api/runs` has never had a caller in `web/`. So a finished run — with its judgments, its report
and its export — exists in the database and is **unreachable from the page**. Runs 7, 8 and 9 are in
that state right now.

This cost a real debugging cycle. A run paused on an eBay 403 and the reader never saw the **Resume**
and **Cancel** buttons, because the pause happened while the run view was closed and there was no way
back to it. The buttons were correct, wired, and visible in `scripts/repro-live-ui.ts`; the *door to
them* was missing. Unit tests could not see it: "there is no way to get there" is an absence, and no
assertion in a 376-test suite checks for one.

**Goal.** From the search list, reach any of a search's runs and its report; see and answer a paused
run from there; delete a search and everything under it.

**Who it is for.** The single owner, at his own machine, running the same search more than once.

**Success.** Start the app, and without knowing any internal id: open run 9's report, resume a paused
run, and delete a search — each from the list, with no export step.

## 2. Decisions

### 2.1 The report is per run, not per search

Chosen by the owner over an aggregate across runs. A search's row lists its runs; each finished run
opens what already exists. An aggregate report is deliberately **not** in scope: it would have to
decide what to do with runs judged under different questions and with the same item seen twice, and
nothing needs that answer yet.

### 2.2 The search row is the hub, inline

Chosen over a separate "Runs" page (a navigation concept this single-screen app does not have) and
over showing only the latest run (which would lose the ability to reopen an earlier one).

### 2.3 Delete is a search-level operation, guarded

`DELETE /api/searches/:id` removes the search and, by the schema's `on delete cascade`, its runs,
listings, judgments, questionnaires and events. It is **refused with 409 while a run of that search
is active**, because that run holds the one-job lock and is writing to rows the delete would remove
under it (rule 9). "Active" means the runner's `activeRunId()` names one of its runs, which covers a
re-judge as well as a run — they share the lock. Two clicks in the UI, and the second one states what
it destroys in real numbers — a count of runs, listings and answers, from the same summary the row
already has.

### 2.4 RAM and storage come from the title, the same way the pre-filter reads them

`parseRamGb(title)` / `parseStorageGb(title)` (`src/shared/parse.ts`) — the functions the pre-filter
already uses to reject a contradiction. **Not** from item specifics: rule 15 established that their
labels vary per listing, and the pre-filter never consults them either, so deriving the column any
other way would let the table claim a capacity the filter disagreed with. The consequence is worth
stating: a row showing `16 GB` is one the pre-filter would have rejected had a floor been set. Item
specifics stay visible in the expanded panel, where they already are.

No data → `—`, never `0`. Sorting puts them last in **both** directions, the rule `compare` already
applies to `blend` ("unknown is last whichever way the sort points: it is not a low score").

## 3. Design

### 3.1 Storage — `src/storage/runs.ts`

```ts
export interface RunSummary {
  id: number
  searchId: number
  status: RunStatus
  startedAt: string | null
  finishedAt: string | null
  /** Everything found, and how much of it the pre-filter stopped. */
  listings: number
  rejected: number
  /** Listings with at least one answer: the report is empty without them. */
  judged: number
}

export function listRunSummaries(db: SqliteDatabase): RunSummary[]
```

One query, newest first, counts as correlated subqueries — no N+1, and the whole table is small
enough that filtering per search in JS is honest.

### 3.2 API — `src/server/routes/searches.ts`

| Route | Answer |
|---|---|
| `GET /api/searches` | `Search[]`, each with `runs: RunSummary[]` — its own, newest first |
| `DELETE /api/searches/:id` | `204`; `404` unknown; `409` while one of its runs is active |

The `409` reads the runner's `activeRunId()`. A search with no runs deletes freely. The route
composes the runs onto the searches rather than changing the `Search` storage type: the repository
stays a repository, and the join belongs where the response is shaped.

### 3.3 UI — `web/src/App.tsx` and a shared badge

Each search row gains, under its requirements line, one entry per run:

```
30 ago · cancelled · 75 listings · 0 juzgados   [Ver reporte]
25 sep · complete  · 85 listings · 20 juzgados  [Ver reporte]
```

- **Ver reporte** opens the existing `RunView` for that id. Nothing new is rendered.
- A `paused` run instead shows **Resume** and **Cancel**, calling the routes that already exist.
- A run with no judgments says `sin juzgar` and offers **Re-judge** — the answer to "process what
  was collected after a 403" — which opens its `RunView`, where the editor already lives.
- The per-search **Borrar** button is two clicks, red-ish rather than the almond used by every other
  action, and the second click spells out the damage.

`RunStatusBadge` is extracted from `RunView.tsx` so both places render a status identically. This is
the lesson Stage 6 already paid for once: two copies of a rendering drift, and the drift is invisible
until a reader is misled about whether a run is working (rule 22's defect was exactly this).

### 3.4 Report columns — phase 2

`SortColumn` gains `'ram' | 'storage'`. Two columns and two pure helpers, `ramGbOf(listing)` and
`storageGbOf(listing)`, each a one-line call into `src/shared/parse.ts`. No import from
`scraper/` into `jev/` is involved and no new data is stored — the capacity is a property of the
title, computed on read.

## 4. Out of scope

- A report aggregated across a search's runs (§2.1).
- Re-judging **from the list**: the button is a door into the run view, which already owns the editor
  and the version selector. No second copy of that editor.
- Anything that touches eBay. This change reads the database and shapes responses.
- Deleting a single run. The owner asked to delete a *search*; a run-level delete would need its own
  answer about what a partially-deleted search's report means.

## 5. Testing

| What | Where |
|---|---|
| `listRunSummaries` counts, ordering, empty run | `tests/storage.test.ts` |
| `GET /api/searches` carries each search's own runs, newest first | `tests/server-searches.test.ts` |
| `DELETE` → 204, and the cascade leaves no listings/judgments behind | `tests/server-searches.test.ts` |
| `DELETE` → 409 while a run of that search is active | `tests/server-searches.test.ts` |
| `DELETE` → 404 for an unknown id | `tests/server-searches.test.ts` |
| `ramGbOf` / `storageGbOf`: specifics ignored, title parsed, null not zero | `tests/web-spec.test.ts` (or a new file) |
| Sorting by RAM/storage puts unknowns last in both directions | `tests/score.test.ts` |
| **A finished run is reachable from the list, and deleting a search removes it** | `scripts/repro-live-ui.ts` |

The last row is the point of the whole change. The repro is the only layer that could have caught the
missing door, and it will now assert the door exists: a run listed with a `Ver reporte` button, the
button opening a table with rows, and a delete that leaves the search gone after a reload.

## 6. Risks

- **Deleting is irreversible** and the database is the only copy of work that cost real money. The
  guard is the 409 plus a second click naming the numbers; there is no undo, and the backup habit is
  the owner's (`/tmp/jevbrowser-before-probe.db` is this session's, not a feature).
- **The list now makes one request that returns every search's every run.** Fine at this size
  (6 searches, 9 runs). If a run history ever grows past reading, the row's runs become a lazy fetch.
- **`RunStatusBadge` extraction touches `RunView`**, which the Stage 7/8 repro covers; that repro runs
  after the change.
