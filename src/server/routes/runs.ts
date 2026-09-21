import type { FastifyInstance } from 'fastify'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { getRun, listRuns } from '../../storage/runs'
import { listListings } from '../../storage/listings'
import { listEvents } from '../../storage/events'
import { listJudgments } from '../../storage/judgments'
import { activeRunId, cancelRun, isRunning, startRun, subscribe } from '../../pipeline/runner'
import type { PageSource } from '../../scraper/browser'
import type { JevClient } from '../../jev/client'

export interface RunRouteOptions {
  /** See `ServerOptions.sourceFactory`; unset in production. */
  sourceFactory?: () => Promise<PageSource>
  judgeClientFactory?: () => JevClient
}

export function registerRunRoutes(
  app: FastifyInstance,
  db: SqliteDatabase,
  opts: RunRouteOptions = {},
): void {
  app.post('/api/runs', async (request, reply) => {
    const body = request.body as Partial<{ searchId: number; settings: Record<string, unknown> }>
    if (typeof body?.searchId !== 'number') {
      return reply.code(400).send({ error: 'searchId is required' })
    }
    try {
      const runId = startRun(db, {
        searchId: body.searchId,
        settings: body.settings,
        sourceFactory: opts.sourceFactory,
        judgeClientFactory: opts.judgeClientFactory,
      })
      return reply.code(202).send({ runId })
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/runs', async () => ({ runs: listRuns(db), activeRunId: activeRunId() }))

  app.get('/api/runs/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const run = getRun(db, id)
    if (!run) return reply.code(404).send({ error: `No run ${id}` })
    // Judgments travel with the listings: the report joins them by listing id
    // in the browser, and re-weighting must not cost a request (spec §5.6).
    return { run, listings: listListings(db, id), judgments: listJudgments(db, id) }
  })

  app.post('/api/runs/:id/cancel', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const ok = cancelRun(id)
    return reply.code(ok ? 200 : 409).send({ cancelled: ok, runId: id })
  })

  /**
   * Live event stream. Replays everything stored so far, then pushes new events
   * as they happen — which is what lets a page refresh mid-run re-attach
   * instead of showing an empty screen.
   */
  app.get('/api/runs/:id/events', (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const run = getRun(db, id)
    if (!run) {
      return reply.code(404).send({ error: `No run ${id}` })
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const send = (event: { seq: number; type: string; at: string; payload: unknown }) => {
      reply.raw.write(`id: ${event.seq}\n`)
      reply.raw.write(`event: ${event.type}\n`)
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    // Replay first.
    const past = listEvents(db, id)
    for (const e of past) send(e)
    reply.raw.write('event: snapshot\n')
    reply.raw.write(
      `data: ${JSON.stringify({ listings: listListings(db, id), run: getRun(db, id) })}\n\n`,
    )

    const unsubscribe = subscribe(id, send)

    // Keep proxies and idle connections from closing the stream.
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  app.get('/api/status', async () => ({ running: isRunning(), activeRunId: activeRunId() }))
}
