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
npm test                  # vitest, 211 tests
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
```

`.env` must contain `TYPESAFE_API_KEY`. It is gitignored — keep it that way.

## Layout

```
src/shared/types + config   DEFAULTS, PRICING, LIMITS, MODEL_ALIAS, estimateCostUsd
src/storage/                schema.sql + db/runs/listings/events/searches repositories
src/scraper/                url.ts (buildSearchUrl), cards.ts (extractCards),
                            listing.ts (extractDetail), browser.ts (PageSource)
src/pipeline/               run.ts (executeRun), runner.ts (startRun, one run at a time),
                            prefilter.ts, judge.ts (judgeSurvivors)
src/jev/                    client.ts (JevClient + fake), env.ts, questions.ts, batch.ts
src/server/                 Fastify routes: searches, runs, SSE event stream
web/                        Vite + React + TS + Tailwind
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
    **~291 tokens per listing**, so the 32k state limit would allow ~109 listings. The full request
    (state + six questions) costs **~2,414–2,809 tokens per listing**, because `buildQuestions`
    writes the listing's facts paragraph into *each* of the six questions even though `buildState`
    already carries the same facts. So the 64k context binds long before the 32k state: a batch of
    10 measured 32,047 input tokens and a batch of 20 measured 56,186 — 88% of the context. The
    duplication is the cost driver and it is removable; the state never was. Re-measure with the
    probe after any change to the questions.

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


16. **A question key is invisible to the model.** JEV sees only each question's `instructions`
    text, so a question that does not name its listing is asking about all of them at once. Every
    question opens "About listing L3 — «title» at $1,299.99: …", and labels are assigned per run in
    card order. Two consequences: the same facts are stated once and reused by all six questions
    (inconsistent subsets invite inconsistent answers), and the buyer's criteria are quoted
    verbatim, in quotes. `src/jev/questions.ts` owns this; build questions with the SDK's
    `noul()`/`score()` helpers so a change in what JEV accepts breaks the build. Note the naming:
    `SearchRequest` (what the buyer asked for) is deliberately not `JevRequest` (the state +
    questions envelope in `client.ts`).

17. **Judging is a phase of the run, after the detail phase.** Every survivor is judged, including
    ones whose listing page failed (`detail_failed`) and ones past `maxDetailVisits` — those are
    judged on card data alone, and the question text says no listing page was opened so the model
    does not invent specifics. One call per `batchSize` (default 10) listings; a `422` halves the
    batch *permanently for the run* (a size refused once will be refused again) down to 1, and a
    listing still refused fails the run loudly. Cost is a fraction of a cent: two listings with
    twelve questions measured 3,632 input tokens, $0.00015.

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

**Resume here (2026-09-21):** Stages 0–5 are complete. **Next is Stage 6, the report and controls.**
The plan's *Handoff* section lists what is unfinished; the two items that matter most are that no
real end-to-end run has happened since Stage 4 (so prompt sizes are unmeasured and `batchSize: 10`
is probably far below the 32k limit), and that the sponsored marker is still a known defect.

A run now judges as part of the run, so it needs `TYPESAFE_API_KEY`: the client is built before the
first page load, so a missing key fails the run in the first second rather than after spending eBay
page loads on listings it could never judge. A 28-survivor run costs roughly $0.0015.

Stages 0–5 complete (Stage 5 = JEV judgments). 211 tests passing, typecheck clean.

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
