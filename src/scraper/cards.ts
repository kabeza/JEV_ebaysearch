import type { Page } from 'playwright'

/**
 * Reads eBay search-result cards.
 *
 * The DOM-reading half is deliberately thin: it pulls raw text out of the page
 * and hands it to the pure parsing functions below, which are what the tests
 * exercise. Everything that could be wrong about eBay's markup lives in one
 * `CARD_QUERY` constant, so a layout change is a one-line fix.
 */

export interface RawCard {
  itemId: string
  title: string
  url: string
  price: number | null
  shipping: number | null
  currency: string
  conditionLabel: string | null
  sellerName: string | null
  sellerFeedback: string | null
  watchers: number | null
  buyingFormat: string | null
  /**
   * Whether eBay's `.s-card__sep b` element is present.
   *
   * KNOWN DEFECT (2026-09-18): this element exists on **every** card in the
   * current layout, so it currently carries no signal — a live two-page run
   * flagged 113 of 113 cards. Do not display it as "sponsored" until a real
   * discriminator is found. Kept as a raw observation rather than deleted, so
   * the data is there when we work out the actual marker.
   */
  sponsoredMarker: boolean
  rawText: string[]
}

/** Raw text pulled straight from one card element, before any interpretation. */
export interface CardDomFields {
  listingId: string | null
  title: string
  url: string
  priceText: string
  subtitleText: string
  attributeRows: string[]
  secondaryRows: string[]
  hasSponsoredMarker: boolean
}

export const ITEM_ID_PATTERN = /\/itm\/(\d{9,})/

/** eBay's own condition vocabulary, as displayed on result cards. */
export const CONDITION_LABELS = [
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
  // Last on purpose. eBay's listing pages state a new item as "New: A
  // brand-new, unused, unopened…", and nothing earlier in this list matches it.
  // Keeping it last means every more specific label still wins.
  'New',
] as const

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Filler cards eBay injects at the top of every results page. */
export function isPlaceholderCard(urlOrTitle: string): boolean {
  return urlOrTitle.includes('/itm/123456') || urlOrTitle.trim() === 'Shop on eBay'
}

