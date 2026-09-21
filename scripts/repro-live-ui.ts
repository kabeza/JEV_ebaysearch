/**
 * Reproduces a live run in the real browser UI with no eBay: a local HTTP server
 * serves the captured eBay fixture, a real Playwright page scrapes it through the
 * real `extractCards`, and the real Vite page renders the run.
 *
 * EventSource and fetch are instrumented from outside the React app, so it can be
 * seen exactly which listeners fire — the question the UI bug turns on.
 *
 * Usage: start `npm run dev:web` first, then
 *   node --import tsx scripts/repro-live-ui.ts
 */
import { createServer } from 'node:http'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { buildServer } from '../src/server/index.js'
import { extractCards } from '../src/scraper/cards.js'
import { extractDetail } from '../src/scraper/listing.js'
import type { PageSource } from '../src/scraper/browser.js'
import type { JevAnswer, JevClient, JevRequest, JevResult } from '../src/jev/client.js'

const DB = 'data/repro.db'
const APP = 'http://127.0.0.1:5173'
const FIXTURE = readFileSync('tests/fixtures/ebay/srp-results.html', 'utf8')
const LISTING_FIXTURE = readFileSync('tests/fixtures/ebay/listing-t14s.html', 'utf8')
const FIXTURE_PORT = 3999
const PAGES = 1

/** The results fixture is the bare `ul.srp-results` element, so wrap it in a page. */
function fixturePage(): string {
  return `<!doctype html><html><body>${FIXTURE}</body></html>`
}

/** `/` is a results page, `/listing` is a listing page. */
/**
 * A stand-in for JEV: answers plausibly and varies by listing, so the panel
 * shows real-looking numbers — including one near the fence — without spending
 * anything or needing an API key.
 */
function fakeJevClient(): JevClient {
  let seen = 0
  return {
    async systemOne(req: JevRequest): Promise<JevResult> {
      const answers: Record<string, JevAnswer> = {}
      for (const key of Object.keys(req.questions)) {
        const short = key.split('.').pop() ?? ''
        const n = seen++
        const wobble = short === 'is_target_product' && n % 7 === 0 ? 0.52 : 0.9 + (n % 9) / 100
        answers[key] =
          short === 'listing_trust' || short === 'price_value'
            ? {
                type: 'score',
                score: 2 + (n % 5) / 10,
                confidence: 0.4 + (n % 6) / 10,
                legend: { '0': 'warning signs', '1': 'something is off', '2': 'ordinary', '3': 'solid', '4': 'fully reassuring' },
                probabilities: { '0': 0.05, '1': 0.1, '2': 0.5, '3': 0.3, '4': 0.05 },
              }
            : { type: 'noul', noul: Math.min(0.98, wobble) }
      }
      return { model: 'fake', answers, usage: { input_tokens: 8_000, output_tokens: 200 } }
    },
  }
}

const fixtureServer = createServer((req, res) => {
  const isListing = (req.url ?? '').startsWith('/listing')
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(isListing ? LISTING_FIXTURE : fixturePage())
})

