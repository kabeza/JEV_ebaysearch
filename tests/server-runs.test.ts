import { describe, it, expect } from 'vitest'
import { buildServer } from '../src/server/index'

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
