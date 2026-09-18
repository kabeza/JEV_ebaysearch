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
npm test                  # vitest, 75 tests
npm run typecheck         # tsc on BOTH the server and web projects
npm run dev:server        # API on 127.0.0.1:3001 (needs .env)
npm run dev:web           # Vite page on 127.0.0.1:5173
npm run dev               # both
npm run spike:jev         # Stage 0: one real JEV call, prints answers + cost
node --import tsx scripts/recon-ebay.ts       # fetch eBay, dump HTML + screenshot + selectors
node --import tsx scripts/probe-access.ts     # the headless-vs-headed access matrix
```

`.env` must contain `TYPESAFE_API_KEY`. It is gitignored — keep it that way.

## Layout

```
src/shared/types + config   DEFAULTS, PRICING, LIMITS, MODEL_ALIAS, estimateCostUsd
src/storage/                schema.sql + db/runs/listings/events/searches repositories
src/scraper/                url.ts (buildSearchUrl), cards.ts (extractCards), browser.ts
src/pipeline/               run.ts (executeRun), runner.ts (startRun, one run at a time)
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
    politeness; cost is not the constraint.

11. **JEV is stateless.** It answers questions, it does not remember your search and it cannot write
    questions. Bundle independent questions into **one** call — TypeSafe measure this at ~12x
    cheaper and 10x faster. Hard limits: 64k context, **32k for `state`**, which is what bounds
    batch size. Pricing is $0.042/Mtok input, output free.

12. **`legend` and `probabilities` on a score answer are keyed by STRING index** (`"0"`, `"1"`…),
    not integers. Assuming numbers renders blank cells.

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

Stage 0 and Stage 1 complete. Stage 2 roughly 85% complete. 75 tests passing, typecheck clean.

Scraping is verified working: 113 listings from a 2-page run, prices parsed 113/113, shipping
captured for all, URLs valid.

**The one known-broken thing:** the live results table in `RunView.tsx` does not update during a
run. The server stream is proven correct (raw `EventSource` in the same page receives everything);
the break is in React. Instrument the handlers rather than theorising.

## Design decisions already settled

Node 22 + TypeScript in one process · Playwright as a library (CLI for selector work, MCP for
recon only) · React + Vite + Tailwind · `@typesafe-ai/sdk` · SQLite via `better-sqlite3` · SSE for
live updates. Language choice is the expensive one to reverse; everything else is cheap.

Palette: Space Indigo `#22223b`, Dusty Grape `#4a4e69`, Lilac Ash `#9a8c98`, Almond Silk `#c9ada7`,
Seashell `#f2e9e4`.
