/**
 * Reads spec facts out of messy eBay titles.
 *
 * Every function returns `null` rather than a guess. A wrong number here becomes
 * a wrong rejection in the pre-filter, and a rejected listing never reaches JEV,
 * so there is no later stage that can catch the mistake. Null is honest: it means
 * "the title does not say", which the pre-filter treats as "keep it".
 */

/** Capacities that actually exist. Snapping to these kills model-number noise. */
const RAM_GB_VALUES = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128]
const STORAGE_GB_VALUES = [64, 128, 256, 512, 1024, 2048, 4096, 8192]

/** Words that mark a capacity as memory, and as disk. Checked in that order. */
const RAM_LABELS = /\b(ram|memory|lpddr\d*|ddr\d*)\b/
const STORAGE_LABELS = /\b(ssd|nvme|hdd|emmc|m\.?2|storage|hard drive|disk)\b/

export type CpuVendor = 'amd' | 'intel' | 'qualcomm'

const VENDOR_PATTERNS: { vendor: CpuVendor; re: RegExp }[] = [
  // "Ryzen AI 7 PRO 350", "Ryzen 5 PRO 8540U", plain "AMD".
  { vendor: 'amd', re: /\b(ryzen|amd|athlon|threadripper|epyc)\b/ },
  // "Core Ultra 7 255U" with or without the Intel prefix; "Ultra 7 268V";
  // "i7-1370P"; "Core i5".
  { vendor: 'intel', re: /\b(intel|core ultra|ultra [3579]\b|celeron|pentium|core i[3579]\b|i[3579][- ]\d{3,4}[a-z]{0,2}\b)/ },
  { vendor: 'qualcomm', re: /\b(snapdragon|qualcomm)\b/ },
]

/** Lowercases, unifies the quote characters eBay mixes, and squashes whitespace. */
function normalise(title: string): string {
  return title
    .toLowerCase()
    .replace(/[‘’“”″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

interface CapacityToken {
  value: number
  /** The text between this token and the next one, and the text before it. */
  after: string
  before: string
}

/**
 * Finds every `<number> GB/TB` and records the nearest text on each side, so a
 * label can be matched where eBay actually puts it — before the value ("SSD
 * 512gb") or after it ("512gb SSD").
 */
function capacityTokens(title: string): CapacityToken[] {
  const source = normalise(title)
  const re = /(\d+(?:\.\d+)?)\s*(tb|gb)\b/g
  const found: { value: number; start: number; end: number }[] = []

  for (const m of source.matchAll(re)) {
    const raw = Number(m[1])
    // A trailing "0" is a word character, so `\b` already rejects part numbers
    // like 21TB000EUS; the snap-to-known-capacity pass below catches the rest.
    found.push({ value: m[2] === 'tb' ? raw * 1024 : raw, start: m.index, end: m.index + m[0].length })
  }

  return found.map((t, i) => {
    const next = found[i + 1]
    const prev = found[i - 1]
    // Windows stop at the neighbouring capacity so that "32GB,256gb SSD" cannot
    // borrow the storage label sitting on the other side of the comma.
    const after = source.slice(t.end, next ? next.start : source.length).slice(0, 16)
    const before = source.slice(prev ? prev.end : 0, t.start).slice(-16)
    return { value: t.value, after, before }
  })
}

function snap(value: number, allowed: number[]): number | null {
  return allowed.includes(value) ? value : null
}

/** Splits the capacities in a title into memory and disk, or null where unsure. */
function readCapacities(title: string): { ram: number | null; storage: number | null } {
  const tokens = capacityTokens(title)
  let ram: number | null = null
  let storage: number | null = null
  const unlabelled: CapacityToken[] = []

  for (const t of tokens) {
    const labelledStorage = STORAGE_LABELS.test(t.after) || STORAGE_LABELS.test(t.before)
    const labelledRam = RAM_LABELS.test(t.after) || RAM_LABELS.test(t.before)
    // TB is disk by construction; memory is never sold in terabytes.
    if (labelledStorage || (t.value >= 1024 && !labelledRam)) storage ??= t.value
    else if (labelledRam) ram ??= t.value
    else unlabelled.push(t)
  }

  // "32GB,256gb SSD": the SSD token is labelled, so the bare 32GB is the memory.
  if (ram === null && unlabelled.length === 1 && storage !== null) {
    ram = unlabelled[0]!.value
  }

  // Exactly two bare capacities — "32GB 512GB", the way most sellers write it.
  // Magnitude decides, so the order does not matter: memory is the smaller of the
  // two. Only accepted when each number is a real capacity of its kind, so
  // "8GB 16GB" (no disk in sight) or a pair of disk sizes stays null.
  if (ram === null && storage === null && unlabelled.length === 2) {
    const [small, large] = unlabelled.map((t) => t.value).sort((a, b) => a - b)
    if (
      small !== undefined &&
      large !== undefined &&
      RAM_GB_VALUES.includes(small) &&
      STORAGE_GB_VALUES.includes(large)
    ) {
      ram = small
      storage = large
    }
  }

  return { ram: ram === null ? null : snap(ram, RAM_GB_VALUES), storage: storage === null ? null : snap(storage, STORAGE_GB_VALUES) }
}

export function parseRamGb(title: string): number | null {
  return readCapacities(title).ram
}

export function parseStorageGb(title: string): number | null {
  return readCapacities(title).storage
}

/**
 * Whether the listing advertises a touchscreen. Negation is checked first:
 * `Non-Touch` contains `Touch`, and reading it as touch-capable would reject a
 * non-touch panel from a request that wants touch — the exact failure this
 * ordering prevents.
 */
export function parseTouch(title: string): 'touch' | 'non-touch' | null {
  // A multi-touch trackpad is not a touchscreen, so strip the phrase first.
  const source = normalise(title).replace(/\bmulti[- ]touch\b/g, ' ')

  if (/\b(non[- ]?touch|no touch|without touch|not touch)\b/.test(source)) return 'non-touch'
  if (/\b(touchscreen|touch screen|touch)\b/.test(source)) return 'touch'
  return null
}

/** The CPU vendor, or null when the title names none or names more than one. */
export function parseCpuVendor(title: string): CpuVendor | null {
  const source = normalise(title)
  const matched = VENDOR_PATTERNS.filter((p) => p.re.test(source))
  return matched.length === 1 ? matched[0]!.vendor : null
}
