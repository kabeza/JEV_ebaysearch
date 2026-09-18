/**
 * Stage 0 spike: prove the JEV call works end to end before anything else is built.
 *
 * Run with: npm run spike:jev
 *
 * Sends two real judgments about one realistic ThinkPad listing — a noul (yes/no)
 * and a score (graded) — and prints the answers, the probabilities, the token
 * usage and the estimated cost. This is the moment to judge whether JEV's answers
 * are good enough to build the rest of the app on.
 */
import { noul, score } from '@typesafe-ai/sdk'
import { createJevClient } from '../src/jev/client'
import { estimateCostUsd, MODEL_ALIAS } from '../src/shared/config'

/** Shape of one listing once scraped, mirroring the spec's example search. */
const state = {
  request: {
    keyword: 'Thinkpad T14s gen 6',
    criteria_text:
      '32gb ram, Ryzen (AMD) processor, 1tb storage, touch screen, less than u$s 1600, brand new or refurbished/open box/eBay Refurbished',
    spec: {
      cpu_family: 'AMD Ryzen',
      ram_gb: 32,
      storage_gb: 1024,
      touch: true,
    },
    max_price: 1600,
    accepted_conditions: [
      'Brand New',
      'Open Box',
      'Certified - Refurbished',
      'eBay Refurbished',
    ],
  },
  listing: {
    title: 'Lenovo ThinkPad T14s Gen 6 AMD Ryzen 7 7840U 32GB RAM 1TB SSD 14" Touch WUXGA',
    price: 1429.0,
    shipping: 0,
    currency: 'USD',
    condition_label: 'Certified - Refurbished',
    item_specifics: {
      Processor: 'AMD Ryzen 7 7840U',
      'RAM Size': '32 GB',
      'Storage Capacity': '1 TB SSD',
      'Screen Size': '14 in',
      Touchscreen: 'Yes',
    },
    seller: { name: 'example-store', feedback_pct: 99.4, feedback_count: 18422 },
  },
}

const questions = {
  is_target_product: noul(
    'Is this listing for the laptop computer itself, rather than an accessory, case, charger, dock, screen, or set of parts?',
    {
      true: 'The listing is for the complete laptop computer.',
      false: 'The listing is for an accessory, part, or something other than the laptop itself.',
    },
  ),
  price_value: score(
    'How good is the value for money at this price including shipping, against the budget in `request.max_price`?',
    [
      'Far above the budget, or poor value for the specification.',
      'Slightly above budget, or mediocre value for the specification.',
      'At the top of the budget, with fair value for the specification.',
      'Comfortably within budget, with good value for the specification.',
      'Well below budget for this specification — unusually good value.',
    ],
  ),
}

const client = createJevClient()
const result = await client.systemOne({ state, questions, model: MODEL_ALIAS })

console.log('model: ', result.model)
console.log('answers:')
console.log(JSON.stringify(result.answers, null, 2))
console.log('usage: ', result.usage)
console.log('estimated cost (USD):', estimateCostUsd(result.usage))
