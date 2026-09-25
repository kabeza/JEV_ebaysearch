import { describe, it, expect } from 'vitest'
import { openDatabase } from '../src/storage/db'
import {
  createSearch,
  listSearches,
  getSearch,
  specForSearch,
  updateSearchRequest,
} from '../src/storage/searches'

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

describe('specForSearch', () => {
  it('mirrors the budget and the accepted conditions where the readers look', () => {
    // The budget is held twice in a `SearchRequest`: `max_price` at the top level,
    // which is what the questions quote to JEV, and `spec.max_price`, which is what
    // `requirementsFromSpec` filters on and what `_udhi` caps the eBay URL with.
    // The editor only edits the top-level one, so a spec written back without the
    // mirror would leave the pre-filter and the URL still ignoring the budget.
    const spec = specForSearch({
      spec: { ram_gb: 32 },
      maxPrice: 1600,
      acceptedConditions: ['Open Box', 'Certified - Refurbished'],
    })

    expect(spec).toEqual({
      ram_gb: 32,
      max_price: 1600,
      accepted_conditions: ['Open Box', 'Certified - Refurbished'],
    })
  })

  it('leaves an absent budget absent rather than writing null', () => {
    expect(specForSearch({ spec: { touch: true }, acceptedConditions: [] })).toEqual({
      touch: true,
      accepted_conditions: [],
    })
  })
})

describe('updateSearchRequest', () => {
  it('writes the buyer’s half back onto the search', () => {
    const db = openDatabase(':memory:')
    const created = createSearch(db, { ...input, spec: {} })

    updateSearchRequest(db, created.id, {
      criteriaText: '32gb ram, Ryzen',
      spec: { ram_gb: 32, storage_gb: 1024 },
      maxPrice: 1600,
      acceptedConditions: ['Open Box'],
    })

    const found = getSearch(db, created.id)!
    expect(found.criteriaText).toBe('32gb ram, Ryzen')
    expect(found.spec).toEqual({
      ram_gb: 32,
      storage_gb: 1024,
      max_price: 1600,
      accepted_conditions: ['Open Box'],
    })
  })

  it('leaves the keyword, the settings and the other searches alone', () => {
    const db = openDatabase(':memory:')
    const other = createSearch(db, { ...input, name: 'other' })
    const target = createSearch(db, { ...input, spec: {} })

    updateSearchRequest(db, target.id, {
      criteriaText: 'changed',
      spec: {},
      acceptedConditions: ['Used'],
    })

    const found = getSearch(db, target.id)!
    expect(found.keyword).toBe(input.keyword)
    expect(found.name).toBe(input.name)
    expect(found.settings).toEqual(input.settings)
    expect(getSearch(db, other.id)!.spec).toEqual(input.spec)
  })

  it('does nothing for an unknown search rather than throwing', () => {
    const db = openDatabase(':memory:')
    expect(() =>
      updateSearchRequest(db, 999, { criteriaText: 'x', spec: {}, acceptedConditions: [] }),
    ).not.toThrow()
  })
})
