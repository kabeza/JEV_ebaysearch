import { describe, it, expect } from 'vitest'
import { noul } from '@typesafe-ai/sdk'
import { createFakeJevClient } from '../src/jev/client'

describe('createFakeJevClient', () => {
  it('returns the canned answers it was given', async () => {
    const fake = createFakeJevClient({
      'item_0.is_target_product': { type: 'noul', noul: 0.93 },
    })
    const result = await fake.systemOne({ state: {}, questions: {} })
    expect(result.answers['item_0.is_target_product']).toEqual({ type: 'noul', noul: 0.93 })
    expect(result.usage.input_tokens).toBe(0)
  })

  it('records the requests it received, so tests can assert on batching', async () => {
    const fake = createFakeJevClient({})
    await fake.systemOne({ state: { a: 1 }, questions: { q: noul('is this a laptop?') } })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.questions).toEqual({
      q: { type: 'noul', instructions: 'is this a laptop?' },
    })
  })
})
