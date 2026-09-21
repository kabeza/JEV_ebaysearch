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
