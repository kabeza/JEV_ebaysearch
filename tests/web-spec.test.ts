import { describe, it, expect } from 'vitest'
import { EMPTY_SPEC_FORM, specFromForm, summariseSpec } from '../web/src/lib/spec'
import { ramGbOf, storageGbOf } from '../web/src/lib/capacity'
import type { Listing } from '../web/src/lib/api'

/**
 * The form is where requirements are chosen, so this is where a blank field
 * could quietly become a real requirement. Blank must stay blank: a `0` would
 * reject every listing in the run.
 */
describe('specFromForm', () => {
  it('produces an empty spec from an untouched form', () => {
    expect(specFromForm(EMPTY_SPEC_FORM)).toEqual({})
  })

  it('keeps only the fields that were filled in', () => {
    expect(specFromForm({ ...EMPTY_SPEC_FORM, ramGb: '32' })).toEqual({ ram_gb: 32 })
  })

  it('treats whitespace, zero and nonsense as no requirement', () => {
    expect(specFromForm({ ...EMPTY_SPEC_FORM, maxPrice: '   ' })).toEqual({})
    expect(specFromForm({ ...EMPTY_SPEC_FORM, maxPrice: '0' })).toEqual({})
    expect(specFromForm({ ...EMPTY_SPEC_FORM, storageGb: 'lots' })).toEqual({})
  })

  it('records touch only when the box is ticked', () => {
    expect(specFromForm({ ...EMPTY_SPEC_FORM, touch: false })).toEqual({})
    expect(specFromForm({ ...EMPTY_SPEC_FORM, touch: true })).toEqual({ touch: true })
  })

  it('builds a complete spec', () => {
    expect(
      specFromForm({
        maxPrice: '1600',
        ramGb: '32',
        storageGb: '1000',
        touch: true,
        cpuFamily: 'AMD Ryzen',
      }),
    ).toEqual({ max_price: 1600, ram_gb: 32, storage_gb: 1000, touch: true, cpu_family: 'AMD Ryzen' })
  })
})

describe('summariseSpec', () => {
  it('says nothing for an empty spec, so the UI can say "nothing pre-filtered"', () => {
    expect(summariseSpec({})).toBeNull()
  })

  it('reads storage in the unit a person would say it in', () => {
    expect(summariseSpec({ storage_gb: 1024 })).toBe('1TB+ storage')
    expect(summariseSpec({ storage_gb: 512 })).toBe('512GB+ storage')
  })

  it('groups a max price for legibility', () => {
    expect(summariseSpec({ max_price: 1600 })).toBe('up to $1,600')
  })

  it('lists every requirement in one line', () => {
    expect(
      summariseSpec({ max_price: 1600, ram_gb: 32, storage_gb: 1024, touch: true, cpu_family: 'AMD Ryzen' }),
    ).toBe('up to $1,600 · 32GB+ RAM · 1TB+ storage · touchscreen · AMD Ryzen')
  })

  it('ignores a touch flag that is not true', () => {
    expect(summariseSpec({ touch: false })).toBeNull()
  })
})

const listing = (over: Partial<Listing>): Listing => ({
  id: 1,
  itemId: '1',
  title: 'Lenovo ThinkPad T14s Gen 6',
  url: 'https://www.ebay.com/itm/1',
  price: 1200,
  shipping: 0,
  conditionLabel: 'Open Box',
  sellerName: 'store',
  sellerFeedback: '100% positive (450)',
  watchers: null,
  buyingFormat: 'Buy It Now',
  sponsoredMarker: false,
  stage: 'survivor',
  rejectReason: null,
  detail: null,
  ...over,
})

describe('capacity columns', () => {
  it('reads the capacity the title states', () => {
    const row = listing({ title: 'Lenovo ThinkPad T14s 32GB RAM 1TB SSD' })
    expect(ramGbOf(row)).toBe(32)
    expect(storageGbOf(row)).toBe(1024)
  })

  it('answers null, never zero, when the title states nothing', () => {
    // The pre-filter treats a missing capacity as survivable, not as a
    // contradiction; the column must not turn that silence into a `0`, which
    // would read as "no RAM at all".
    const row = listing({ title: 'Lenovo ThinkPad T14s Gen 6' })
    expect(ramGbOf(row)).toBeNull()
    expect(storageGbOf(row)).toBeNull()
  })

  it('agrees with the pre-filter about a title that contradicts a floor', () => {
    // Both read `parseRamGb`, which is the point: a row shown as 16GB is one the
    // pre-filter would have rejected against a 32GB floor.
    const row = listing({ title: 'Lenovo ThinkPad T14s 16GB RAM 512GB SSD' })
    expect(ramGbOf(row)).toBe(16)
    expect(storageGbOf(row)).toBe(512)
  })

  it('ignores item specifics on purpose', () => {
    // Rule 15: their labels vary per listing, and the pre-filter never reads them.
    // A column derived any other way could claim a capacity the filter disagreed
    // with. The specifics stay readable in the row's expanded panel.
    const row = listing({
      title: 'Lenovo ThinkPad T14s Gen 6',
      detail: {
        title: 'Lenovo ThinkPad T14s Gen 6',
        price: 1200,
        shipping: 0,
        condition: 'Open Box',
        sellerName: 'store',
        sellerFeedback: '100% positive (450)',
        specifics: { 'RAM Size': '64 GB' },
        rawText: [],
      },
    })
    expect(ramGbOf(row)).toBeNull()
  })
})
