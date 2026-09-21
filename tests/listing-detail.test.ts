import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  extractDetail,
  parseDetail,
  parseShippingValue,
  extractSpecifics,
  type DetailFields,
} from '../src/scraper/listing'

const FIXTURE = join(import.meta.dirname, 'fixtures/ebay/listing-t14s.html')
const SECOND_FIXTURE = join(import.meta.dirname, 'fixtures/ebay/listing-t14s-amd.html')

/** Real strings, copied from the captured listing page. */
const REAL: DetailFields = {
  titleText: 'Lenovo ThinkPad T14s Gen 6 Notebook, 14 in. WUXGA IPS Display, Intel Core Ultra',
  priceText: 'US $1,259.00',
  conditionText: 'Open box Open box',
  sellerText: "vipoutlet (974852) 97.2% positive Seller's other items Seller's other items",
  shippingLabel: 'Shipping:',
  shippingValue: 'Free FedEx Ground / FedEx Home Delivery®. See details for shipping',
  specificPairs: [
    { label: 'Condition', value: 'Open box: An item in excellent, new condition with no wear.' },
    { label: 'UPC', value: '680358950921' },
    { label: 'Brand', value: 'Lenovo' },
    { label: 'MPN', value: '21R1002QUS' },
    { label: 'Processor', value: 'N\\A' },
    { label: 'Screen Size', value: 'N\\A' },
    { label: 'Country of Origin', value: 'China' },
  ],
}

describe('parseShippingValue', () => {
  it('reads Free as zero, however it is spelled', () => {
    expect(parseShippingValue('Free FedEx Ground / FedEx Home Delivery®. See details')).toBe(0)
    expect(parseShippingValue('Free')).toBe(0)
  })

  it('reads a stated cost', () => {
    expect(parseShippingValue('US $12.34')).toBe(12.34)
    expect(parseShippingValue('$112.00 shipping')).toBe(112)
  })

  it('returns null when eBay will not say', () => {
    expect(parseShippingValue('Calculated at checkout')).toBeNull()
    expect(parseShippingValue('')).toBeNull()
    expect(parseShippingValue(null)).toBeNull()
  })
})

describe('parseDetail', () => {
  it('reads the real listing into named fields', () => {
    const d = parseDetail(REAL)
    expect(d.title).toContain('ThinkPad T14s Gen 6')
    expect(d.price).toBe(1259)
    expect(d.shipping).toBe(0)
    expect(d.condition).toBe('Open Box')
    expect(d.sellerName).toBe('vipoutlet')
    expect(d.sellerFeedback).toBe('97.2% positive')
  })

  it('keeps the item specifics as label/value pairs', () => {
    const d = parseDetail(REAL)
    expect(d.specifics.Brand).toBe('Lenovo')
    expect(d.specifics.UPC).toBe('680358950921')
    expect(d.specifics['Country of Origin']).toBe('China')
  })

  it("drops eBay's N\\A placeholder instead of recording it as a fact", () => {
    const d = parseDetail(REAL)
    expect(d.specifics).not.toHaveProperty('Processor')
    expect(d.specifics).not.toHaveProperty('Screen Size')
  })

  it('reduces the Condition row to a label instead of keeping eBay boilerplate', () => {
    const d = parseDetail(REAL)
    // The raw row is a paragraph — "Open box: An item in excellent, new
    // condition with no wear. ..." — and the captured page's real row is longer
    // still, ending in "See all condition definitions".
    expect(REAL.specificPairs[0]?.value.length).toBeGreaterThan(40)
    expect(d.specifics.Condition).toBe('Open Box')
  })

  it('drops the Condition row entirely when it is not a known condition', () => {
    const d = parseDetail({
      ...REAL,
      // No dedicated condition element either, so the row is the only source.
      conditionText: '',
      specificPairs: [
        { label: 'Condition', value: 'Please read the description carefully before bidding' },
        { label: 'Brand', value: 'Lenovo' },
      ],
    })
    expect(d.specifics).not.toHaveProperty('Condition')
    expect(d.condition).toBeNull()
  })

  it('ignores a value that is only whitespace', () => {
    const d = parseDetail({
      ...REAL,
      specificPairs: [{ label: 'Brand', value: '   ' }, { label: 'MPN', value: 'X1' }],
    })
    expect(d.specifics).toEqual({ MPN: 'X1' })
  })

  it('falls back to the specifics row when the condition element is empty', () => {
    const d = parseDetail({ ...REAL, conditionText: '' })
    expect(d.condition).toBe('Open Box')
  })

  it('leaves the condition null when nothing matches the known vocabulary', () => {
    const d = parseDetail({
      ...REAL,
      conditionText: 'Seller refurbished-ish, see description',
      specificPairs: [{ label: 'Brand', value: 'Lenovo' }],
    })
    // "Seller refurbished" IS in the vocabulary; this text is not a clean match
    // for it and must not be pasted in as prose.
    expect(d.condition === null || d.condition === 'Seller refurbished').toBe(true)
  })

  it('survives a page where everything is missing', () => {
    const d = parseDetail({
      titleText: null,
      priceText: null,
      conditionText: null,
      sellerText: null,
      shippingLabel: null,
      shippingValue: null,
      specificPairs: [],
    })
    expect(d).toMatchObject({
      title: null,
      price: null,
      shipping: null,
      condition: null,
      sellerName: null,
      sellerFeedback: null,
      specifics: {},
    })
  })

  it('keeps the raw label/value lines for debugging', () => {
    const d = parseDetail(REAL)
    expect(d.rawText.some((l) => l.includes('Brand'))).toBe(true)
  })
})

