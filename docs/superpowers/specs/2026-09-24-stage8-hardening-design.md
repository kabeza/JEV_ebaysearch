# Stage 8 — hardening — design

**Date:** 2026-09-24 · **Binding authority for Stage 8.** The plan that implements it is
`docs/superpowers/plans/2026-09-24-stage8-hardening-plan.md`. The requirements are the parent design's
§11 table and §9.2; where this document and the parent disagree, this one wins for Stage 8.

## 1. What this stage is for

The spec's §12 says eBay changes its markup and that scraping earns a 403 by volume (rule 10: it
already happened once). Today both of those **fail the run** with a message. The spec's §11 asks for
something better for exactly two of them: *"Pause the run, emit an event, surface it in the UI, offer
resume. Never continue silently."*

**Deliverable:** a run that survives a bot challenge, a markup change, a cancellation and a JEV
outage without losing data and without lying about what happened.

**Acceptance, as the build plan wrote it:** each failure is triggered deliberately in a test and
produces an event, a screenshot where relevant, and no silent empty result.

## 2. What exists, and the two gaps

| §11 row | Today |
|---|---|
| Bot challenge / captcha / interstitial | A non-200 page takes a screenshot and **fails the run**, with `looksLikeChallenge(title)` decorating the message. The run stops; nothing can resume it. |
| Expected element not found (layout change) | Throws, screenshots, records `extraction_failed` or `no_cards_on_page`. **No deliberate test** — the fixture tests cover the happy path only. |
| Listing page times out | `detail_failed`, judged on card data. Done and tested. |
| JEV `422` | Halves the batch, tested. Done. |
| JEV `429` / `529` | The SDK retries 408/429/500–599 with backoff, so what reaches us is an **exhausted** outage — and it **fails the run**. §11 asks to pause and report. |
| Browser crash | Fails the run through the generic catch. Everything stored stays readable. **Untested.** |
| User cancels | Checked between pages and batches; the context is closed in a `finally`; partial results kept. Tested in `pipeline-run.test.ts`. |

So Stage 8 is one mechanism — **pause and resume** — with two triggers, plus the tests that trigger
each row of the table deliberately.

## 3. Decisions

1. **A pause happens in place, with the browser alive.** The run's loop waits; the page or batch it
   was on is retried when it resumes. This is the only shape that helps with a captcha, which is
   solved by a human in the visible window — and it means a resume re-scrapes nothing.
2. **No deadline.** The run waits until it is resumed or cancelled, and the event log says how long
   it has been waiting. A single-user local tool whose process the owner controls does not need a
   third way to end; an automatic timeout would only add a mode to reason about.
3. **A paused run keeps the one-job lock** (rule 9). The visible browser holds the persistent
   profile, so starting another run while paused would be two Chromium profiles on one directory.
4. **A pause is not a failure and does not end the run.** Status becomes `paused` (already in
   `RunStatus`), the `run.paused` event carries the reason and what was in flight, and resuming
   writes `run.resumed` and returns the status to `running`.
5. **Cancelling works while paused**, and is the only way out other than resuming. The wait resolves
   on either signal, and the loop checks `isCancelled()` immediately after every wait.
6. **Retry on resume is unconditional and bounded by the human.** A page that challenges again pauses
   again; a JEV batch that is still overloaded pauses again. There is no retry counter, because the
   loop cannot make progress without a person either way.

## 4. The mechanism

`src/pipeline/run.ts` gains one option, symmetric with the `isCancelled` it already has:

```ts
/**
 * Called when the run cannot make progress without a person: a bot challenge, or
 * a JEV outage the SDK's retries did not survive. It emits the event, sets the
 * status and **resolves when the run should continue** — with `isCancelled()`
 * true if the person chose to stop instead.
 */
pause?: (reason: 'bot_challenge' | 'jev_outage', detail: PauseDetail) => Promise<void>
```

```ts
export interface PauseDetail {
  /** What was in flight, in the run's own terms. */
  page?: number
  batch?: number
  /** The page title, for a challenge: it is what makes it recognisable. */
  title?: string
  status?: number
  screenshot?: string
  message: string
}
```

`runner.ts` owns the signal, next to `cancelled`:

```ts
let active: {
  runId: number
  cancelled: boolean
  kind: 'run' | 'rejudge'
  paused: PauseDetail | null
  resume: (() => void) | null
} | null = null

export function isPaused(): boolean
export function resumeRun(runId: number): boolean   // false when not paused or not this run
export function pauseSignal(runId: number, detail: PauseDetail): Promise<void>
```

`pauseSignal` records the detail, emits `run.paused`, sets the status to `paused`, and returns a
promise resolved by `resumeRun` (which emits `run.resumed` and sets the status back to `running`) or
by `cancelRun` (which resolves it too, so a cancelled pause is not a deadlock).

`src/storage/runs.ts` gains:

```ts
export function updateRunStatus(db: SqliteDatabase, id: number, status: RunStatus): void
```

