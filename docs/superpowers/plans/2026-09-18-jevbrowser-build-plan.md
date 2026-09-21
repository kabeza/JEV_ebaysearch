# jevbrowser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, single-user app that scrapes eBay with Playwright, judges listings with the JEV model, and produces a sortable, re-weightable report of matching products — while making JEV's reasoning visible and inspectable.

**Architecture:** One Node process holds everything: a Playwright scraper, a JEV client, a SQLite store, and an HTTP server that streams run events to a React page over SSE. The scraper and the JEV layer never import each other — the pipeline passes plain data between them, so either can be swapped without touching the other.

**Tech Stack:** Node 22 + TypeScript, Playwright (library), `@typesafe-ai/sdk`, `better-sqlite3`, Fastify (or Express), Vite + React + TypeScript + Tailwind, Vitest, SSE.

**Spec:** `docs/superpowers/specs/2026-09-18-jevbrowser-design.md`

---

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include this section.

- **No version control.** Do not run `git init`, `git add`, `git commit`, or any branch command. Tasks end with a checkpoint, not a commit.
- **Node 20+ required** (`@typesafe-ai/sdk` demands it; the machine has 22.18.0).
- **The JEV API key never reaches the browser.** It is read from `TYPESAFE_API_KEY` server-side only.
- **Run defaults:** 25 result pages, 10 minutes, JEV batch size 10, visible browser (`headed: true`).
- **Never log in to an eBay account.** Anonymous browsing only.
- **Never fetch eBay pages in parallel.** Randomized 1.5–3s delay between page loads.
- **Default thresholds:** gate thresholds 0.5, weighted match threshold 0.6.
- **Palette is referenced by name via CSS variables** — no hex literals inside components.
  Space Indigo `#22223b`, Dusty Grape `#4a4e69`, Lilac Ash `#9a8c98`, Almond Silk `#c9ada7`, Seashell `#f2e9e4`.
- **Silence is a bug.** An unexpected page state must raise an explicit error and save a screenshot to `data/screenshots/` — never return an empty list.
- **`scraper/` and `jev/` must never import each other.**

---

## Stages at a glance

Each stage produces something you can actually run and judge. Task-level detail is written for
**Stage 0** below; later stages get their task breakdown when we start them, so the plan stays
reviewable and we can adjust based on what the previous stage taught us.

| Stage | Goal | You'll be able to… |
|---|---|---|
| **0** | Retire the riskiest dependency first | Run one command and get a real JEV answer back |
| **1** | Skeleton: storage, server, page shell | Run `npm run dev`, save a search, see it listed |
| **2** | Scraper reads eBay search results | Watch result cards stream into a table live |
| **3** | Code pre-filter | See non-matching listings rejected, with reasons |
| **4** | Listing detail extraction | Inspect the item specifics captured for survivors |
| **5** | JEV judgments wired in | Watch real JEV probabilities arrive per listing |
| **6** | Report and controls | Re-weight, re-sort and export with zero new calls |
| **7** | Persistence, re-open, re-judge | Edit questions and re-judge without scraping again |
| **8** | Hardening | Survive bot challenges and eBay markup changes |

---

## Stage 0 — Prove JEV works before building anything else

**Why first:** every later stage depends on the JEV call working — the SDK's real export names,
the model alias, the key, and the response shape. If any of those is wrong, we find out in an
hour instead of after building a scraper, a server and a UI. This stage retires that risk.

**Deliverable:** `npm run spike:jev` prints a real JEV answer with its probabilities and token
usage.

**Files:**

- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env`, `.env.example`
- Create: `src/shared/config.ts`
- Create: `src/jev/env.ts`
- Create: `src/jev/client.ts`
- Create: `scripts/spike-jev.ts`
- Test: `tests/config.test.ts`, `tests/jev-env.test.ts`

---

### Task 0.1: Project skeleton and agreed defaults

**Files:**

- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/shared/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**

- Consumes: nothing (first task)
- Produces: `DEFAULTS` (object with `maxPages`, `maxMinutes`, `batchSize`, `headed`, `zhomeZip`, `pacingMinMs`, `pacingMaxMs`), and the `RunSettings` type — later stages read these instead of hardcoding numbers. `PROJECT_NAME` (string).

- [ ] **Step 1: Write the failing test**

```ts
// tests/config.test.ts
import { describe, it, expect } from 'vitest'
import { DEFAULTS } from '../src/shared/config'

