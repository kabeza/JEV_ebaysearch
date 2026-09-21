import { describe, it, expect } from 'vitest'
import {
  parseCpuVendor,
  parseRamGb,
  parseStorageGb,
  parseTouch,
} from '../src/shared/parse'

/**
 * Titles below are copied verbatim from live runs (listings table, run 7), so
 * these tests cost nothing and stay honest about what eBay actually writes.
 */
describe('parseRamGb / parseStorageGb', () => {
  const cases: { title: string; ram: number | null; storage: number | null }[] = [
    {
      title: 'Lenovo ThinkPad T14s Gen 6 14" WUXGA Ultra 7 256u 32GB,256gb SSD',
      ram: 32,
      storage: 256,
    },
    {
      title: 'Lenovo ThinkPad T14 Gen 5 FHD+ TOUCH 3.2 GHz Ryzen 5 PRO 8540U 16GB 512GB SSD',
      ram: 16,
      storage: 512,
    },
    {
      // Label after the value, and the values out of order.
      title: 'Lenovo ThinkPad T14s Laptop AMD Ryzen 5650U 2.30GHZ/FHD/16GB/256gb/Touchscreen',
      ram: 16,
      storage: 256,
    },
    {
      title: 'Lenovo ThinkPad T14s Gen 6 14" Laptop Ultra 5 235U 16GB RAM 256GB NVMe',
      ram: 16,
      storage: 256,
    },
    {
      title: 'Lenovo ThinkPad T14s Gen 6 (SSD 512gb RAM 32gb Intel Core Ultra 5)',
      ram: 32,
      storage: 512,
    },
    {
      title: 'Lenovo ThinkPad T14s Gen 6 14.0" AMD Ryzen AI 5 PRO 340 32GB 256GB NVMe W11P',
      ram: 32,
      storage: 256,
    },
    {
      title: 'NEW Lenovo ThinkPad T14s Gen 6 14" Touch Ryzen AI 7 PRO 32GB 512GB 21TB000EUS',
      ram: 32,
      storage: 512,
    },
    { title: 'Lenovo ThinkPad T14s Gen 6 Black FHD+ 3.4 GHz Snapdragon X Elite 32GB 1TB SSD', ram: 32, storage: 1024 },
    { title: 'Lenovo ThinkPad T14s Gen 6 14" Touchscreen Ultra 7 268V 32GB 1TB Win11Pro', ram: 32, storage: 1024 },
    {
      title: 'Lenovo ThinkPad T14s Gen 6 14" WUXGA IPS Display, Intel Core Ultra 7 155U 32GB 512GB',
      ram: 32,
      storage: 512,
    },
    // Model numbers and screen sizes must never be read as capacity.
    {
      title: 'Lenovo ThinkPad T14s Gen 6 14 in. WUXGA IPS Display, Intel Core Ultra|1259.0',
      ram: null,
      storage: null,
    },
    {
      title: 'Lenovo ThinkPad T14s Gen 4 21F6 Series 14" WUXGA Non-Touch LCD Laptop Screen',
      ram: null,
      storage: null,
    },
    { title: 'Lenovo Thinkpad T14s Gen 6 Snapdragon X Elite 32GB RAM, HD removed', ram: 32, storage: null },
    // Two bare capacities and no label: the smaller is memory, the larger disk.
    { title: 'Lenovo ThinkPad T14s Gen 6 16GB 512GB', ram: 16, storage: 512 },
    // Three bare capacities and no label: too many ways to be wrong, so null.
    { title: 'Lenovo ThinkPad T14s Gen 6 16GB 256GB 512GB', ram: null, storage: null },
    // Two bare capacities that are not a memory/disk pair: null rather than a guess.
    { title: 'Lenovo ThinkPad T14s Gen 6 8GB 16GB', ram: null, storage: null },
    // A part number that looks like a capacity is not one.
    { title: 'Lenovo 21TB000EUS ThinkPad T14s Gen 6 WUXGA', ram: null, storage: null },
  ]

  for (const c of cases) {
    it(`reads RAM and storage from ${JSON.stringify(c.title.slice(0, 56))}`, () => {
      expect(parseRamGb(c.title)).toBe(c.ram)
      expect(parseStorageGb(c.title)).toBe(c.storage)
    })
  }
})

describe('parseTouch', () => {
  it('reads a plain touchscreen mention', () => {
    expect(parseTouch('Lenovo ThinkPad T14s Gen 6 14" Touchscreen Ultra 7 268V 32GB')).toBe('touch')
  })

  it('reads TOUCH in caps', () => {
    expect(parseTouch('Lenovo ThinkPad T14 Gen 5 FHD+ TOUCH 3.2 GHz Ryzen 5')).toBe('touch')
  })

  it('does not read a non-touch panel as touch', () => {
    expect(parseTouch('Lenovo ThinkPad T14s Gen 4 21F6 Series 14" WUXGA Non-Touch LCD')).toBe(
      'non-touch',
    )
  })

  it('treats "no touch" and "without touch" as non-touch', () => {
    expect(parseTouch('ThinkPad T14s Gen 6 32GB no touch screen')).toBe('non-touch')
    expect(parseTouch('ThinkPad T14s Gen 6 32GB without touch')).toBe('non-touch')
  })

  it('does not read a touchpad as a touchscreen', () => {
    expect(parseTouch('Lenovo ThinkPad T14s Gen 6 32GB Touchpad 1TB')).toBe(null)
  })

  it('returns null when the title says nothing about touch', () => {
    expect(parseTouch('Lenovo ThinkPad T14s Gen 6 32GB RAM 1TB SSD')).toBe(null)
  })
})

describe('parseCpuVendor', () => {
  const cases: { title: string; vendor: 'amd' | 'intel' | 'qualcomm' | null }[] = [
    { title: 'Lenovo ThinkPad T14 Gen 5 Ryzen 5 PRO 8540U 16GB', vendor: 'amd' },
    { title: 'Lenovo ThinkPad T14s Gen 6 AMD Ryzen 7 7840U 32GB', vendor: 'amd' },
    { title: 'Lenovo ThinkPad T14s Gen 6 14" Core Ultra 7 255U 16GB 1TB', vendor: 'intel' },
    { title: 'Lenovo ThinkPad T14s Gen 6 14" Touch Ultra 7 268V 32GB 1TB', vendor: 'intel' },
    { title: 'Lenovo ThinkPad T14s Gen 4 i7-1370P 32GB RAM 512GB SSD Win11 No AC', vendor: 'intel' },
    { title: 'Lenovo ThinkPad T14s Gen 6 14" WUXGA Intel Core Ultra 5 125U', vendor: 'intel' },
    { title: 'Lenovo ThinkPad T14s Gen 6 14" Snapdragon X Elite 32GB 1TB', vendor: 'qualcomm' },
    // Two vendors named: refuse to guess.
    { title: 'ThinkPad T14s Gen 6 AMD Ryzen vs Intel Core i7 listing', vendor: null },
    { title: 'Lenovo ThinkPad T14s Gen 6 32GB 1TB SSD Win 11 Pro', vendor: null },
  ]

  for (const c of cases) {
    it(`reads the vendor from ${JSON.stringify(c.title.slice(0, 56))}`, () => {
      expect(parseCpuVendor(c.title)).toBe(c.vendor)
    })
  }
})
