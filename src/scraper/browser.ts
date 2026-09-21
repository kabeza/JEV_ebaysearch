import { chromium, type BrowserContext, type Page } from 'playwright'
import { mkdirSync } from 'node:fs'
import { DEFAULTS } from '../shared/config'
import { extractCards, type RawCard } from './cards'
import { extractDetail, type RawDetail } from './listing'

export interface LaunchOptions {
  /** Persistent profile directory. Accumulating state is what keeps eBay happy. */
  profileDir: string
  /**
   * Visible browser. This is a requirement, not a preference: every headless
   * configuration tested returned HTTP 403 from eBay. See the reconnaissance
   * notes in the build plan.
   */
  headed: boolean
}

export async function launchBrowser(o: LaunchOptions): Promise<BrowserContext> {
  mkdirSync(o.profileDir, { recursive: true })
  return chromium.launchPersistentContext(o.profileDir, {
    headless: !o.headed,
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  })
}

/** Randomized pause between page loads, so the crawl is not machine-regular. */
export function pace(minMs = DEFAULTS.pacingMinMs, maxMs = DEFAULTS.pacingMaxMs): Promise<void> {
  const ms = Math.round(minMs + Math.random() * (maxMs - minMs))
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * What the pipeline needs from a results page. Implemented for real by
 * Playwright, and faked in tests so the whole run can be exercised with no
 * browser and no network.
 */
export interface PageSource {
  goto(url: string): Promise<{ status: number }>
  /** Page title, used to recognise eBay's error and challenge pages. */
  title(): Promise<string>
  readCards(): Promise<RawCard[]>
  /** Reads whatever listing page is currently open (spec §5.4). */
  readListing(): Promise<RawDetail>
  screenshot(path: string): Promise<void>
  close(): Promise<void>
}

export function playwrightPageSource(page: Page): PageSource {
  return {
    async goto(url: string) {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      return { status: res?.status() ?? 0 }
    },
    title: () => page.title(),
    readCards: () => extractCards(page),
    readListing: () => extractDetail(page),
    screenshot: async (path: string) => {
      await page.screenshot({ path })
    },
    close: async () => {
      /* the context owns the page */
    },
  }
}
