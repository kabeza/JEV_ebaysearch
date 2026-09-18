import { describe, it, expect } from 'vitest'
import { requireApiKey } from '../src/jev/env'

describe('requireApiKey', () => {
  it('returns the trimmed key when present', () => {
    expect(requireApiKey({ TYPESAFE_API_KEY: '  abc123  ' })).toBe('abc123')
  })

  it('throws a message naming the fix when missing', () => {
    expect(() => requireApiKey({})).toThrowError(/TYPESAFE_API_KEY is not set/)
  })

  it('treats a whitespace-only key as missing', () => {
    expect(() => requireApiKey({ TYPESAFE_API_KEY: '   ' })).toThrowError(/TYPESAFE_API_KEY/)
  })
})