describe('DEFAULTS', () => {
  it('matches the run defaults agreed in the spec', () => {
    expect(DEFAULTS.maxPages).toBe(25)
    expect(DEFAULTS.maxMinutes).toBe(10)
    expect(DEFAULTS.batchSize).toBe(10)
    expect(DEFAULTS.headed).toBe(true)
  })

  it('paces page loads between 1.5s and 3s', () => {
    expect(DEFAULTS.pacingMinMs).toBe(1500)
    expect(DEFAULTS.pacingMaxMs).toBe(3000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/shared/config`.

- [ ] **Step 3: Create the project and install what this task needs**

```bash
npm init -y
npm install --save-dev typescript vitest @types/node tsx
```

Then create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist"
  },
  "include": ["src", "scripts", "tests", "web"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
```

Add to `package.json` scripts:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

Set `"type": "module"` in `package.json`.

- [ ] **Step 4: Write the minimal implementation**

```ts
// src/shared/config.ts
export const PROJECT_NAME = 'jevbrowser'

/** Run settings, defaulted to the values agreed in the design spec (section 5.1). */
export interface RunSettings {
  /** Stop after this many result pages. */
  maxPages: number
  /** Stop after this many minutes, whichever comes first. */
  maxMinutes: number
  /** How many listings to send to JEV in one request. */
  batchSize: number
  /** Visible browser by default: a broken selector is visible, not silent. */
  headed: boolean
  /** US ZIP used to get domestic shipping costs. */
  zhomeZip: string
  /** Randomized pacing between page loads, in milliseconds. */
  pacingMinMs: number
  pacingMaxMs: number
}

export const DEFAULTS: RunSettings = {
  maxPages: 25,
  maxMinutes: 10,
  batchSize: 10,
  headed: true,
  zhomeZip: '10001',
  pacingMinMs: 1500,
  pacingMaxMs: 3000,
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Verify types compile**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Checkpoint**

Report to the user: files created, test output, and that `DEFAULTS` now holds the agreed numbers
in one place. **Stop for review.**

---

### Task 0.2: Load the API key from the environment

**Files:**

- Create: `.env.example`, `.env`
- Create: `src/jev/env.ts`
- Modify: `package.json` (scripts use `--env-file=.env`)
- Test: `tests/jev-env.test.ts`

**Interfaces:**

- Consumes: nothing from Task 0.1.
- Produces: `requireApiKey(env?: NodeJS.ProcessEnv): string` — returns the trimmed key or throws a message naming the fix. Used by `createJevClient` in Task 0.3.

- [ ] **Step 1: Write the failing test**

```ts
// tests/jev-env.test.ts
import { describe, it, expect } from 'vitest'
import { requireApiKey } from '../src/jev/env'

describe('requireApiKey', () => {
  it('returns the trimmed key when present', () => {
    expect(requireApiKey({ TYPESAFE_API_KEY: '  abc123  ' })).toBe('abc123')
  })

  it('throws a message naming the fix when missing', () => {
    expect(() => requireApiKey({})).toThrowError(/TYPESAFE_API_KEY is not set/)
  })

  it('treats a whitespace-only key as missing', () => {
    expect(() => requireApiKey({ TYPESAFE_API_KEY: '   ' })).toThrowError(/TYPESAFE_API_KEY/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/jev-env.test.ts`
Expected: FAIL — cannot resolve `../src/jev/env`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/jev/env.ts
/**
 * Reads the TypeSafe API key. Called only from server-side code — the key must
 * never be sent to the browser (spec section 8.2).
 */
export function requireApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.TYPESAFE_API_KEY?.trim()
  if (!key) {
    throw new Error(
      'TYPESAFE_API_KEY is not set. Copy .env.example to .env and paste your key.',
    )
  }
  return key
}
```

- [ ] **Step 4: Create the env files**

`.env.example`:

```
# Copy this file to .env and paste your TypeSafe API key.
# Get one at https://typesafe.ai — the key is used server-side only.
TYPESAFE_API_KEY=
```

Then create `.env` with the real key. **This file must never be copied into `web/` or served
over HTTP, and never sent to the browser.** Add `--env-file=.env` to the scripts that need it:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "spike:jev": "node --env-file=.env --import tsx scripts/spike-jev.ts"
  }
}
```

- [ ] **Step 5: Run tests and verify they pass**

Run: `npx vitest run tests/jev-env.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Confirm the key is actually visible to a script**

Run: `node --env-file=.env -e "console.log(process.env.TYPESAFE_API_KEY ? 'key loaded, length ' + process.env.TYPESAFE_API_KEY.length : 'NOT LOADED')"`
Expected: prints `key loaded, length <n>` — **not** `NOT LOADED`, and it must not print the key itself.

- [ ] **Step 7: Checkpoint**

Report: key loads, tests pass, and confirm the `.env` file exists with the real key. **Stop for review.**

---

### Task 0.3: A thin JEV client, verified against the real SDK

**Files:**

- Create: `src/jev/client.ts`
- Test: `tests/jev-client.test.ts`
- Install: `@typesafe-ai/sdk`

**Interfaces:**

- Consumes: `requireApiKey` (Task 0.2).
- Produces: the `JevClient` interface, the `JevAnswer` and `JevUsage` types, `createJevClient()` (real, talks to TypeSafe), and `createFakeJevClient(answers)` (returns canned answers for tests — used from Stage 5 onward so the pipeline is testable without spending money).

**This task starts by verifying the SDK rather than assuming it** — the spec's open item 5 is
whether `noul` and `score` helpers are exported the way `choice` is.

- [ ] **Step 1: Install the SDK and read its actual exports**

```bash
npm install @typesafe-ai/sdk
ls node_modules/@typesafe-ai/sdk/dist
```

Read the `.d.ts` files it ships and the `README` if present. Record, in your report:
the exact exported function names for noul / choice / score, and the exact method signature of
the client's system-one call.

**If `noul` or `score` helpers are not exported:** build questions as plain objects of the
documented shape instead — `{ type: 'noul', instructions, criteria? }`, `{ type: 'score',
instructions, criteria: [...] }`, `{ type: 'choice', instructions, criteria: {...} }` — and note
that in the checkpoint so Stage 5 uses objects throughout. Do not invent helper names.

- [ ] **Step 2: Write the failing test**

```ts
// tests/jev-client.test.ts
import { describe, it, expect } from 'vitest'
import { createFakeJevClient } from '../src/jev/client'

describe('createFakeJevClient', () => {
  it('returns the canned answers it was given', async () => {
    const fake = createFakeJevClient({
      'item_0.is_target_product': { type: 'noul', noul: 0.93 },
    })
    const result = await fake.systemOne({ state: {}, questions: {} })
    expect(result.answers['item_0.is_target_product']).toEqual({ type: 'noul', noul: 0.93 })
    expect(result.usage.input_tokens).toBe(0)
  })

  it('records the requests it received, so tests can assert on batching', async () => {
    const fake = createFakeJevClient({})
    await fake.systemOne({ state: { a: 1 }, questions: { q: {} } })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.questions).toEqual({ q: {} })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/jev-client.test.ts`
Expected: FAIL — cannot resolve `../src/jev/client`.

- [ ] **Step 4: Write the implementation**

Write the types to match what you actually found in Step 1; the shape below is the minimum the
rest of the plan depends on, so keep these names.

```ts
// src/jev/client.ts
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { requireApiKey } from './env.js'

/** A single judgment, however the primitive shaped it. */
export interface JevAnswer {
  type: 'noul' | 'choice' | 'score'
  [key: string]: unknown
}

export interface JevUsage {
  input_tokens: number
  output_tokens: number
}

export interface JevRequest {
  state: unknown
  questions: Record<string, unknown>
}

export interface JevResult {
  model: string
  answers: Record<string, JevAnswer>
  usage: JevUsage
}

export interface JevClient {
  systemOne(req: JevRequest): Promise<JevResult>
}

/** Real client. Server-side only — constructed with a validated key. */
export function createJevClient(): JevClient {
  requireApiKey()
  const client = new TypeSafeClient()
  return {
    async systemOne(req: JevRequest): Promise<JevResult> {
      const res = await client.systemOne(req as never)
      return res as unknown as JevResult
    },
  }
}

/**
 * Test double. Returns canned answers and records every request, so the pipeline
 * can be exercised end to end without spending money or touching the network.
 */
export interface FakeJevClient extends JevClient {
  calls: JevRequest[]
}

export function createFakeJevClient(
  answers: Record<string, JevAnswer>,
  usage: JevUsage = { input_tokens: 0, output_tokens: 0 },
): FakeJevClient {
  const calls: JevRequest[] = []
  return {
    calls,
    async systemOne(req: JevRequest): Promise<JevResult> {
      calls.push(req)
      return { model: 'fake', answers, usage }
    },
  }
}
```

- [ ] **Step 5: Run tests and verify they pass**

Run: `npx vitest run tests/jev-client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Verify types compile**

Run: `npm run typecheck`
Expected: no errors. If the SDK's types reject the cast, replace `as never` with the exact
parameter type you found in Step 1 and note the change.

- [ ] **Step 7: Checkpoint**

Report: the SDK's real export names, the client's real method signature, whether `noul`/`score`
helpers exist, and the test output. **Stop for review.**

---

### Task 0.4: The spike — one real JEV answer, end to end

**Files:**

- Create: `scripts/spike-jev.ts`
- Modify: `src/shared/config.ts` (add the pricing rate constant)
- Test: none — this script's output *is* the test

**Interfaces:**

- Consumes: `createJevClient` (Task 0.3), `requireApiKey` (Task 0.2), `DEFAULTS` (Task 0.1).
- Produces: `PRICING` (object with `inputPerMillionUsd`, `outputPerMillionUsd`) and `estimateCostUsd(usage)` — reused by the run cost display in Stage 5.

- [ ] **Step 1: Add the pricing constants**

The real rate is the spec's open item 1. Look it up now at
`https://docs.typesafe.ai/models.md` (and the TypeSafe pricing page if it links there). If you
cannot find a published rate, **leave the values at 0 and say so in the checkpoint** — do not
invent a number. A visible zero is honest; a made-up rate is not.

```ts
// append to src/shared/config.ts

/**
 * TypeSafe pricing, USD per million tokens. Verify against the vendor's current
 * pricing page before trusting the cost estimate in the UI.
 */
export const PRICING = {
  inputPerMillionUsd: 0,
  outputPerMillionUsd: 0,
}

export function estimateCostUsd(usage: { input_tokens: number; output_tokens: number }): number {
  return (
    (usage.input_tokens / 1_000_000) * PRICING.inputPerMillionUsd +
    (usage.output_tokens / 1_000_000) * PRICING.outputPerMillionUsd
  )
}
```

- [ ] **Step 2: Write the spike script**

Use a real ThinkPad listing shape from the spec's example search, so the answer is meaningful.

```ts
// scripts/spike-jev.ts
import { createJevClient } from '../src/jev/client.js'
import { estimateCostUsd } from '../src/shared/config.js'

const state = {
  request: {
    keyword: 'Thinkpad T14s gen 6',
    criteria_text:
      '32gb ram, Ryzen (AMD) processor, 1tb storage, touch screen, less than u$s 1600, brand new or refurbished/open box/eBay Refurbished',
    max_price: 1600,
  },
  listing: {
    title: 'Lenovo ThinkPad T14s Gen 6 AMD Ryzen 7 7840U 32GB RAM 1TB SSD 14" Touch WUXGA',
    price: 1429.0,
    shipping: 0,
    condition_label: 'Certified - Refurbished',
    item_specifics: {
      Processor: 'AMD Ryzen 7 7840U',
      'RAM Size': '32 GB',
      'Storage Capacity': '1 TB',
      Touchscreen: 'Yes',
    },
  },
}

const questions = {
  is_target_product: {
    type: 'noul',
    instructions:
      'Is this listing for the laptop computer itself, rather than an accessory, case, charger, dock, screen, or set of parts?',
  },
  price_value: {
    type: 'score',
    instructions:
      'How good is the value for money at this price including shipping, against `request.max_price`?',
    criteria: [
      'Far above the budget, or poor value for the specification.',
      'Slightly above budget, or mediocre value.',
      'At the top of the budget with fair value.',
      'Comfortably within budget with good value.',
      'Well below budget for the specification — unusually good value.',
    ],
  },
}

const client = createJevClient()
const result = await client.systemOne({ state, questions })

console.log('model:', result.model)
console.log(JSON.stringify(result.answers, null, 2))
console.log('usage:', result.usage)
console.log('estimated cost (USD):', estimateCostUsd(result.usage))
```

- [ ] **Step 3: Run the spike**

Run: `npm run spike:jev`
Expected: real answers printed — an `is_target_product` noul probability and a `price_value`
score with a `legend` and `probabilities` — plus a non-zero token usage.

If it fails with `401`, the key is wrong or not loading. If it fails with `422`, the question
shape is wrong — fix it against the docs, and record the correct shape for Stage 5.

- [ ] **Step 4: Checkpoint — the real decision point**

Report to the user, in plain language:

1. The actual answers JEV gave and whether they look sane for that listing.
2. The real token usage and estimated cost. **If pricing was not found, say so** and propose
   either finding it or running the first real search to measure tokens empirically.
3. Any correction needed to the question shapes recorded in Task 0.3, which Stage 5 depends on.

**This is the moment to judge whether JEV's answers are good enough to build on.** If they are
not, stop here and revise the questions — everything downstream is machinery around them.

---

## Stage 1 — Skeleton: storage, server, page shell

**Goal:** `npm run dev` starts a server and a page; a search can be saved and listed.

**Deliverable:** a page on `localhost` showing saved searches, with the palette applied.

**Acceptance:** create a search in the UI, refresh, it is still there; `npm test` passes; the
palette is defined once in `tokens.css` and referenced by name everywhere else.

**Verified before planning:** `better-sqlite3` ships prebuilt binaries and loads without a native
build step on this machine, so Decision 4's "native module" caveat does not currently apply.
`better-sqlite3@13` and `@typesafe-ai/sdk@0.6.0` are already installed.

**Corrections found while executing this stage** — the plan below is otherwise unchanged:

- `better-sqlite3` ships **no** type declarations. `npm install --save-dev @types/better-sqlite3`
  is required or `npm run typecheck` fails with TS7016. Added to Task 1.1.
- React 19 does not bundle its own types either: `@types/react` and `@types/react-dom` are both
  required. Added to Task 1.3.
- A CSS side-effect import (`import './styles/tokens.css'`) fails typecheck with TS2882 without a
  `web/src/vite-env.d.ts` containing `/// <reference types="vite/client" />`. Added to Task 1.3.
- The `web/` project gets its own `tsconfig.json` (DOM lib, `jsx: react-jsx`), and `typecheck`
  runs both projects: `tsc --noEmit && tsc --noEmit -p web`. Keeps DOM types out of server code.
- The dev server entry is `scripts/start-server.ts`, not `src/server/index.ts` — the module
  exports `buildServer`/`startServer` without invoking them, so tests can import it freely.

---

### Task 1.1: The storage layer

**Files:**

- Create: `src/storage/schema.sql`, `src/storage/db.ts`, `src/storage/searches.ts`
- Test: `tests/storage.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `openDatabase(path?: string): Database.Database`, `Search`, `NewSearch`, `createSearch`, `listSearches`, `getSearch`. Stages 2–7 import these names.

The whole schema is created now, in one file, even though only `searches` is used in this stage.
Creating all tables up front avoids migration churn while the shape is still in flux; the spec's
§7 is the reference.

- [ ] **Step 1: Write the failing test**

```ts
// tests/storage.test.ts
import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/storage/db'
import { createSearch, listSearches, getSearch } from '../src/storage/searches'

const input = {
  name: 'ThinkPad T14s Gen 6',
  keyword: 'Thinkpad T14s gen 6',
  criteriaText: '32gb ram, Ryzen, 1tb, touch screen, under u$s 1600, new or refurbished',
  spec: { cpu_family: 'AMD Ryzen', ram_gb: 32, storage_gb: 1024, touch: true },
  settings: { maxPages: 25, maxMinutes: 10 },
}

describe('searches repository', () => {
  it('stores a search and reads it back with its spec intact', () => {
    const db = openDatabase(':memory:')
    const created = createSearch(db, input)

    expect(created.id).toBeGreaterThan(0)
    const found = getSearch(db, created.id)
    expect(found?.keyword).toBe('Thinkpad T14s gen 6')
    expect(found?.spec).toEqual(input.spec)
    expect(found?.settings).toEqual(input.settings)
  })

  it('lists searches newest first', () => {
    const db = openDatabase(':memory:')
    createSearch(db, { ...input, name: 'first' })
    createSearch(db, { ...input, name: 'second' })
    expect(listSearches(db).map((s) => s.name)).toEqual(['second', 'first'])
  })

  it('returns undefined for an unknown id', () => {
    const db = openDatabase(':memory:')
    expect(getSearch(db, 999)).toBeUndefined()
  })

  it('creates every table from the spec, so later stages need no migration', () => {
    const db = openDatabase(':memory:')
    const names = db
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((r) => (r as { name: string }).name)
    for (const t of ['searches', 'runs', 'listings', 'questionnaires', 'judgments', 'events']) {
      expect(names).toContain(t)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storage.test.ts`
Expected: FAIL — cannot resolve `../src/storage/db`.

- [ ] **Step 3: Write the schema**

```sql
-- src/storage/schema.sql
-- Full schema from the design spec, section 7. Create-if-not-exists so startup is idempotent.

create table if not exists searches (
  id            integer primary key autoincrement,
  name          text not null,
  keyword       text not null,
  criteria_text text not null default '',
  spec_json     text not null default '{}',
  settings_json text not null default '{}',
  created_at    text not null default (datetime('now')),
  updated_at    text not null default (datetime('now'))
);

create table if not exists runs (
  id            integer primary key autoincrement,
  search_id     integer not null references searches(id) on delete cascade,
  status        text not null default 'queued',
  started_at    text,
  finished_at   text,
  settings_json text not null default '{}',
  stats_json    text not null default '{}',
  error         text
);

create table if not exists listings (
  id               integer primary key autoincrement,
  run_id           integer not null references runs(id) on delete cascade,
  ebay_item_id     text,
  title            text not null default '',
  url              text,
  price            real,
  shipping         real,
  currency         text,
  condition_label  text,
  seller_json      text,
  is_refurb        integer not null default 0,
  raw_card_json    text,
  raw_detail_json  text,
  stage            text not null default 'card_only',
  reject_reason    text
);
create index if not exists idx_listings_run on listings(run_id);

create table if not exists questionnaires (
  id              integer primary key autoincrement,
  run_id          integer not null references runs(id) on delete cascade,
  definition_json text not null,
  version         integer not null default 1,
  created_at      text not null default (datetime('now'))
);

create table if not exists judgments (
  id               integer primary key autoincrement,
  run_id           integer not null references runs(id) on delete cascade,
  questionnaire_id integer not null references questionnaires(id) on delete cascade,
  listing_id       integer not null references listings(id) on delete cascade,
  question_key     text not null,
  answer_json      text not null,
  created_at       text not null default (datetime('now'))
);
create index if not exists idx_judgments_listing on judgments(listing_id);

create table if not exists events (
  id           integer primary key autoincrement,
  run_id       integer not null references runs(id) on delete cascade,
  seq          integer not null,
  at           text not null default (datetime('now')),
  type         text not null,
  payload_json text
);
create index if not exists idx_events_run_seq on events(run_id, seq);
```

- [ ] **Step 4: Write `db.ts`**

Read `schema.sql` from disk relative to the module (use `import.meta.dirname`, available in Node 20.11+).

```ts
// src/storage/db.ts
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SCHEMA_PATH = join(import.meta.dirname, 'schema.sql')

/**
 * Opens the database and applies the schema. Idempotent, so it is safe to call
 * on every startup. Pass ':memory:' in tests.
 */
export function openDatabase(path = 'data/jevbrowser.db'): Database.Database {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'))
  return db
}

export type { Database }
```

- [ ] **Step 5: Write `searches.ts`**

```ts
// src/storage/searches.ts
import type { Database as SqliteDatabase } from 'better-sqlite3'

export interface SearchSpec {
  cpu_family?: string
  ram_gb?: number
  storage_gb?: number
  touch?: boolean
  [key: string]: unknown
}

export interface Search {
  id: number
  name: string
  keyword: string
  criteriaText: string
  spec: SearchSpec
  settings: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface NewSearch {
  name: string
  keyword: string
  criteriaText: string
  spec?: SearchSpec
  settings?: Record<string, unknown>
}

interface Row {
  id: number
  name: string
  keyword: string
  criteria_text: string
  spec_json: string
  settings_json: string
  created_at: string
  updated_at: string
}

function toSearch(row: Row): Search {
  return {
    id: row.id,
    name: row.name,
    keyword: row.keyword,
    criteriaText: row.criteria_text,
    spec: JSON.parse(row.spec_json) as SearchSpec,
    settings: JSON.parse(row.settings_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createSearch(db: SqliteDatabase, input: NewSearch): Search {
  const info = db
    .prepare(
      `insert into searches (name, keyword, criteria_text, spec_json, settings_json)
       values (@name, @keyword, @criteriaText, @specJson, @settingsJson)`,
    )
    .run({
      name: input.name,
      keyword: input.keyword,
      criteriaText: input.criteriaText,
      specJson: JSON.stringify(input.spec ?? {}),
      settingsJson: JSON.stringify(input.settings ?? {}),
    })
  return getSearch(db, Number(info.lastInsertRowid))!
}

export function getSearch(db: SqliteDatabase, id: number): Search | undefined {
  const row = db.prepare('select * from searches where id = ?').get(id) as Row | undefined
  return row ? toSearch(row) : undefined
}

export function listSearches(db: SqliteDatabase): Search[] {
  const rows = db.prepare('select * from searches order by id desc').all() as Row[]
  return rows.map(toSearch)
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/storage.test.ts`
Expected: PASS (4 tests). `data/` is only created for a file path, so these in-memory tests touch nothing.

- [ ] **Step 7: Checkpoint**

Report: tests, and confirmation that all six tables exist. **Stop for review.**

---

### Task 1.2: The HTTP server and the searches API

**Files:**

- Create: `src/server/index.ts`, `src/server/routes/searches.ts`
- Test: `tests/server-searches.test.ts`
- Install: `fastify`

**Interfaces:**

- Consumes: `openDatabase`, `createSearch`, `listSearches` (Task 1.1).
- Produces: `buildServer(opts: { dbPath?: string })` returning a Fastify instance — tests build one per test; `startServer()` used by the dev script. Routes: `GET /api/searches`, `POST /api/searches`. Stage 2 adds `runs` routes to the same server.

- [ ] **Step 1: Write the failing test**

```ts
// tests/server-searches.test.ts
import { describe, it, expect } from 'vitest'
import { buildServer } from '../src/server/index'

const body = {
  name: 'ThinkPad T14s Gen 6',
  keyword: 'Thinkpad T14s gen 6',
  criteriaText: '32gb ram, Ryzen, 1tb, touch screen, under u$s 1600',
  spec: { ram_gb: 32 },
}

describe('searches API', () => {
  it('starts with no searches', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    const res = await app.inject({ method: 'GET', url: '/api/searches' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await app.close()
  })

  it('creates a search and returns it in the list', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    const created = await app.inject({ method: 'POST', url: '/api/searches', payload: body })
    expect(created.statusCode).toBe(201)
    expect(created.json().id).toBeGreaterThan(0)

    const list = await app.inject({ method: 'GET', url: '/api/searches' })
    expect(list.json()).toHaveLength(1)
    expect(list.json()[0].keyword).toBe('Thinkpad T14s gen 6')
    await app.close()
  })

  it('rejects a search with no keyword', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/searches',
      payload: { ...body, keyword: '   ' },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server-searches.test.ts`
Expected: FAIL — cannot resolve `../src/server/index`.

- [ ] **Step 3: Install Fastify and write the routes**

```bash
npm install fastify
```

```ts
// src/server/routes/searches.ts
import type { FastifyInstance } from 'fastify'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { createSearch, listSearches } from '../../storage/searches'

export function registerSearchRoutes(app: FastifyInstance, db: SqliteDatabase): void {
  app.get('/api/searches', async () => listSearches(db))

  app.post('/api/searches', async (request, reply) => {
    const body = request.body as Partial<{
      name: string
      keyword: string
      criteriaText: string
      spec: Record<string, unknown>
      settings: Record<string, unknown>
    }>

    if (!body?.keyword?.trim()) {
      return reply.code(400).send({ error: 'keyword is required' })
    }
    if (!body.name?.trim()) {
      return reply.code(400).send({ error: 'name is required' })
    }

    const created = createSearch(db, {
      name: body.name,
      keyword: body.keyword,
      criteriaText: body.criteriaText ?? '',
      spec: body.spec ?? {},
      settings: body.settings ?? {},
    })
    return reply.code(201).send(created)
  })
}
```

```ts
// src/server/index.ts
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { openDatabase } from '../storage/db'
import { registerSearchRoutes } from './routes/searches'

export interface ServerOptions {
  dbPath?: string
  logger?: boolean
}

export function buildServer(opts: ServerOptions = {}): FastifyInstance {
  const dbPath = opts.dbPath ?? 'data/jevbrowser.db'
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })

  const app = Fastify({ logger: opts.logger ?? false })
  const db = openDatabase(dbPath)

  registerSearchRoutes(app, db)
  app.addHook('onClose', async () => db.close())

  return app
}

export async function startServer(port = 3001): Promise<FastifyInstance> {
  const app = buildServer({ logger: true })
  await app.listen({ port, host: '127.0.0.1' })
  return app
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server-searches.test.ts`
Expected: PASS (3 tests).

**Security note for the reviewer:** the server binds `127.0.0.1` only, never `0.0.0.0`. This app
holds an API key and drives a real browser; it must not be reachable from the network.

- [ ] **Step 5: Checkpoint**

Report: tests, and confirm the bind address is `127.0.0.1`. **Stop for review.**

---

### Task 1.3: The page, with the palette

**Files:**

- Create: `web/index.html`, `web/vite.config.ts`, `web/src/main.tsx`, `web/src/App.tsx`,
  `web/src/styles/tokens.css`, `web/src/lib/api.ts`
- Modify: `package.json` (dev scripts)
- Install: `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`

**Interfaces:**

- Consumes: the `searches` API from Task 1.2.
- Produces: `listSearches()`, `createSearch(input)` in `web/src/lib/api.ts` — Stage 6 extends this module.

- [ ] **Step 1: Install and configure Vite + React + Tailwind v4**

```bash
npm install react react-dom
npm install --save-dev vite @vitejs/plugin-react tailwindcss @tailwindcss/vite @types/react @types/react-dom
```

Also create `web/src/vite-env.d.ts` containing exactly `/// <reference types="vite/client" />`,
or the `tokens.css` side-effect import fails typecheck.

`web/vite.config.ts` — the proxy is what keeps the browser same-origin, so no CORS and no key
anywhere near the page:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
})
```

Add to the root `package.json` scripts:

```json
{
  "scripts": {
    "dev:server": "node --env-file=.env --import tsx src/server/index.ts",
    "dev:web": "vite --config web/vite.config.ts",
    "dev": "npm run dev:server & npm run dev:web"
  }
}
```

- [ ] **Step 2: Define the palette once**

```css
/* web/src/styles/tokens.css */
@import 'tailwindcss';

/*
 * The project palette, defined exactly once. Referenced as Tailwind colour
 * utilities (bg-space-indigo, text-seashell, ...) so no component ever holds a
 * hex literal. Names come from the design spec, section 10.1.
 */
@theme {
  --color-space-indigo: #22223b; /* dark base — quiet strength, nighttime sky */
  --color-dusty-grape: #4a4e69;  /* surfaces, secondary structure */
  --color-lilac-ash: #9a8c98;    /* muted text, borders, inactive states */
  --color-almond-silk: #c9ada7;  /* warm accent, highlights */
  --color-seashell: #f2e9e4;     /* light backdrop, primary text on dark */
}

body {
  @apply bg-space-indigo text-seashell antialiased;
}
```

- [ ] **Step 3: Write the API client and the page**

```ts
// web/src/lib/api.ts
export interface Search {
  id: number
  name: string
  keyword: string
  criteriaText: string
  spec: Record<string, unknown>
  settings: Record<string, unknown>
}

export async function listSearches(): Promise<Search[]> {
  const res = await fetch('/api/searches')
  if (!res.ok) throw new Error(`GET /api/searches failed: ${res.status}`)
  return res.json()
}

export async function createSearch(input: {
  name: string
  keyword: string
  criteriaText: string
}): Promise<Search> {
  const res = await fetch('/api/searches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`POST /api/searches failed: ${res.status}`)
  return res.json()
}
```

`web/src/App.tsx` — a responsive two-column layout (stacked on small screens, side by side from
`md` up), a form on the left and the saved list on the right. Uses only palette utilities.

```tsx
import { useEffect, useState } from 'react'
import { createSearch, listSearches, type Search } from './lib/api'

export default function App() {
  const [searches, setSearches] = useState<Search[]>([])
  const [name, setName] = useState('')
  const [keyword, setKeyword] = useState('')
  const [criteriaText, setCriteriaText] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    try {
      setSearches(await listSearches())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await createSearch({ name, keyword, criteriaText })
      setName('')
      setKeyword('')
      setCriteriaText('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <main className="mx-auto grid max-w-5xl gap-8 p-6 md:grid-cols-2">
      <section>
        <h1 className="mb-6 text-2xl font-semibold text-almond-silk">jevbrowser</h1>
        <form onSubmit={onSubmit} className="space-y-4 rounded-lg bg-dusty-grape/40 p-5">
          <label className="block">
            <span className="text-sm text-lilac-ash">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded border border-lilac-ash/40 bg-space-indigo p-2"
            />
          </label>
          <label className="block">
            <span className="text-sm text-lilac-ash">Keyword</span>
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="Thinkpad T14s gen 6"
              className="mt-1 w-full rounded border border-lilac-ash/40 bg-space-indigo p-2"
            />
          </label>
          <label className="block">
            <span className="text-sm text-lilac-ash">Criteria</span>
            <textarea
              value={criteriaText}
              onChange={(e) => setCriteriaText(e.target.value)}
              rows={4}
              placeholder="32gb ram, Ryzen, 1tb, touch screen, under u$s 1600"
              className="mt-1 w-full rounded border border-lilac-ash/40 bg-space-indigo p-2"
            />
          </label>
          <button
            type="submit"
            className="rounded bg-almond-silk px-4 py-2 font-medium text-space-indigo disabled:opacity-40"
            disabled={!name.trim() || !keyword.trim()}
          >
            Save search
          </button>
          {error && <p className="text-sm text-almond-silk">Error: {error}</p>}
        </form>
      </section>

      <section>
        <h2 className="mb-4 text-lg text-lilac-ash">Saved searches</h2>
        {searches.length === 0 ? (
          <p className="text-lilac-ash/70">Nothing saved yet.</p>
        ) : (
          <ul className="space-y-3">
            {searches.map((s) => (
              <li key={s.id} className="rounded border border-lilac-ash/30 p-4">
                <p className="font-medium text-almond-silk">{s.name}</p>
                <p className="text-sm text-lilac-ash">{s.keyword}</p>
                {s.criteriaText && (
                  <p className="mt-2 text-sm text-lilac-ash/80">{s.criteriaText}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
```

`web/src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/tokens.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

`web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>jevbrowser</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Run it and verify the acceptance criteria by hand**

Run: `npm run dev`
Then, in the browser at `http://localhost:5173`:

1. Save a search using the spec's example — name "ThinkPad T14s Gen 6", keyword
   "Thinkpad T14s gen 6", criteria "32gb ram, Ryzen, 1tb, touch screen, under u$s 1600".
2. **Reload the page.** The search is still listed — it came from SQLite, not React state.
3. Resize the window narrow and wide: the layout stacks, then splits into two columns.
4. Confirm `data/jevbrowser.db` exists on disk.

- [ ] **Step 5: Confirm the palette is defined in exactly one place**

Run: `grep -rn '#[0-9a-fA-F]\{6\}' web/src --include=*.tsx --include=*.ts`
Expected: **no matches.** Hex values live only in `tokens.css`; everything else uses palette
utility names. If this prints anything, replace those literals with the utility class.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass (17 total: 10 from Stage 0 plus 7 new), no type errors.

- [ ] **Step 7: Checkpoint — Stage 1 acceptance**

Report against the acceptance criteria: the search survives a reload, the palette is defined once,
tests and typecheck are clean. **Stop for review.**

---

---

## Stage 2 — Scraper reads eBay search results

**Goal:** Playwright opens ebay.com, applies native filters, sets a US ZIP, reads up to the page
cap of result cards, stores them, and streams events to the page live.

**Deliverable:** start a run and watch result cards appear in a table in real time.

**Already done during Stage 1:** `playwright@1.63.0` is installed and
`npx playwright install chromium` has been run. The pre-existing browser cache held revision 1234
from an older Playwright and does not match; revision 1243 is now present. Anyone setting this up
on another machine must run `npx playwright install chromium`.

---

### Reconnaissance findings (2026-09-18)

These were established by probing the live site, not from documentation. They are the most
expensive knowledge in this plan — do not replace them with guesses.

**1. The browser must be VISIBLE. Headless is blocked.**

Measured with `scripts/probe-access.ts` against one search URL:

| Configuration | HTTP status |
|---|---|
| bundled Chromium, headless, default UA | **403** |
| bundled Chromium, headless, desktop UA | **403** |
| bundled Chromium, **headed** | 200 — 62 cards |
| real Chrome, headless, default UA | **403** |
| real Chrome, headless, desktop UA | 200 — 62 cards |
| real Chrome, headed | 200 — 62 cards |

403 returns a generic eBay error page with a reference id — not a captcha. `headless: false` is a
requirement, not a preference. Decision 6's visible-browser default is now evidence-backed.

**2. Verified working, driven purely by URL parameters.**

- Search: `https://www.ebay.com/sch/i.html?_nkw=<urlencoded keyword>`
- Shipping location: `&_stpos=<ZIP>&_sadis=200` — the page then shows "Shipping to: <ZIP>", and
  the **persistent profile remembers it** across runs. Results genuinely differ.
- Price: `&_udlo=<min>&_udhi=<max>` — verified: max price went from $2,299 to **$1,599.95**, zero
  items over the cap.

**3. Verified NOT to work as URL parameters.**

- `LH_ItemCondition=<code>` — ignored. With it applied, max price jumped to $15,999 and results
  went *up*, not down.
- `LH_BIN=1` — ignored.
- Aspect filters `RAM Size=` and `Features=Touchscreen` — unreliable. One returned 0 items,
  another returned *more* items than the baseline.

**Design decision taken from finding 3:** condition is **not** filtered on eBay at all. JEV's
`condition_ok` question handles it instead. This removes the most fragile part of the scraper —
eBay's sidebar filters are not plain checkboxes (`input[type=checkbox]` count is 0), so driving
them would mean custom selectors against the most changeable markup on the page. It also gives a
better answer, because JEV can distinguish eBay Refurbished from seller refurbished from
"New (other)", which eBay's own filter cannot express.

**4. Result cards.** Container is `li.s-card` carrying `data-listingid` (the eBay item id) and
`data-viewport`. Fields:

| Field | Selector |
|---|---|
| title | `.s-card__title` — strip the trailing `Opens in a new window or tab` from `.clipped` |
| price | `.s-card__price` |
| condition | `.s-card__subtitle` — **unreliable, see finding 6** |
| shipping / format / watchers | `.s-card__attribute-row` (3–5 per card) |
| seller + feedback | `.su-card-container__attributes__secondary .s-card__attribute-row` |
| url | `a.s-card__link` — **5 per card**, the title one is inside `.su-card-container__header` |

**5. Two traps on every results page.**

- **The first two cards are placeholders** — title `"Shop on eBay"`, price `$20.00`, and an href
  matching `/itm/123456`. Reading the first N cards blindly ingests them. Filter on a real item id
  (`/itm/\d{9,}` and not `123456`).
- **"Sponsored" is hidden.** eBay renders it backwards (`derosnopS`), colour-transparent, behind a
  base64 background image in `.s-card__sep b`. Text matching for "Sponsored" returns 0. Detect via
  the presence of `.s-card__sep b`. Note: in the captured sample all 62 cards had this element, so
  treat the flag as provisional and surface it in the UI rather than trusting it silently.

**6. `.s-card__subtitle` is not reliably the condition.** On some cards it holds the condition
("Brand New"); on others it holds item specifics ("Lenovo · 512 GB"). Extract it, then match
against eBay's condition vocabulary — `Brand New`, `Open Box`, `Certified - Refurbished`,
`eBay Refurbished`, `Pre-Owned`, `Used`, `For parts or not working` — and leave it null when
nothing matches, rather than recording junk as fact. A null condition is honest input for JEV.

**7. The search is genuinely polluted.** Page one of "Thinkpad T14s gen 6" is largely laptop
replacement keyboards and palmrests at ~$34. This is exactly what `is_target_product` exists to
catch.

**8. Fixture captured.** `tests/fixtures/ebay/srp-results.html` — the real `ul.srp-results`
element from a live page, 62 cards, 479 KB, no scripts, self-contained. Card extraction is tested
against it with `page.setContent()`: real DOM, real code path, no network.

**9. Recon tools kept for reuse:** `scripts/probe-access.ts` (the headless matrix) and
`scripts/recon-ebay.ts` (fetch a page, dump HTML + screenshot + selector counts). Both are useful
again in Stage 8 when eBay changes something.

---

### Task list

- **2.1** Search URL builder + browser launcher (pure function tested; launcher smoke-tested)
- **2.2** Card extraction from the fixture (the highest-value, most testable task)
- **2.3** Storage for runs / listings / events, and the run pipeline with paced pagination
- **2.4** SSE endpoint and the live results table

Each task follows the same shape as Stage 0: write the failing test, run it and watch it fail,
write the minimum implementation, run it and watch it pass, then a checkpoint.

**Interfaces produced for later stages** (names fixed now, used verbatim from here on):

```ts
// src/scraper/url.ts
export interface SearchUrlOptions {
  keyword: string
  zip: string
  minPrice?: number
  maxPrice?: number
  page?: number          // 1-based
}
export function buildSearchUrl(o: SearchUrlOptions): string

// src/scraper/cards.ts
export interface RawCard {
  itemId: string
  title: string
  url: string
  price: number | null
  shipping: number | null
  currency: string
  conditionLabel: string | null
  sellerName: string | null
  sellerFeedback: string | null
  watchers: number | null
  buyingFormat: string | null
  isSponsored: boolean
  rawText: string[]
}
export function extractCards(page: Page): Promise<RawCard[]>

// src/scraper/browser.ts
export interface LaunchOptions { profileDir: string; headed: boolean }
export function launchBrowser(o: LaunchOptions): Promise<BrowserContext>
export function pace(): Promise<void>   // randomized 1.5–3s delay

// src/pipeline/events.ts
export type RunEventType =
  | 'run.started' | 'run.finished' | 'run.failed' | 'run.cancelled'
  | 'page.fetched' | 'cards.extracted' | 'run.progress' | 'error'
export interface RunEvent { seq: number; at: string; type: RunEventType; payload: unknown }
```

**Stage 2 acceptance:** a run against the fixture extracts all 62 cards with the two placeholders
rejected and `data-listingid` captured as `itemId`; a live run streams real cards into the page as
they are fetched, paced and headed; an unexpected page state raises an explicit error with a
screenshot instead of returning an empty list.

**Files:**

- `src/scraper/browser.ts` — launch with persistent profile, pacing
- `src/scraper/search.ts` — build the search URL, apply filters, set the ZIP
- `src/scraper/cards.ts` — read result cards
- `src/pipeline/run.ts`, `src/pipeline/events.ts`
- `src/server/routes/runs.ts` (incl. the SSE endpoint)
- `src/server/routes/events.ts`
- `tests/fixtures/ebay/*.html`, `tests/scraper/*.test.ts`

**Acceptance:** a run against a saved fixture extracts the expected cards in a test; a live run
streams real cards into the page; any unexpected page state raises an explicit error and writes a
screenshot rather than returning an empty list.

**Note:** the spec's open items 3 and 4 (eBay's exact filter labels, and whether Touchscreen is a
usable item-specific) get resolved here, using the Playwright MCP server as a research aid.

---

## Stage 3 — Code pre-filter

**Goal:** reject listings on price and on spec parseable from the card title, before JEV sees them.

**Deliverable:** rejected listings visible in the UI alongside their reject reasons.

**Files:** `src/pipeline/prefilter.ts`, `src/shared/parse.ts` (price and spec parsing from
titles), tests for both against real messy eBay titles.

**Acceptance:** given the spec's example criteria, a card titled with a Ryzen 5 and 16GB is
rejected with a reason naming the failure; a matching card survives. Pure unit tests, no network.

---

## Stage 4 — Listing detail extraction

**Goal:** open only the survivors and read the Item Specifics table, shipping and seller.

**Deliverable:** an expandable detail panel per survivor showing the captured fields.

**Files:** `src/scraper/listing.ts`, fixtures and tests for it.

**Acceptance:** against a saved listing fixture, the item specifics parse into named fields; a
timed-out listing is marked `detail_failed` and still reaches judgment on card data alone.

---

## Stage 5 — JEV judgments wired in

**Goal:** build the six questions for all survivors, chunk them into batches, call JEV, store
every answer, and stream answers to the page as they arrive.

**Deliverable:** real JEV probabilities appearing live, per listing, during a run.

**Files:** `src/jev/questions.ts`, `src/jev/batch.ts`, `src/storage/judgments.ts`,
`src/storage/questionnaires.ts`, `src/pipeline/judge.ts`, tests using `createFakeJevClient`.

**Acceptance:** with the fake client, a 25-survivor run makes 3 requests of 10/10/5 and stores 150
judgments; with the real client, answers stream in live and token usage plus estimated cost are
displayed for the run.

---

## Stage 6 — Report and controls

**Goal:** turn stored judgments into the report — weights, thresholds, sorting, expansion, export,
seller-trust marking and best-item highlighting.

**Deliverable:** the app you actually wanted: a ranked list of matching listings with URLs, and
sliders that change the ranking instantly.

**Files:** `web/src/components/ReportTable.tsx`, `.../WeightControls.tsx`, `.../AnswerDetail.tsx`,
`.../SellerBadge.tsx`, `web/src/lib/score.ts` (composition — mirrors the server's rules),
`web/src/lib/sellerTrust.ts`, `web/src/lib/export.ts`

**Features added 2026-09-18 (spec §5.6.1 and §5.6.2):**

- **Seller trust marking**, three tiers. Parse the percentage and count out of the stored feedback
  string (`"99.1% positive (17K)"`). Then: exactly 100% **and** count ≥ 100 → solid badge; exactly
  100% with count < 100 → faded badge; below 100% → no badge. The review count is shown beside the
  badge in every tier. Parsing must handle `17K` / `2.8K` / `1,234` forms and return null rather
  than guessing when the string is unexpected.
- **Best-item highlighting** as a threshold on the blended score, with its own control. Gates
  apply first — an item failing `is_target_product` or `condition_ok` can never be highlighted.
- **Shipping scored in absolute dollars**, inverted and bounded: free and cheapest rate highest,
  most expensive lowest, with the scale taken from the spread of shipping costs in the current run
  so the slider stays meaningful on both $0–$20 and $0–$200 ranges. Free shipping is a bonus, not
  merely zero.

**Acceptance:** moving a weight or a threshold re-sorts the table with **zero** network requests
(verify in the browser's network tab); each row expands to show raw answers, probabilities and
confidence; CSV and JSON export contain the URL of every matching listing; low-confidence
judgments near 0.5 are visibly flagged; a seller at 100% with 3 reviews is visually distinguishable
from one at 100% with 17,000; highlighting a threshold marks a sensible subset, never an item that
failed a gate.

---

## Stage 7 — Persistence, re-open, re-judge

**Goal:** saved searches are re-runnable and past runs re-openable; questions can be edited and
re-asked without scraping again.

**Deliverable:** reopen yesterday's run, change the questions, re-judge, and compare.

**Files:** `src/storage/runs.ts`, `src/server/routes/rejudge.ts`, `web/src/components/RunList.tsx`,
`web/src/components/QuestionEditor.tsx`

**Acceptance:** re-judging a stored run makes no browser navigation at all (assert on the fake
scraper's call count); a new questionnaire version is created; answers from the previous version
remain readable and comparable.

---

## Stage 8 — Hardening

**Goal:** survive the real world.

**Deliverable:** a run that handles a bot challenge, a markup change, a cancellation and a JEV
outage without losing data or lying about it.

**Files:** `src/pipeline/errors.ts`, `src/scraper/challenge.ts`, screenshot capture,
`src/server/routes/cancel.ts`, plus a fixtures-based regression test that fails loudly when eBay's
markup changes.

**Acceptance:** each of the four failures in the spec's §11 table is triggered deliberately in a
test and produces an event, a screenshot where relevant, and no silent empty result.

---

## Stage 3 — code pre-filter (complete 2026-09-21)

**Goal and acceptance, as written above, are met.** 150 tests passing, typecheck clean on both
projects.

**What was built**

- `src/shared/parse.ts` — `parseRamGb`, `parseStorageGb`, `parseTouch`, `parseCpuVendor`. Each
  returns null rather than a guess. Capacities snap to real values (RAM in 4…128GB, disk in
  64GB…8TB), which is what stops `T14s Gen 6` and `21TB000EUS` being read as capacity. RAM and disk
  are told apart by label proximity first, then by magnitude for a bare pair like `32GB 512GB`.
  `parseTouch` checks `non-touch` before `touch`, because `Non-Touch` contains `Touch`.
- `src/pipeline/prefilter.ts` — `prefilter(listing, requirements)` and
  `requirementsFromSpec(spec)`. Fixed rule order (price, RAM, storage, touch, vendor), first
  failure wins, every reason naming both sides.
- Requirements come from structured form fields on the search (`max_price`, `ram_gb`,
  `storage_gb`, `touch`, `cpu_family`), not from the criteria prose. `spec_json` was `{}` for every
  saved search before this, so there was nothing to filter on.
- `cards.filtered` event, `rejected` run stat, and a collapsed **Filtered out (N)** table in
  `RunView.tsx` showing each rejected listing with its reason. Rejected rows are stored with
  `stage: 'rejected'` so the reason survives a refresh.
- `tests/server-events-stream.test.ts` — new guard for live SSE push at the HTTP layer.

**The governing rule: only a contradiction rejects.** A missing price, an unreadable spec or an
ambiguous title survives to JEV. A rejected listing is never seen again, so a wrong reject cannot be
recovered downstream — the cost of this filter is JEV calls, and the cost of being wrong is silent.

**Bug found and fixed while wiring the price rule.** `parseShipping` read the first number in the
`join`ed attribute rows. The first row of every card is the item's own price, so every
paid-shipping card stored its price as its shipping cost — 59 of 60 fixture cards, 11 of 60 in a
live run. Free-shipping cards escaped because that branch returns 0 first. Now parsed row by row,
with a fixture-level guard. Run 7's stored shipping is wrong; nothing re-reads it yet.

**Deviations worth knowing:** the two pure parsers were written test-first; `web/src/lib/spec.ts`
was written then tested, and its first version used `toLocaleString`, which does not group on this
machine — both sides now group by hand.

## Stage 4 — listing detail extraction (complete 2026-09-21)

**What was built**

- `src/scraper/listing.ts` — `extractDetail(page)`, `parseDetail(fields)`,
  `parseShippingValue`, `extractSpecifics`. Same split as `cards.ts`: DOM reading produces plain
  `DetailFields`, and `parseDetail` maps them with no browser involved.
- `PageSource` gained `readListing()`. The pipeline visits survivors after the results-page loop,
  in card order (eBay's relevance order), capped by `maxDetailVisits` (new `DEFAULTS` value, 20).
- `listing.visited` event, `detailsFetched` / `detailsFailed` stats, stored in `raw_detail_json`
  and exposed as `StoredListing.detail`. Card fields are never overwritten.
- `RunView.tsx` rows expand into a `ListingDetailPanel` showing the specifics as label/value
  pairs, plus condition and seller from the page.

**Failure policy, which is the delicate part.** One listing whose page will not read is marked
`detail_failed`, gets an `error` event, and still reaches JEV on its card data. Three in a row is
not bad luck — that is a markup change, so the run fails loudly with a screenshot.

**Recon findings (2026-09-21), established by probing a real listing page.** Item specifics is a
`<dl>` of alternating `dt.ux-labels-values__labels` / `dd.ux-labels-values__values`; title is
`h1.x-item-title__mainTitle`; price `.x-price-primary`; condition `.x-item-condition-text`; seller
`.x-sellercard-atf`; shipping is the label/value pair labelled `Shipping`, whose value reads
"Free FedEx Ground…" or a price. Two traps: `N\A` is eBay's literal placeholder for an unknown
field, and the `Condition` row is a paragraph of boilerplate. Both are dropped rather than stored.

**Deviations and things fixed mid-stage**

- Playwright's default 30s wait per locator meant six missing fields would stall a run for three
  minutes; every read is now bounded at 1s.
- `RunView` did not listen for `listing.visited` and `run.finished` refreshed only the run, not the
  listings — so the specifics stayed invisible until a reload. The browser repro caught it. The
  table now re-reads both from the server on any event that changes either.
- `runner-live` and `server-events-stream` tests run with `maxDetailVisits: 0`: they cover live
  delivery, and a real detail visit paces for seconds per listing.

**Fixtures and tools**

- `tests/fixtures/ebay/listing-t14s.html` — 16.8 KB, the real nodes the parser reads.
- `scripts/recon-listing.ts` — probe one listing page; `scripts/build-listing-fixture.ts` —
  rebuild the fixture from a fresh capture when eBay changes its layout.

## Handoff — state at end of 2026-09-21

**Working and verified:** Stages 0–4 complete.

- 173 tests passing, `tsc --noEmit` clean on both the server and web projects.
- Live scraping verified repeatedly; three runs on 2026-09-21 (60 listings each).
- The live-table bug reported on 2026-09-18 **does not reproduce** — see `CLAUDE.md` rule 13 for the
  likeliest cause and `tests/server-events-stream.test.ts` for the new guard.
- A browser-level repro that needs no eBay: `node --import tsx scripts/repro-live-ui.ts` (start
  `npm run dev:web` first). It drives the real UI with a real Playwright page over the captured
  fixtures, prints which `EventSource` listeners fired, and shows a survivor's detail panel. It has
  already caught one real defect that no unit test could.

**Unfinished — pick up here next session:**

1. **The sponsored marker is still a known defect.** `.s-card__sep b` is present on every card, so
   it carries no signal — a live run flagged 113 of 113. The field is retained as a raw observation
   but is deliberately not displayed. Find the real discriminator before surfacing it.

2. **Stage 5 (JEV judgments) is next.** Everything it needs is now stored: `stage: 'survivor'`
   selects the listings, and `detail.specifics` carries the item specifics to reason over. The
   six questions are sketched in spec §5.5 and the questionnaire table; batching rules are in
   spec §8 (one call, ~12x cheaper than separate calls) with `batchSize` from `DEFAULTS`.

3. **Only one listing page has ever been parsed.** The fixture is a single item; labels vary
   between listings, so a second capture from a different seller would harden the label handling
   before Stage 5 depends on it.

4. **eBay rate-limits by volume.** After roughly 50 page loads in a day, a run returned HTTP 403
   with the standard error page. Detail visits spend the same budget — hence `maxDetailVisits`.

**Note for Stage 6:** shipping is scored in absolute dollars there, and it now actually means
shipping. Runs stored before 2026-09-21 have prices in the shipping column.

## Self-review

**Spec coverage:** every functional requirement in spec §5 maps to a stage — search definition
(1), scraping (2), pre-filter (3), listing detail (4), JEV judgments (5), report (6), persistence
(7), live view (2 and 5). Error handling (§11) and the robustness decisions (§9.2) are Stage 8,
with the persistent profile and pacing built into Stage 2 where they belong. Testing (§13) is
distributed through every stage rather than deferred. The two genuinely unknown items (§15.1
pricing, §15.5 SDK helper exports) are handled as explicit verification steps in Stage 0 rather
than assumed.

**Placeholder scan:** Stage 0 contains no placeholders — every step has real code or a real
command. Stages 1–8 are deliberately listed as goal/deliverable/acceptance rather than detailed
tasks; that is the staging the user asked for, not an omission, and each gets its task list
written when we start it.

**Type consistency:** `JevClient`, `JevRequest`, `JevResult`, `JevAnswer`, `JevUsage`,
`createJevClient`, `createFakeJevClient`, `FakeJevClient.calls`, `RunSettings`, `DEFAULTS`,
`PRICING`, `estimateCostUsd` and `requireApiKey` are named once in Stage 0 and reused verbatim
in later stages. Stage 5's batching test assumes `batchSize` from `DEFAULTS`, and Stage 6's
composition mirrors the thresholds in the Global Constraints.
