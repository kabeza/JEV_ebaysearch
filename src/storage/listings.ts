import type { Database as SqliteDatabase } from 'better-sqlite3'
import type { RawCard } from '../scraper/cards'
import type { RawDetail } from '../scraper/listing'

export type ListingStage = 'card_only' | 'rejected' | 'survivor' | 'detail_failed' | 'judged'

export interface StoredListing extends RawCard {
  id: number
  runId: number
  stage: ListingStage
  rejectReason: string | null
  /** What the listing page said, or null when it was never visited / failed. */
  detail: RawDetail | null
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
  raw_detail_json: string | null
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
    detail: row.raw_detail_json ? (JSON.parse(row.raw_detail_json) as RawDetail) : null,
  }
}

export interface InsertCardsResult {
  /** Every card in the batch, including ones already stored, keyed by eBay item id. */
  idsByItemId: Map<string, number>
  /** How many rows were newly inserted. */
  stored: number
}

/**
 * Stores the cards from one results page. Idempotent per run: a card already
 * stored for this run is skipped, so a re-fetched page cannot duplicate rows.
 *
 * Returns the row id of every card in the batch — not just the new ones — so the
 * caller can stamp each row with its pre-filter verdict without a second lookup.
 */
export function insertCards(
  db: SqliteDatabase,
  runId: number,
  cards: RawCard[],
): InsertCardsResult {
  const insert = db.prepare(
    `insert into listings
       (run_id, ebay_item_id, title, url, price, shipping, currency,
        condition_label, seller_json, raw_card_json, stage)
     values (@runId, @itemId, @title, @url, @price, @shipping, @currency,
             @conditionLabel, @sellerJson, @rawCardJson, 'card_only')
     on conflict do nothing`,
  )

  const existing = db
    .prepare('select id, ebay_item_id from listings where run_id = ?')
    .all(runId) as { id: number; ebay_item_id: string }[]
  const idsByItemId = new Map(existing.map((r) => [r.ebay_item_id, r.id]))
  const seen = new Set(idsByItemId.keys())

  let inserted = 0
  const tx = db.transaction((rows: RawCard[]) => {
    for (const c of rows) {
      if (seen.has(c.itemId)) continue
      const info = insert.run({
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
      idsByItemId.set(c.itemId, Number(info.lastInsertRowid))
      inserted++
    }
  })
  tx(cards)
  return { idsByItemId, stored: inserted }
}

/** Stores what the listing page said, alongside the card data — never over it. */
export function updateListingDetail(
  db: SqliteDatabase,
  listingId: number,
  detail: RawDetail,
): void {
  db.prepare('update listings set raw_detail_json = ? where id = ?').run(
    JSON.stringify(detail),
    listingId,
  )
}

/**
 * The survivors of a run, in the order they came off the results pages — which
 * is eBay's relevance order, and the order detail visits should follow.
 */
export function listSurvivors(db: SqliteDatabase, runId: number, limit?: number): StoredListing[] {
  const rows = (limit === undefined
    ? db.prepare("select * from listings where run_id = ? and stage = 'survivor' order by id").all(runId)
    : db
        .prepare("select * from listings where run_id = ? and stage = 'survivor' order by id limit ?")
        .all(runId, limit)) as Row[]
  return rows.map(toListing)
}

/**
 * Every listing the judging phase must ask about: the survivors and the ones
 * whose detail page would not read.
 *
 * A `detail_failed` listing is judged on its card data — `run.ts` says so and
 * CLAUDE.md rule 17 says so — and nothing else will ever judge it, so leaving it
 * out means a finished run carries a listing that waits forever for an answer it
 * will never get. Separate from `listSurvivors` because the detail phase must
 * not re-open a page that already failed.
 */
export function listToJudge(db: SqliteDatabase, runId: number): StoredListing[] {
  const rows = db
    .prepare(
      "select * from listings where run_id = ? and stage in ('survivor', 'detail_failed') order by id",
    )
    .all(runId) as Row[]
  return rows.map(toListing)
}

/** Records a pre-filter verdict on a listing. */
export function updateListingStage(
  db: SqliteDatabase,
  listingId: number,
  stage: ListingStage,
  rejectReason: string | null,
): void {
  db.prepare('update listings set stage = ?, reject_reason = ? where id = ?').run(
    stage,
    rejectReason,
    listingId,
  )
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
