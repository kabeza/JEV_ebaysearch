import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../src/server/index'
import { openDatabase } from '../src/storage/db'
import { createSearch } from '../src/storage/searches'
import { createRun, finishRun } from '../src/storage/runs'
import { insertCards } from '../src/storage/listings'
import { saveJudgments, saveQuestionnaire } from '../src/storage/judgments'
import type { RawCard } from '../src/scraper/cards'

const body = {
  name: 'ThinkPad T14s Gen 6',
  keyword: 'Thinkpad T14s gen 6',
  criteriaText: '32gb ram, Ryzen, 1tb, touch screen, under u$s 1600',
  spec: { ram_gb: 32 },
}

const card = (itemId: string): RawCard => ({
  itemId,
  title: `Lenovo ThinkPad T14s ${itemId}`,
  url: `https://www.ebay.com/itm/${itemId}`,
  price: 1200,
  shipping: 0,
  currency: 'USD',
  conditionLabel: 'Open Box',
  sellerName: 'store',
  sellerFeedback: '100% positive (450)',
  watchers: null,
  buyingFormat: 'Buy It Now',
  sponsoredMarker: false,
  rawText: [],
})

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

describe('a search carries its own runs', () => {
  it('lists each search’s runs newest first, and only its own', async () => {
    // The door this closes: the page could not reach a run it had not just
    // started, so a finished report was unreachable from the UI.
    const dir = mkdtempSync(join(tmpdir(), 'jevbrowser-hub-'))
    const dbPath = join(dir, 'hub.db')

    const seed = openDatabase(dbPath)
    const mine = createSearch(seed, { ...body, spec: {} })
    const other = createSearch(seed, { ...body, name: 'other', spec: {} })
    const older = createRun(seed, mine.id, {})
    finishRun(seed, older.id, { status: 'cancelled' })
    const newer = createRun(seed, mine.id, {})
    createRun(seed, other.id, {})
    seed.close()

    const app = buildServer({ dbPath })
    const res = await app.inject({ method: 'GET', url: '/api/searches' })
    const searches = res.json() as { id: number; runs: { id: number; status: string }[] }[]
    await app.close()

    const found = searches.find((s) => s.id === mine.id)!
    expect(found.runs.map((r) => r.id)).toEqual([newer.id, older.id])
    expect(found.runs[1]!.status).toBe('cancelled')
    expect(found.runs[0]).toMatchObject({ listings: 0, rejected: 0, judged: 0 })
    // The other search's run is not on this search's row.
    expect(searches.find((s) => s.id === other.id)!.runs).toHaveLength(1)
  })

  it('gives a search with no runs an empty list rather than omitting the field', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    await app.inject({ method: 'POST', url: '/api/searches', payload: body })
    const res = await app.inject({ method: 'GET', url: '/api/searches' })
    expect(res.json()[0].runs).toEqual([])
    await app.close()
  })
})

describe('DELETE /api/searches/:id', () => {
  it('removes the search and everything under it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevbrowser-del-'))
    const dbPath = join(dir, 'del.db')

    const seed = openDatabase(dbPath)
    const search = createSearch(seed, { ...body, spec: {} })
    const run = createRun(seed, search.id, {})
    const stored = insertCards(seed, run.id, [card('1'), card('2')])
    const questionnaireId = saveQuestionnaire(
      seed,
      run.id,
      { request: body, questionKeys: ['is_target_product'] },
      1,
    )
    saveJudgments(seed, {
      runId: run.id,
      questionnaireId,
      listingId: stored.idsByItemId.get('1')!,
      answers: { is_target_product: { type: 'noul', noul: 0.9 } },
    })
    seed.close()

    const app = buildServer({ dbPath })
    const res = await app.inject({ method: 'DELETE', url: `/api/searches/${search.id}` })
    expect(res.statusCode).toBe(204)

    // The cascade is the schema's, so the proof is that nothing is left behind.
    const after = openDatabase(dbPath)
    expect(after.prepare('select count(*) c from searches').get()).toMatchObject({ c: 0 })
    expect(after.prepare('select count(*) c from runs').get()).toMatchObject({ c: 0 })
    expect(after.prepare('select count(*) c from listings').get()).toMatchObject({ c: 0 })
    expect(after.prepare('select count(*) c from judgments').get()).toMatchObject({ c: 0 })
    expect(after.prepare('select count(*) c from questionnaires').get()).toMatchObject({ c: 0 })
    after.close()
    await app.close()
  })

  it('refuses while a run of that search is working, and removes nothing', async () => {
    // A run holds the one-job lock and is writing to the very rows a delete would
    // remove under it (rule 9). 409 rather than 500, and nothing deleted.
    const dir = mkdtempSync(join(tmpdir(), 'jevbrowser-busy-'))
    const dbPath = join(dir, 'busy.db')

    const seed = openDatabase(dbPath)
    const search = createSearch(seed, { ...body, spec: {} })
    // A second search with no runs of its own: the lock belongs to the first, so
    // this one must still delete. Without the ownership check in the route, "a job
    // is active" would refuse every search.
    const innocent = createSearch(seed, { ...body, name: 'innocent', spec: {} })
    seed.close()

    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const blocking = {
      async goto() {
        await held
        return { status: 200 }
      },
      async title() {
        return 'eBay'
      },
      async readCards() {
        return []
      },
      async screenshot() {},
      async close() {},
    }

    const app = buildServer({
      dbPath,
      sourceFactory: async () => blocking as never,
      judgeClientFactory: () =>
        ({
          systemOne: async () => ({
            model: 'fake',
            answers: {},
            usage: { input_tokens: 0, output_tokens: 0 },
          }),
        }) as never,
    })

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { searchId: search.id },
    })
    expect(started.statusCode).toBe(202)

    const refused = await app.inject({ method: 'DELETE', url: `/api/searches/${search.id}` })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toMatch(/in progress/i)

    const still = openDatabase(dbPath)
    expect(still.prepare('select count(*) c from searches').get()).toMatchObject({ c: 2 })
    still.close()

    // The lock is that run's, not every search's: another search still deletes.
    const unrelated = await app.inject({
      method: 'DELETE',
      url: `/api/searches/${innocent.id}`,
    })
    expect(unrelated.statusCode).toBe(204)

    const after = openDatabase(dbPath)
    const left = after.prepare('select id from searches').all() as { id: number }[]
    expect(left.map((r) => r.id)).toEqual([search.id])
    after.close()

    release()
    await app.close()
  })

  it('answers 404 for a search that does not exist, twice over', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    expect((await app.inject({ method: 'DELETE', url: '/api/searches/999' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: '/api/searches/999' })).statusCode).toBe(404)
    await app.close()
  })

  it('deletes a search that has never had a run', async () => {
    const app = buildServer({ dbPath: ':memory:' })
    const created = await app.inject({ method: 'POST', url: '/api/searches', payload: body })
    const id = created.json().id as number
    expect((await app.inject({ method: 'DELETE', url: `/api/searches/${id}` })).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/api/searches' })).json()).toEqual([])
    await app.close()
  })
})
