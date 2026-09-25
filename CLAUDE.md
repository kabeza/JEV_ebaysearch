# jevbrowser

A local, single-user app that searches eBay with Playwright, judges the results with **JEV**
(TypeSafe's System One model), and produces a sortable report of matching listings — while making
JEV's reasoning visible and inspectable.

Primarily an exploration tool: watch JEV's answers arrive live, see where it is confident and where
it sits near 0.5, edit the questions, and re-judge the same listings without scraping again.

## Read these first

| Document | What it is |
|---|---|
| `docs/superpowers/specs/2026-09-18-jevbrowser-design.md` | The design. Source of truth for requirements and decisions. |
| `docs/superpowers/plans/2026-09-18-jevbrowser-build-plan.md` | The staged build plan. **Start with its "Handoff" section** — it lists exactly what is unfinished. |

## Commands

```bash
npm test                  # vitest, 372 tests
npm run typecheck         # tsc on BOTH the server and web projects
npm run dev:server        # API on 127.0.0.1:3001 (needs .env)
npm run dev:web           # Vite page on 127.0.0.1:5173
npm run dev               # both
npm run spike:jev         # Stage 0: one real JEV call, prints answers + cost
node --import tsx scripts/recon-ebay.ts       # fetch eBay, dump HTML + screenshot + selectors
node --import tsx scripts/recon-listing.ts    # probe one listing page (Stage 4 selectors)
node --import tsx scripts/build-listing-fixture.ts  # rebuild a listing fixture from a capture
node --import tsx scripts/probe-access.ts     # the headless-vs-headed access matrix
node --import tsx scripts/repro-live-ui.ts    # drive the real UI with no eBay (start dev:web first)
node --import tsx scripts/probe-batch-size.ts         # what a batch costs in tokens, per size
node --env-file=.env --import tsx scripts/probe-facts-duplication.ts  # re-measure what the questions carry
```

`.env` must contain `TYPESAFE_API_KEY`. It is gitignored — keep it that way.

## Layout

```
src/shared/types + config   DEFAULTS, PRICING, LIMITS, MODEL_ALIAS, estimateCostUsd
src/storage/                schema.sql + db/runs/listings/events/searches repositories
src/scraper/                url.ts (buildSearchUrl), cards.ts (extractCards),
                            listing.ts (extractDetail), browser.ts (PageSource)
src/pipeline/               run.ts (executeRun), runner.ts (startRun/startRejudge, one job at a
                            time), prefilter.ts, judge.ts (judgeSurvivors, askInBatches),
                            rejudge.ts (rejudgeRun)
src/jev/                    client.ts (JevClient + fake), env.ts, questions.ts (keys, types,
                            buildState, buildFromDraft), draft.ts (the editable question set),
                            batch.ts
src/server/                 Fastify routes: searches, runs, SSE event stream
web/                        Vite + React + TS + Tailwind (lib/versions.ts separates questionnaire
                            versions before the report ranks anything)
tests/fixtures/ebay/        real captured eBay HTML, used for offline scraper tests
```

**Hard architectural rule: `scraper/` and `jev/` must never import each other.** The pipeline
passes plain data between them. This keeps two expensive swaps contained — eBay to the official
Browse API, and JEV to another model. Do not break it for convenience.

## Non-obvious rules — all learned the hard way

These were established by probing the live site. Do not replace them with assumptions.

1. **The browser MUST be visible.** Every headless configuration tested returned HTTP 403 from
   eBay, including with a desktop user-agent. `headless: false` is a requirement. See
   `scripts/probe-access.ts` for the evidence.

2. **Condition cannot be filtered by URL.** `LH_ItemCondition` is ignored by eBay (results went
   *up*, to a $15,999 max). `LH_BIN` is ignored. Aspect filters (`RAM Size`, `Features`) are
   unreliable. Only these URL parameters are verified to work: `_nkw`, `_stpos` + `_sadis` (shipping
   ZIP), `_udlo`/`_udhi` (price), `_pgn`, `_ipg`. **Condition is judged by JEV's `condition_ok`
   question instead** — it handles nuance eBay's own filter cannot express.

3. **The first two cards on every results page are placeholders** — title `"Shop on eBay"`, price
   `$20.00`, linking to `/itm/123456`. `extractCards` filters them. Never take the first N cards
   blindly.

4. **Never put a named inner function inside a Playwright page callback.** The server runs under
   `tsx`, which enables esbuild's `keepNames` and injects `__name(...)` wrappers into the
   serialized function. `__name` does not exist in the browser, so extraction dies with
   `ReferenceError: __name is not defined`. **Vitest does not transform this way, so tests pass
   while the real server fails.** Keep page callbacks to inline expressions only. This bug cost a
   debugging cycle; there is a warning comment in `cards.ts`.

5. **"Sponsored" cannot be detected by text.** eBay renders it backwards (`derosnopS`),
   colour-transparent, behind a base64 background image. Worse, the `.s-card__sep b` element is
   present on *every* card, so the current marker carries no signal — it flagged 113 of 113 in a
   live run. The field is stored but deliberately **not displayed**. Find the real discriminator
   before surfacing it.

6. **`.s-card__subtitle` is not reliably the condition.** Sometimes it holds item specifics
   (`"Lenovo · 512 GB"`). `matchCondition` returns null for unrecognised text — a null is honest
   input for JEV, junk recorded as fact is not.

7. **Silence is a bug.** A broken selector and a genuinely empty result set look identical. Any
   unexpected page state must throw, save a screenshot to `data/screenshots/`, and record an
   explicit error. `executeRun` does this; keep it that way.

8. **Events must be published, not just stored.** `executeRun` writes to SQLite *and* calls
   `options.publish`, which `runner.ts` wires to the in-process bus that feeds SSE. Writing only to
   SQLite means live viewers see nothing until they reconnect — a bug that was found and fixed once
   already. `tests/runner-live.test.ts` guards it.

9. **One run at a time.** A second concurrent run would fight over the same browser profile.

10. **eBay rate-limits by volume.** Roughly 50 page loads in a day earned a 403 with eBay's error
    page. It recovered on its own. The agreed caps (25 pages / 10 minutes) exist for time and
    politeness; cost is not the constraint. **Listing detail visits spend the same budget** — one
    page load each — which is why `maxDetailVisits` (default 20) caps them per run. Survivors past
    the cap are still judged, on card data alone.

11. **JEV is stateless.** It answers questions, it does not remember your search and it cannot write
    questions. Bundle independent questions into **one** call — TypeSafe measure this at ~12x
    cheaper and 10x faster. Hard limits: 64k context, 32k for `state`. Pricing is $0.042/Mtok
    input, output free.

11b. **What actually bounds batch size is the question text, not the state.** Measured on
    2026-09-23 with `scripts/probe-batch-size.ts` against 20 stored judged listings: `state` costs
    **~291 tokens per listing**, so the 32k state limit would allow ~109 listings. Measured again on
    2026-09-24 with `scripts/probe-facts-duplication.ts`, and then fixed: `buildQuestions` no longer
    writes the listing's facts paragraph into each of the six questions, so a batch of 20 costs
    **31,522 tokens** where it cost 56,186 — 49% of the 64k context instead of 88%, because the
    questions *were* the cost driver, not the state. **Do not restate a listing's facts in a
    question.** Two numbers say why the fix is safe: the same request sent twice moved 7 of 120
    answers by more than 0.05 (`price_value` alone moved on 7 of 20 listings — the model is not
    deterministic, so a delta smaller than that is not an effect), and removing the facts moved 13
    of 120 with **zero gate decisions flipped**, five questions inside that noise. The probe caches
    its responses in `data/probe-facts-duplication.json`, so re-analysis is free; re-measure with it
    after any change to the questions.

12. **`legend` and `probabilities` on a score answer are keyed by STRING index** (`"0"`, `"1"`…),
    not integers. Assuming numbers renders blank cells. And **`score` is not that index** — it is a
    probability-weighted value on the same scale: a five-level answer comes back as `score: 2.18`
    with `confidence: 0.27` and probabilities `{"0":0.04,"1":0.27,…}`. So a score answer lives on
    0…n-1 (n-1 high) while a noul answer lives on 0…1, and anything that blends them must normalise
    first. Verified against `jev-1.13.0` on 2026-09-21.

12b. **A noul answer carries no confidence and no probabilities** — it is stored as
    `{ type: 'noul', noul: 0.98 }`, while a score answer carries `score`, `confidence`,
    `legend`, `probabilities`. So a "near the fence" marker for a noul has to be its own distance
    from 0.5. And `confidence` is not that distance for a score: a real run (2026-09-23) produced
    `price_value` at `score: 2.48` with `confidence: 0` and probabilities spread over 0/3/4, next to
    a `listing_trust` at `3.32` with `confidence: 0.52` and a similar spread. Do not treat
    `confidence` as a fence measure without checking it against real answers first.

13. **The dev server does NOT hot-reload.** `tsx` runs the source once; editing anything under
    `src/` has no effect until `dev:server` is restarted. A stale process keeps writing events to
    SQLite while publishing nothing to the SSE bus — so a run looks dead live, yet a fresh page or
    a `curl` afterwards shows a perfect stream, because that is the replay. This exact false
    positive cost a debugging cycle. Restart the server after any `src/` change, and verify live
    delivery with `tests/server-events-stream.test.ts` rather than by reading a stream after the
    fact.

14. **A card's first attribute row is its own price.** `parseShipping` used to take the first
    number in the `join`ed rows, which returned the *price* as the shipping cost on every card that
    charged for shipping — 59 of 60 fixture cards, and 11 of 60 in a live run. Free-shipping cards
    escaped only because that branch returns 0 first. Read attribute rows one at a time; never infer
    a field from a concatenation of rows.



15. **A listing page states `N\A` and writes prose into value slots.** Item specifics is a `<dl>`
    of alternating `dt.ux-labels-values__labels` / `dd.ux-labels-values__values` (verified
    2026-09-21). Two of its values are not values: `N\A` is eBay's placeholder for a field it does
    not know, and the `Condition` row is a paragraph of boilerplate ending in "See all condition
    definitions". Both are dropped or reduced to a vocabulary label — feeding them to JEV would be
    recording junk as fact. Labels vary per listing, so key the map by eBay's own label rather than
    assuming names like "RAM Size" exist.


16. **A question key is invisible to the model, and so are the state's field names.** JEV sees only
    each question's `instructions` text, so a question that does not name its listing is asking
    about all of them at once. Every question opens "About listing L3 — «title» at $1,299.99: Its
    card, price, seller and item specifics are the state's entry for L3. …", and labels are assigned
    per run in card order. **A listing's facts are stated once — in its `listings[]` entry — never
    restated per question**; that was measured, not assumed (rule 11b, and see §8.3 of the design
    spec). The buyer's criteria and requirements are the exception: they stay in the question that
    asks about them, in quotes, because removing the quote measurably degraded
    `criteria_freeform`. `src/jev/questions.ts` owns this; build questions with the SDK's
    `noul()`/`score()` helpers so a change in what JEV accepts breaks the build. Note the naming:
    `SearchRequest` (what the buyer asked for) is deliberately not `JevRequest` (the state +
    questions envelope in `client.ts`).

17. **Judging is a phase of the run, after the detail phase.** Every survivor is judged, including
    ones whose listing page failed (`detail_failed`) and ones past `maxDetailVisits` — those are
    judged on card data alone, and the state says so in `listing_page_opened`, because
    `item_specifics: null` cannot distinguish "the page was never opened" from "the page had nothing
    to say" and only one of those licenses a guess. One call per `batchSize` listings — **25 since
    2026-09-25, raised from 10 on measurement** (`scripts/probe-batch-size.ts`): with the questions
    44% cheaper, a batch of listings carrying item specifics costs ~1,570 tokens each, so 20 listings
    is 49% of the 64k context, 25 is 63%, 40 is 98%, and 45 is refused. A refusal halves the batch
    *permanently for the run* (a size refused once will be refused again) down to 1, and a listing
    still refused fails the run loudly. **What a refusal looks like is not what it says in the docs:**
    it is a `BadRequestError` — `status: 400`,
    `400 {"detail":{"error_type":"max_tokens_exceeded"}}` — and `isTooLargeError` originally matched
    only a `422`, so an oversized batch was never halved and the run died instead. It now matches
    that marker too, and deliberately not the bare 400: a 400 for a malformed question carries no
    marker, and halving for it would walk the batch to 1 and fail there anyway. Cost is a fraction of
    a cent: two listings with twelve questions measured 3,632 input tokens, $0.00015. **The judge
    phase selects through
    `listToJudge` (`stage in ('survivor', 'detail_failed')`), not `listSurvivors`.** Selecting only
    `'survivor'` looks harmless and strands every failed-page listing as unjudged forever — nothing
    else ever comes back for it, so a finished run shows it as still waiting. It took a review of
    Stage 6 to surface, because the report was the first thing to display "not judged yet" and make
    the wait visible.

18. **A re-judge re-asks; it does not re-scrape.** It selects `listJudgeable` — every listing the
    pre-filter kept, `stage != 'rejected'` — and **not** `listToJudge`, which selects
    `survivor`/`detail_failed` and returns nothing at all once every row is `judged`. It never
    touches `listing.stage` and it never builds a `PageSource`. It takes the same one-job-at-a-time
    lock a run takes, so a run and a re-judge can never overlap (rule 9).

19. **A run's questions are data now, and they are versioned.** `src/jev/draft.ts` owns them:
    `DraftQuestion`, the shipped bodies, `defaultDraft`, `draftFromDefinition`, `validateDraft`. The
    text a person edits is the question's **body** — the `About listing L3 …` prefix and the buyer's
    requirements are generated from the draft's request at build time, so an edit cannot leave a
    question unnamed (rule 16) or a quoted criterion stale. Two consequences worth knowing:
    `buildQuestions` is now a wrapper over `defaultDraft`, so the shipped constants and the editor
    cannot drift; and `draft.ts` imports no SDK, because the browser's editor reads it.

20. **`listJudgments` returns every questionnaire version.** Anyone ranking or displaying answers
    must filter to one version first: `score.ts` keys answers by listing and question, so two
    versions of the same answer handed together would overwrite each other silently and the report
    would show a mixture. `web/src/lib/versions.ts` does the filtering. A version stored before
    2026-09-24 has no question text at all (`{request, questionKeys}`) — it stays readable, and the
    editor falls back to the shipped wording.

21. **A run can pause, and a pause waits for a person.** Two things reach it, and only two: a bot
    challenge on a results page (403, 503, or a challenge-looking title — never a 404, which is how a
    run past its last page ends) and a JEV outage that the SDK's retries did not survive (429 or 5xx;
    a 401 still fails loudly). `src/pipeline/pause.ts` holds the signal as a value the runner owns per
    job: `wait` writes `paused` and the `run.paused` event, `resume` is the way back, and `release` is
    what a cancel uses — without it a cancelled pause would hold the one-job lock forever. **A paused
    run keeps the lock**, because its visible browser owns the persistent profile.