/** "$1,549.00" -> 1549. Takes the low figure from a range. */
export function parsePrice(text: string): number | null {
  const cleaned = text.replace(/,/g, '')
  const m = cleaned.match(/\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? n : null
}

/**
 * Reads the shipping cost out of a card's attribute rows.
 *
 * Row by row, never from the joined text: the first row on every card is the
 * item's own price, so a single `match` over the whole blob returned the price
 * as the shipping cost on every card that charged for shipping. Rows that
 * mention shipping without naming a cost ("Shipping not specified") are
 * null — an unknown cost is not a free one.
 */
export function parseShipping(rows: string[]): number | null {
  for (const row of rows) {
    if (/free\s+(shipping|delivery|international shipping)/i.test(row)) return 0
    if (!/\b(shipping|delivery)\b/i.test(row)) continue
    const m = row.replace(/,/g, '').match(/\d+(?:\.\d+)?/)
    if (m) return Number(m[0])
  }
  return null
}

/**
 * Maps a subtitle to a known eBay condition, or null.
 *
 * `.s-card__subtitle` is not reliably the condition — on some cards it holds
 * item specifics such as "Lenovo · 512 GB". Returning null for unrecognised
 * text is deliberate: a null is honest input for JEV, junk recorded as fact is
 * not.
 *
 * Matching is on word boundaries, not substrings. A plain `includes` read the
 * condition description "New: A brand-new, unused, unopened, undamaged item" as
 * **Used**, because "unused" contains "used" — a new laptop reported to JEV as
 * second-hand. Labels are tried in order, so the more specific ones win.
 */
export function matchCondition(text: string): string | null {
  const lower = text.toLowerCase()
  for (const label of CONDITION_LABELS) {
    const pattern = new RegExp(`\\b${escapeRegExp(label.toLowerCase())}\\b`)
    if (pattern.test(lower)) return label
  }
  return null
}

/** ["11 watchers"] -> 11 */
export function parseWatchers(rows: string[]): number | null {
  for (const row of rows) {
    const m = row.match(/(\d[\d,]*)\s+watchers?/i)
    if (m?.[1]) return Number(m[1].replace(/,/g, ''))
  }
  return null
}

/** "Buy It Now", "or Best Offer", or null. */
export function parseBuyingFormat(rows: string[]): string | null {
  for (const row of rows) {
    const t = row.trim()
    if (/^buy it now$/i.test(t)) return 'Buy It Now'
    if (/best offer/i.test(t)) return 'or Best Offer'
    if (/^auction$/i.test(t)) return 'Auction'
  }
  return null
}

function extractSeller(rows: string[]): { name: string | null; feedback: string | null } {
  for (const row of rows) {
    const m = row.match(/(.+?)\s+(\d+(?:\.\d+)?%\s*positive\s*\([\d.,KkMm]+\))/)
    if (m?.[1] && m[2]) return { name: m[1].trim(), feedback: m[2].trim() }
  }
  return { name: null, feedback: null }
}

/**
 * Turns raw card text into a card, or null if this is eBay filler rather than a
 * real listing.
 */
export function toRawCard(f: CardDomFields): RawCard | null {
  if (isPlaceholderCard(f.url) || isPlaceholderCard(f.title)) return null

  const itemId = f.listingId && /^\d{9,}$/.test(f.listingId)
    ? f.listingId
    : (f.url.match(ITEM_ID_PATTERN)?.[1] ?? null)
  if (!itemId) return null

  const seller = extractSeller(f.secondaryRows)
  const allRows = [...f.attributeRows, ...f.secondaryRows]

  return {
    itemId,
    title: f.title.replace(/Opens in a new window or tab/g, '').trim(),
    url: f.url,
    price: parsePrice(f.priceText),
    shipping: parseShipping(allRows),
    currency: 'USD',
    conditionLabel: matchCondition(f.subtitleText),
    sellerName: seller.name,
    sellerFeedback: seller.feedback,
    watchers: parseWatchers(allRows),
    buyingFormat: parseBuyingFormat(allRows),
    sponsoredMarker: f.hasSponsoredMarker,
    rawText: allRows,
  }
}

/**
 * Reads every card on the current results page.
 *
 * Throws when the page has no cards at all — an empty list is how a broken
 * selector silently looks like "no results", and that must never be mistaken
 * for a successful search.
 */
export async function extractCards(page: Page): Promise<RawCard[]> {
  // IMPORTANT: the callback below must contain no named inner functions or
  // arrow functions assigned to variables. The server runs under tsx, which
  // enables esbuild's `keepNames` and injects `__name(...)` wrappers into the
  // serialized function — and `__name` does not exist inside the browser page,
  // so the whole extraction dies with "ReferenceError: __name is not defined".
  // Vitest does not transform this way, so tests pass while the real server
  // fails. Keep every helper inline as an expression.
  //
  // Verified live on 2026-09-18: this exact bug surfaced as a failed run with a
  // screenshot rather than a silent empty result.
  const fields = await page.$$eval('.s-card', (cards) =>
    cards.map((card) => ({
      listingId: card.getAttribute('data-listingid'),
      title: (card.querySelector('.s-card__title')?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
      url:
        card
          .querySelector('.su-card-container__header a.s-card__link')
          ?.getAttribute('href') ??
        card.querySelector('a.s-card__link')?.getAttribute('href') ??
        '',
      priceText: (card.querySelector('.s-card__price')?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
      subtitleText: (card.querySelector('.s-card__subtitle')?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
      attributeRows: Array.from(card.querySelectorAll('.s-card__attribute-row')).map((el) =>
        (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
      ),
      secondaryRows: Array.from(
        card.querySelectorAll('.su-card-container__attributes__secondary .s-card__attribute-row'),
      ).map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()),
      hasSponsoredMarker: card.querySelector('.s-card__sep b') !== null,
    })),
  )

  if (fields.length === 0) {
    throw new Error(
      'No .s-card elements found on the results page. eBay markup may have changed, ' +
        'or the page did not load. Refusing to report this as "no results".',
    )
  }

  return fields.map(toRawCard).filter((c): c is RawCard => c !== null)
}
