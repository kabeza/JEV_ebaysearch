/** A run as the search list needs it: enough to date it, count it and open it. */
export interface RunSummary {
  id: number
  searchId: number
  status: RunStatus
  startedAt: string | null
  finishedAt: string | null
  listings: number
  rejected: number
  /** Listings with at least one answer. Zero means there is nothing to report yet. */
  judged: number
}

export interface Search {
  id: number
  name: string
  keyword: string
  criteriaText: string
  spec: Record<string, unknown>
  settings: Record<string, unknown>
  /**
   * This search's runs, newest first. The only door to a stored report: before
   * this existed the page could not open a run it had not just started.
   */
  runs: RunSummary[]
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init)
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${init?.method ?? 'GET'} ${input} failed: ${res.status} ${detail}`)
  }
  return res.json() as Promise<T>
}

export function listSearches(): Promise<Search[]> {
  return request<Search[]>('/api/searches')
}

export function createSearch(input: {
  name: string
  keyword: string
  criteriaText: string
  spec?: Record<string, unknown>
}): Promise<Search> {
  return request<Search>('/api/searches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

/** What a listing page said, when it was visited. */
export interface ListingDetail {
  title: string | null
  price: number | null
  shipping: number | null
  condition: string | null
  sellerName: string | null
  sellerFeedback: string | null
  /** Every label/value pair eBay states, keyed by its own label. */
  specifics: Record<string, string>
  rawText: string[]
}

export interface Listing {
  id: number
  itemId: string
  title: string
  url: string
  price: number | null
  shipping: number | null
  conditionLabel: string | null
  sellerName: string | null
  sellerFeedback: string | null
  watchers: number | null
  buyingFormat: string | null
  sponsoredMarker: boolean
  stage: string
  rejectReason: string | null
  /** Null when the listing was never visited, or its page failed to read. */
  detail: ListingDetail | null
}

/** The six states a run can be in. `Run`, `RunSummary` and the badge share one name. */
export type RunStatus = 'queued' | 'running' | 'paused' | 'cancelled' | 'failed' | 'complete'

export interface Run {
  id: number
  searchId: number
  status: RunStatus
  startedAt: string | null
  finishedAt: string | null
  stats: Record<string, number | undefined>
  error: string | null
}

export function startRun(searchId: number): Promise<{ runId: number }> {
  return request<{ runId: number }>('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ searchId }),
  })
}

/**
 * Re-asks a stored run's questions under an edited set. No page load and no
 * scrape: the listings and their item specifics are already stored.
 */
export function rejudge(
  runId: number,
  draft: Record<string, unknown>,
): Promise<{ runId: number; version: number }> {
  return request<{ runId: number; version: number }>(`/api/runs/${runId}/rejudge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  })
}

/** Wakes a paused run so it retries the page or batch it stopped on. */
export function resumeRun(runId: number): Promise<{ resumed: boolean; runId: number }> {
  return request<{ resumed: boolean; runId: number }>(`/api/runs/${runId}/resume`, {
    method: 'POST',
  })
}

export function cancelRun(runId: number): Promise<{ cancelled: boolean }> {
  return request<{ cancelled: boolean }>(`/api/runs/${runId}/cancel`, { method: 'POST' })
}

/**
 * A JEV answer, however the primitive shaped it.
 *
 * `probabilities` and `legend` are keyed by STRING index, and for a score answer
 * `score` is a probability-weighted value on the legend's scale — not an index
 * into it. A five-level answer can read 2.18.
 */
export interface JevAnswer {
  type: 'noul' | 'score' | string
  noul?: number
  score?: number
  confidence?: number
  legend?: Record<string, string>
  probabilities?: Record<string, number>
}

export interface Judgment {
  id: number
  /** Which questionnaire version answered this. A run can carry several. */
  questionnaireId: number
  listingId: number
  questionKey: string
  answer: JevAnswer
}

/** One stored version of a run's questions, and the answers it produced. */
export interface Questionnaire {
  id: number
  version: number
  createdAt: string
  definition: Record<string, unknown>
}

export function getRun(runId: number): Promise<{
  run: Run
  listings: Listing[]
  judgments: Judgment[]
  questionnaires: Questionnaire[]
}> {
  return request<{
    run: Run
    listings: Listing[]
    judgments: Judgment[]
    questionnaires: Questionnaire[]
  }>(`/api/runs/${runId}`)
}

export interface RunEvent {
  seq: number
  at: string
  type: string
  payload: Record<string, unknown>
}

/** Removes a search and everything under it. Irreversible; the UI asks twice. */
export async function deleteSearch(id: number): Promise<void> {
  const res = await fetch(`/api/searches/${id}`, { method: 'DELETE' })
  if (res.status === 204) return
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  throw new Error(body.error ?? `DELETE /api/searches/${id} failed: ${res.status}`)
}
