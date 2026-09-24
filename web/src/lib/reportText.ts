/**
 * What the report says about itself, as pure functions, because the wording is
 * where two different silences get confused for one another (CLAUDE.md rule 7).
 *
 * A run with 65 rejected cards and no survivors, and a run that has not fetched
 * a page yet, are not the same state and must not print the same sentence.
 */

/** How many of `count` rows the row limit actually lets through. */
export function visibleCount(count: number, maxRows: number): number {
  return Math.min(count, maxRows)
}

/** `199 (showing 50)` when the row limit is holding rows back, `199` otherwise. */
export function countLabel(count: number, maxRows: number): string {
  return count > maxRows ? `${count} (showing ${maxRows})` : String(count)
}

export interface EmptyReportFacts {
  matchingCount: number
  pendingCount: number
  discardedCount: number
  /** Cards the pre-filter stopped before any question was asked. */
  rejectedCount: number
}

/**
 * The empty table's one line. Call it when the table is rendering no rows: a
 * `discardedCount` above zero then means nobody has turned the toggle on.
 */
export function emptyReportMessage(facts: EmptyReportFacts): string {
  if (facts.discardedCount > 0) {
    return `Nothing matched. ${facts.discardedCount} judged listings were discarded — tick “show discarded” to inspect them.`
  }
  if (facts.pendingCount > 0) {
    return `${facts.pendingCount} listings are waiting to be judged.`
  }
  if (facts.rejectedCount > 0) {
    return `All ${facts.rejectedCount} cards were filtered out before any question was asked — see “Filtered out” below.`
  }
  return 'No listings yet.'
}

/**
 * The rows an export writes: what the table is showing, in the table's order,
 * so the count on the button is the count on screen (spec §7, "what you see is
 * what you get"). The unjudged rows are on screen, so they are in the file —
 * their `status` column is what tells the reader they carry no answers.
 */
export function rowsToExport<T>(
  report: { matching: T[]; pending: T[]; discarded: T[] },
  showDiscarded: boolean,
): T[] {
  const rows = [...report.matching, ...report.pending]
  return showDiscarded ? [...rows, ...report.discarded] : rows
}
