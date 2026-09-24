import type { Database as SqliteDatabase } from 'better-sqlite3'
import type { JevAnswer } from '../jev/client'

/**
 * The judgment log. Every answer is stored whole — value, probabilities,
 * confidence and legend — because the report's job is to make the reasoning
 * inspectable, and because re-weighting and re-thresholding must cost no new
 * API calls (spec §5.6).
 */

export interface Questionnaire {
  id: number
  runId: number
  version: number
  definition: Record<string, unknown>
  createdAt: string
}

export interface Judgment {
  id: number
  runId: number
  questionnaireId: number
  listingId: number
  questionKey: string
  answer: JevAnswer
  createdAt: string
}

interface QuestionnaireRow {
  id: number
  run_id: number
  definition_json: string
  version: number
  created_at: string
}

interface JudgmentRow {
  id: number
  run_id: number
  questionnaire_id: number
  listing_id: number
  question_key: string
  answer_json: string
  created_at: string
}

/** The next version number for a run's questionnaires, starting at 1. */
export function nextQuestionnaireVersion(db: SqliteDatabase, runId: number): number {
  const row = db
    .prepare('select coalesce(max(version), 0) + 1 as next from questionnaires where run_id = ?')
    .get(runId) as { next: number }
  return row.next
}

/**
 * Stores one version's definition. `version` is explicit and required: a
 * re-judge is a new version of the same run, and a defaulted 1 would make every
 * version collide on the first number (spec §5.7).
 */
export function saveQuestionnaire(
  db: SqliteDatabase,
  runId: number,
  definition: Record<string, unknown>,
  version: number,
): number {
  const info = db
    .prepare('insert into questionnaires (run_id, definition_json, version) values (?, ?, ?)')
    .run(runId, JSON.stringify(definition), version)
  return Number(info.lastInsertRowid)
}

export function listQuestionnaires(db: SqliteDatabase, runId: number): Questionnaire[] {
  const rows = db
    .prepare('select * from questionnaires where run_id = ? order by id')
    .all(runId) as QuestionnaireRow[]
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    version: r.version,
    definition: JSON.parse(r.definition_json) as Record<string, unknown>,
    createdAt: r.created_at,
  }))
}

/**
 * Stores the answers for one listing. `questionKey` is the bare key
 * ("price_value"): the listing id already says which listing it belongs to, and
 * the `L3.` prefix is a per-call detail of how the question was addressed.
 */
export function saveJudgments(
  db: SqliteDatabase,
  o: {
    runId: number
    questionnaireId: number
    listingId: number
    answers: Record<string, JevAnswer>
  },
): number {
  const insert = db.prepare(
    `insert into judgments (run_id, questionnaire_id, listing_id, question_key, answer_json)
     values (?, ?, ?, ?, ?)`,
  )
  const tx = db.transaction((entries: [string, JevAnswer][]) => {
    for (const [key, answer] of entries) {
      insert.run(o.runId, o.questionnaireId, o.listingId, key, JSON.stringify(answer))
    }
  })
  const entries = Object.entries(o.answers)
  tx(entries)
  return entries.length
}

/**
 * Every judgment for a run, across **every** questionnaire version, ordered by
 * id. Callers that rank or display answers must filter to one version first:
 * `score.ts` keys answers by listing and question, so two versions of the same
 * answer would overwrite each other silently.
 */
export function listJudgments(db: SqliteDatabase, runId: number): Judgment[] {
  const rows = db
    .prepare('select * from judgments where run_id = ? order by id')
    .all(runId) as JudgmentRow[]
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    questionnaireId: r.questionnaire_id,
    listingId: r.listing_id,
    questionKey: r.question_key,
    answer: JSON.parse(r.answer_json) as JevAnswer,
    createdAt: r.created_at,
  }))
}
