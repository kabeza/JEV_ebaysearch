import type { Database as SqliteDatabase } from 'better-sqlite3'
import type { RawCard } from '../scraper/cards'

export type ListingStage = 'card_only' | 'rejected' | 'survivor' | 'detail_failed' | 'judged'

export interface StoredListing extends RawCard {
  id: number
  runId: number
  stage: ListingStage
  rejectReason: string | null
}

interface Row {
  id: number
  run_id: number
  ebay_item_id: string
  title: string
  url: string
  price: number | null
  shipping: number | null
  currency: string | null
  condition_label: string | null
  seller_json: string | null
  is_refurb: number
  stage: ListingStage
  reject_reason: string | null
  raw_card_json: string | null
}

function toListing(row: Row): StoredListing {
  const raw = JSON.parse(row.raw_card_json ?? '{}') as Partial<RawCard>
  const seller = JSON.parse(row.seller_json ?? '{}') as {
    name?: string | null
    feedback?: string | null
  }
  return {
    id: row.id,
    runId: row.run_id,
    itemId: row.ebay_item_id,
    title: row.title,
    url: row.url,
    price: row.price,
    shipping: row.shipping,
    currency: row.currency ?? 'USD',
    conditionLabel: row.condition_label,
    sellerName: seller.name ?? null,
    sellerFeedback: seller.feedback ?? null,
    watchers: raw.watchers ?? null,
    buyingFormat: raw.buyingFormat ?? null,
    sponsoredMarker: raw.sponsoredMarker ?? false,
    rawText: raw.rawText ?? [],
    stage: row.stage,
    rejectReason: row.reject_reason,
  }
}

/**
 * Stores the cards from one results page. Idempotent per run: a card already
 * stored for this run is skipped, so a re-fetched page cannot duplicate rows.
 */
export function insertCards(db: SqliteDatabase, runId: number, cards: RawCard[]): number {
  const insert = db.prepare(
    `insert into listings
       (run_id, ebay_item_id, title, url, price, shipping, currency,
        condition_label, seller_json, raw_card_json, stage)
     values (@runId, @itemId, @title, @url, @price, @shipping, @currency,
             @conditionLabel, @sellerJson, @rawCardJson, 'card_only')
     on conflict do nothing`,
  )

  const existing = db
    .prepare('select ebay_item_id from listings where run_id = ?')
    .all(runId) as { ebay_item_id: string }[]
  const seen = new Set(existing.map((r) => r.ebay_item_id))

  let inserted = 0
  const tx = db.transaction((rows: RawCard[]) => {
    for (const c of rows) {
      if (seen.has(c.itemId)) continue
      insert.run({
        runId,
        itemId: c.itemId,
        title: c.title,
        url: c.url,
        price: c.price,
        shipping: c.shipping,
        currency: c.currency,
        conditionLabel: c.conditionLabel,
        sellerJson: JSON.stringify({ name: c.sellerName, feedback: c.sellerFeedback }),
        rawCardJson: JSON.stringify({
          watchers: c.watchers,
          buyingFormat: c.buyingFormat,
          sponsoredMarker: c.sponsoredMarker,
          rawText: c.rawText,
        }),
      })
      seen.add(c.itemId)
      inserted++
    }
  })
  tx(cards)
  return inserted
}

export function listListings(db: SqliteDatabase, runId: number): StoredListing[] {
  const rows = db
    .prepare('select * from listings where run_id = ? order by id')
    .all(runId) as Row[]
  return rows.map(toListing)
}

export function countListings(db: SqliteDatabase, runId: number): number {
  const r = db.prepare('select count(*) as n from listings where run_id = ?').get(runId) as {
    n: number
  }
  return r.n
}
