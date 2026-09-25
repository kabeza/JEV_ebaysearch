import type { Database as SqliteDatabase } from 'better-sqlite3'

/**
 * What the search is looking for. These are the pre-filter's requirements, so
 * they are stated as wants rather than facts: `ram_gb: 32` means "at least
 * 32GB", not "exactly 32GB". `cpu_family` is free text and only becomes a
 * requirement when a single vendor can be read out of it.
 */
export interface SearchSpec {
  cpu_family?: string
  ram_gb?: number
  storage_gb?: number
  touch?: boolean
  max_price?: number
  min_price?: number
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

/**
 * The buyer's half of a question set, in the search's own terms. Deliberately not
 * `SearchRequest`: that lives in `jev/` and carries the SDK's vocabulary, and
 * storage has no business importing it.
 */
export interface SearchRequestFields {
  criteriaText: string
  spec: SearchSpec
  maxPrice?: number
  acceptedConditions: string[]
}

/**
 * The `spec_json` to store for a request — one bag holding everything the readers
 * look for.
 *
 * A `SearchRequest` states the budget twice: `max_price` at the top level, which
 * is what `spec_match` and `price_value` quote to JEV, and `spec.max_price`, which
 * is what `requirementsFromSpec` turns into the pre-filter's price rule and what
 * `runner.ts` puts in the URL's `_udhi`. The question editor only edits the
 * top-level one, so writing a spec back without this mirror would leave the
 * pre-filter and the eBay URL still ignoring the budget a person just set.
 *
 * The accepted conditions are here for the same reason: `searches` has no column
 * for them, and `spec` is already the free-form bag — `requirementsFromSpec`
 * ignores the keys it does not know.
 */
/** The half of a request that lands in `spec_json` — everything but the words. */
export type SpecFields = Pick<SearchRequestFields, 'spec' | 'maxPrice' | 'acceptedConditions'>

export function specForSearch(fields: SpecFields): SearchSpec {
  const spec: SearchSpec = {
    ...fields.spec,
    accepted_conditions: fields.acceptedConditions,
  }
  if (typeof fields.maxPrice === 'number') spec.max_price = fields.maxPrice
  return spec
}

/**
 * Writes the buyer's half of a question set back onto the search, so the next
 * fresh run pre-filters on it and asks JEV about it instead of starting from
 * `spec: {}` and "no particular specification".
 *
 * The keyword is left alone: the question editor does not edit it, so writing it
 * would only risk losing a change made elsewhere.
 */
export function updateSearchRequest(
  db: SqliteDatabase,
  id: number,
  fields: SearchRequestFields,
): void {
  db.prepare(
    `update searches set criteria_text = ?, spec_json = ?, updated_at = datetime('now')
      where id = ?`,
  ).run(fields.criteriaText, JSON.stringify(specForSearch(fields)), id)
}
