import { describe, it, expect } from 'vitest'
import { chunk, isTooLargeError, halve } from '../src/jev/batch'

describe('chunk', () => {
  it('splits into batches of the given size, last batch short', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('makes exactly one batch when everything fits', () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]])
  })

  it('makes 3 batches of 10/10/5 for 25 items, as the acceptance criteria state', () => {
    const items = Array.from({ length: 25 }, (_, i) => i)
    const batches = chunk(items, 10)
    expect(batches.map((b) => b.length)).toEqual([10, 10, 5])
  })

  it('returns nothing for nothing', () => {
    expect(chunk([], 10)).toEqual([])
  })

  it('refuses a batch size below one rather than looping forever', () => {
    expect(() => chunk([1, 2], 0)).toThrowError(/batch size/i)
  })
})

describe('halve', () => {
  it('halves a size, never below one', () => {
    expect(halve(10)).toBe(5)
    expect(halve(3)).toBe(1)
    expect(halve(1)).toBe(1)
    expect(halve(2)).toBe(1)
  })
})

describe('isTooLargeError', () => {
  it('recognises the API saying the request is too big', () => {
    expect(isTooLargeError(new Error('Request failed with status 422'))).toBe(true)
    expect(isTooLargeError(new Error('422 Unprocessable Entity'))).toBe(true)
    expect(isTooLargeError({ status: 422 })).toBe(true)
  })

  it('does not confuse a bad key or an overload for an oversized request', () => {
    expect(isTooLargeError(new Error('401 Unauthorized'))).toBe(false)
    expect(isTooLargeError(new Error('529 Overloaded'))).toBe(false)
    expect(isTooLargeError(new Error('socket hang up'))).toBe(false)
  })

  it('recognises an oversized batch refused as a bad request', () => {
    // Measured 2026-09-25 with `scripts/probe-batch-size.ts`: the API refuses a
    // batch that does not fit as a **400**, not a 422 — `BadRequestError` with
    // `400 {"detail":{"error_type":"max_tokens_exceeded"}}`. The 422-only test
    // missed it, so such a batch was never halved and the run died instead, which
    // is the opposite of what rule 17 promises.
    const refused = Object.assign(
      new Error('400 {"detail":{"error_type":"max_tokens_exceeded"}}'),
      { status: 400, body: { detail: { error_type: 'max_tokens_exceeded' } } },
    )
    expect(isTooLargeError(refused)).toBe(true)

    // The marker alone is enough: the SDK does not always carry a status field,
    // and nothing else the service says contains this string.
    expect(isTooLargeError(new Error('max_tokens_exceeded'))).toBe(true)
    expect(isTooLargeError({ body: { detail: { error_type: 'max_tokens_exceeded' } } })).toBe(true)
  })

  it('does not halve for a bad request that says something else', () => {
    // A 400 for a malformed question is not a size problem. Halving for it would
    // spend calls walking the batch down to 1 to fail there anyway.
    const malformed = Object.assign(new Error('400 {"detail":{"error_type":"invalid_question"}}'), {
      status: 400,
    })
    expect(isTooLargeError(malformed)).toBe(false)
    expect(isTooLargeError({ status: 400 })).toBe(false)
    expect(isTooLargeError(new Error('400 Bad Request'))).toBe(false)
  })
})
