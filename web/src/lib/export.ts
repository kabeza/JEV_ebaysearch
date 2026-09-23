import { WEIGHTED_SIGNALS, type ReportRow } from './score'

/**
 * What a run becomes once it leaves the browser.
 *
 * Two different jobs: the CSV is a table a person opens, so every answer is
 * resolved to one number and a missing answer is an empty cell. The JSON keeps
 * the answers exactly as JEV returned them — legend, probabilities, confidence —
 * because that is the file that can be re-analysed without paying for another
 * call (spec §7). Both carry the URL: a report of listings you cannot click
 * through to is not a report.
 */

export const CSV_COLUMNS = [
  'title',
  'url',
  'price',
  'shipping',
  'condition',
  'seller',
  'feedback',
  'trust',
  ...WEIGHTED_SIGNALS,
  'blend',
  'highlighted',
  'status',
] as const

function cell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function number(value: number | null): string {
  return value === null ? '' : value.toFixed(4)
}

export function toCsv(rows: ReportRow[]): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const row of rows) {
    // Every field is escaped exactly once, by the `cell` at the end: escaping a
    // field before building the row and again here would double every quote.
    lines.push(
      [
        row.listing.title,
        row.listing.url,
        row.listing.price === null ? '' : row.listing.price.toFixed(2),
        row.listing.shipping === null ? '' : row.listing.shipping.toFixed(2),
        row.listing.conditionLabel,
        row.listing.sellerName,
        row.trust.count,
        row.trust.tier,
        ...WEIGHTED_SIGNALS.map((signal) => number(row.values[signal])),
        number(row.blend),
        row.highlighted,
        row.matching ? 'matching' : 'discarded',
      ]
        .map(cell)
        .join(','),
    )
  }
  return `${lines.join('\n')}\n`
}

/** The rows as they stand, raw answers included. */
export function toJson(rows: ReportRow[]): string {
  return JSON.stringify(rows, null, 2)
}

/** Triggers a download from data already in the page — no endpoint (spec §7). */
export function download(filename: string, contents: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