22. **`pause` is optional and additive.** With no handler, a challenge fails the run exactly as it did
    before this existed; a retry with nothing to wait on would fetch the same page forever. Two more
    things that are easy to get wrong: the pipeline's page loop needs an inner retry (a `continue` in
    the outer loop skips the page that blocked), and `RunView` only receives the events named in its
    own listener list — a pause the page never hears about leaves it showing `running` and offering
    no way back.

23. **Pacing comes from the run's settings, and the settings come from the search.**
    `sleep = o.sleep ?? (() => pace(settings.pacingMinMs, settings.pacingMaxMs))`; it used to pace at
    the `DEFAULTS` whatever a search asked for, which made the anti-403 mitigation decorative
    (spec §9.2).

24. **A 404 past page 1 is the end of the results, not an error.** The paging stops and the run
    finishes with what it found; a 404 on page 1 still fails, because that is a search URL that is
    wrong.

25. **A pause is not charged to the run's `maxMinutes`, and a cancel that arrives first still
    wins.** Two things the Stage 8 review found, both fixed with a test through the real runner:
    the deadline is now discounted by the wall-clock a pause cost (`waitedMs` in `run.ts`, fed by a
    single `waitForPerson` wrapper both pause sites go through), because the cap exists for time and
    politeness (rule 10) and a captcha someone takes three minutes over was spending a third of a
    ten-minute run. And the runner's `pause` wiring checks `active.cancelled` *before* installing a
    wait: `cancelRun` releases whatever is waiting, so a cancel that lands just before a challenge
    used to install a wait nothing would ever release — the run sat `paused` holding the one-job
    lock until a second click. Both orderings are pinned in `tests/runner-live.test.ts`.

