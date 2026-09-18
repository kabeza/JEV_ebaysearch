import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SCHEMA_PATH = join(import.meta.dirname, 'schema.sql')

/**
 * Opens the database and applies the schema. Idempotent, so it is safe to call
 * on every startup. Pass ':memory:' in tests.
 */
export function openDatabase(path = 'data/jevbrowser.db'): Database.Database {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'))
  return db
}

export type { Database }
