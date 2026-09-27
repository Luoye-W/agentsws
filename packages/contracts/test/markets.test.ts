/**
 * WP169：每个市场的主要语言——多语国家取第一语言，档案里可按市场覆盖；表里没有的按品牌语言。
 */
import { describe, expect, it } from 'vitest'
import {
  MARKET_COUNTRY_CODES,
  MARKET_PRIMARY_LANGUAGE,
  marketLanguage,
  normalizeMarketLanguages,
} from '../src/index.js'

describe('WP169 · 市场的主要语言', () => {
  it('派工单点名的那几个', () => {
    expect(marketLanguage('DE')).toBe('de')
    expect(marketLanguage('FR')).toBe('fr')
    expect(marketLanguage('JP')).toBe('ja')
    for (const c of ['US', 'GB', 'CA', 'AU']) expect(marketLanguage(c)).toBe('en')
    // 大小写、UK 都认
    expect(marketLanguage('de')).toBe('de')
    expect(marketLanguage('UK')).toBe('en')
  })

  it('多语国家取第一语言；档案里可以覆盖', () => {
    expect(marketLanguage('CH')).toBe('de')
    // 繁体带地区子标签
    expect(marketLanguage('TW')).toBe('zh-tw')
    expect(marketLanguage('CN')).toBe('zh')
    expect(marketLanguage('CA', { CA: 'fr' })).toBe('fr')
    expect(marketLanguage('ca', { ca: 'FR' })).toBe('fr')
    // 覆盖表里坏的一格不算
    expect(marketLanguage('CA', { CA: 'french!' })).toBe('en')
  })

  it('表里没有的回 undefined（调用方按品牌语言）；表里的键都是正式国家码、值都是语言码', () => {
    expect(marketLanguage('AQ')).toBeUndefined()
    expect(marketLanguage('ZZ')).toBeUndefined()
    for (const [k, v] of Object.entries(MARKET_PRIMARY_LANGUAGE)) {
      expect(MARKET_COUNTRY_CODES).toContain(k)
      expect(v).toMatch(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/)
    }
  })

  it('覆盖表归一化：国家码大写、语言码小写，认不出的丢掉', () => {
    expect(normalizeMarketLanguages({ ca: 'FR', uk: 'en', XX: 'de', DE: 'deutsch' })).toEqual({
      CA: 'fr',
      GB: 'en',
    })
    expect(normalizeMarketLanguages(undefined)).toEqual({})
  })
})
