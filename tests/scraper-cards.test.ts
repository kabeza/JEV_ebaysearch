import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  extractCards,
  parsePrice,
  parseShipping,
  matchCondition,
  parseWatchers,
  parseBuyingFormat,
  isPlaceholderCard,
  ITEM_ID_PATTERN,
} from '../src/scraper/cards'

const FIXTURE = join(import.meta.dirname, 'fixtures/ebay/srp-results.html')

describe('parsePrice', () => {
  it('parses a plain price', () => {
    expect(parsePrice('$20.99')).toBe(20.99)
  })

  it('parses a price with thousands separators', () => {
    expect(parsePrice('$1,549.00')).toBe(1549)
  })

  it('parses a range from its lowest figure', () => {
    expect(parsePrice('$10.00 to $20.00')).toBe(10)
  })

  it('returns null when there is no number', () => {
    expect(parsePrice('or Best Offer')).toBeNull()
    expect(parsePrice('')).toBeNull()
  })
})

describe('parseShipping', () => {
  it('parses a shipping amount', () => {
    expect(parseShipping('+$79.99 shipping')).toBe(79.99)
  })

  it('treats free shipping as zero', () => {
    expect(parseShipping('Free shipping')).toBe(0)
    expect(parseShipping('Free International Shipping')).toBe(0)
    expect(parseShipping('Free delivery')).toBe(0)
  })

  it('returns null when shipping is not mentioned', () => {
    expect(parseShipping('Buy It Now')).toBeNull()
    expect(parseShipping('')).toBeNull()
  })
})

describe('matchCondition', () => {
  it('recognises eBay condition labels', () => {
    expect(matchCondition('Brand New')).toBe('Brand New')
    expect(matchCondition('Open Box')).toBe('Open Box')
    expect(matchCondition('Certified - Refurbished')).toBe('Certified - Refurbished')
    expect(matchCondition('Pre-Owned')).toBe('Pre-Owned')
  })

  it('finds the label when embedded in extra text', () => {
    expect(matchCondition('Brand New · Free shipping')).toBe('Brand New')
  })

  it('returns null rather than recording junk as a condition', () => {
    // Seen live: the subtitle sometimes holds item specifics instead.
    expect(matchCondition('Lenovo · 512 GB')).toBeNull()
    expect(matchCondition('')).toBeNull()
  })
})

describe('parseWatchers', () => {
  it('parses a watcher count', () => {
    expect(parseWatchers(['11 watchers'])).toBe(11)
  })

  it('returns null when absent', () => {
    expect(parseWatchers(['Buy It Now'])).toBeNull()
  })
})

describe('parseBuyingFormat', () => {
  it('finds Buy It Now', () => {
    expect(parseBuyingFormat(['$10.00', 'Buy It Now', '+$5.00 shipping'])).toBe('Buy It Now')
  })

  it('finds auction-style listings', () => {
    expect(parseBuyingFormat(['$10.00', 'or Best Offer'])).toBe('or Best Offer')
  })

  it('returns null when neither is present', () => {
    expect(parseBuyingFormat(['$10.00'])).toBeNull()
  })
})

describe('isPlaceholderCard', () => {
  it('rejects eBay filler cards, which link to item 123456', () => {
    expect(isPlaceholderCard('https://ebay.com/itm/123456?hash=abc')).toBe(true)
    expect(isPlaceholderCard('Shop on eBay')).toBe(true)
  })

  it('accepts a real listing', () => {
    expect(isPlaceholderCard('https://www.ebay.com/itm/267234363490?hash=abc')).toBe(false)
  })
})

describe('ITEM_ID_PATTERN', () => {
  it('matches real eBay item urls', () => {
    expect('https://www.ebay.com/itm/267234363490?_skw=x'.match(ITEM_ID_PATTERN)?.[1]).toBe(
      '267234363490',
    )
  })
})

describe('extractCards against the captured results page', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
    // No network: the fixture is a saved results page with its scripts stripped.
    await page.setContent(readFileSync(FIXTURE, 'utf8'), { waitUntil: 'domcontentloaded' })
  })

  afterAll(async () => {
    await browser.close()
  })

  it('extracts the real cards and drops eBay filler', async () => {
    const cards = await extractCards(page)
    // The fixture holds 62 .s-card elements, two of which are placeholders.
    expect(cards.length).toBeGreaterThanOrEqual(58)
    expect(cards.length).toBeLessThanOrEqual(62)
  })

  it('never returns a placeholder, and gets a 9+ digit item id for every card', async () => {
    const cards = await extractCards(page)
    for (const c of cards) {
      expect(c.itemId).not.toBe('123456')
      expect(c.itemId).toMatch(/^\d{9,}$/)
      expect(c.title).not.toBe('Shop on eBay')
      expect(c.url).toMatch(/\/itm\/\d{9,}/)
    }
  })

  it('gives every card a non-empty title', async () => {
    const cards = await extractCards(page)
    for (const c of cards) {
      expect(c.title.length).toBeGreaterThan(3)
    }
  })

  it('never leaves the "Opens in a new window" screen-reader text in a title', async () => {
    const cards = await extractCards(page)
    for (const c of cards) {
      expect(c.title).not.toContain('Opens in a new window')
    }
  })

  it('parses numeric prices for most cards, and null for the rest — never NaN', async () => {
    const cards = await extractCards(page)
    const priced = cards.filter((c) => c.price !== null)
    expect(priced.length).toBeGreaterThan(cards.length * 0.8)
    for (const c of cards) {
      expect(c.price === null || Number.isFinite(c.price)).toBe(true)
    }
  })

  it('produces a usable spread of prices from the real page', async () => {
    const cards = await extractCards(page)
    const prices = cards.map((c) => c.price).filter((p): p is number => p !== null)
    expect(Math.max(...prices)).toBeGreaterThan(500)
    expect(Math.min(...prices)).toBeLessThan(100)
  })

  it('captures condition for some cards and null for others — never junk', async () => {
    const cards = await extractCards(page)
    // eBay's real condition vocabulary. Stated here in full as a specification,
    // rather than imported from the implementation, so the test can disagree
    // with the code. "New (Other)" was found on a live card.
    const known = [
      'Brand New',
      'Open Box',
      'Certified - Refurbished',
      'Excellent - Refurbished',
      'Very Good - Refurbished',
      'Good - Refurbished',
      'eBay Refurbished',
      'Manufacturer refurbished',
      'Seller refurbished',
      'New (Other)',
      'Pre-Owned',
      'Used',
      'For parts or not working',
    ]
    for (const c of cards) {
      if (c.conditionLabel !== null) expect(known).toContain(c.conditionLabel)
    }
    // The page genuinely contains at least one recognised condition.
    expect(cards.some((c) => c.conditionLabel !== null)).toBe(true)
  })

  it('finds at least one set of attribute rows, proving the selector still works', async () => {
    const cards = await extractCards(page)
    const withRows = cards.filter((c) => c.rawText.length > 0)
    expect(withRows.length).toBeGreaterThan(0)
  })
})
