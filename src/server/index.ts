import Fastify, { type FastifyInstance } from 'fastify'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { openDatabase } from '../storage/db'
import { registerSearchRoutes } from './routes/searches'
import { registerRunRoutes } from './routes/runs'

export interface ServerOptions {
  dbPath?: string
  logger?: boolean
}

export function buildServer(opts: ServerOptions = {}): FastifyInstance {
  const dbPath = opts.dbPath ?? 'data/jevbrowser.db'
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })

  const app = Fastify({ logger: opts.logger ?? false })
  const db = openDatabase(dbPath)

  registerSearchRoutes(app, db)
  registerRunRoutes(app, db)
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
