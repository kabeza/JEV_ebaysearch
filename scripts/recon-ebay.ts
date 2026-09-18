/**
 * Reconnaissance tool. Fetches a real eBay page and reports what is actually
 * there, so selectors get written against reality instead of memory.
 *
 * Run: npm run recon
 *
 * Writes the HTML and a screenshot to /tmp so they can be inspected, and prints
 * counts for candidate selectors plus any bot-challenge markers.
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const PROFILE_DIR = 'data/browser-profile'
const KEYWORD = process.argv[2] ?? 'Thinkpad T14s gen 6'
const OUT = '/tmp/ebay-recon'

mkdirSync(PROFILE_DIR, { recursive: true })
mkdirSync(OUT, { recursive: true })

const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(KEYWORD)}`
console.log('fetching:', url)

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  // Headed is not a preference, it is a requirement: eBay returns 403 to every
  // headless configuration tested. See scripts/probe-access.ts.
  headless: false,
  viewport: { width: 1440, height: 1000 },
  locale: 'en-US',
  timezoneId: 'America/New_York',
})
const page = context.pages()[0] ?? (await context.newPage())

const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
console.log('http status:', response?.status())

await page.waitForTimeout(4000) // let client-side rendering settle

console.log('page title: ', await page.title())
console.log('final url:  ', page.url())

const html = await page.content()
writeFileSync(`${OUT}/search.html`, html)
await page.screenshot({ path: `${OUT}/search.png`, fullPage: false })
console.log(`html: ${html.length} bytes -> ${OUT}/search.html`)
console.log(`screenshot -> ${OUT}/search.png`)

// Candidate card containers. eBay has used several over the years; count them all.
const CARD_SELECTORS = [
  'li.s-item',
  '.s-item',
  '.s-card',
  'li[data-viewport]',
  '[data-view="mi"]',
  '.srp-results li',
  'ul.srp-results > li',
]
console.log('\n--- card container candidates ---')
for (const sel of CARD_SELECTORS) {
  const n = await page.locator(sel).count()
  if (n > 0) console.log(`${String(n).padStart(5)}  ${sel}`)
}

// Where do prices appear?
const PRICE_SELECTORS = ['.s-item__price', '.s-card__price', '[class*="price"]', '.s-item__detail']
console.log('\n--- price element candidates ---')
for (const sel of PRICE_SELECTORS) {
  const n = await page.locator(sel).count()
  if (n > 0) console.log(`${String(n).padStart(5)}  ${sel}`)
}

// Sidebar filter headings, to learn eBay's real filter labels.
console.log('\n--- sidebar / filter headings ---')
const headings = await page
  .locator('h3, h4, .x-refine__heading, .srp-refine__category__title, button[aria-expanded]')
  .allInnerTexts()
console.log(
  headings
    .map((h) => h.trim())
    .filter(Boolean)
    .slice(0, 60)
    .join(' | '),
)

// Bot challenge markers.
console.log('\n--- challenge markers ---')
const markers = ['#captcha', 'iframe[src*="captcha"]', 'text=/Pardon our interruption/',
  'text=/Verify yourself/', 'text=/are you a human/']
for (const m of markers) {
  const n = await page.locator(m).count()
  if (n > 0) console.log(`FOUND (${n}): ${m}`)
}
console.log('done.')

await context.close()
