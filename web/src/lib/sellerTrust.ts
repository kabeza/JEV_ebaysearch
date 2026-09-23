/**
 * Seller feedback arrives as raw text on every card — `"99.8% positive (19K)"` —
 * so marking a seller costs no scraping and no JEV call (spec §5.6.1).
 *
 * The tier is split at the count because 100% of 3 reviews is not 100% of 17,000.
 * A binary "100%" badge would lend both the same confidence, so the count travels
 * with the badge and the reader judges for themselves.
 */

/** Below this many reviews, "100% positive" is not yet a record. */
export const TRUSTED_MIN_COUNT = 100

export type TrustTier = 'trusted' | 'flawless_new' | 'not_marked'

export interface ParsedFeedback {
  pct: number
  count: number
}

export interface SellerTrust {
  raw: string | null
  pct: number | null
  count: number | null
  tier: TrustTier
}

/** `17K`, `2.8K`, `1.2M`, `1,234`, `45` — the forms eBay actually writes. */
function parseCount(text: string): number | null {
  const cleaned = text.replace(/,/g, '')
  const match = /^(\d+(?:\.\d+)?)([KM])?$/.exec(cleaned)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  const suffix = match[2]
  if (suffix === 'K') return Math.round(value * 1_000)
  if (suffix === 'M') return Math.round(value * 1_000_000)
  return Math.round(value)
}

/**
 * `"99.1% positive (17K)"` -> `{ pct: 99.1, count: 17000 }`. Anything else is
 * null: a feedback string this code does not recognise is not a feedback score.
 */
export function parseSellerFeedback(raw: string | null | undefined): ParsedFeedback | null {
  if (!raw) return null
  const match = /^\s*(\d+(?:\.\d+)?)%\s+positive\s+\(([^)]+)\)\s*$/.exec(raw)
  if (!match) return null
  const pct = Number(match[1])
  const count = parseCount(match[2]!.trim())
  if (!Number.isFinite(pct) || count === null) return null
  return { pct, count }
}

export function sellerTrust(raw: string | null | undefined): SellerTrust {
  const parsed = parseSellerFeedback(raw)
  if (!parsed) return { raw: raw ?? null, pct: null, count: null, tier: 'not_marked' }
  const perfect = parsed.pct === 100
  const tier: TrustTier = !perfect
    ? 'not_marked'
    : parsed.count >= TRUSTED_MIN_COUNT
      ? 'trusted'
      : 'flawless_new'
  return { raw: raw ?? null, pct: parsed.pct, count: parsed.count, tier }
}
