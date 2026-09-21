import { describe, it, expect } from 'vitest'
import { EMPTY_SPEC_FORM, specFromForm, summariseSpec } from '../web/src/lib/spec'

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
