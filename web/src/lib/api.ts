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
}): Promise<Search> {
  return request<Search>('/api/searches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
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

export function getRun(runId: number): Promise<{ run: Run; listings: Listing[] }> {
  return request<{ run: Run; listings: Listing[] }>(`/api/runs/${runId}`)
}

export interface RunEvent {
  seq: number
  at: string
  type: string
  payload: Record<string, unknown>
}
