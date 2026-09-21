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
})
