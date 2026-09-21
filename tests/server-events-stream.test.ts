import { describe, it, expect } from 'vitest'
import { get as httpGet } from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildServer } from '../src/server/index'
import { isRunning } from '../src/pipeline/runner'
import type { PageSource } from '../src/scraper/browser'
import type { RawCard } from '../src/scraper/cards'
import type { JevAnswer, JevClient, JevRequest, JevResult } from '../src/jev/client'

function card(itemId: string): RawCard {
  return {
    itemId,
    title: `Lenovo ThinkPad T14s Gen 6 ${itemId}`,
    url: `https://www.ebay.com/itm/${itemId}`,
    price: 1200,
    shipping: 0,
    currency: 'USD',
    conditionLabel: 'Brand New',
    sellerName: 'store',
    sellerFeedback: '99% positive (1K)',
    watchers: 2,
    buyingFormat: 'Buy It Now',
    sponsoredMarker: false,
    rawText: ['$1,200.00'],
  }
}

/** Answers any question asked, so a live-path run behaves like a real one. */
function fakeJevClient(): JevClient {
  return {
    async systemOne(req: JevRequest): Promise<JevResult> {
      const answers: Record<string, JevAnswer> = {}
      for (const key of Object.keys(req.questions)) {
        answers[key] = { type: 'noul', noul: 0.9 }
      }
      return { model: 'fake', answers, usage: { input_tokens: 0, output_tokens: 0 } }
    },
  }
}

/** A gate the fake page source waits on, so the run can be held mid-flight. */
function makeGate() {
  let release: () => void = () => {}
  const opened = new Promise<void>((r) => {
    release = r
  })
  return { release: () => release(), opened }
}

async function waitForIdle(timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  while (isRunning() && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** A promise that resolves once `predicate()` is true, or rejects on timeout. */
async function until(predicate: () => boolean, ms = 8000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

interface SseEvent {
  id: number | null
  event: string
  data: unknown
}

/** Opens the SSE endpoint and records every event as it arrives. */
function openStream(url: string) {
  const events: SseEvent[] = []
  let buffer = ''

  const done = new Promise<void>((resolve, reject) => {
    const req = httpGet(url, (res) => {
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('text/event-stream')
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          if (!raw.startsWith(':')) {
            const idLine = /^id: (\d+)$/m.exec(raw)
            const eventLine = /^event: (.*)$/m.exec(raw)
            const dataLine = /^data: (.*)$/m.exec(raw)
            events.push({
              id: idLine ? Number(idLine[1]) : null,
              event: eventLine ? eventLine[1]!.trim() : 'message',
              data: dataLine ? JSON.parse(dataLine[1]!) : null,
            })
          }
          boundary = buffer.indexOf('\n\n')
        }
      })
      res.on('end', resolve)
    })
    req.on('error', reject)
    // The route never closes the stream itself; the test ends it.
    setTimeout(() => req.destroy(), 15_000).unref()
  })

  return {
    events,
    done,
    types: () => events.map((e) => e.event),
    close: () => undefined,
  }
}

/**
 * Guards the layer Friday's bug lived in: the SSE HTTP route must PUSH events
 * over an already-open connection. A stream that only ever replays stored
 * events looks perfect in curl after a run has finished, and is useless live —
 * which is exactly how this failed twice.
 */
