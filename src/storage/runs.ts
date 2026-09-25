import type { Database as SqliteDatabase } from 'better-sqlite3'
import { appendEvent } from './events'

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
  /** Cards the code pre-filter stopped before they could cost a JEV call. */
  rejected?: number
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

/** Moves a run to another status without finishing it: `paused`, and back. */
export function updateRunStatus(db: SqliteDatabase, id: number, status: RunStatus): void {
  db.prepare('update runs set status = ? where id = ?').run(status, id)
}

/** Records progress mid-run, so a re-attached page can show where the run is. */
export function updateRunStats(db: SqliteDatabase, id: number, stats: RunStats): void {
  const existing = getRun(db, id)
  const merged = { ...(existing?.stats ?? {}), ...stats }
  db.prepare('update runs set stats_json = ? where id = ?').run(JSON.stringify(merged), id)
}

/**
 * Ends every run still marked `paused` — what a server start does before it
 * accepts anything.
 *
 * A pause lives in the process that took it: the wait is a promise and the
 * browser it holds is in memory. A run left `paused` by a stopped process has
 * nobody left to resume it, and while it stays that way the page offers a Resume
 * button that can only 409 and the question editor stays shut, because the
 * editor opens on a run with a final status — so the row can never be re-judged.
 * Restarting after a change under `src/` is routine (rule 13), so this is easy
 * to hit by accident.
 *
 * Such a run did not finish and did not fail: it was stopped, and its partial
 * results are kept. Returns how many rows it ended, so the caller can say so.
 */
export function sweepPausedRuns(db: SqliteDatabase): number {
  const orphans = db.prepare("select id from runs where status = 'paused'").all() as {
    id: number
  }[]

  for (const { id } of orphans) {
    finishRun(db, id, {
      status: 'cancelled',
      error:
        'The server restarted while this run was paused. A pause lives in the running ' +
        'process, so there was nothing left to resume. The listings already found are kept.',
    })
    appendEvent(db, id, 'run.cancelled', { status: 'cancelled', reason: 'server_restarted' })
  }

  return orphans.length
}

/**
 * One row per run, with what the search list needs to offer its report: how much
 * the run found, how much the pre-filter stopped, and how many listings have an
 * answer.
 *
 * `judged` counts distinct listings across every questionnaire version, not rows:
 * a re-judged run has two versions answering the same listings, and counting rows
 * would report twice the truth.
 */
export interface RunSummary {
  id: number
  searchId: number
  status: RunStatus
  startedAt: string | null
  finishedAt: string | null
  listings: number
  rejected: number
  judged: number
}

/**
 * Every run, newest first. One query with correlated counts rather than a query
 * per run: the search list refetches after every action, and this is the request
 * it makes. The whole table is small enough that callers group in memory.
 */
export function listRunSummaries(db: SqliteDatabase): RunSummary[] {
  const rows = db
    .prepare(
      `select r.id, r.search_id, r.status, r.started_at, r.finished_at,
              (select count(*) from listings l where l.run_id = r.id) as listings,
              (select count(*) from listings l where l.run_id = r.id and l.stage = 'rejected')
                as rejected,
              (select count(distinct j.listing_id) from judgments j where j.run_id = r.id)
                as judged
         from runs r
        order by r.id desc`,
    )
    .all() as {
    id: number
    search_id: number
    status: RunStatus
    started_at: string | null
    finished_at: string | null
    listings: number
    rejected: number
    judged: number
  }[]

  return rows.map((row) => ({
    id: row.id,
    searchId: row.search_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    listings: row.listings,
    rejected: row.rejected,
    judged: row.judged,
  }))
}
