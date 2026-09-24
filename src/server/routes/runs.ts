import type { FastifyInstance } from 'fastify'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { getRun, listRuns } from '../../storage/runs'
import { listJudgeable, listListings } from '../../storage/listings'
import { listEvents } from '../../storage/events'
import { listJudgments, listQuestionnaires } from '../../storage/judgments'
import {
  activeRunId,
  cancelRun,
  isRunning,
  startRejudge,
  startRun,
  subscribe,
} from '../../pipeline/runner'
import type { PageSource } from '../../scraper/browser'
import type { JevClient } from '../../jev/client'
import { validateDraft, type QuestionnaireDraft } from '../../jev/draft'

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
    // Every questionnaire version's judgments travel too, each carrying its
    // `questionnaireId`: the report shows one version and a row's diff compares
    // it with the previous one, so filtering per request would cost a request
    // per comparison (spec §3 decision 4).
    return {
      run,
      listings: listListings(db, id),
      judgments: listJudgments(db, id),
      questionnaires: listQuestionnaires(db, id).map((q) => ({
        id: q.id,
        version: q.version,
        createdAt: q.createdAt,
        definition: q.definition,
      })),
    }
  })

  /**
   * Re-judges a stored run's listings under an edited question set. No page load
   * and no scrape: everything the questions need is already stored.
   */
  app.post('/api/runs/:id/rejudge', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const run = getRun(db, id)
    if (!run) return reply.code(404).send({ error: `No run ${id}` })

    const draft = request.body as QuestionnaireDraft
    // Checked here as well as inside the pipeline: a bad edit should be one 400
    // with its reasons, not a background job that fails a second later.
    const reasons = validateDraft(draft)
    if (reasons.length > 0) {
      return reply
        .code(400)
        .send({ error: `This question set cannot be judged: ${reasons.join(' ')}`, reasons })
    }
    // Nothing to re-ask: the spec's §9 table promises a refusal here, and the
    // alternative is a 202 carrying a version number that will never exist.
    if (listJudgeable(db, id).length === 0) {
      return reply
        .code(400)
        .send({ error: `Run ${id} has no listings to judge: the pre-filter kept none.` })
    }

    try {
      const { version } = startRejudge(db, {
        runId: id,
        draft,
        judgeClientFactory: opts.judgeClientFactory,
      })
      return reply.code(202).send({ runId: id, version })
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) })
    }
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
