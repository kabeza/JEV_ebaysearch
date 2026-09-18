/**
 * Diagnostic probe: which browser configuration can actually reach eBay?
 *
 * Run: node --import tsx scripts/probe-access.ts
 *
 * Tries a small matrix of configurations against one search URL and reports the
 * HTTP status for each. Temporary tool — delete once we know what works.
 */
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_TO_TRY = 'https://www.ebay.com/sch/i.html?_nkw=Thinkpad+T14s+gen+6'
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'

interface Attempt {
  label: string
  channel?: 'chrome'
  headless: boolean
  userAgent?: string
}

const attempts: Attempt[] = [
  { label: 'bundled chromium, headless, default UA', headless: true },
  { label: 'bundled chromium, headless, desktop UA', headless: true, userAgent: DESKTOP_UA },
  { label: 'bundled chromium, HEADED, default UA', headless: false },
  { label: 'real Chrome, headless, default UA', channel: 'chrome', headless: true },
  { label: 'real Chrome, headless, desktop UA', channel: 'chrome', headless: true, userAgent: DESKTOP_UA },
  { label: 'real Chrome, HEADED, default UA', channel: 'chrome', headless: false },
]

async function tryOne(a: Attempt): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), 'ebay-probe-'))
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  try {
    // launchPersistentContext needs to be called on the type, so branch here
    const opts = {
      headless: a.headless,
      ...(a.channel ? { channel: a.channel } : {}),
      ...(a.userAgent ? { userAgent: a.userAgent } : {}),
      viewport: { width: 1440, height: 1000 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    }
    context = await chromium.launchPersistentContext(profile, opts)
    const page = context.pages()[0] ?? (await context.newPage())
    const res = await page.goto(URL_TO_TRY, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    const status = res?.status()
    await page.waitForTimeout(2500)
    const title = await page.title()
    const cards = await page.locator('li.s-item, .s-card, .s-item').count()
    console.log(
      `${String(status).padEnd(4)} cards=${String(cards).padEnd(5)} ${a.label}\n      title: ${title}`,
    )
  } catch (err) {
    console.log(`ERR  ${a.label}\n      ${err instanceof Error ? err.message.split('\n')[0] : err}`)
  } finally {
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
  }
}

for (const a of attempts) {
  await tryOne(a)
  await new Promise((r) => setTimeout(r, 3000)) // be polite between attempts
}
