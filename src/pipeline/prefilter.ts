import {
  parseCpuVendor,
  parseRamGb,
  parseStorageGb,
  parseTouch,
  type CpuVendor,
} from '../shared/parse'
import type { SearchSpec } from '../storage/searches'

/**
 * The code pre-filter: the cheap gate every card passes before it is worth a
 * listing-page visit and a JEV call (spec §5.3). It is the main cost control, so
 * it has to be trustworthy in both directions.
 *
 * The rule it lives by: **only a contradiction rejects.** A missing price, an
 * unreadable spec or an ambiguous title survives, because the thing this filter
 * spends to save money is JEV calls, and the thing it can never get back is a
 * listing it threw away — no later stage ever sees a rejected listing again.
 */

export interface Requirements {
  /** Fails when price + shipping exceeds this. */
  maxPrice?: number
  /** Floor, not equality: 64GB satisfies a request for 32GB. */
  minRamGb?: number
  minStorageGb?: number
  /** When true, a listing that states it is not a touchscreen is rejected. */
  requireTouch?: boolean
  cpuVendor?: CpuVendor
}

export interface PrefilterInput {
  title: string
  price: number | null
  shipping: number | null
}

export type PrefilterDecision =
  | { stage: 'survivor'; reason: null }
  | { stage: 'rejected'; reason: string }

/**
 * Turns a saved search's spec into pre-filter requirements. Absent or
 * wrong-typed fields produce no requirement at all — a search that asks for
 * nothing must not be able to reject anything.
 */
export function requirementsFromSpec(spec: SearchSpec): Requirements {
  const req: Requirements = {}

  if (typeof spec.max_price === 'number') req.maxPrice = spec.max_price
  // Stored as the wanted capacity, used as a floor.
  if (typeof spec.ram_gb === 'number') req.minRamGb = spec.ram_gb
  if (typeof spec.storage_gb === 'number') req.minStorageGb = spec.storage_gb
  if (spec.touch === true) req.requireTouch = true

  // cpu_family is free text ("AMD Ryzen"); it only becomes a requirement when
  // exactly one vendor can be read out of it.
  if (typeof spec.cpu_family === 'string') {
    const vendor = parseCpuVendor(spec.cpu_family)
    if (vendor !== null) req.cpuVendor = vendor
  }

  return req
}

const VENDOR_NAMES: Record<CpuVendor, string> = {
  amd: 'AMD',
  intel: 'Intel',
  qualcomm: 'Qualcomm',
}

/** `$1,599.95` — grouped by hand so the reason reads the same on every machine. */
function money(v: number): string {
  const [whole, cents] = v.toFixed(2).split('.')
  return `$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`
}

/** A budget is usually a round number, and reads better without cents: `$1,200`. */
function moneyBudget(v: number): string {
  return Number.isInteger(v) ? money(v).replace(/\.00$/, '') : money(v)
}

const SURVIVOR: PrefilterDecision = { stage: 'survivor', reason: null }

/**
 * Rules run in a fixed order and the first failure wins, so a listing has one
 * reason rather than a pile of them. Price first: it is the one fact that is
 * always trustworthy, since eBay itself reported it.
 */
export function prefilter(input: PrefilterInput, req: Requirements): PrefilterDecision {
  if (req.maxPrice !== undefined && input.price !== null) {
    const shipping = input.shipping ?? 0
    if (input.price + shipping > req.maxPrice) {
      // Both parts, so it is visible when shipping is what pushed it over.
      return {
        stage: 'rejected',
        reason: `${money(input.price)} + ${money(shipping)} shipping is over the ${moneyBudget(req.maxPrice)} limit`,
      }
    }
  }

  if (req.minRamGb !== undefined) {
    const ram = parseRamGb(input.title)
    if (ram !== null && ram < req.minRamGb) {
      return { stage: 'rejected', reason: `${ram}GB RAM, wanted at least ${req.minRamGb}GB` }
    }
  }

  if (req.minStorageGb !== undefined) {
    const storage = parseStorageGb(input.title)
    if (storage !== null && storage < req.minStorageGb) {
      const wanted =
        req.minStorageGb % 1024 === 0 ? `${req.minStorageGb / 1024}TB` : `${req.minStorageGb}GB`
      return {
        stage: 'rejected',
        reason: `${storage}GB storage, wanted at least ${wanted}`,
      }
    }
  }

  if (req.requireTouch === true && parseTouch(input.title) === 'non-touch') {
    return { stage: 'rejected', reason: 'listed as non-touch' }
  }

  if (req.cpuVendor !== undefined) {
    const vendor = parseCpuVendor(input.title)
    if (vendor !== null && vendor !== req.cpuVendor) {
      return {
        stage: 'rejected',
        reason: `${VENDOR_NAMES[vendor]}, wanted ${VENDOR_NAMES[req.cpuVendor]}`,
      }
    }
  }

  return SURVIVOR
}