async function main() {
  rmSync(DB, { force: true })
  rmSync(`${DB}-wal`, { force: true })
  rmSync(`${DB}-shm`, { force: true })

  await new Promise<void>((r) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', r))

  // A real browser, real extraction, real pacing — only the URL is not eBay.
  const scraperBrowser = await chromium.launch()
  const scraperPage = await scraperBrowser.newPage()
  let pagesRead = 0
  const source: PageSource = {
    async goto(url: string) {
      const isListing = url.includes('/itm/')
      if (!isListing && pagesRead >= PAGES) return { status: 404 }
      await scraperPage.goto(`http://127.0.0.1:${FIXTURE_PORT}${isListing ? '/listing' : '/'}`, {
        waitUntil: 'domcontentloaded',
      })
      return { status: 200 }
    },
    async title() {
      return await scraperPage.title()
    },
    async readCards() {
      pagesRead++
      return extractCards(scraperPage)
    },
    async readListing() {
      return extractDetail(scraperPage)
    },
    async screenshot() {},
    async close() {},
  }

  const server = buildServer({
    dbPath: DB,
    // Mimics the real path's dead time: launching a browser and loading eBay's
    // first results page takes seconds, during which the stream sits idle.
    judgeClientFactory: fakeJevClient,
    sourceFactory: async () => {
      pagesRead = 0
      console.log('sourceFactory: idling 4s like a real browser launch…')
      await new Promise((r) => setTimeout(r, 4_000))
      return source
    },
  })
  await server.listen({ port: 3001, host: '127.0.0.1' })


  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.addInitScript(`
    window.__log = []
    const Orig = window.EventSource
    class Patched extends Orig {
      constructor(url, init) { super(url, init); window.__log.push(['es.open', url]) }
      addEventListener(type, cb, opts) {
        window.__log.push(['es.listen', type])
        return super.addEventListener(type, (e) => {
          window.__log.push(['es.fire', type])
          return cb(e)
        }, opts)
      }
    }
    window.EventSource = Patched
    const origFetch = window.fetch
    window.fetch = async (...args) => {
      const res = await origFetch(...args)
      window.__log.push(['fetch', String(args[0]).replace(location.origin, ''), res.status])
      return res
    }
  `)
  page.on('console', (m) => {
    if (!m.text().includes('[vite]')) console.log(`  [console.${m.type()}] ${m.text()}`)
  })
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`))

  await page.goto(APP)
  // Create the search through the API so run settings are under our control.
  const created = await page.evaluate(async () => {
    const res = await fetch('/api/searches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Repro search',
        keyword: 'fake keyword',
        criteriaText: 'fake criteria',
        settings: { maxPages: 1, maxDetailVisits: 3, pacingMinMs: 200, pacingMaxMs: 400 },
        spec: { ram_gb: 32, storage_gb: 512, touch: true, cpu_family: 'AMD', max_price: 1600 },
      }),
    })
    return res.json()
  })
  console.log('search created:', JSON.stringify(created))
  await page.reload()
  await page.waitForSelector('button:has-text("Run search")')

  await page.click('button:has-text("Run search")')
  await page.waitForSelector('table')

  const samples: string[] = []
  const sampleRun = async (label: string) => {
    const started = Date.now()
    while (Date.now() - started < 60_000) {
      const status = await page
        .locator('h2 span')
        .first()
        .textContent()
        .catch(() => '?')
      const rows = await page.locator('table tbody tr').count()
      const stats = await page.locator('h2 + p, header p').first().textContent().catch(() => '')
      samples.push(
        `${label} t=${((Date.now() - started) / 1000).toFixed(1)}s status=${status} rows=${rows} | ${stats}`,
      )
      if (status === 'complete' || status === 'failed') return
      await page.waitForTimeout(1500)
    }
  }
  await sampleRun('run1')

  // A second run in the same page session: new runId, new EventSource.
  await page.click('button:has-text("Run search")')
  await page.waitForTimeout(500)
  await sampleRun('run2')

  const log = await page.evaluate(() => (window as never as { __log: unknown[][] }).__log)
  console.log('\n--- samples ---')
  console.log(samples.join('\n'))
  console.log('\n--- fires only ---')
  for (const entry of log) if (entry[0] === 'es.fire') console.log(entry.map(String).join(' '))
  console.log('\n--- fetch/opens ---')
  for (const entry of log) if (entry[0] !== 'es.fire') console.log(entry.map(String).join(' '))

  const finalRows = await page.locator('table tbody tr').count()
  const firstRow = await page.locator('table tbody tr >> nth=0').innerText().catch(() => '(none)')
  console.log(`\nfinal rows=${finalRows} firstRow=${JSON.stringify(firstRow.slice(0, 80))}`)

  // The pre-filter's visible outcome: survivors above, rejects with reasons below.
  const summary = await page.locator('details summary').textContent().catch(() => '(no rejects)')
  await page.locator('details summary').click().catch(() => {})
  const rejectedRows = await page.evaluate(() => {
    const details = document.querySelector('details')
    if (!details) return []
    const rows = details.querySelectorAll('tbody tr')
    return Array.from(rows)
      .slice(0, 6)
      .map((r) => Array.from(r.querySelectorAll('td')).map((td) => td.textContent ?? ''))
  })
  console.log(`\nfiltered summary: ${summary}`)
  for (const r of rejectedRows) console.log(`  reject: ${r[0]?.slice(0, 60)} | ${r[2]}`)
  const stats = await page.locator('header p').first().textContent().catch(() => '')
  console.log(`header stats: ${stats}`)

  const answers = await page
    .locator('table tbody tr td ul')
    .first()
    .innerText()
    .catch(() => '(no answers shown)')
  console.log(`\nanswers panel:\n${answers.split('\n').slice(0, 7).join('\n')}`)

  // When the panel is empty, the HTML says why; guessing wastes a cycle.
  if (answers === '(no answers shown)') {
    const html = await page.content()
    writeFileSync('/tmp/repro-panel.html', html)
    console.log(
      `dumped ${html.length} bytes | <dl>: ${(html.match(/<dl/g) ?? []).length}` +
        ` | <ul>: ${(html.match(/<ul/g) ?? []).length}` +
        ` | no-answers text: ${html.includes('No answers for this listing')}`,
    )
  }

  // The expanded row: item specifics from the listing page, and the six JEV
  // answers. Waits are explicit so the checks measure the render, not a race.
  await page.locator('table tbody tr button').first().click()
  await page.waitForSelector('text=Is the product itself', { timeout: 10_000 }).catch(() => {})

  const panelOpen = await page.locator('text=Is the product itself').count()
  console.log(`\nanswers panel rendered: ${panelOpen > 0}`)
  if (panelOpen > 0) {
    const panel = await page.locator('table tbody tr td ul').first().innerText()
    console.log(panel.split('\n').slice(0, 12).join('\n'))
  } else {
    const html = await page.content()
    writeFileSync('/tmp/repro-panel.html', html)
    console.log(
      `dumped ${html.length} bytes | <dl>: ${(html.match(/<dl/g) ?? []).length}` +
        ` | no-answers: ${html.includes('No answers for this listing')}` +
        ` | answered-anywhere: ${html.includes('Is the product itself')}`,
    )
  }

  const specifics = await page
    .locator('table tbody tr td dl')
    .first()
    .innerText()
    .catch(() => '(no specifics panel)')
  console.log(`\nspecifics panel:\n${specifics.split('\n').slice(0, 8).join('\n')}`)

  await browser.close()
  await scraperBrowser.close()
  await server.close()
  fixtureServer.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
