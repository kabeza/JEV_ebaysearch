import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } })
const errors: string[] = []
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' })

// Create a search limited to 2 pages so the live run finishes quickly.
await page.getByLabel('Name').fill('Live ThinkPad run')
await page.getByLabel('Keyword').fill('Thinkpad T14s gen 6')
await page.getByLabel('Criteria').fill('32gb ram, Ryzen, 1tb, touch screen, under u$s 1600')
await page.getByRole('button', { name: 'Save search' }).click()
await page.getByText('Live ThinkPad run').waitFor({ timeout: 10_000 })
console.log('1. search created via the UI: OK')

// Cap it at 2 pages through the API (the form does not expose settings yet).
const searches = await (await page.request.get('http://127.0.0.1:3001/api/searches')).json()
const id = searches.find((s: { name: string }) => s.name === 'Live ThinkPad run').id
await page.request.post(`http://127.0.0.1:3001/api/searches`).catch(() => {})

// Patch settings directly through the DB-backed API is not exposed, so start the
// run and rely on the default caps; watch it for a bounded window instead.
const res = await page.request.post('http://127.0.0.1:3001/api/runs', { data: { searchId: id, settings: { maxPages: 2 } } })
console.log('2. run started:', res.status(), await res.text())

await page.reload({ waitUntil: 'networkidle' })
await page.getByText('Saved searches').waitFor()

// Drive the real button so we exercise the UI path too.
await page.getByRole('button', { name: 'Run search' }).first().click().catch(() => {})
await page.waitForTimeout(1500)

// Watch the live table fill.
let rows = 0
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000)
  rows = await page.locator('table tbody tr').count()
  const status = await page.locator('h2 span').first().innerText().catch(() => '?')
  if (i % 5 === 0) console.log(`   t+${i}s status=${status} rows=${rows}`)
  if (rows > 5 && status !== 'running') break
}
console.log('3. rows visible in the live table:', rows)

await page.screenshot({ path: '/tmp/jevbrowser-stage2.png', fullPage: false })
console.log('4. screenshot -> /tmp/jevbrowser-stage2.png')
console.log('page errors:', errors.length ? errors : 'none')
await browser.close()
