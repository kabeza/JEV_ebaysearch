import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../src/server/index'
import { openDatabase } from '../src/storage/db'
import { createSearch } from '../src/storage/searches'
import { createRun, getRun, updateRunStatus, finishRun } from '../src/storage/runs'
import { listEvents } from '../src/storage/events'

/**
 * These cover the read paths and the validation paths of the runs API. Starting
 * a real run would launch a browser, so the run itself is covered by
 * pipeline-run.test.ts against an injected page source.
 */
describe('runs API', () => {
  it('reports no runs initially and nothing active', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    const res = await app.inject({ method: 'GET', url: '/api/runs' })
    expect(res.statusCode).toBe(200)
    expect(res.json().runs).toEqual([])
    expect(res.json().activeRunId).toBeNull()
    await app.close()
  })

  it('rejects a run request with no searchId', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/searchId/)
    await app.close()
  })

  it('returns 409 when the search does not exist, rather than starting anything', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { searchId: 4242 } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/No search with id 4242/)
    await app.close()
  })

  it('returns 404 for an unknown run', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    const res = await app.inject({ method: 'GET', url: '/api/runs/999' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('returns 404 for an unknown run event stream', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    const res = await app.inject({ method: 'GET', url: '/api/runs/999/events' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('reports idle status', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    const res = await app.inject({ method: 'GET', url: '/api/status' })
    expect(res.json()).toEqual({ running: false, activeRunId: null })
    await app.close()
  })
})

describe('a run left paused when the process ended', () => {
  it('is swept to cancelled at startup, so the row is usable again', async () => {
    // A pause lives in the process: the wait is a promise and the browser it
    // holds is in memory. So a run that was paused when the server stopped has
    // nobody left to resume it — and left as `paused` the row offered a Resume
    // button that always 409s, a Cancel that always 409s, and an Edit-questions
    // gate that refuses a run with no final status, so it could never be
    // re-judged. Rule 13 makes this easy to hit: the dev server must be
    // restarted after any change under `src/`.
    const dir = mkdtempSync(join(tmpdir(), 'jevbrowser-sweep-'))
    const dbPath = join(dir, 'sweep.db')

    const seed = openDatabase(dbPath)
    const search = createSearch(seed, { name: 's', keyword: 'k', criteriaText: '' })
    const orphan = createRun(seed, search.id, {})
    updateRunStatus(seed, orphan.id, 'paused')
    const done = createRun(seed, search.id, {})
    finishRun(seed, done.id, { status: 'complete' })
    seed.close()

    const app = buildServer({ dbPath })
    const swept = await app.inject({ method: 'GET', url: `/api/runs/${orphan.id}` })
    expect(swept.json().run.status).toBe('cancelled')
    expect(swept.json().run.finishedAt).toBeTruthy()
    expect(swept.json().run.error).toMatch(/restarted|no longer running/i)

    // A run that had already finished is left exactly as it was.
    const untouched = await app.inject({ method: 'GET', url: `/api/runs/${done.id}` })
    expect(untouched.json().run.status).toBe('complete')
    expect(untouched.json().run.error).toBeNull()

    await app.close()

    // And the sweep is recorded, not silent: the next page to open this run
    // says why it ended.
    const after = openDatabase(dbPath)
    expect(listEvents(after, orphan.id).map((e) => e.type)).toContain('run.cancelled')
    expect(getRun(after, orphan.id)?.status).toBe('cancelled')
    after.close()
  })
})
