# jevbrowser — Project Vision & Design

**Date:** 2026-09-18
**Status:** Approved design, ready for build planning
**Working directory:** `/media/datos/html/jevbrowser`

---

## 1. What this is

A local, single-user web application that searches eBay for a product, filters the results
against criteria the user sets, uses the **JEV** model (TypeSafe's System One) to make the
semantic judgments that ordinary code cannot, and produces a sortable report of the listings
that match — each with its URL.

It exists primarily so the user can **explore how JEV behaves**: watch its answers arrive in
real time, see where it is confident and where it sits near 0.5, edit the questions, and
re-judge the same listings without scraping again. The report is the second goal, not the
only one. Both matter.

**One sentence:** scrape eBay once, ask JEV everything, then tune the answer for free.

---

## 2. Who uses it and how

- **One user** (the project owner), on their own machine, in a browser tab on `localhost`.
- **No accounts, no login, no multi-tenancy, no hosting.** Nothing is exposed publicly.
- The user is in Argentina but **buys in the US and ships within the US**, so the scraper sets
  a **US ZIP code** to obtain domestic shipping costs. Search is performed against **ebay.com
  in USD**.

---

## 3. Goals and non-goals

### Goals

1. Take a keyword plus criteria (free text, and optionally a structured spec block) and search
   eBay via a real browser.
2. Apply eBay's own native filters where they exist, to cut noise before spending JEV tokens.
3. Use JEV to judge each surviving listing across several typed dimensions.
4. Stream JEV's answers to the browser **live**, with the raw probabilities inspectable.
5. Produce a ranked, sortable report; let the user re-weight and re-threshold **without any new
   JEV calls or new scraping**.
6. Persist searches and runs so a search can be repeated, and a past run re-opened and re-judged.

### Non-goals (explicitly out of scope)

- No public/multi-user deployment, no auth, no billing.
- No eBay official API for now (see §12 for when to revisit).
- No purchasing, bidding, messaging sellers, or any write action on eBay.
- No scheduled/background monitoring — searches are started by hand.
- No price history tracking over time.

---

## 4. Glossary

| Term | Meaning |
|---|---|
| **JEV** | TypeSafe's flagship "System One" model. Returns typed judgments and probabilities, never generated text. |
| **Primitive** | One of JEV's three judgment types: `noul` (yes/no probability), `choice` (one of a set, with distribution), `score` (position on an ordered rubric). |
| **State** | The data a JEV request is judged against. One request carries one `state` plus a map of `questions`. |
| **Search** | A saved definition: keyword + criteria + spec + settings. Re-runnable. |
| **Run** | One execution of a search: the scrape, the judgments, the report. |
| **Card** | A single search-result tile/summary on the results page (title, price, condition, shipping, seller). |
| **Survivor** | A listing that passed the code pre-filter and therefore gets a listing-page visit and JEV judgments. |
| **Item specifics** | eBay's structured spec table on a listing page (Brand, Processor, RAM, Storage, Screen, Touchscreen…). |
| **eBay Refurbished** | eBay's own refurbishment program — a distinct, trusted condition label, not the same as seller refurbished. |

---

## 5. Functional requirements

### 5.1 Search definition

- A **keyword** field.
- A **free-text criteria** field — the user's own words, judged verbatim by JEV.
- An **optional structured spec block** used when the category warrants it: processor family,
  RAM, storage, screen/touch, price cap, accepted conditions. Generic by default; the spec block
  is filled only when relevant, so the same app works for laptops, cameras, watches, anything.
- Settings: result page cap, time cap, JEV batch size, headless/visible toggle, US ZIP.
- Defaults: **25 pages**, **10 minutes**, **batch of 10**, **visible browser**.

### 5.2 Scraping

- Launch Chromium via Playwright with a **persistent profile** at `data/browser-profile/`.
- Navigate to ebay.com search for the keyword; apply **native filters in the UI** where they
  exist (Condition, Price, and Processor/RAM/Storage/Screen when the spec block supplies them).
- **Set the US ZIP code** so shipping costs appear.
- Page through results up to the page cap, or until the time cap, whichever comes first.
- Read each card; store the raw card data.
- **Never log in to an eBay account.** Anonymous browsing only.
- **Never fetch pages in parallel**; pace page loads with a randomized 1.5–3s delay.

### 5.3 Code pre-filter (before JEV)

- Reject on price, and on any spec parseable from the card title.
- Record a human-readable **reject reason** for every rejection — these are shown in the UI so
  the user can see the filter is behaving.
- Only survivors get a listing-page visit and JEV calls. This is the main cost control.

### 5.4 Listing detail

- For each survivor, open the listing page and read the **Item Specifics table**, full title,
  condition, shipping cost, and seller information.
- Store the raw extracted detail alongside the card data.

### 5.5 JEV judgments

Six questions per listing, all in the same batched request (see §8).

### 5.6 Report

- Ranked list of matching listings, each with **its URL**, price, shipping, condition, and its
  judgment scores.
- Controls: **weight sliders** per weighted dimension, **match threshold**, **gate thresholds**,
  sort by any column, and a **max number of rows** to display.
- Every row expands to show the **raw JEV answers** — value, probabilities, confidence.
- Export to CSV and JSON.
- All ranking, weighting and thresholding happen **in the browser over already-stored data**.
  Changing any control triggers **no** new scraping and **no** new JEV calls.

#### 5.6.1 Seller trust marking

Listings from sellers with a flawless feedback record are **marked** in the report.

Seller feedback is already captured on every card as raw text (e.g. `"99.1% positive (17K)"`), so
this needs no extra scraping and no JEV call — it is pure code over stored data.

**Marking is three-tier (agreed 2026-09-18):**

| Tier | Condition | Display |
|---|---|---|
| **Trusted** | exactly 100% positive **and** the feedback count is meaningful (≥ 100) | solid badge |
| **Flawless but new** | exactly 100% positive but few reviews (< 100) | faded badge, count always shown |
| **Not marked** | below 100% | no badge; percentage still shown in the row |

The rationale for the split: **100% of 3 reviews is not 100% of 17,000.** A binary "100%" badge
would lend the same confidence to both. The review count is displayed next to the badge in every
tier, so the reader can judge for themselves rather than trusting a binary signal.

#### 5.6.2 Highlighting the best items

The report **highlights the items that best satisfy the request**, so the top candidates are
visible without sorting by hand.

"Best" is a weighted blend of signals already present, not a new scoring system:

| Signal | Source | Notes |
|---|---|---|
| `is_target_product` | JEV | gate — a case or charger can never be "best" |
| `condition_ok` | JEV | gate |
| `spec_match` | JEV | weighted |
| `price_value` | JEV | weighted |
| **seller feedback %** | code | weighted |
| **shipping cost** | code | weighted |

Highlighting is a **threshold on the blended score**, controllable in the UI, so the user tunes how
selective it is rather than the app guessing.

**Shipping is scored in absolute dollars (agreed 2026-09-18)**, not relative to item price, and
free shipping is treated as an outright bonus rather than merely zero cost. To make the weight
intuitive, shipping enters the blend as an inverted, bounded term: cheapest and free rate highest,
most expensive rate lowest, with the scale derived from the spread of shipping costs actually seen
in the current run. This keeps the slider meaningful whether a run's shipping ranges from $0–$20
or from $0–$200.

The weight sliders from §5.6 remain the single control surface — these two features add signals and
a highlight threshold, not a second parallel scoring path.

### 5.7 Persistence

- Every run stores: criteria, settings, raw scraped listings (card + detail), the exact question
  definitions used, and every JEV answer.
- A past run can be reopened, re-weighted, re-sorted — and **re-judged with edited questions**
  without scraping again.
- The questions used in each run are **versioned**, so answers from an older question set remain
  comparable rather than being overwritten.

### 5.8 Live view

- While a run is in progress the page shows a live feed of events and rows as JEV answers arrive.
- Refreshing the page mid-run **re-attaches** to the running job and replays its event history.
- A run can be **cancelled**; partial results are kept.

---

## 6. Architecture

One Node process. One SQLite file. One browser page.

```
src/
  shared/types.ts     — types shared by server, scraper and UI
  storage/            — SQLite access layer (searches, runs, listings, questionnaires,
                        judgments, events)
  scraper/            — Playwright only. Knows eBay. Knows nothing about JEV.
  jev/                — question builders, client, batching. Knows JEV. Knows nothing about eBay.
  pipeline/           — orchestrates phases, cancellation, event emission
  server/             — HTTP routes + SSE
web/                  — Vite + React + TS + Tailwind
data/
  jevbrowser.db
  browser-profile/    — persistent Playwright profile
  screenshots/        — saved on any unexpected page state
```

**The critical boundary:** `scraper/` and `jev/` must never import each other. The pipeline
passes plain data between them. This keeps two expensive-to-reverse swaps contained:
eBay → eBay official API, and JEV → another model.

---

## 7. Data model

| Table | Purpose | Key fields |
|---|---|---|
| `searches` | Saved, re-runnable search definition | id, name, keyword, criteria_text, spec_json, settings_json, created_at, updated_at |
| `runs` | One execution | id, search_id, status, started_at, finished_at, settings_json, stats_json, error |
| `listings` | One scraped listing within a run | id, run_id, ebay_item_id, title, url, price, shipping, currency, condition_label, seller_json, is_refurb, raw_card_json, raw_detail_json, stage, reject_reason |
| `questionnaires` | The exact question definitions used | id, run_id, definition_json, version, created_at |
| `judgments` | One JEV answer | id, run_id, questionnaire_id, listing_id, question_key, answer_json, created_at |
| `events` | Run event log (drives replay) | id, run_id, seq, at, type, payload_json |

`stage` is one of `card_only`, `rejected`, `survivor`, `detail_failed`, `judged`.

`status` is one of `queued`, `running`, `paused`, `cancelled`, `failed`, `complete`.

---

## 8. JEV integration

### 8.1 API facts (verified against the live docs)

- Package: **`@typesafe-ai/sdk`** (`npm install @typesafe-ai/sdk`). Requires Node 20+.
- API key is read from the environment variable **`TYPESAFE_API_KEY`**.
- Client: `const client = new TypeSafeClient();`
- Call: `client.systemOne({ state, questions })`
- Answer types are **inferred from the questions**; read answers by key,
  e.g. `response.answers.category.choice`.
- Raw HTTP equivalent (for reference): `POST https://api.typesafe.ai/v1/systemone`,
  `Authorization: Bearer <key>`, body `{ state, model, questions }`, model alias `jev-latest`.
- Response contains `answers` (keyed by your question ids) and `usage` (`input_tokens`,
  `output_tokens`).
- Errors: `401` bad key, `422` invalid body, `429` rate limited, `529` overloaded. On `429`/`529`,
  retry with exponential backoff — the SDK does this automatically.

### 8.2 Key handling

**The API key never reaches the browser.** The Node process reads `TYPESAFE_API_KEY` from a local
`.env` file and makes every JEV call server-side. The browser only ever receives answers.

This project is **not under version control** (explicit owner decision). Nothing in the build may
assume commits, branches, or a gitignored file — secrets are kept out of shared or synced
locations by convention instead.

### 8.3 Batching

Independent questions over the same state are asked **together in one request** — TypeSafe's own
cookbook measures this at roughly 12× cheaper and 10× faster than one call per item. So:

- One request carries `state = { request: {...}, listings: [ {...}, {...}, ... ] }` and questions
  keyed per item (`item_3.spec_match`, `item_3.price_value`, …).
- The shared `request` object is sent **once**, not repeated per listing.
- A listing's own facts are sent **once**, in its `listings[]` entry, and never restated per
  question. Measured 2026-09-24 (`scripts/probe-facts-duplication.ts`, 20 listings, 120 questions):
  restating them in all six questions cost **44% of the request** — 56,186 → 31,522 tokens — and
  changed no gate decision, with five of six questions inside the model's own run-to-run noise. Each
  question names its listing and points at its state entry instead.
- The buyer's requirements are the exception: they stay in the question that asks about them.
  Removing the criteria quote degraded `criteria_freeform` on 9 of 20 listings, up to 0.58 — that
  question exists to quote them.
- Since a question no longer says whether a listing page was opened, the **state** does, as
  `listing_page_opened`: `item_specifics: null` cannot tell "never opened" from "nothing to say",
  and only one of those licenses a guess.
- Requests are **chunked**, default **10 listings per call**, configurable in the UI.
- The documented size limit for one request is unknown; chunking keeps an oversized request a
  settings change rather than a rewrite, and a `422` is retried with the batch halved, down to 1.

### 8.4 The six questions

All six are asked per listing. Question **keys are for code only — the model never sees them**,
so each question must carry its complete meaning in its text.

| Key | Type | Intent |
|---|---|---|
| `is_target_product` | noul | Is this listing actually for the requested product — not a case, charger, dock, screen, or parts lot? |
| `spec_match` | noul | Does it satisfy the requested spec (processor family, memory, storage, screen/touch) as `request.spec` and `request.criteria_text` describe? |
| `condition_ok` | noul | Is the condition one the buyer accepts? Every acceptable label written out explicitly. |
| `listing_trust` | score | How trustworthy is this listing — seller feedback, return policy, vague or contradictory text, bait pricing? Concrete rubric levels. |
| `price_value` | score | Value for money at this price including shipping, against the budget. Concrete rubric levels. |
| `criteria_freeform` | noul | Does it satisfy the buyer's own written criteria, quoted verbatim? Catches what the other five miss. |

**Why `is_target_product` matters most:** an eBay keyword search for a product name returns
chargers, cases, palmrests, screens and parts pallets. No price filter and no spec block removes
those. It is the single highest-value question.

### 8.5 Composition (code owns this)

- **Gates:** `is_target_product` and `condition_ok` below their threshold ⇒ out. A great price
  never rescues a charger.
- **Weighted:** `spec_match`, `listing_trust`, `price_value`, `criteria_freeform` combined into a
  weighted average the user controls with sliders.
- **Default thresholds:** gates 0.5, weighted match 0.6. These are starting guesses, expected to
  be tuned once real answers are seen — and tuning is free because judgments are stored.
- Judgments near 0.5 are surfaced explicitly in the UI rather than hidden, because uncertainty is
  the thing the user is here to inspect.

### 8.6 Cost visibility

Verified 2026-09-18 at `https://docs.typesafe.ai/models.md`:

- Model: **`jev-1.13.0`**, aliases `jev-latest` (SDK default) and `jev-preview`.
- Price: **$0.042 per million tokens, input only — output tokens are free.**
- Rate limits: 250,000 tokens/sec, 1,200 requests/min.
- **Context ceiling: 64k tokens per request, of which 32k is available to `state`.**

That 32k state ceiling is what bounds batch size, so batching is deterministic rather than
guessed. Every response reports token usage; the app sums tokens and shows an estimated cost per
run, using the rate in `PRICING` (a config constant, correctable without touching code).

Measured on the Stage 0 spike: **816 input tokens** for one listing with two questions, costing
**$0.000034**. A full run of ~40 survivors lands near 30k input tokens — roughly **$0.001**, a
tenth of a cent. Cost is effectively a non-issue at this scale; the caps exist for time and
politeness, not money.

---

## 9. Scraper

### 9.1 Strategy

1. Launch Chromium with the persistent profile, visible by default.
2. Go to ebay.com search for the keyword.
3. Apply native filters in the UI: Condition, Price, and category filters (Processor, RAM,
   Storage, Screen size) when the spec block supplies them.
4. Set the US ZIP.
5. Page through results, reading each card, up to the caps.
6. Open only the survivors, reading Item Specifics + shipping + seller.

### 9.2 Robustness decisions

- **Visible browser by default** (`chromium`, not `chromium_headless_shell`), with a toggle for
  headless once selectors are stable. Rationale: when eBay changes a class, a headless run
  returns nothing and gives no clue; a visible run shows the broken page.
- **Persistent profile** at `data/browser-profile/` so cookies and a consistent fingerprint
  accumulate and the session looks like a returning visitor. This is the single biggest
  robustness win and it costs almost nothing.
- **Paced, serial page loads** — randomized 1.5–3s between navigations, never parallel.
- **Playwright as a library** (`playwright` npm package) for runtime, with the **Playwright CLI**
  used while developing selectors and as a regression test harness. Playwright MCP is **not** the
  runtime driver — it is designed for an agent deciding what to click, and would add a second
  process, a protocol hop, and much slower, token-heavy operation for a flow we already know.
  It remains useful as a scratchpad while reverse-engineering eBay's markup.

### 9.3 Caps (agreed)

- **25 result pages (≈1,500 listings)** or **10 minutes**, whichever comes first.
- Both configurable per search.

---

## 10. UI

One local web page, no navigation between views.

- **Top:** the search form — keyword, free-text criteria, spec block, settings.
- **Middle:** live run feed. Progress by phase, pages fetched, cards seen, rejected (with
  reasons), survivors, listing pages opened, JEV batches returned, tokens spent.
- **Bottom:** the report table. Rows stream in as judgments arrive. Each row expands to reveal the
  raw JEV answers — value, probabilities, confidence — for all six questions.
- **Controls above the table:** weight sliders, match threshold, gate thresholds, sort, max rows.
- **Export:** CSV and JSON.

### 10.1 Design system

Palette, defined once as CSS variables and referenced by name — no hex literals in components:

| Name | Hex | Role |
|---|---|---|
| Space Indigo | `#22223b` | Dark base — quiet strength, nighttime sky |
| Dusty Grape | `#4a4e69` | Surfaces, secondary structure |
| Lilac Ash | `#9a8c98` | Muted text, borders, inactive states |
| Almond Silk | `#c9ada7` | Warm accent, highlights |
| Seashell | `#f2e9e4` | Light backdrop, primary text on dark |

Dark base with warm light accents. Responsive layout via Tailwind breakpoints.

---

## 11. Error handling

**The failure that matters most: the scraper silently returning zero results because eBay
changed its markup.** Therefore every unexpected page state raises an explicit error and saves a
screenshot to `data/screenshots/`. Silence is treated as a bug.

| Failure | Handling |
|---|---|
| Bot challenge / captcha / interstitial | Pause the run, emit an event, surface it in the UI, offer resume. Never continue silently. |
| Expected element not found (layout change) | Explicit "layout changed" error + screenshot, not an empty list. |
| Listing page times out | Skip, mark `detail_failed`, still judge on card data, flag the reduced evidence. |
| JEV `422` | Retry with the batch halved, down to a single item. |
| JEV `429` / `529` | SDK exponential backoff; if exhausted, pause the run and report. |
| Browser crash | Fail the run; everything already stored stays viewable. |
| User cancels | Checked between pages and between batches; close the browser; keep partial results. |

Every error is emitted as an event, so it appears in the live feed rather than only in a log file.

---

## 12. Risks and constraints

- **eBay's User Agreement.** Scraping technically violates it. This is a personal, low-volume,
  local tool, which is the ordinary gray zone; the agreed caps and pacing keep it there. Two
  rules that are not negotiable: **keep the caps**, and **never log in to a real eBay account**.
  If this ever becomes public or commercial, that is the moment to switch to eBay's official
  Browse API (`developer.ebay.com`) — kept cheap by the `scraper/` boundary in §6.
- **Bot detection.** Mitigated by the persistent profile, visible browser, real Chromium, and
  pacing. Not eliminated. The escape hatch is the official API.
- **Breakage.** eBay changes markup; fixtures and screenshots make this a fixable annoyance rather
  than a mystery.
- **Cost.** JEV is the only recurring cost, scaling with survivors × questions. Controlled by the
  pre-filter, batching, and the caps. Usage is measured and displayed per run.

---

## 13. Testing

- **Pure unit tests** (no browser, no API, no cost): URL building, price parsing, spec parsing from
  titles, score composition, question construction.
- **Scraper tests against saved HTML fixtures** from real eBay pages — deterministic, offline, and
  the deliberate way to detect markup changes.
- **Fake JEV client** returning canned answers, so the full pipeline runs end to end for free.
- **One optional live smoke test** behind a flag, using real eBay and real JEV.
- Development follows test-driven practice: failing test first.

---

## 14. Tech decisions (all agreed)

| Decision | Choice | Reversibility |
|---|---|---|
| Language / runtime | **Node 22 + TypeScript**, one process for scraper, server, JEV and shared types | **Expensive** — the one to be deliberate about |
| Browser automation | **Playwright as a library**, CLI for selector work and tests | Moderate |
| Frontend | **React + Vite + TypeScript + Tailwind**, palette as CSS variables | Cheap — one page, no public API |
| JEV access | **`@typesafe-ai/sdk`**, key from `TYPESAFE_API_KEY` server-side only | Cheap |
| Storage | **SQLite via `better-sqlite3`** at `data/jevbrowser.db` | Cheap |
| Live updates | **SSE** at `/api/runs/:id/events` | Cheap |

Other agreed behaviours: one run at a time (later runs queue), runs are re-attachable across a
page refresh, and every run is persisted.

---

## 15. Open items

### Resolved during Stage 0 (2026-09-18)

1. **TypeSafe pricing rate** — $0.042 per million input tokens, output free. See §8.6.
2. **Maximum request size JEV accepts** — 64k context, 32k of it for `state`. This is the real
   bound on batch size.
3. **SDK helper exports** — `choice`, `noul` and `score` are all exported by
   `@typesafe-ai/sdk@0.6.0`. Signatures:
   `noul(instructions?, criteria?)`, `score(instructions, criteria)`,
   `choice(instructions, criteria)`. `ScoreCriteria` is a **tuple** (minimum two levels);
   `ChoiceCriteria` maps an option to rubric text or `null`.
4. **Response field names** — confirmed against a live call. A `score` answer returns
   `score`, `confidence`, `legend` and `probabilities`; **`legend` and `probabilities` are keyed
   by string level index** (`"0"`, `"1"`, …), not by number. The UI must not assume integer keys.
   A `noul` answer returns `noul` and no separate confidence.

### Still open

5. **eBay's exact filter labels and DOM** for the laptop category (RAM, storage, processor) —
   resolved in Stage 2, captured as fixtures.
6. **Whether eBay shows a usable Touchscreen item-specific for all relevant categories** — if not,
   touchscreen falls entirely to JEV's reading of the title and description.
