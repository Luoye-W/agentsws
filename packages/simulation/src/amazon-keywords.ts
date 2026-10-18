/**
 * WP398（docs/106 §13 A8）：模拟里的 **Amazon 词库**——用录好的联想词与 Listing 文本跑一遍和服务进程同一份的纯逻辑
 * （`@agentsws/seo-core` 的拆词 / 归一化 / 他牌名 / 差距），不调模型、不联网、不碰浏览器。
 *
 * 联想词按服务进程那一套走：种子词本身 + a–z 一批，`blocked_at` = 第几页出验证页（那一页起停下，不重试）。
 * 品牌名都是编的。
 */

import { amazonAutocompletePrefixes } from '@agentsws/brand-intake'
import type { AmazonKeyword, AmazonListingText } from '@agentsws/contracts'
import {
  computeKeywordGaps,
  mergeSightings,
  seedFromTitle,
  sightingsFromListing,
  sightingsFromSuggestions,
} from '@agentsws/seo-core'

const at = '2026-10-18T01:00:00.000Z'

export const AMAZON_KEYWORD_SAMPLE_OWN: AmazonListingText = {
  side: 'own',
  asin: 'B0SIMOWN01',
  marketplace: 'US',
  brand: 'Nordride',
  title: 'Nordride Electric Bike for Adults, 750W Motor, 28MPH Commuter E-Bike with 48V Battery',
  bullets: ['LONG RANGE: up to 50 miles per charge.', 'COMFORT: suspension fork for city rides.'],
  read_at: at,
}

const comp = (
  id: string,
  name: string,
  asin: string,
  title: string,
  bullets: string[] = [],
): AmazonListingText => ({
  side: 'competitor',
  competitor_id: id,
  competitor: name,
  asin,
  marketplace: 'US',
  title,
  ...(bullets.length === 0 ? {} : { bullets }),
  read_at: at,
})

export const AMAZON_KEYWORD_SAMPLE_COMPETITORS: AmazonListingText[] = [
  comp(
    'c_voltway',
    'Voltway',
    'B0SIMVOLT1',
    'Voltway Fat Tire Electric Bike with Removable Battery, Hydraulic Disc Brakes',
    ['Works with Ridgeline racks.'],
  ),
  comp(
    'c_ridgeline',
    'Ridgeline',
    'B0SIMRIDG1',
    'Ridgeline Electric Mountain Bike, Removable Battery, Hydraulic Disc Brakes',
  ),
  comp(
    'c_pedalux',
    'Pedalux',
    'B0SIMPEDL1',
    'Pedalux Step-Thru Electric Bike, Removable Battery, Fat Tire, Hydraulic Disc Brakes',
  ),
]

/** 录好的联想词（前缀 → 那一页的联想；没录的前缀回空表）。 */
export const AMAZON_KEYWORD_SAMPLE_SUGGESTIONS: Readonly<Record<string, readonly string[]>> = {
  'electric bike': [
    'electric bike for adults',
    'electric bike',
    'electric bike folding',
    'voltway electric bike',
  ],
  'electric bike a': ['electric bike adult', 'electric bike all terrain'],
  'electric bike f': ['electric bike fat tire', 'electric bike folding'],
  'electric bike r': ['ridgeline electric bike', 'electric bike removable battery'],
}

export interface AmazonKeywordSampleRun {
  autocomplete: 'ok' | 'blocked'
  seed: string
  pages_read: number
  /** 差距词（按竞品数排）：`[词, 几家竞品]`。 */
  gaps: [string, number][]
  /** 含他牌名的联想词。 */
  other_brand_terms: string[]
  total: number
}

/** 每个模拟世界一份词库（同一条场景里几次刷新接着上一次的词库，和服务进程落盘一样）。 */
const banks = new WeakMap<object, AmazonKeyword[]>()

export function runAmazonKeywordSample(
  opts: { blocked_at?: number; world?: object } = {},
): AmazonKeywordSampleRun {
  const own = AMAZON_KEYWORD_SAMPLE_OWN
  const competitors = AMAZON_KEYWORD_SAMPLE_COMPETITORS
  const brands = ['Nordride', ...competitors.map((c) => c.competitor ?? '')].filter((b) => b !== '')
  const seed = seedFromTitle(own.title, { language: 'en', brands }) ?? 'electric bike'
  const pages: { prefix: string; values: readonly string[] }[] = []
  let status: AmazonKeywordSampleRun['autocomplete'] = 'ok'
  for (const [i, prefix] of amazonAutocompletePrefixes(seed).entries()) {
    if (opts.blocked_at !== undefined && i + 1 >= opts.blocked_at) {
      status = 'blocked'
      break
    }
    pages.push({ prefix, values: AMAZON_KEYWORD_SAMPLE_SUGGESTIONS[prefix] ?? [] })
  }
  const listing = [own, ...competitors].flatMap((t) => sightingsFromListing(t, brands))
  const suggested = pages.flatMap((p) =>
    sightingsFromSuggestions(p.values, {
      marketplace: 'US',
      prefix: p.prefix,
      ownBrand: 'Nordride',
      otherBrands: brands.filter((b) => b !== 'Nordride'),
    }),
  )
  const before = opts.world === undefined ? [] : (banks.get(opts.world) ?? [])
  const bank = mergeSightings(before, [...listing, ...suggested], at).bank
  if (opts.world !== undefined) banks.set(opts.world, bank)
  const [gap] = computeKeywordGaps({ own: [own], competitors, knownBrands: brands, now: at })
  return {
    autocomplete: status,
    seed,
    pages_read: pages.length,
    gaps: (gap?.terms ?? []).map((t) => [t.norm, t.competitors]),
    other_brand_terms: bank.filter((k) => k.other_brand !== undefined).map((k) => k.term),
    total: bank.length,
  }
}
