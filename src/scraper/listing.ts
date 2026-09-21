import type { Page } from 'playwright'
import { matchCondition } from './cards'

/**
 * Reads a listing page — the Item Specifics table, full title, condition,
 * shipping and seller (spec §5.4).
 *
 * The split mirrors `cards.ts`: DOM reading produces plain `DetailFields`, and
 * `parseDetail` turns those into a `RawDetail` with no browser involved, so the
 * mapping rules are testable by themselves.
 *
 * Two values eBay supplies are deliberately not recorded:
 *
 * - `N\A`, its literal placeholder for a field it does not know. Storing it would
 *   turn "eBay did not say" into a fact, and a fact is what JEV reasons over.
 * - Prose in a field that should hold a label. The condition row on a listing
 *   page is a paragraph of marketing copy, so it is matched against the known
 *   condition vocabulary and left null when nothing matches.
 */

export interface SpecificPair {
  label: string
  value: string
}

export interface RawDetail {
  title: string | null
  price: number | null
  shipping: number | null
  condition: string | null
  sellerName: string | null
  sellerFeedback: string | null
  /** Every label/value pair eBay states, keyed by its own label. */
  specifics: Record<string, string>
  /** The raw lines as read, kept for debugging a selector change. */
  rawText: string[]
}

/** Everything the detail parser needs, as plain strings read from the page. */
export interface DetailFields {
  titleText: string | null
  priceText: string | null
  conditionText: string | null
  sellerText: string | null
  shippingLabel: string | null
  shippingValue: string | null
  specificPairs: SpecificPair[]
}

/** eBay's ways of saying "no value": a literal N\A, or nothing at all. */
const EMPTY_VALUE = /^(n\\?a|n\/a|unknown|--|-|)$/i

/**
 * Reads a shipping cost out of the value half of the shipping row.
 *
 * The row reads like a sentence — "Free FedEx Ground / FedEx Home Delivery®" —
 * so "Free" is a cost of zero, and anything without a price ("Calculated at
 * checkout") is null rather than free.
 */
export function parseShippingValue(text: string | null): number | null {
  if (!text) return null
  const trimmed = text.trim()
  if (/^free\b/i.test(trimmed)) return 0
  const m = trimmed.replace(/,/g, '').match(/\$\s*(\d+(?:\.\d+)?)/)
  return m?.[1] !== undefined ? Number(m[1]) : null
}

/** Label/value pairs to a map, dropping the placeholders and keeping the first of a repeat. */
export function extractSpecifics(pairs: SpecificPair[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of pairs) {
    const label = pair.label.replace(/\s+/g, ' ').trim()
    const value = pair.value.replace(/\s+/g, ' ').trim()
    if (!label || EMPTY_VALUE.test(value)) continue
    if (!(label in out)) out[label] = value
  }
  return out
}

