export const PROJECT_NAME = 'jevbrowser'

/** Run settings, defaulted to the values agreed in the design spec (section 5.1). */
export interface RunSettings {
  /**
   * Stop after this many result pages.
   *
   * 10 since 2026-09-25, reduced from 25 after a real run was 403'd on page 18. The
   * pages-to-listings arithmetic is not 50 each: eBay returned 14–19 cards per page
   * with `_ipg=60` requested (measured on run 9, 318 cards over 17 pages), so ten
   * pages is ~150–190 cards — and past page 14 the same items were recurring.
   */
  maxPages: number
  /** Stop after this many minutes, whichever comes first. */
  maxMinutes: number
  /**
   * How many listings to send to JEV in one request.
   *
   * Measured, not guessed. With the questions made 44% cheaper on 2026-09-24, a
   * batch of listings that carry item specifics costs ~1,570 tokens each: 20 is
   * 49% of the 64k context, 25 is 63%, 40 is 98%, and 45 is refused. 25 keeps
   * real headroom for a listing longer than the pool that was measured, and gives
   * a 28-survivor run two calls instead of three. See
   * `scripts/probe-batch-size.ts` and CLAUDE.md rule 17.
   */
  batchSize: number
  /**
   * How many listing pages one run may open, on top of the search pages.
   *
   * Every visit is another page load, and eBay starts refusing after roughly 50
   * in a day, so this is a politeness cap as much as a time one. Survivors past
   * the cap are still judged — on their card data alone.
   */
  maxDetailVisits: number
  /** Visible browser by default: a broken selector is visible, not silent. */
  headed: boolean
  /** US ZIP used to get domestic shipping costs. */
  zhomeZip: string
  /** Randomized pacing between page loads, in milliseconds. */
  pacingMinMs: number
  pacingMaxMs: number
}

export const DEFAULTS: RunSettings = {
  maxPages: 10,
  maxMinutes: 10,
  batchSize: 25,
  maxDetailVisits: 20,
  headed: true,
  zhomeZip: '10001',
  pacingMinMs: 1500,
  pacingMaxMs: 3000,
}

/** Default model alias; resolves to jev-1.13.0. */
export const MODEL_ALIAS = 'jev-latest'

/**
 * TypeSafe pricing, USD per million tokens. Verified 2026-09-18 at
 * https://docs.typesafe.ai/models.md ($42 per Btok). Output tokens are free.
 * Re-check before trusting the cost estimate shown in the UI.
 */
export const PRICING = {
  inputPerMillionUsd: 0.042,
  outputPerMillionUsd: 0,
}

export function estimateCostUsd(usage: { input_tokens: number; output_tokens: number }): number {
  return (
    (usage.input_tokens / 1_000_000) * PRICING.inputPerMillionUsd +
    (usage.output_tokens / 1_000_000) * PRICING.outputPerMillionUsd
  )
}

/**
 * Service limits, from the same page.
 *
 * `contextTokens` is what actually bounds batch size, not `stateTokens`: the whole
 * request — state *and* question text — shares the context. Measured 2026-09-25,
 * the state for 50 listings with no detail behind them was 7,575 tokens (12% of
 * the context) where the same request's questions pushed the full batch past the
 * limit. The state limit alone would allow ~80 listings.
 */
export const LIMITS = {
  contextTokens: 64_000,
  stateTokens: 32_000,
  requestsPerMinute: 1_200,
  tokensPerSecond: 250_000,
} as const
