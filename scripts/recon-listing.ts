/**
 * Reconnaissance for Stage 4. Fetches one real eBay listing page and reports
 * what is actually there, so the Item Specifics selectors are written against
 * reality instead of memory.
 *
 * Run: node --import tsx scripts/recon-listing.ts [itemUrlOrId]
 *
 * One page load. eBay rate-limits by volume, so keep it to one.
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const PROFILE_DIR = 'data/browser-profile'
const OUT = '/tmp/ebay-recon'
// Default: a real listing stored by run 7.
const TARGET = process.argv[2] ?? '117416125363'
const url = /^https?:/.test(TARGET) ? TARGET : `https://www.ebay.com/itm/${TARGET}`

mkdirSync(PROFILE_DIR, { recursive: true })
mkdirSync(OUT, { recursive: true })

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false, // evidence: scripts/probe-access.ts — headless gets a 403
  viewport: { width: 1440, height: 1000 },
  locale: 'en-US',
  timezoneId: 'America/New_York',
})
const page = context.pages()[0] ?? (await context.newPage())

console.log('fetching:', url)
const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
console.log('http status:', response?.status())
await page.waitForTimeout(4000)

console.log('page title: ', await page.title())
console.log('final url:  ', page.url())

const html = await page.content()
writeFileSync(`${OUT}/listing.html`, html)
await page.screenshot({ path: `${OUT}/listing.png`, fullPage: false })
console.log(`html: ${html.length} bytes -> ${OUT}/listing.html`)
console.log(`screenshot -> ${OUT}/listing.png`)

/** Counts candidates so a selector can be chosen from evidence, not memory. */
async function count(label: string, selectors: string[]): Promise<void> {
  console.log(`\n--- ${label} ---`)
  for (const sel of selectors) {
    const n = await page.locator(sel).count()
    if (n > 0) console.log(`${String(n).padStart(5)}  ${sel}`)
  }
}

await count('title', ['h1.x-item-title__mainTitle', '.x-item-title__mainTitle', 'h1 span.ux-textspans', '[data-testid="x-item-title"]'])
await count('price', ['.x-price-primary', '[data-testid="x-price-primary"]', '.x-bin-price__content'])
await count('condition', ['.x-item-condition-text', '.d-item-condition-label', '[data-testid="ux-condition"]'])
await count('item specifics (labels/values)', [
  '.ux-labels-values',
  '.ux-labels-values__labels',
  '.ux-labels-values__values',
  'dl.ux-labels-values',
  '[data-testid="ux-labels-values"]',
  '.ux-layout-section-evo__item',
  '.ux-layout-section__row',
  '.ux-layout-section-evo',
  '.ux-layout-section',
  'div[data-testid="ux-layout-section"]',
])
await count('shipping', [
  '.ux-labels-values--shipping',
  '[data-testid="ux-labels-values"]',
  '.d-shipping-minview',
  '.ux-labels-values--shippingCost',
  '[data-testid="d-shipping-minview"]',
])
await count('seller', [
  '.x-sellercard-atf__info__about-seller',
  '[data-testid="x-sellercard-atf"]',
  '.x-sellercard-atf',
  '.ux-seller-section__item--seller',
])
await count('about this item bullets', [
  '.ux-layout-section-evo__item--bullet',
  '.ux-list-item--bulleted',
  '[data-testid="ux-list-item"]',
])
await count('challenge markers', [
  '#captcha',
  'iframe[src*="captcha"]',
  'text=/Pardon our interruption/',
  'text=/Verify yourself/',
  'text=/are you a human/',
])

// What a labels/values pair actually looks like when found.
const sample = await page.locator('.ux-labels-values').allInnerTexts().catch(() => [])
if (sample.length > 0) {
  console.log('\n--- first 12 label/value pairs (innerText) ---')
  console.log(sample.slice(0, 12).map((s) => s.replace(/\s+/g, ' ').trim()).join('\n'))
} else {
  const anyPairs = await page.locator('.ux-layout-section-evo__item').allInnerTexts().catch(() => [])
  console.log('\n--- ux-layout-section-evo__item samples ---')
  console.log(anyPairs.slice(0, 12).map((s) => s.replace(/\s+/g, ' ').trim()).join('\n'))
}

console.log('\ndone.')
await context.close()
