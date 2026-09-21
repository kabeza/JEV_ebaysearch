/**
 * Builds a self-contained listing fixture out of a page captured by
 * `recon-listing.ts`, so listing-detail parsing is tested against eBay's real
 * markup with no browser session and no network.
 *
 * Run: node --import tsx scripts/build-listing-fixture.ts [rawHtml] [outFile]
 *
 * Only the subtrees the parser reads are kept, but they are the real nodes —
 * classes, data-testids and nesting exactly as eBay served them. Regenerate this
 * when eBay changes its listing layout.
 */
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
import { SHIPPING_ROW_SELECTOR } from '../src/scraper/listing.js'

const RAW = process.argv[2] ?? '/tmp/ebay-recon/listing.html'
const OUT = process.argv[3] ?? 'tests/fixtures/ebay/listing-t14s.html'

/**
 * The blocks the parser depends on, in document order. The shipping row uses the
 * parser's own selector, so the fixture can never drift from what is read.
 */
const BLOCKS = [
  ['.x-item-title', 'title'],
  ['.x-price-primary', 'price'],
  ['.x-item-condition-text', 'condition'],
  ['.x-sellercard-atf', 'seller'],
  ['dl[data-testid="ux-layout-section-evo__item"]', 'item specifics'],
  [SHIPPING_ROW_SELECTOR, 'shipping'],
] as const

const raw = readFileSync(RAW, 'utf8')
// Scripts would try to load third-party resources; none of them build markup we read.
const withoutScripts = raw.replace(/<script\b[\s\S]*?<\/script>/gi, '')

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.setContent(withoutScripts, { waitUntil: 'domcontentloaded' })

const parts: string[] = []
for (const [selector, label] of BLOCKS) {
  const node = page.locator(selector).first()
  const count = await node.count()
  if (count === 0) {
    console.log(`MISSING (${label}): ${selector}`)
    continue
  }
  const html = await node.evaluate((el) => el.outerHTML)
  const text = (await node.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`ok  ${label.padEnd(16)} ${String(html.length).padStart(6)} bytes | ${text.slice(0, 70)}`)
  parts.push(`<!-- ${label} -->\n${html}`)
}

const fixture = `<!doctype html>
<!--
  Captured from a real eBay listing page (item 117416125363) on 2026-09-21 by
  scripts/recon-listing.ts and trimmed to the nodes the detail parser reads.
  Do not hand-edit: regenerate from a fresh capture when eBay changes its layout.
-->
<html lang="en">
  <head><meta charset="utf-8" /><title>listing fixture</title></head>
  <body>
${parts.join('\n')}
  </body>
</html>
`

writeFileSync(OUT, fixture)
console.log(`\nwrote ${fixture.length} bytes -> ${OUT}`)

await browser.close()
