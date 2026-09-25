import { parseRamGb, parseStorageGb } from '../../../src/shared/parse'
import type { Listing } from './api'

/**
 * A listing's capacity, as the report table's columns show it.
 *
 * Read from the **title**, through the same two functions the pre-filter uses to
 * reject a contradiction (`src/pipeline/prefilter.ts`). Item specifics are
 * deliberately not consulted: their labels vary per listing (CLAUDE.md rule 15)
 * and the pre-filter never reads them either, so deriving the column any other way
 * would let the table claim a capacity the filter disagreed with. The consequence
 * is the useful property — a row showing `16 GB` is one the pre-filter would have
 * rejected had a floor been set.
 *
 * Null for a title that states nothing, never `0`, which would read as "none".
 */
export function ramGbOf(listing: Listing): number | null {
  return parseRamGb(listing.title)
}

export function storageGbOf(listing: Listing): number | null {
  return parseStorageGb(listing.title)
}