/** "vipoutlet (974852) 97.2% positive …" -> name and feedback, or nulls. */
function parseSeller(text: string | null): { name: string | null; feedback: string | null } {
  if (!text) return { name: null, feedback: null }
  // The name is what precedes the review count; the feedback is the percentage
  // as written, without reordering it into the card's shape.
  const name = text.match(/^\s*([^\s(]+)/)?.[1] ?? null
  const feedback = text.match(/\d+(?:\.\d+)?%\s*positive/i)?.[0] ?? null
  return { name, feedback: feedback?.replace(/\s+/g, ' ') ?? null }
}

export function parseDetail(f: DetailFields): RawDetail {
  const specifics = extractSpecifics(f.specificPairs)

  // The dedicated condition element is a label; the specifics row is a
  // paragraph. Prefer the label, and fall back to the paragraph only through
  // the vocabulary matcher.
  const condition = matchCondition(f.conditionText ?? '') ?? matchCondition(specifics.Condition ?? '')

  // The Condition row on a listing page holds eBay's own boilerplate — "Open
  // box: An item in excellent, new condition with no wear. ... See all condition
  // definitions" — which is not a value. Reduce it to the vocabulary label, or
  // drop the key: JEV reasons over what is in this map, and boilerplate recorded
  // as a fact is exactly what the honest-null rule exists to prevent.
  if ('Condition' in specifics) {
    const label = matchCondition(specifics.Condition ?? '')
    if (label) specifics.Condition = label
    else delete specifics.Condition
  }
  const priceMatch = f.priceText?.replace(/,/g, '').match(/\$\s*(\d+(?:\.\d+)?)/)
  const seller = parseSeller(f.sellerText)

  return {
    title: f.titleText?.replace(/\s+/g, ' ').trim() || null,
    price: priceMatch?.[1] !== undefined ? Number(priceMatch[1]) : null,
    shipping: parseShippingValue(f.shippingValue),
    condition,
    sellerName: seller.name,
    sellerFeedback: seller.feedback,
    specifics,
    rawText: [
      ...(f.shippingLabel ? [`${f.shippingLabel} ${f.shippingValue ?? ''}`.trim()] : []),
      ...f.specificPairs.map((p) => `${p.label} ${p.value}`),
    ],
  }
}

/**
 * How long to wait for one field before calling it absent.
 *
 * Playwright's default is 30 seconds, which a run pays for every missing
 * selector — six fields on a dead or half-rendered listing would stall it for
 * three minutes that the time cap is supposed to be spending on other listings.
 */
const READ_TIMEOUT_MS = 1000

/**
 * The shipping row, found by its label rather than by its styling.
 *
 * eBay wraps it as `ux-labels-values--shipping` on some listings and as
 * `ux-labels-values-with-hints--SEC` on others, so a class-based selector reads
 * null on a whole page layout without ever failing — the worst kind of selector.
 * The label it shows is "Shipping:" on both.
 */
export const SHIPPING_ROW_SELECTOR =
  'div[data-testid="ux-labels-values"]:has(.ux-labels-values__labels:has-text("Shipping"))'


/**
 * Reads the fields off an open listing page.
 *
 * Page callbacks stay inline expressions: the server runs under tsx, which
 * injects `__name` wrappers into serialized functions that do not exist in the
 * browser (see the warning in `cards.ts`).
 */
export async function extractDetail(page: Page): Promise<RawDetail> {
  const field = { timeout: READ_TIMEOUT_MS }
  const titleText = await page
    .locator('h1.x-item-title__mainTitle')
    .first()
    .innerText(field)
    .catch(() => null)
  const priceText = await page
    .locator('.x-price-primary')
    .first()
    .innerText(field)
    .catch(() => null)
  const conditionText = await page
    .locator('.x-item-condition-text')
    .first()
    .innerText(field)
    .catch(() => null)
  const sellerText = await page
    .locator('.x-sellercard-atf')
    .first()
    .innerText(field)
    .catch(() => null)

  const pairs = await page
    .locator('dl[data-testid="ux-layout-section-evo__item"] dt, dl[data-testid="ux-layout-section-evo__item"] dd')
    .allInnerTexts()
    .catch(() => [] as string[])

  // dt/dd alternate: label, value, label, value…
  const specificPairs: SpecificPair[] = []
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    specificPairs.push({ label: pairs[i] ?? '', value: pairs[i + 1] ?? '' })
  }

  const shippingRow = page.locator(SHIPPING_ROW_SELECTOR).first()
  const shippingLabel = await shippingRow
    .locator('.ux-labels-values__labels')
    .first()
    .innerText(field)
    .catch(() => null)
  const shippingValue = await shippingRow
    .locator('.ux-labels-values__values')
    .first()
    .innerText(field)
    .catch(() => null)

  const detail = parseDetail({
    titleText,
    priceText,
    conditionText,
    sellerText,
    shippingLabel,
    shippingValue,
    specificPairs,
  })

  // A listing page with no title, no price and no specifics is not an item page
  // at all — a login wall, a challenge, or an ended listing. Silence is a bug.
  if (detail.title === null && detail.price === null && Object.keys(detail.specifics).length === 0) {
    throw new Error('Could not read this listing page: no title, price or item specifics found')
  }

  return detail
}
