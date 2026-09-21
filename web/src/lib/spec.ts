/**
 * Renders a search's spec as the requirements the pre-filter will actually
 * apply, so what will be rejected is visible before a run starts.
 *
 * Returns null when the spec asks for nothing — in which case nothing can be
 * rejected, and the UI says so rather than looking like a filter that found
 * nothing to do.
 */
/** `1,600` — grouped by hand, because `toLocaleString` depends on the machine's ICU. */
function grouped(n: number): string {
  return n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function summariseSpec(spec: Record<string, unknown>): string | null {
  const parts: string[] = []

  if (typeof spec.max_price === 'number') parts.push(`up to $${grouped(spec.max_price)}`)
  if (typeof spec.ram_gb === 'number') parts.push(`${spec.ram_gb}GB+ RAM`)
  if (typeof spec.storage_gb === 'number') {
    const gb = spec.storage_gb
    parts.push(`${gb % 1024 === 0 ? `${gb / 1024}TB` : `${gb}GB`}+ storage`)
  }
  if (spec.touch === true) parts.push('touchscreen')
  if (typeof spec.cpu_family === 'string' && spec.cpu_family.trim()) {
    parts.push(spec.cpu_family.trim())
  }

  return parts.length === 0 ? null : parts.join(' · ')
}

/** The spec keys the form manages, so a saved search can be edited later. */
export interface SpecFormValues {
  maxPrice: string
  ramGb: string
  storageGb: string
  touch: boolean
  cpuFamily: string
}

export const EMPTY_SPEC_FORM: SpecFormValues = {
  maxPrice: '',
  ramGb: '',
  storageGb: '',
  touch: false,
  cpuFamily: '',
}

/** Form strings to the stored spec. Blank means "no requirement", not zero. */
export function specFromForm(values: SpecFormValues): Record<string, unknown> {
  const spec: Record<string, unknown> = {}
  const number = (s: string): number | null => {
    const n = Number(s.trim())
    return s.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null
  }

  const maxPrice = number(values.maxPrice)
  if (maxPrice !== null) spec.max_price = maxPrice

  const ram = number(values.ramGb)
  if (ram !== null) spec.ram_gb = ram

  const storage = number(values.storageGb)
  if (storage !== null) spec.storage_gb = storage

  if (values.touch) spec.touch = true

  const cpu = values.cpuFamily.trim()
  if (cpu) spec.cpu_family = cpu

  return spec
}
