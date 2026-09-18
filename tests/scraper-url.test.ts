import { describe, it, expect } from 'vitest'
import { buildSearchUrl } from '../src/scraper/url'

describe('buildSearchUrl', () => {
  it('builds a keyword search on ebay.com', () => {
    const url = buildSearchUrl({ keyword: 'Thinkpad T14s gen 6', zip: '10001' })
    expect(url).toContain('https://www.ebay.com/sch/i.html')
    expect(url).toContain('_nkw=Thinkpad+T14s+gen+6')
  })

  it('url-encodes awkward keywords', () => {
    const url = buildSearchUrl({ keyword: 'ThinkPad X1 & "carbon"', zip: '10001' })
    expect(url).not.toContain('"')
    expect(url).toContain('_nkw=ThinkPad+X1+%26+%22carbon%22')
  })

  it('sets the shipping ZIP, which eBay only applies via _stpos + _sadis', () => {
    const url = buildSearchUrl({ keyword: 'thinkpad', zip: '10001' })
    expect(url).toContain('_stpos=10001')
    expect(url).toContain('_sadis=200')
  })

  it('omits the price bounds when none are given', () => {
    const url = buildSearchUrl({ keyword: 'thinkpad', zip: '10001' })
    expect(url).not.toContain('_udlo')
    expect(url).not.toContain('_udhi')
  })

  it('applies a verified price cap', () => {
    const url = buildSearchUrl({ keyword: 'thinkpad', zip: '10001', maxPrice: 1600 })
    expect(url).toContain('_udhi=1600')
  })

  it('applies both bounds when given', () => {
    const url = buildSearchUrl({ keyword: 'thinkpad', zip: '10001', minPrice: 200, maxPrice: 1600 })
    expect(url).toContain('_udlo=200')
    expect(url).toContain('_udhi=1600')
  })

  it('omits the page parameter on page 1, since eBay omits it too', () => {
    expect(buildSearchUrl({ keyword: 'thinkpad', zip: '10001', page: 1 })).not.toContain('_pgn')
  })

  it('adds the page parameter beyond page 1', () => {
    expect(buildSearchUrl({ keyword: 'thinkpad', zip: '10001', page: 3 })).toContain('_pgn=3')
  })

  it('defaults to 60 results per page', () => {
    expect(buildSearchUrl({ keyword: 'thinkpad', zip: '10001' })).toContain('_ipg=60')
  })

  it('never sets a condition parameter, because eBay ignores it', () => {
    // Verified live: LH_ItemCondition is ignored and returns MORE results.
    // Condition is judged by JEV's condition_ok question instead.
    const url = buildSearchUrl({ keyword: 'thinkpad', zip: '10001', maxPrice: 1600 })
    expect(url).not.toContain('LH_ItemCondition')
    expect(url).not.toContain('LH_BIN')
  })
})
