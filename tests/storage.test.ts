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