`src/storage/events.ts` gains `run.paused` and `run.resumed` in `RunEventType`.

## 5. Where the pipeline pauses

**A challenge, on a results page.** Today: a non-200 status fails the run. New — an inner retry loop,
because a `continue` in the page loop would advance past the page that challenged:

```ts
let res: { status: number }
let title = ''
for (;;) {
  res = await o.source.goto(url)
  title = await o.source.title().catch(() => '')
  if (res.status === 200) break

  // …screenshot as today, into shotPath…
  const message = `eBay returned HTTP ${res.status} on page ${page} …`

  if (looksLikeChallenge(title) || res.status === 403 || res.status === 503) {
    await o.pause?.('bot_challenge', { page, status: res.status, title, screenshot: shotPath, message })
    // Resolved by a resume **or** a cancel, so check which before retrying.
    if (o.isCancelled?.()) return stopWith('cancelled')
    emit('run.progress', { page, retrying: true })
    continue
  }

  emit('error', { page, status: res.status, title, screenshot: shotPath })
  return stopWith('failed', message)
}
```

A 403 is treated as a challenge even when the title says nothing, because that is the status eBay
returned when it rate-limited a real run (rule 10) — and a 404 does not pause: it is a normal end of
results (`url.ts`/`fetchPage` already turns past-the-last-page into a 404, so pausing on it would
hang every run that hits its page cap).

A repeat challenge pauses again, and the loop is bounded by the person, not by a counter: each pause
needs a resume, so a run that cannot get past a page waits rather than spinning.

**A JEV outage.** `src/jev/batch.ts` gains the sibling of `isTooLargeError`:

```ts
/**
 * Whether an error means the service is overloaded rather than the request wrong.
 *
 * The SDK already retried 408/429/500–599 with backoff, so what arrives here has
 * exhausted that — the same statuses, checked the same way `isTooLargeError`
 * checks 422.
 */
export function isOutageError(err: unknown): boolean
```

and `askInBatches`, in the arm that today throws:

```ts
if (isOutageError(err)) {
  await o.pause?.('jev_outage', { batch: batchIndex + 1, message })
  if (o.isCancelled?.()) { outcome.cancelled = true; return outcome }
  continue  // the same batch, again
}
```

When no `pause` is passed — every existing caller and test — the behaviour is exactly today's: the
error propagates. That keeps the change additive.

## 6. UI

- **The status badge** already renders `run.status`; `paused` needs its own colour treatment so a
  stopped run does not look like a working one.
- **A Resume button** in the run header, shown only while `paused`, next to (instead of) Cancel.
  Cancel stays available while paused — it is the way out.
- **The pause says why.** The event feed already prints every event, so `run.paused`'s payload
  (reason, page or batch, title, screenshot path) is visible where the rest of the run's story is.
  Nothing new is needed beyond the event reaching the stream, which Task 1's tests pin.

## 7. Tests — the point of the stage

`tests/hardening.test.ts` (new) triggers each row of §11's table on purpose:

| Test | What it pins |
|---|---|
| A challenge pauses, and a resumed run finishes | The run emits `run.paused` with `reason: 'bot_challenge'` and a screenshot path, its status is `paused`, the listings fetched before it are still stored, and after `resumeRun` the same page is fetched again and the run completes. |
| A challenge that repeats pauses again | Two pauses, two events, no infinite loop without a person. |
| A cancelled pause ends as cancelled | `cancelRun` while paused resolves the wait; the run ends `cancelled` with partial results and the source's `close()` called. |
| A markup change is a loud error, never an empty run | Cards extracted as `[]` from a real-but-broken fixture → `extraction_failed`/`no_cards_on_page` + a screenshot, status `failed`. |
| A JEV outage pauses, and resume retries the batch | A client that throws a 429-shaped error twice then answers → one pause, then a complete run with judgments, and the batches stored before the pause are intact. |
| A browser crash fails the run and keeps the data | A source that throws on the first page → status `failed`, and the run's listings are still returned by `GET /api/runs/:id`. |

`tests/fixtures/ebay/srp-broken.html` (new) is `srp-results.html` with the card container renamed —
the deliberate stand-in for "eBay changed its markup". The plan says how to rebuild it from a real
capture (`scripts/recon-ebay.ts`) when eBay actually changes.

The browser-level half goes in `scripts/repro-live-ui.ts`: the fixture server grows a `/challenge`
route, the repro makes page 2 a challenge, and it asserts the page shows `paused` with a Resume
button, that clicking it finishes the run, and that the run then has its listings.

## 8. Out of scope

- Surviving a **process restart** while paused. The pause lives in the process; a restart leaves the
  run `paused` forever with its data intact. Making it resumable across restarts is a different
  stage's problem (it needs the browser profile's state, not just the run's).
- Automatic retry of a pause after a delay. A human decides.
- JEV `401`/authentication: a bad key is not an outage, and pausing on it would hide a fixable
  mistake. It keeps failing the run loudly.
- The official Browse API as a fallback scraper (§12 describes it as the escape hatch, not a stage).