describe('run event stream (HTTP)', () => {
  it('pushes events over an open connection as the run happens', async () => {
    const gate = makeGate()
    const source: PageSource = {
      async goto() {
        await gate.opened
        return { status: 200 }
      },
      async title() {
        return 'ThinkPad T14s Gen 6 for sale | eBay'
      },
      async readCards() {
        return [card('111111111'), card('222222222')]
      },
      async readListing() {
        return {
          title: 'Lenovo ThinkPad T14s Gen 6 32GB RAM 1TB SSD',
          price: 1200,
          shipping: 0,
          condition: 'Open Box',
          sellerName: 'store',
          sellerFeedback: '99% positive',
          specifics: { Brand: 'Lenovo' },
          rawText: ['Brand Lenovo'],
        }
      },
      async screenshot() {},
      async close() {},
    }

    const app = buildServer({
      dbPath: ':memory:',
      sourceFactory: async () => source,
      judgeClientFactory: fakeJevClient,
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port

    // A search with no stored settings, so the run settings come from the request.
    const created = await app.inject({
      method: 'POST',
      url: '/api/searches',
      payload: { name: 'stream guard', keyword: 'thinkpad', criteriaText: '' },
    })
    const searchId = created.json().id as number

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs',
      // Detail visits off: this test is about the stream, not listing pages, and
      // a real visit paces for seconds per survivor.
      payload: {
        searchId,
        settings: { maxPages: 2, pacingMinMs: 5, pacingMaxMs: 10, maxDetailVisits: 0 },
      },
    })
    expect(started.statusCode).toBe(202)
    const runId = started.json().runId as number

    // Attach while the run is held at the gate: replay has nothing but
    // run.started, and the stream then has to sit idle.
    const stream = openStream(`http://127.0.0.1:${port}/api/runs/${runId}/events`)
    await until(() => stream.types().includes('snapshot'))

    const beforeRelease = stream.types()
    expect(beforeRelease).toEqual(['run.started', 'snapshot'])

    gate.release()
    await until(() => stream.types().includes('run.finished'))

    // These arrived on the connection that was already open and idle — the
    // only way they can be here is the server pushing them.
    expect(stream.types()).toContain('page.fetched')
    expect(stream.types()).toContain('cards.extracted')
    expect(stream.types()).toContain('run.finished')
    expect(new Set(stream.events.map((e) => e.id!)).size).toBe(stream.events.length)

    await waitForIdle()
    await app.close()
  }, 20_000)

  it('serves the snapshot and the run read path with listings mid-run', async () => {
    const gate = makeGate()
    const source: PageSource = {
      async goto() {
        await gate.opened
        return { status: 200 }
      },
      async title() {
        return 'ThinkPad T14s Gen 6 for sale | eBay'
      },
      async readCards() {
        return [card('333333333'), card('444444444')]
      },
      async readListing() {
        return {
          title: 'Lenovo ThinkPad T14s Gen 6 32GB RAM 1TB SSD',
          price: 1200,
          shipping: 0,
          condition: 'Open Box',
          sellerName: 'store',
          sellerFeedback: '99% positive',
          specifics: { Brand: 'Lenovo' },
          rawText: ['Brand Lenovo'],
        }
      },
      async screenshot() {},
      async close() {},
    }

    const app = buildServer({
      dbPath: ':memory:',
      sourceFactory: async () => source,
      judgeClientFactory: fakeJevClient,
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port

    const created = await app.inject({
      method: 'POST',
      url: '/api/searches',
      payload: { name: 'snapshot guard', keyword: 'thinkpad', criteriaText: '' },
    })
    const searchId = created.json().id as number

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        searchId,
        settings: { maxPages: 1, pacingMinMs: 5, pacingMaxMs: 10, maxDetailVisits: 0 },
      },
    })
    const runId = started.json().runId as number

    const stream = openStream(`http://127.0.0.1:${port}/api/runs/${runId}/events`)
    await until(() => stream.types().includes('snapshot'))
    const snapshot = stream.events.find((e) => e.event === 'snapshot')!.data as {
      run: { id: number; status: string }
      listings: unknown[]
    }
    expect(snapshot.run.id).toBe(runId)
    expect(snapshot.run.status).toBe('running')

    gate.release()
    await until(() => stream.types().includes('cards.extracted'))

    // The read path the UI falls back on must already show the stored rows.
    const midRun = await app.inject({ method: 'GET', url: `/api/runs/${runId}` })
    expect(midRun.json().listings).toHaveLength(2)
    expect(midRun.json().listings[0].title).toContain('ThinkPad')

    await until(() => stream.types().includes('run.finished'))
    await waitForIdle()
    await app.close()
  }, 20_000)
})
