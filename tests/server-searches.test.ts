import { describe, it, expect } from 'vitest'
import { buildServer } from '../src/server/index'

const body = {
  name: 'ThinkPad T14s Gen 6',
  keyword: 'Thinkpad T14s gen 6',
  criteriaText: '32gb ram, Ryzen, 1tb, touch screen, under u$s 1600',
  spec: { ram_gb: 32 },
}

describe('searches API', () => {
  it('starts with no searches', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    const res = await app.inject({ method: 'GET', url: '/api/searches' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await app.close()
  })

  it('creates a search and returns it in the list', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    const created = await app.inject({ method: 'POST', url: '/api/searches', payload: body })
    expect(created.statusCode).toBe(201)
    expect(created.json().id).toBeGreaterThan(0)

    const list = await app.inject({ method: 'GET', url: '/api/searches' })
    expect(list.json()).toHaveLength(1)
    expect(list.json()[0].keyword).toBe('Thinkpad T14s gen 6')
    await app.close()
  })

  it('rejects a search with no keyword', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/searches',
      payload: { ...body, keyword: '   ' },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})
