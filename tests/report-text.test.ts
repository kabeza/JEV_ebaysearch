import { describe, it, expect } from 'vitest'
import { countLabel, emptyReportMessage, rowsToExport, visibleCount } from '../web/src/lib/reportText'

/**
 * The words the report says about itself (CLAUDE.md rule 7 — silence is a bug).
 * Every one of these was wrong in a way only real data showed: the "every weight
 * is zero" banner fired at the start of every run, and a run whose cards were all
 * pre-filtered claimed "No listings yet." — two different silences said with the
 * same words, and neither of them said what had actually happened.
 */
describe('countLabel', () => {
  it('says the count alone when the row limit is not holding anything back', () => {
    expect(countLabel(12, 50)).toBe('12')
    expect(countLabel(0, 50)).toBe('0')
    expect(countLabel(50, 50)).toBe('50')
  })

  it('says how many are shown when the limit bites', () => {
    expect(countLabel(199, 50)).toBe('199 (showing 50)')
    expect(countLabel(51, 50)).toBe('51 (showing 50)')
  })
})

describe('visibleCount', () => {
  it('counts the rows the limit lets through, never more than exist', () => {
    // The "show N discarded" label used the raw count, so it offered rows the
    // table would not render once the limit bit.
    expect(visibleCount(199, 50)).toBe(50)
    expect(visibleCount(12, 50)).toBe(12)
    expect(visibleCount(0, 50)).toBe(0)
  })
})

describe('emptyReportMessage', () => {
  const empty = {
    matchingCount: 0,
    pendingCount: 0,
    discardedCount: 0,
    rejectedCount: 0,
  }

  it('points at the discarded toggle when judged listings exist but none matched', () => {
    expect(emptyReportMessage({ ...empty, discardedCount: 19 })).toBe(
      'Nothing matched. 19 judged listings were discarded — tick “show discarded” to inspect them.',
    )
  })

  it('says the run is still waiting, not that there is nothing', () => {
    expect(emptyReportMessage({ ...empty, pendingCount: 20 })).toBe(
      '20 listings are waiting to be judged.',
    )
  })

  it('says every card was filtered out when the pre-filter took them all', () => {
    // The case the old wording got wrong: 65 rejected cards and no survivors
    // rendered "No listings yet.", which reads as a scraper that found nothing.
    expect(emptyReportMessage({ ...empty, rejectedCount: 65 })).toBe(
      'All 65 cards were filtered out before any question was asked — see “Filtered out” below.',
    )
  })

  it('says there is nothing yet only when there really is nothing', () => {
    expect(emptyReportMessage(empty)).toBe('No listings yet.')
  })
})

describe('rowsToExport', () => {
  // Generics on purpose: what is being tested is which rows and in what order,
  // not the shape of a row, so the test needs no ReportRow to make its point.
  const report = { matching: ['m1', 'm2'], pending: ['p1'], discarded: ['d1'] }

  it('follows what the table is showing: the unjudged rows are on screen too', () => {
    expect(rowsToExport(report, false)).toEqual(['m1', 'm2', 'p1'])
  })

  it('adds the discarded rows in the table’s order when the toggle is on', () => {
    expect(rowsToExport(report, true)).toEqual(['m1', 'm2', 'p1', 'd1'])
  })
})