26. **A pause cannot outlive its process, so a server start ends any run still `paused`.**
    `sweepPausedRuns` (`src/storage/runs.ts`, called from `buildServer`) marks them `cancelled`,
    writes `finished_at` with a reason, and records a `run.cancelled` event. Nothing was left to
    resume them — the wait was a promise in the dead process — and while such a row stayed `paused`
    the page offered a Resume button that could only 409 and the question editor stayed shut,
    because the editor opens on a run with a final status. Rule 13 makes this easy to hit by
    accident.

27. **A re-judge writes the buyer's half of the draft back onto the search.** Until 2026-09-25 the
    editor wrote the request into the questionnaire and nowhere else, so **every** stored search had
    `spec: {}` — which meant a fresh run pre-filtered on nothing and `spec_match` asked JEV about
    "no particular specification". `rejudgeRun` now calls `updateSearchRequest` (`src/storage/
    searches.ts`) after the version is stored and before the first JEV call: the request is *data*,
    complete the moment its version exists, so a judging failure must not leave the newest version
    and the search disagreeing. It writes `criteria_text`, and a `spec_json` built by `specForSearch`
    — which **mirrors two fields** and is why it is a function rather than an object literal:

    - `max_price` is stated twice in a `SearchRequest`: at the top level, which the questions quote to
      JEV, and as `spec.max_price`, which `requirementsFromSpec` turns into the pre-filter rule and
      `runner.ts` puts in the URL's `_udhi`. The editor edits only the top-level one, so a spec
      written back without the mirror would leave the pre-filter and the eBay URL ignoring the budget
      a person just set.
    - `accepted_conditions` has no column in `searches` and lives in the same bag. `runner.ts` reads
      them through `acceptedConditionsFrom(spec)` (in `jev/questions.ts`), which falls back to the
      shipped default when the search has none — and treats an empty or unusable list as none, because
      `condition_ok` quotes the list verbatim and an empty list is a question with no content.

    The keyword is deliberately not written: the editor does not edit it. Searches stored before this
    date keep their empty spec until someone re-judges one of their runs.

