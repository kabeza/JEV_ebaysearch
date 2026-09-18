/**
 * Builds eBay search URLs.
 *
 * Only parameters verified against the live site are used (see the Stage 2
 * reconnaissance notes in the build plan):
 *
 *   `_nkw`               keyword
 *   `_stpos` + `_sadis`  shipping ZIP — the only way the location sticks, and
 *                        the persistent profile remembers it afterwards
 *   `_udlo` / `_udhi`    price bounds — verified working
 *   `_pgn` / `_ipg`      page number and page size
 *
 * Deliberately NOT used: `LH_ItemCondition` and `LH_BIN` are ignored by eBay,
 * and the aspect filters (`RAM Size`, `Features`) are unreliable. Condition is
 * judged by JEV's `condition_ok` question instead, which handles nuance eBay's
 * own filter cannot express.
 */

export interface SearchUrlOptions {
  keyword: string
  /** US ZIP code used to obtain domestic shipping costs. */
  zip: string
  minPrice?: number
  maxPrice?: number
  /** 1-based. Page 1 omits the parameter, matching eBay's own URLs. */
  page?: number
  /** Results per page. 60 is eBay's default. */
  perPage?: number
}

const EBAY_SEARCH = 'https://www.ebay.com/sch/i.html'

export function buildSearchUrl(o: SearchUrlOptions): string {
  const params = new URLSearchParams()

  params.set('_nkw', o.keyword)
  params.set('_stpos', o.zip)
  params.set('_sadis', '200')
  params.set('_ipg', String(o.perPage ?? 60))

  if (o.minPrice !== undefined) params.set('_udlo', String(o.minPrice))
  if (o.maxPrice !== undefined) params.set('_udhi', String(o.maxPrice))
  if (o.page !== undefined && o.page > 1) params.set('_pgn', String(o.page))

  // URLSearchParams encodes spaces as '+', which is what eBay itself emits.
  return `${EBAY_SEARCH}?${params.toString()}`
}
