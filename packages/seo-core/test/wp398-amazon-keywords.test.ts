/**
 * WP398：词库纯逻辑——归一化、他牌名、拆词、并进词库、差距（录好的竞品 / 自家文本）。
 */
import { describe, expect, it } from 'vitest'
import {
  applyMarks,
  commonGapCount,
  computeKeywordGaps,
  extractPhrases,
  keywordRows,
  mergeSightings,
  normalizeKeyword,
  otherBrandIn,
  seedFromTitle,
  sightingsFromListing,
  sightingsFromSuggestions,
  singularEn,
} from '../src/index.js'
import { COMPETITORS, KNOWN_BRANDS, OWN } from './fixtures/wp398-listings.js'

const now = '2026-10-18T09:00:00.000Z'

describe('WP398 归一化', () => {
  it('单复数（常见规则 + 不改的词）', () => {
    expect(singularEn('batteries')).toBe('battery')
    expect(singularEn('brakes')).toBe('brake')
    expect(singularEn('boxes')).toBe('box')
    expect(singularEn('adults')).toBe('adult')
    expect(singularEn('glass')).toBe('glass')
    expect(singularEn('series')).toBe('series')
    expect(singularEn('bus')).toBe('bus')
  })

  it('大小写、连字符、停用词：E-Bikes for Adults = ebike adult', () => {
    expect(normalizeKeyword('E-Bikes for Adults')).toBe('ebike adult')
    expect(normalizeKeyword('Electric Bike  FOR adults')).toBe('electric bike adult')
    expect(normalizeKeyword('all terrain')).toBe('all terrain')
  })

  it('种子词：标题第一段里最长的一串，取最后 3 个词', () => {
    const en = { language: 'en', brands: ['Nordvolt'] }
    expect(seedFromTitle('Nordvolt Portable Power Station 1000W, 1024Wh LiFePO4 Battery', en)).toBe(
      'portable power station',
    )
    expect(seedFromTitle(OWN.title, { language: 'en', brands: ['Nordride'] })).toBe('electric bike')
    expect(seedFromTitle('Nordvolt 1000W', en)).toBeUndefined()
  })

  it('他牌名：词里含别家品牌就认出来（多词品牌也认）', () => {
    expect(otherBrandIn('voltway electric bike', ['Voltway'])).toBe('Voltway')
    expect(otherBrandIn('rad power bike battery', ['Rad Power Bikes'])).toBe('Rad Power Bikes')
    expect(otherBrandIn('electric bike', ['Voltway'])).toBeUndefined()
  })
})

describe('WP398 拆词', () => {
  it('标点切段；停用词、规格、品牌当断点；整段一个词的也留', () => {
    const got = extractPhrases(
      'Voltway Electric Bike for Adults, 750W Fat Tire Ebike with Removable Battery',
      { language: 'en', brands: ['Voltway'] },
    ).map((p) => p.norm)
    expect(got).toContain('electric bike')
    expect(got).toContain('adult')
    expect(got).toContain('fat tire ebike')
    expect(got).toContain('removable battery')
    expect(got.some((n) => n.includes('voltway'))).toBe(false)
    expect(got.some((n) => n.includes('750w'))).toBe(false)
    expect(got.some((n) => /\bfor\b|\bwith\b/.test(n))).toBe(false)
  })

  it('显示用原写法（保留连字符），键去连字符', () => {
    const [p] = extractPhrases('Step-Thru Frame', { language: 'en', brands: [] })
    expect(p).toEqual({ norm: 'stepthru frame', term: 'step-thru frame' })
  })

  it('竞品文本：五点里提到的别家品牌（Ridgeline）也去掉；标题 / 五点分开记', () => {
    const s = sightingsFromListing(COMPETITORS[0] as never, KNOWN_BRANDS)
    expect(s.every((x) => x.source === 'competitor_listing' && x.competitor === 'Voltway')).toBe(
      true,
    )
    expect(s.some((x) => x.norm.includes('ridgeline'))).toBe(false)
    expect(s.find((x) => x.norm === 'removable battery')?.field).toBe('title')
    expect(s.find((x) => x.norm === 'all terrain')?.field).toBe('bullets')
  })

  it('联想词：整句一个词；别家品牌标出来，自家品牌不标', () => {
    const s = sightingsFromSuggestions(
      [
        'electric bike for adults',
        'voltway electric bike',
        'nordride ebike',
        'Electric Bike For Adults',
      ],
      {
        marketplace: 'us',
        prefix: 'electric bike',
        ownBrand: 'Nordride',
        otherBrands: KNOWN_BRANDS,
      },
    )
    expect(s.map((x) => x.norm)).toEqual([
      'electric bike adult',
      'voltway electric bike',
      'nordride ebike',
    ])
    expect(s[1]?.other_brand).toBe('Voltway')
    expect(s[2]?.other_brand).toBeUndefined()
    expect(s[0]?.marketplace).toBe('US')
  })
})

