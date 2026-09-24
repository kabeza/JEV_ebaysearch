/**
 * Chunking for the JEV calls.
 *
 * One request carries several listings, which TypeSafe measure at roughly 12×
 * cheaper and 10× faster than a call per listing. The size limit for a single
 * request is not documented, so the batch size is a setting rather than a
 * constant — and an oversized request is recoverable at runtime rather than a
 * rewrite.
 */

/** Splits items into batches, the last one short. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error(`batch size must be at least 1, got ${size}`)
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size))
  }
  return batches
}

/** Half the batch, never below one, so a retry always makes progress. */
export function halve(size: number): number {
  return Math.max(1, Math.floor(size / 2))
}

/**
 * Whether an error means "this request was too large".
 *
 * The documented answer is a 422, but the SDK surfaces it several ways — a
 * message, a plain status on the thrown object — so both are checked. A 401 and
 * a 529 deliberately do not match: retrying a bad key smaller would loop until
 * the batch size hit 1 and then fail anyway, with a much less useful message.
 */
export function isTooLargeError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const status = (err as { status?: unknown; statusCode?: unknown }).status ??
      (err as { statusCode?: unknown }).statusCode
    if (status === 422) return true
  }
  const message = err instanceof Error ? err.message : String(err)
  return /\b422\b/.test(message) || /unprocessable/i.test(message)
}

/**
 * Whether an error means the service is overloaded rather than the request wrong.
 *
 * The SDK already retried 408/429/500–599 with backoff, so what arrives here has
 * exhausted that. Checked the same way `isTooLargeError` checks 422 — the status
 * on the thrown object, then the message — because the SDK surfaces it both ways.
 * A 401 deliberately does not match: a bad key is a mistake to fix, not something
 * to wait out.
 */
export function isOutageError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const status =
      (err as { status?: unknown; statusCode?: unknown }).status ??
      (err as { statusCode?: unknown }).statusCode
    if (typeof status === 'number' && (status === 429 || status >= 500)) return true
  }
  const message = err instanceof Error ? err.message : String(err)
  return /\b(429|5\d\d)\b/.test(message) || /rate limit|overloaded|timeout/i.test(message)
}
