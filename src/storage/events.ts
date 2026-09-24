import type { Database as SqliteDatabase } from 'better-sqlite3'

/**
 * The run event log. Written as events happen, which is what lets a browser
 * that refreshes mid-run re-attach and replay rather than showing a blank page.
 */

export type RunEventType =
  | 'run.started'
  | 'run.finished'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.progress'
  | 'page.fetched'
  | 'cards.extracted'
  | 'cards.filtered'
  | 'listing.visited'
  | 'judgments.received'
  | 'rejudge.started'
  | 'rejudge.finished'
  | 'rejudge.failed'
  | 'error'

export interface RunEvent {
  seq: number
  at: string
  type: RunEventType
  payload: unknown
}

interface Row {
  seq: number
  at: string
  type: RunEventType
  payload_json: string | null
}

export function appendEvent(
  db: SqliteDatabase,
  runId: number,
  type: RunEventType,
  payload: unknown = {},
): RunEvent {
  const next = db.prepare('select coalesce(max(seq), 0) + 1 as seq from events where run_id = ?').get(runId) as { seq: number }
  const seq = next.seq
  db.prepare('insert into events (run_id, seq, type, payload_json) values (?, ?, ?, ?)').run(
    runId,
    seq,
    type,
    JSON.stringify(payload ?? {}),
  )
  const row = db
    .prepare('select seq, at, type, payload_json from events where run_id = ? and seq = ?')
    .get(runId, seq) as Row
  return { seq: row.seq, at: row.at, type: row.type, payload: JSON.parse(row.payload_json ?? '{}') }
}

/** Events after `sinceSeq`, for replaying a run a browser just attached to. */
export function listEvents(db: SqliteDatabase, runId: number, sinceSeq = 0): RunEvent[] {
  const rows = db
    .prepare('select seq, at, type, payload_json from events where run_id = ? and seq > ? order by seq')
    .all(runId, sinceSeq) as Row[]
  return rows.map((r) => ({
    seq: r.seq,
    at: r.at,
    type: r.type,
    payload: JSON.parse(r.payload_json ?? '{}'),
  }))
}
