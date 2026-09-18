import type { FastifyInstance } from 'fastify'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { createSearch, listSearches } from '../../storage/searches'

export function registerSearchRoutes(app: FastifyInstance, db: SqliteDatabase): void {
  app.get('/api/searches', async () => listSearches(db))

  app.post('/api/searches', async (request, reply) => {
    const body = request.body as Partial<{
      name: string
      keyword: string
      criteriaText: string
      spec: Record<string, unknown>
      settings: Record<string, unknown>
    }>

    if (!body?.keyword?.trim()) {
      return reply.code(400).send({ error: 'keyword is required' })
    }
    if (!body.name?.trim()) {
      return reply.code(400).send({ error: 'name is required' })
    }

    const created = createSearch(db, {
      name: body.name,
      keyword: body.keyword,
      criteriaText: body.criteriaText ?? '',
      spec: body.spec ?? {},
      settings: body.settings ?? {},
    })
    return reply.code(201).send(created)
  })
}
