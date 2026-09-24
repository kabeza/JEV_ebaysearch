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
import { WEIGHTED_SIGNALS } from '../web/src/lib/score.js'
import { extractDetail } from '../src/scraper/listing.js'
import type { PageSource } from '../src/scraper/browser.js'
import type { JevAnswer, JevClient, JevRequest, JevResult } from '../src/jev/client.js'

const DB = 'data/repro.db'
const APP = 'http://127.0.0.1:5173'
const FIXTURE = readFileSync('tests/fixtures/ebay/srp-results.html', 'utf8')
const LISTING_FIXTURE = readFileSync('tests/fixtures/ebay/listing-t14s.html', 'utf8')
const FIXTURE_PORT = 3999
const PAGES = 2

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
        // A question the repro's editor has edited answers differently, so the
        // row diff has a real change to show rather than two identical numbers.
        const edited = JSON.stringify(req.questions[key]).includes('Edited by the repro')
        const wobble = edited ? 0.7 : short === 'is_target_product' && n % 7 === 0 ? 0.52 : 0.9 + (n % 9) / 100
        answers[key] =
          short === 'listing_trust' || short === 'price_value'
            ? {
                type: 'score',
                score: 2 + (n % 5) / 10,
                confidence: 0.4 + (n % 6) / 10,
                legend: { '0': 'warning signs', '1': 'something is off', '2': 'ordinary', '3': 'solid', '4': 'fully reassuring' },
                probabilities: { '0': 0.05, '1': 0.1, '2': 0.5, '3': 0.3, '4': 0.05 },
              }
            : { type: 'noul', noul: edited ? 0.7 : Math.min(0.98, wobble) }
      }
      return { model: 'fake', answers, usage: { input_tokens: 8_000, output_tokens: 200 } }
    },
  }
}

/**
 * Counts every page the scraper is served. Stage 7's acceptance criterion is that
 * a re-judge adds zero to this number: it re-asks about listings already stored,
 * so it must not touch eBay — or, here, the fixture standing in for it.
 */
let fixtureRequests = 0

const fixtureServer = createServer((req, res) => {
  fixtureRequests++
  const url = req.url ?? ''
  res.writeHead(200, { 'content-type': 'text/html' })
  // What a challenge looks like to the pipeline: a title it recognises and a
  // status that is not 200.
  if (url.startsWith('/challenge')) {
    res.end('<!doctype html><html><head><title>Pardon Our Interruption</title></head><body>challenge</body></html>')
    return
  }
  res.end(url.startsWith('/listing') ? LISTING_FIXTURE : fixturePage())
})