28. **A signal JEV never answered is worth 0.5 in the blend, not nothing.** `MISSING_AS_NEUTRAL` in
    `web/src/lib/score.ts`. Until 2026-09-25 a missing signal was dropped and the remaining weights
    renormalised, which measured that listing over five signals where every other listing was
    measured over six — so a listing with less known about it was *easier* to score highly. That is
    an incentive, not just a distortion, and the wrong way round for choosing something to buy. Not
    zero either: a signal JEV never answered still outranks one it answered "worst possible". A
    signal switched off by a **zero weight** is a different state and stays out of the average
    entirely — value and weight both — which is why the weight check precedes the substitution.
    `blendOf` therefore returns null for exactly one state, every weight at zero.

    **Two things the change did and did not buy, measured on run 8.** The one row with an
    unparseable seller record went 0.726 → 0.688 and stayed the only matching row: one missing
    signal out of six moves a blend by little, and that row's other five signals really were strong.
    The rows printed "below" it in an earlier reading were trackpoint caps with
    `is_target_product = 0.02` — gate failures, not competitors — so the earlier claim that the
    unknown "topped the ranking above every complete row" was a misreading of a list that mixed
    gated-out rows with matching ones. The policy is right; on this data it changed no ordering.
    Design spec §3.3 of `2026-09-23-stage6-report-design.md` records the reversal and that caveat.

