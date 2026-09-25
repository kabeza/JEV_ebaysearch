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
 * Everything an error says, as one string: the message, plus the response body
 * when the SDK attached one. The status is a separate question — this is the text
 * a marker can be found in.
 */
function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const body =
    typeof err === 'object' && err !== null ? (err as { body?: unknown }).body : undefined
  if (body === undefined) return message
  try {
    return `${message} ${typeof body === 'string' ? body : JSON.stringify(body)}`
  } catch {
    return message
  }
}

/**
 * Whether an error means "this request was too large".
 *
 * The documented answer is a 422, but the service refuses an oversized batch as a
 * **400** — measured on 2026-09-25 with `scripts/probe-batch-size.ts`:
 * `BadRequestError`, `status: 400`,
 * `400 {"detail":{"error_type":"max_tokens_exceeded"}}`. With the 422-only test
 * the batch was never halved and the run died instead, which is the opposite of
 * what rule 17 promises a person.
 *
 * The 400 is matched on the service's own marker rather than on the status: a 400
 * for a malformed question carries no such marker, and halving for it would loop
 * the batch down to 1 and fail there anyway, with a much less useful message. The
 * marker is checked without a status too, because the SDK does not always attach
 * one.
 *
 * A 401 and a 529 deliberately do not match either: retrying a bad key smaller is
 * the same loop as above.
 */
export function isTooLargeError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const status =
      (err as { status?: unknown; statusCode?: unknown }).status ??
      (err as { statusCode?: unknown }).statusCode
    if (status === 422) return true
  }

  const text = errorText(err)
  if (/\b422\b/.test(text) || /unprocessable/i.test(text)) return true
  return /max_tokens_exceeded/i.test(text)
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
