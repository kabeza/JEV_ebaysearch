import { describe, it, expect } from 'vitest'
import { prefilter, requirementsFromSpec, type Requirements } from '../src/pipeline/prefilter'
import type { RawCard } from '../src/scraper/cards'

function listing(title: string, price: number | null = 1000, shipping: number | null = 0): RawCard {
  return {
    itemId: '123456789',
    title,
    url: 'https://www.ebay.com/itm/123456789',
    price,
    shipping,
    currency: 'USD',
    conditionLabel: 'Brand New',
    sellerName: 'store',
    sellerFeedback: '99% positive (1K)',
    watchers: 1,
    buyingFormat: 'Buy It Now',
    sponsoredMarker: false,
    rawText: [],
  }
}

const TARGET = 'Lenovo ThinkPad T14s Gen 6 14" WUXGA 32GB RAM 1TB SSD AMD Ryzen 7'

describe('prefilter', () => {
  it('keeps everything when no requirements are set', () => {
    const d = prefilter(listing('Anything at all'), {})
    expect(d.stage).toBe('survivor')
    expect(d.reason).toBeNull()
  })
})

describe('prefilter: price', () => {
  it('rejects a listing over the limit, naming both prices', () => {
    const d = prefilter(listing(TARGET, 1300), { maxPrice: 1200 })
    expect(d.stage).toBe('rejected')
    expect(d.reason).toBe('$1,300.00 + $0.00 shipping is over the $1,200 limit')
  })

  it('counts shipping towards the limit, and shows it as the culprit', () => {
    // Price alone is under the limit; shipping is what pushes it over, so the
    // reason shows both parts rather than only the total.
    const d = prefilter(listing(TARGET, 1190, 25), { maxPrice: 1200 })
    expect(d.stage).toBe('rejected')
    expect(d.reason).toBe('$1,190.00 + $25.00 shipping is over the $1,200 limit')
  })

  it('keeps a listing exactly at the limit', () => {
    expect(prefilter(listing(TARGET, 1200), { maxPrice: 1200 }).stage).toBe('survivor')
  })

  it('keeps a listing whose price could not be read', () => {
    expect(prefilter(listing(TARGET, null), { maxPrice: 1200 }).stage).toBe('survivor')
  })
})

describe('prefilter: spec', () => {
  it('rejects RAM below the minimum, naming both sides', () => {
    const d = prefilter(listing('ThinkPad T14s Gen 6 16GB RAM 512GB SSD'), { minRamGb: 32 })
    expect(d.stage).toBe('rejected')
    expect(d.reason).toBe('16GB RAM, wanted at least 32GB')
  })

  it('keeps RAM above the minimum', () => {
    expect(prefilter(listing('ThinkPad T14s Gen 6 64GB RAM 1TB SSD'), { minRamGb: 32 }).stage).toBe(
      'survivor',
    )
  })

  it('rejects storage below the minimum', () => {
    const d = prefilter(listing('ThinkPad T14s Gen 6 32GB RAM 256GB SSD'), { minStorageGb: 512 })
    expect(d.stage).toBe('rejected')
    expect(d.reason).toBe('256GB storage, wanted at least 512GB')
  })

  it('rejects a non-touch listing when touch was required', () => {
    const d = prefilter(listing('ThinkPad T14s Gen 6 32GB RAM 1TB SDD Non-Touch'), {
      requireTouch: true,
    })
    expect(d.stage).toBe('rejected')
    expect(d.reason).toBe('listed as non-touch')
  })

  it('rejects a Snapdragon listing when AMD was asked for', () => {
    const d = prefilter(listing('ThinkPad T14s Gen 6 Snapdragon X Elite 32GB 1TB'), {
      cpuVendor: 'amd',
    })
    expect(d.stage).toBe('rejected')
    expect(d.reason).toBe('Qualcomm, wanted AMD')
  })

  it('keeps a listing matching the vendor', () => {
    expect(prefilter(listing(TARGET), { cpuVendor: 'amd' }).stage).toBe('survivor')
  })

  // The safety property the whole design rests on: a title that stays silent
  // cannot be contradicted, so it must survive to JEV. A wrong reject here is
  // unrecoverable — no later stage ever sees the listing.
  describe('never rejects on silence', () => {
    const quiet = listing('Lenovo ThinkPad T14s Gen 6 Laptop, WUXGA, Win 11 Pro')

    it('keeps a title with no readable spec', () => {
      const d = prefilter(quiet, {
        minRamGb: 64,
        minStorageGb: 2048,
        requireTouch: true,
        cpuVendor: 'amd',
      })
      expect(d.stage).toBe('survivor')
    })

    it('keeps an ambiguous two-capacity title rather than guessing', () => {
      const d = prefilter(listing('ThinkPad T14s Gen 6 8GB 16GB'), { minRamGb: 32 })
      expect(d.stage).toBe('survivor')
    })

    it('keeps a title whose touch state is unstated', () => {
      expect(prefilter(quiet, { requireTouch: true }).stage).toBe('survivor')
    })
  })

  it('reports the first failure only, in a stable order', () => {
    // Over price AND under RAM AND non-touch: price is reported.
    const d = prefilter(listing('ThinkPad T14s Gen 6 16GB RAM 512GB SSD Non-Touch', 1500), {
      maxPrice: 1200,
      minRamGb: 32,
      requireTouch: true,
    })
    expect(d.stage).toBe('rejected')
    expect(d.reason).toContain('over the $1,200 limit')
  })
})

describe('requirementsFromSpec', () => {
  it('maps a fully specified search', () => {
    expect(
      requirementsFromSpec({
        max_price: 1200,
        ram_gb: 32,
        storage_gb: 512,
        touch: true,
        cpu_family: 'AMD Ryzen',
      }),
    ).toEqual({ maxPrice: 1200, minRamGb: 32, minStorageGb: 512, requireTouch: true, cpuVendor: 'amd' })
  })

  it('returns nothing for an empty spec, so nothing can be contradicted', () => {
    expect(requirementsFromSpec({})).toEqual({})
  })

  it('reads the vendor out of a free-text cpu_family', () => {
    expect(requirementsFromSpec({ cpu_family: 'Intel Core Ultra' }).cpuVendor).toBe('intel')
    expect(requirementsFromSpec({ cpu_family: 'Snapdragon X Elite' }).cpuVendor).toBe('qualcomm')
  })

  it('drops a cpu_family it cannot place rather than guessing', () => {
    expect(requirementsFromSpec({ cpu_family: 'whatever is fastest' })).toEqual({})
  })

  it('treats touch: false as "not required", not as "must not have touch"', () => {
    expect(requirementsFromSpec({ touch: false })).toEqual({})
  })

  it('ignores keys of the wrong type instead of throwing', () => {
    expect(
      requirementsFromSpec({ ram_gb: 'lots', max_price: null, touch: 'yes' } as never),
    ).toEqual({})
  })
})

describe('prefilter: Requirements shape', () => {
  it('ignores undefined requirement fields', () => {
    const req: Requirements = { maxPrice: undefined, minRamGb: 16 }
    expect(prefilter(listing('ThinkPad 16GB RAM 512GB'), req).stage).toBe('survivor')
  })
})