## Conventions

- **TDD**: write the failing test, run it and watch it fail, implement minimally, watch it pass.
- Tests live in `tests/`, one file per module. Pure parsing logic gets fast unit tests; anything
  touching eBay gets a fixture test against `tests/fixtures/ebay/`.
- The pipeline takes an injected `PageSource`, so the whole run is testable with no browser and no
  network. Keep that seam.
- **No hex colour literals outside `web/src/styles/tokens.css`.** The palette has exactly one home;
  reference it by Tailwind name (`bg-space-indigo`, `text-seashell`, …). Verify with
  `grep -rn '#[0-9a-fA-F]\{6\}' web/src --include='*.tsx' --include='*.ts'`.
- The API key is server-side only. It must never reach the browser, and the server binds
  `127.0.0.1` only.
- `git` is now in use. `.env` and `data/` are gitignored — **never commit `.env`.**

## Current state

**Resume here (2026-09-25):** **Stages 0–8 are complete — the build plan has no next stage.** Stage 8
was reviewed by a fresh-context reviewer on 2026-09-25: one Critical and four Important findings, all
five closed with a test each (rules 25 and 26 hold three of them). The `spec: {}` gap closed the same
day (rule 27): a re-judge now writes the buyer's half back onto the search, so a fresh run
pre-filters on what the editor confirmed. What is left:

- the **sponsored marker** (rule 5) — stored, not displayed, still no real discriminator;
- **`spec: {}` on searches stored before 2026-09-25** — rule 27 fixes the write path, not the past:
  the five empty-spec searches stay empty until someone re-judges one of their runs (run 8's search 6
  is the only one that ever had a real spec);
