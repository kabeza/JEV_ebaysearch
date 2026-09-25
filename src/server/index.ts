import Fastify, { type FastifyInstance } from 'fastify'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { openDatabase } from '../storage/db'
import { sweepPausedRuns } from '../storage/runs'
import type { PageSource } from '../scraper/browser'
import type { JevClient } from '../jev/client'
import { registerSearchRoutes } from './routes/searches'
import { registerRunRoutes } from './routes/runs'

export interface ServerOptions {
  dbPath?: string
  logger?: boolean
  /**
   * Overrides how a run gets its pages. Production leaves this unset and a real
   * browser is launched; a script can pass a fake source to exercise the whole
   * server — run, SSE stream, UI — with no browser and no eBay.
   */
  sourceFactory?: () => Promise<PageSource>
  /** See `StartRunOptions.judgeClientFactory`. Unset in production. */
  judgeClientFactory?: () => JevClient
}

export function buildServer(opts: ServerOptions = {}): FastifyInstance {
  const dbPath = opts.dbPath ?? 'data/jevbrowser.db'
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })

  const app = Fastify({ logger: opts.logger ?? false })
  const db = openDatabase(dbPath)

  // Nothing is running yet, so any run still marked `paused` belongs to a process
  // that has ended — and a pause cannot outlive its process. Without this the row
  // keeps a Resume button that can only 409 and stays shut to the editor.
  const orphans = sweepPausedRuns(db)
  if (orphans > 0) {
    app.log.warn(`Ended ${orphans} run(s) left paused by a previous process.`)
  }

  registerSearchRoutes(app, db)
  registerRunRoutes(app, db, {
    sourceFactory: opts.sourceFactory,
    judgeClientFactory: opts.judgeClientFactory,
  })
  app.addHook('onClose', async () => db.close())

  return app
}

/**
 * Binds to loopback only. This process holds the TypeSafe API key and drives a
 * real browser — it must never be reachable from the network.
 */
export async function startServer(port = 3001): Promise<FastifyInstance> {
  const app = buildServer({ logger: true })
  await app.listen({ port, host: '127.0.0.1' })
  return app
}
