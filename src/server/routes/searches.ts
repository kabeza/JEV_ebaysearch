import type { FastifyInstance } from 'fastify'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { createSearch, getSearch, listSearches } from '../../storage/searches'
import { listRunSummaries } from '../../storage/runs'
import { activeRunId } from '../../pipeline/runner'

export function registerSearchRoutes(app: FastifyInstance, db: SqliteDatabase): void {
  /**
   * Every search with its own runs, newest first.
   *
   * Composed here rather than in `storage/searches.ts`: the repository owns
   * searches, and the join belongs where the response is shaped. One query for all
   * the runs, not one per search — the list refetches after every action, and this
   * is the request it makes.
   */
  app.get('/api/searches', async () => {
    const summaries = listRunSummaries(db)
    return listSearches(db).map((search) => ({
      ...search,
      runs: summaries.filter((run) => run.searchId === search.id),
    }))
  })

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

  /**
   * Removes a search and, by the schema's `on delete cascade`, its runs, listings,
   * judgments, questionnaires and events.
   *
   * Refused while one of its runs is the active job: that run holds the one-job
   * lock and is writing rows this would remove underneath it. Asked here rather
   * than in the repository because "active" is the runner's word, not a column,
   * and it covers a re-judge as well as a run — they share the lock.
   *
   * There is no undo, so the UI asks twice and says what it will destroy.
   */
  app.delete('/api/searches/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const search = getSearch(db, id)
    if (!search) return reply.code(404).send({ error: `No search ${id}` })

    const busy = activeRunId()
    if (busy !== null) {
      const isOurs = db.prepare('select 1 from runs where id = ? and search_id = ?').get(busy, id)
      if (isOurs) {
        return reply
          .code(409)
          .send({ error: `Run ${busy} of this search is in progress. Cancel it first.` })
      }
    }

    db.prepare('delete from searches where id = ?').run(id)
    return reply.code(204).send()
  })
}