/** Served once, so one Resume is enough to get past it. */
let challengesServed = 0

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
      // A challenge on the second results page, once: the run pauses, the page
      // offers Resume, and the same page is fetched again afterwards.
      if (!isListing && /[?&]_pgn=2/.test(url) && challengesServed === 0) {
        challengesServed++
        await scraperPage.goto(`http://127.0.0.1:${FIXTURE_PORT}/challenge`, {
          waitUntil: 'domcontentloaded',
        })
        return { status: 503 }
      }
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
        settings: { maxPages: 2, maxDetailVisits: 3, pacingMinMs: 200, pacingMaxMs: 400 },
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
  let pausesSeen = 0
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
      // The person at the keyboard: a paused run is resumed from the page.
      if (status === 'paused') {
        pausesSeen++
        await page.getByRole('button', { name: 'Resume' }).click()
      }
      await page.waitForTimeout(1500)
    }
  }
  await sampleRun('run1')

  // A second run in the same page session: new runId, new EventSource.
  await page.click('button:has-text("Run search")')
  await page.waitForTimeout(500)
  await sampleRun('run2')

  console.log(`\n--- stage 8: a challenge on page 2 ---`)
  console.log(`paused runs seen on the page: ${pausesSeen}`)

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

  // The report orders rows by blend, so the first row is not necessarily one
  // whose listing page was opened. Expand a row that has one: the expand
  // button's title says which, which is why it is still there.
  const withDetail = page.locator('table tbody tr button[title="Show item specifics"]').first()
  if (await withDetail.count()) {
    await withDetail.click()
    await page.waitForTimeout(300)
  }
  const specifics = await page
    .locator('table tbody tr td dl')
    .first()
    .innerText()
    .catch(() => '(no specifics panel)')
  console.log(`\nspecifics panel:\n${specifics.split('\n').slice(0, 8).join('\n')}`)

  // The feedback cell, in both of its shapes: a badged seller and one with no
  // badge. The count belongs in both (spec §6) — 99.5% of 14.7K is not 99.5% of
  // 3 — and this is the cell that once printed the percentage twice.
  const feedbackCells = await page.evaluate(() =>
    [...document.querySelectorAll('table tbody tr')]
      .map((tr) => (tr.querySelector('td:nth-child(6)')?.textContent ?? '').trim())
      .filter((text) => text.length > 0),
  )
  const barePercent = feedbackCells.filter((text) => /^\d+(\.\d+)?%$/.test(text))
  console.log(`\nfeedback cells:\n${feedbackCells.slice(0, 8).join('\n')}`)
  console.log(`feedback cells showing a percentage with no count: ${barePercent.length}`)

  // The acceptance criterion that cannot be tested without a browser: moving a
  // control re-sorts the table with zero network requests (spec §5.6).
  const fetchCount = async () =>
    page.evaluate(() =>
      (window as never as { __log: unknown[][] }).__log.filter((e) => e[0] === 'fetch').length,
    )
  /**
   * Drive a controlled range input the way a person does.
   *
   * Assigning `input.value` directly does NOT work: React keeps its own value
   * tracker for the element, sees no change, and skips onChange — which
   * produced a passing "0 requests" on a slider that never moved. The native
   * setter goes around the tracker, and the input event then reaches React.
   */
  const setRange = (label: string, value: string) =>
    page.evaluate(
      ({ label, value }) => {
        const input = document.querySelector(
          `input[aria-label="${label}"]`,
        ) as HTMLInputElement | null
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set
        setter?.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      },
      { label, value },
    )

  const before = await fetchCount()
  const firstBefore = await page.locator('tbody tr >> nth=0').innerText()
  const moved = await setRange('weight spec_match', '0')
  await page.waitForTimeout(300)
  const after = await fetchCount()
  const firstAfter = await page.locator('tbody tr >> nth=0').innerText()
  const gateMoved = await setRange('gate condition_ok', '0.95')
  await page.waitForTimeout(300)
  const afterGate = await fetchCount()

  // Did React actually re-render? The slider's own readout answers it: if the
  // number beside the slider still says 1.0, the change never reached the
  // component, and the request count above proves nothing about re-sorting.
  const readout = await page.evaluate(() => {
    const input = document.querySelector(
      'input[aria-label="weight spec_match"]',
    ) as HTMLInputElement | null
    return input ? { value: input.value, shown: input.nextElementSibling?.textContent ?? '' } : null
  })

  console.log(`\ncontrols: weight slider found=${moved} gate slider found=${gateMoved}`)
  console.log(`weight spec_match now: ${JSON.stringify(readout)}`)
  console.log(`requests during a weight change: ${after - before}`)
  console.log(`requests during a gate change: ${afterGate - after}`)
  // Print the tail of the row too: its title often survives a re-sort, and the
  // cell that actually moved (the blend) is further along.
  console.log(`first row changed by the weight: ${firstBefore !== firstAfter}`)
  console.log(`first row before: ${JSON.stringify(firstBefore.slice(0, 60))} … ${JSON.stringify(firstBefore.slice(-60))}`)
  console.log(`first row after:  ${JSON.stringify(firstAfter.slice(0, 60))} … ${JSON.stringify(firstAfter.slice(-60))}`)

  // Stage 7's acceptance criterion, measured where it is claimed: editing the
  // questions and re-judging the stored listings touches eBay not at all.
  const pagesBeforeRejudge = fixtureRequests
  const rejudgeButton = page.getByRole('button', { name: 'Edit questions' })
  const editorOpened = await rejudgeButton
    .click()
    .then(() => true)
    .catch(() => false)
  await page.waitForTimeout(200)

  const edited = await page.evaluate(() => {
    const textarea = document.querySelector(
      'textarea[aria-label="instructions criteria_freeform"]',
    ) as HTMLTextAreaElement | null
    if (!textarea) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, 'Edited by the repro: does this satisfy the buyer, really?')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })

  if (edited) {
    await page.getByRole('button', { name: /Re-judge/ }).click()
    // The re-judge is a background job over ~28 stored listings; wait for its
    // version to appear in the selector rather than for a fixed delay.
    for (let i = 0; i < 60; i++) {
      const options = await page.locator('select[aria-label="questionnaire version"] option').count()
      if (options >= 2) break
      await page.waitForTimeout(250)
    }
  }
  const pagesAfterRejudge = fixtureRequests
  const versions = await page
    .locator('select[aria-label="questionnaire version"] option')
    .allInnerTexts()

  console.log(`\nre-judge: editor opened=${editorOpened} textarea found=${edited}`)
  console.log(`fixture pages fetched during a re-judge: ${pagesAfterRejudge - pagesBeforeRejudge}`)
  console.log(`questionnaire versions offered: ${JSON.stringify(versions)}`)

  // The third acceptance criterion: the previous version's answers are still
  // readable, beside the new ones. Open the first row and look for "was".
  // An earlier check already expanded a row, and clicking its button again would
  // close it — so open one only when none is open.
  const anyOpen = await page.locator('table tbody [aria-expanded="true"]').count()
  if (anyOpen === 0) {
    await page
      .locator('table tbody tr button[aria-expanded]')
      .first()
      .click({ timeout: 5000 })
      .catch(() => undefined)
    await page.waitForTimeout(400)
  }
  const diffLines = await page.evaluate(() =>
    [...document.querySelectorAll('table tbody li')]
      .map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter((text) => text.includes('was ')),
  )
  // The edited question is the whole point: its answer is the one that must move,
  // and the previous version's answer must still be there to compare against.
  // `textContent` does not lay the DOM out, so it inserts no spaces between
  // elements where `innerText` did — the pattern allows for either.
  const answerMoved = diffLines.some((line) => /70%\s*was /.test(line))
  console.log(`diff lines on the first row: ${JSON.stringify(diffLines)}`)
  console.log(`the edited question's answer moved: ${answerMoved}`)

  // The two states the report used to tell apart wrongly. Every weight at zero
  // is news — the reader turned them off. No answers yet is not: that is simply
  // what a run looks like in its first seconds, and the banner fired there too.
  const bodyText = () => page.evaluate(() => document.body.innerText)
  for (const signal of WEIGHTED_SIGNALS) await setRange(`weight ${signal}`, '0')
  await page.waitForTimeout(200)
  const bannerWhenAllZero = (await bodyText()).includes('Every weight is zero')
  await setRange('weight spec_match', '1')
  await page.waitForTimeout(200)
  const bannerWhenNotZero = (await bodyText()).includes('Every weight is zero')
  console.log(`\nbanner with every weight at zero: ${bannerWhenAllZero}`)
  console.log(`banner with one weight restored: ${bannerWhenNotZero}`)

  // Every judged row gated out, so the table has no rows to show at all.
  await setRange('gate is_target_product', '1')
  await setRange('gate condition_ok', '1')
  await page.waitForTimeout(300)
  const emptyCell = await page
    .locator('table tbody tr td[colspan]')
    .first()
    .innerText()
    .catch(() => '(no empty-state cell)')
  console.log(`empty table with every row gated out: ${JSON.stringify(emptyCell)}`)

  await browser.close()
  await scraperBrowser.close()
  await server.close()
  fixtureServer.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
