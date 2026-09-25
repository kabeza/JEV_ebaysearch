import { describe, it, expect } from 'vitest'
import { DEFAULTS, PRICING, estimateCostUsd } from '../src/shared/config'

describe('DEFAULTS', () => {
  it('matches the run defaults agreed in the spec', () => {
    expect(DEFAULTS.maxPages).toBe(25)
    expect(DEFAULTS.maxMinutes).toBe(10)
    // Raised from 10 on 2026-09-25, on measurement rather than on the old guess.
    // `scripts/probe-batch-size.ts`: with the questions 44% cheaper, a batch of 20
    // carries item specifics at 31.5k tokens (49% of the 64k context), 25 at 63%,
    // and 45 is refused. 25 gives 28 survivors two calls instead of three with room
    // left for a listing longer than the pool that was measured.
    expect(DEFAULTS.batchSize).toBe(25)
    expect(DEFAULTS.headed).toBe(true)
  })

  it('paces page loads between 1.5s and 3s', () => {
    expect(DEFAULTS.pacingMinMs).toBe(1500)
    expect(DEFAULTS.pacingMaxMs).toBe(3000)
  })
})

describe('estimateCostUsd', () => {
  it('charges input tokens only, since output is free', () => {
    expect(PRICING.outputPerMillionUsd).toBe(0)
    expect(estimateCostUsd({ input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(0.042, 6)
  })

  it('ignores output tokens entirely', () => {
    expect(estimateCostUsd({ input_tokens: 0, output_tokens: 500_000 })).toBe(0)
  })

  it('costs a fraction of a cent for a realistic run of 16k input tokens', () => {
    const cost = estimateCostUsd({ input_tokens: 16_000, output_tokens: 2_000 })
    expect(cost).toBeGreaterThan(0)
    expect(cost).toBeLessThan(0.01)
  })
})