- **resuming a pause a process restart ended** — the row is swept to `cancelled` rather than left
  unusable, but nothing continues what it was doing, and a `401` still only fails loudly;
- nothing about the blend: the owner ruled on 2026-09-25 that a missing signal counts as neutral, and
  rule 28 records what that did and did not change. The standing item about the defaults being worth
  revisiting is closed — the sliders answer it, and the ranking on run 8 was not a defaults problem.

**`batchSize` is 25 since 2026-09-25, measured rather than guessed**, and the measurement found a bug
on the way: an oversized batch is refused as a 400 with a `max_tokens_exceeded` marker, which
`isTooLargeError` did not recognise, so the halving rule 17 promises never ran and the run died
instead. Cost per listing is linear, so the raise buys round trips (28 survivors: 3 calls → 2), not
money. Two probe runs, 60 distinct real listings plus run 8's pool repeated: $0.021.

**A run pauses instead of dying since 2026-09-24.** A bot challenge or an exhausted JEV outage waits
for a person — the browser stays open, the page says `paused`, and Resume continues from the same page
or batch. `scripts/repro-live-ui.ts` proves it in the browser: `paused runs seen on the page: 1`, then
`status=complete` after the click.

**A stored run can be re-judged with edited questions since 2026-09-24**, at zero page loads: the
question set lives in `questionnaires` as data (rules 19 and 20), a re-judge writes version 2 and
judges every listing the pre-filter kept, and the report shows one version at a time with a per-row
`was …` diff against the one before. Verified in the browser by `scripts/repro-live-ui.ts`, which
counts the fixture pages the scraper is served: 0 during a re-judge.

**The questions got 44% cheaper on 2026-09-24.** The listing's facts paragraph is no longer repeated
in all six questions; the state carries it once (`docs/.../2026-09-18-jevbrowser-design.md` §8.3,
CLAUDE.md rules 11b and 16). Same 20 listings, same six questions: 56,186 → 31,522 input tokens,
$0.00236 → $0.00132, 120/120 answers, no gate decision changed. A batch now sits at ~49% of the 64k
context instead of 88%, so `batchSize: 10` has room to grow — and the old rule 11b guess ("the
duplication is removable, probe before believing it") has been probed.

A run judges as part of the run, so it needs `TYPESAFE_API_KEY`: the client is built before the
first page load, so a missing key fails the run in the first second rather than after spending eBay
page loads on listings it could never judge. A 28-survivor run costs roughly $0.0015.

372 tests passing, typecheck clean on both projects. The last full end-to-end run was 2026-09-23
(run 8: 85 cards, 20 survivors judged, $0.00238).

**The report's copy is pure functions now.** `web/src/lib/reportText.ts` owns what an empty table
says and how many rows a count refers to, because the empty table has three different reasons and
they were sharing one sentence. `score.ts`'s `allWeightsZero` is the only state that means "your
weights are all zero" — a run that has simply not been judged yet is not it.

Scraping is verified working: 113 listings from a 2-page run, prices parsed 113/113, URLs valid.
Shipping is parsed correctly since 2026-09-21 — before that fix it stored the item price as the
shipping cost on every card that charged for shipping (rule 14). Runs stored before that date carry
wrong shipping values; nothing re-reads them yet.

The pre-filter rejects only clear contradictions, and a rejected listing never reaches JEV, so a
wrong reject is unrecoverable: unknown or ambiguous titles must always survive.

**The live-table bug of 2026-09-18 does not reproduce.** Four scenarios were exercised in a real
browser — fast fake source, real Playwright with real `extractCards`, an 18s idle gap before the
first event, and a second run in the same page — and rows streamed in every time. The likeliest
cause was a stale `dev:server` process from before the publish fix (see rule 13), whose replay made
a broken push look healthy. `tests/server-events-stream.test.ts` now guards live push at the HTTP
layer, which is the layer that had no test.

## Design decisions already settled

Node 22 + TypeScript in one process · Playwright as a library (CLI for selector work, MCP for
recon only) · React + Vite + Tailwind · `@typesafe-ai/sdk` · SQLite via `better-sqlite3` · SSE for
live updates. Language choice is the expensive one to reverse; everything else is cheap.

Palette: Space Indigo `#22223b`, Dusty Grape `#4a4e69`, Lilac Ash `#9a8c98`, Almond Silk `#c9ada7`,
Seashell `#f2e9e4`.
