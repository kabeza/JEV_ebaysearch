import type { Database as SqliteDatabase } from 'better-sqlite3'

export type RunStatus = 'queued' | 'running' | 'paused' | 'cancelled' | 'failed' | 'complete'

export interface Run {
  id: number
  searchId: number
  status: RunStatus
  startedAt: string | null
  finishedAt: string | null
  settings: Record<string, unknown>
  stats: Record<string, unknown>
  error: string | null
}

export interface RunStats {
  pagesFetched?: number
  cardsSeen?: number
  placeholdersSkipped?: number
  listingsStored?: number
  [key: string]: unknown
}

interface Row {
  id: number
  search_id: number
  status: RunStatus
  started_at: string | null
  finished_at: string | null
  settings_json: string
  stats_json: string
  error: string | null
}

function toRun(row: Row): Run {
  return {
    id: row.id,
    searchId: row.search_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    settings: JSON.parse(row.settings_json) as Record<string, unknown>,
    stats: JSON.parse(row.stats_json) as Record<string, unknown>,
    error: row.error,
  }
}

export function createRun(
  db: SqliteDatabase,
  searchId: number,
  settings: Record<string, unknown> = {},
): Run {
  const info = db
    .prepare(
      `insert into runs (search_id, status, started_at, settings_json)
       values (?, 'running', datetime('now'), ?)`,
    )
    .run(searchId, JSON.stringify(settings))
  return getRun(db, Number(info.lastInsertRowid))!
}

export function getRun(db: SqliteDatabase, id: number): Run | undefined {
  const row = db.prepare('select * from runs where id = ?').get(id) as Row | undefined
  return row ? toRun(row) : undefined
}

export function listRuns(db: SqliteDatabase, searchId?: number): Run[] {
  const rows = (
    searchId === undefined
      ? db.prepare('select * from runs order by id desc').all()
      : db.prepare('select * from runs where search_id = ? order by id desc').all(searchId)
  ) as Row[]
  return rows.map(toRun)
}

export interface FinishRunOptions {
  status: RunStatus
  stats?: RunStats
  error?: string | null
}

export function finishRun(db: SqliteDatabase, id: number, o: FinishRunOptions): void {
  const existing = getRun(db, id)
  const mergedStats = { ...(existing?.stats ?? {}), ...(o.stats ?? {}) }
  db.prepare(
    `update runs
        set status = ?, finished_at = datetime('now'), stats_json = ?, error = ?
      where id = ?`,
  ).run(o.status, JSON.stringify(mergedStats), o.error ?? null, id)
}

/** Records progress mid-run, so a re-attached page can show where the run is. */
export function updateRunStats(db: SqliteDatabase, id: number, stats: RunStats): void {
  const existing = getRun(db, id)
  const merged = { ...(existing?.stats ?? {}), ...stats }
  db.prepare('update runs set stats_json = ? where id = ?').run(JSON.stringify(merged), id)
}