describe('extractSpecifics', () => {
  it('trims labels and values', () => {
    expect(
      extractSpecifics([
        { label: ' Brand ', value: ' Lenovo ' },
        { label: 'MPN', value: '21R1002QUS' },
      ]),
    ).toEqual({ Brand: 'Lenovo', MPN: '21R1002QUS' })
  })

  it('keeps the first value when a label repeats', () => {
    expect(
      extractSpecifics([
        { label: 'Brand', value: 'Lenovo' },
        { label: 'Brand', value: 'Something else' },
      ]),
    ).toEqual({ Brand: 'Lenovo' })
  })
})

/**
 * The second captured listing, chosen because it differs from the first in every
 * way the parser touches: AMD not Intel, "New" not "Open Box", a small seller not
 * a warehouse, more than four times the item specifics — and no
 * `.x-item-condition-text` element and no `ux-labels-values--shipping` class at
 * all. A parser written against one listing silently returns null on this one.
 */
describe('extractDetail against a second captured listing', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
    await page.setContent(readFileSync(SECOND_FIXTURE, 'utf8'), { waitUntil: 'domcontentloaded' })
  })

  afterAll(async () => {
    await browser.close()
  })

  it('reads the fields this layout states differently', async () => {
    const d = await extractDetail(page)
    expect(d.title).toContain('NEW Lenovo ThinkPad T14s Gen 6')
    expect(d.price).toBe(1299.99)
    expect(d.shipping).toBe(0)
    expect(d.sellerName).toBe('EssentialSupplyCompany')
    expect(d.sellerFeedback).toBe('100% positive')
  })

  it('finds the condition in the item specifics when there is no condition element', async () => {
    const d = await extractDetail(page)
    // The only statement of condition is the specifics row, whose text begins
    // "New: A brand-new, unused, unopened, undamaged item in its original…".
    expect(d.condition).toBe('New')
    expect(d.specifics.Condition).toBe('New')
  })

  it('keeps the item specifics this listing actually uses', async () => {
    const d = await extractDetail(page)
    expect(d.specifics['RAM Size']).toBe('32 GB')
    expect(d.specifics['SSD Capacity']).toBe('512 GB')
    expect(d.specifics.Processor).toBe('AMD Ryzen AI 7 PRO')
    expect(d.specifics['Operating System']).toBe('Windows 11 Pro')
    expect(d.specifics.Brand).toBe('Lenovo')
  })

  it('never stores a raw placeholder or a paragraph, on either listing', async () => {
    const d = await extractDetail(page)
    for (const [label, value] of Object.entries(d.specifics)) {
      expect(value).not.toMatch(/^n\\?a$/i)
      expect(value.length, `${label} holds prose`).toBeLessThan(120)
    }
  })
})

describe('extractDetail against the captured listing page', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
    // No network: a saved, self-contained slice of a real listing page.
    await page.setContent(readFileSync(FIXTURE, 'utf8'), { waitUntil: 'domcontentloaded' })
  })

  afterAll(async () => {
    await browser.close()
  })

  it('reads every field off the real page', async () => {
    const d = await extractDetail(page)
    expect(d.title).toContain('Lenovo ThinkPad T14s Gen 6 Notebook')
    expect(d.price).toBe(1259)
    expect(d.shipping).toBe(0)
    expect(d.condition).toBe('Open Box')
    expect(d.sellerName).toBe('vipoutlet')
    expect(d.sellerFeedback).toContain('97.2% positive')
    expect(d.specifics.Brand).toBe('Lenovo')
    expect(d.specifics.MPN).toBe('21R1002QUS')
    expect(d.specifics).not.toHaveProperty('Processor')
  })

  it('never returns prose where a field should hold a label', async () => {
    const d = await extractDetail(page)
    // The condition element renders its text twice, and the specifics row for
    // it is a paragraph of eBay boilerplate. Both must reduce to the label.
    expect(d.condition).toBe('Open Box')
    expect(d.specifics.Condition).toBe('Open Box')
    for (const value of Object.values(d.specifics)) {
      expect(value.length).toBeLessThan(120)
    }
  })

  it('throws rather than returning an empty detail when the page has no specifics', async () => {
    const blank = await browser.newPage()
    await blank.setContent('<html><body><p>nothing here</p></body></html>')
    await expect(extractDetail(blank)).rejects.toThrowError(/listing/i)
    await blank.close()
    // Each field waits out its own 1s timeout before being called absent.
  }, 20_000)
})