describe('WP398 并进词库', () => {
  it('新词进库、同一个词合并来源与出处；数字格一律不出现', () => {
    const a = sightingsFromSuggestions(['electric bike'], {
      marketplace: 'US',
      prefix: 'electric bike',
      otherBrands: [],
    })
    const b = sightingsFromListing(COMPETITORS[3] as never, KNOWN_BRANDS)
    const first = mergeSightings([], a, now)
    expect(first.added).toBe(1)
    const second = mergeSightings(first.bank, b, '2026-10-19T09:00:00.000Z')
    const k = second.bank.find((x) => x.id === 'US:electric bike')
    expect(k?.sources).toEqual(['autocomplete', 'competitor_listing'])
    expect(k?.first_seen_at).toBe(now)
    expect(k?.last_seen_at).toBe('2026-10-19T09:00:00.000Z')
    expect(k?.seen.find((s) => s.source === 'competitor_listing')?.asin).toBe('B0PEDL0001')
    expect(second.bank.every((x) => x.metrics === undefined)).toBe(true)
    // 再见一次只更新时间，不多一条出处
    const third = mergeSightings(second.bank, a, '2026-10-20T09:00:00.000Z')
    expect(third.added).toBe(0)
    expect(third.bank.find((x) => x.id === 'US:electric bike')?.seen).toHaveLength(2)
  })

  it('标记：核心 / 不要互斥', () => {
    const [k] = mergeSightings(
      [],
      sightingsFromSuggestions(['ebike'], { marketplace: 'US', prefix: 'e', otherBrands: [] }),
      now,
    ).bank
    if (k === undefined) throw new Error('no keyword')
    const core = applyMarks(k, ['core', 'in_listing'], [], now)
    expect(core.marks).toEqual(['core', 'in_listing'])
    expect(applyMarks(core, ['exclude'], [], now).marks).toEqual(['in_listing', 'exclude'])
    expect(applyMarks(core, [], ['in_listing'], now).marks).toEqual(['core'])
  })
})

describe('WP398 差距：竞品有、你没有', () => {
  const gaps = computeKeywordGaps({
    own: [OWN],
    competitors: COMPETITORS,
    knownBrands: KNOWN_BRANDS,
    now,
  })
  const gap = gaps[0]

  it('只和同站点的竞品比（英国站那家不算）；同一家的两个 ASIN 只算一家', () => {
    expect(gaps).toHaveLength(1)
    expect(gap?.competitors_compared).toBe(3)
    expect(gap?.terms.some((t) => t.norm.includes('torque'))).toBe(false)
  })

  it('按出现在几家竞品里排；同一串词只留一个；自家写了的不算', () => {
    const top = gap?.terms.slice(0, 5).map((t) => [t.norm, t.competitors])
    expect(top).toEqual([
      ['hydraulic disc brake', 3],
      ['removable battery', 3],
      ['all terrain', 2],
      ['fat tire', 2],
      ['stepthru frame', 2],
    ])
    const norms = gap?.terms.map((t) => t.norm) ?? []
    expect(norms).not.toContain('disc brake')
    expect(norms).not.toContain('removable battery charge')
    expect(norms).not.toContain('electric bike')
    expect(norms).not.toContain('adult')
    const rb = gap?.terms.find((t) => t.norm === 'removable battery')
    expect(rb?.missing_words).toEqual(['removable'])
    expect(rb?.competitor_names).toEqual(['Pedalux', 'Ridgeline', 'Voltway'])
    expect(rb?.asins).toContain('B0VOLT0002')
  })

  it('每一条都带出至少一个新的缺词；品牌名不会成差距词', () => {
    const seen = new Set<string>()
    for (const t of gap?.terms ?? []) {
      expect(t.missing_words.some((w) => !seen.has(w))).toBe(true)
      for (const w of t.missing_words) seen.add(w)
      expect(/voltway|ridgeline|pedalux/.test(t.norm)).toBe(false)
    }
  })

  it('体检卡那一行：不止一家竞品在用的才算「常用」', () => {
    if (gap === undefined) throw new Error('no gap')
    expect(commonGapCount(gap)).toBe(5)
    expect(commonGapCount({ ...gap, competitors_compared: 1 })).toBe(gap.terms.length)
  })

  it('没有竞品文本：差距为空，照实说和 0 家比', () => {
    const [g] = computeKeywordGaps({ own: [OWN], competitors: [], knownBrands: [], now })
    expect(g?.terms).toEqual([])
    expect(g?.competitors_compared).toBe(0)
  })

  it('词表的行：竞品数、自家写没写、是不是差距词', () => {
    const bank = mergeSightings(
      [],
      [
        ...sightingsFromSuggestions(['electric bike for adults', 'electric bike fat tire'], {
          marketplace: 'US',
          prefix: 'electric bike',
          otherBrands: KNOWN_BRANDS,
        }),
        ...COMPETITORS.flatMap((c) => sightingsFromListing(c, KNOWN_BRANDS)),
      ],
      now,
    ).bank
    const rows = keywordRows({ bank, own: [OWN], competitors: COMPETITORS, gaps })
    const adults = rows.find((r) => r.norm === 'electric bike adult')
    expect(adults?.in_own_text).toBe(true)
    expect(adults?.competitors).toBe(1)
    const fat = rows.find((r) => r.norm === 'electric bike fat tire')
    expect(fat?.in_own_text).toBe(false)
    expect(rows.find((r) => r.norm === 'removable battery')?.gap).toBe(true)
    expect(rows[0]?.competitors).toBeGreaterThanOrEqual(rows[rows.length - 1]?.competitors ?? 0)
  })
})
