export interface Search {
  id: number
  name: string
  keyword: string
  criteriaText: string
  spec: Record<string, unknown>
  settings: Record<string, unknown>
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

export interface Run {
  id: number
  searchId: number
  status: 'queued' | 'running' | 'paused' | 'cancelled' | 'failed' | 'complete'
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
  listingId: number
  questionKey: string
  answer: JevAnswer
}

export function getRun(
  runId: number,
): Promise<{ run: Run; listings: Listing[]; judgments: Judgment[] }> {
  return request<{ run: Run; listings: Listing[]; judgments: Judgment[] }>(`/api/runs/${runId}`)
}

export interface RunEvent {
  seq: number
  at: string
  type: string
  payload: Record<string, unknown>
}
