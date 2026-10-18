/**
 * WP398：Amazon 搜索框联想词——地址与读回来的那一页（全用录好的响应，不联网）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  amazonAutocompletePrefixes,
  amazonAutocompleteSupported,
  amazonAutocompleteUrl,
  parseAmazonSuggestions,
} from '../src/index.js'

const fx = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'wp398', name), 'utf8')

describe('WP398 联想词地址', () => {
  it('美国站：completion 服务 + 站点 id + 前缀', () => {
    const url = new URL(amazonAutocompleteUrl('US', ' electric bike a ') ?? '')
    expect(url.hostname).toBe('completion.amazon.com')
    expect(url.pathname).toBe('/api/2017/suggestions')
    expect(url.searchParams.get('prefix')).toBe('electric bike a')
    expect(url.searchParams.get('mid')).toBe('ATVPDKIKX0DER')
    expect(url.searchParams.get('suggestion-type')).toBe('KEYWORD')
  })

  it('UK 当 GB；认不出的站点不拼', () => {
    expect(new URL(amazonAutocompleteUrl('uk', 'x') ?? '').hostname).toBe('completion.amazon.co.uk')
    expect(amazonAutocompleteUrl('ZZ', 'x')).toBeUndefined()
    expect(amazonAutocompleteSupported('US')).toBe(true)
    expect(amazonAutocompleteSupported('ZZ')).toBe(false)
  })

  it('一批 = 种子词本身 + a–z（27 个）', () => {
    const p = amazonAutocompletePrefixes('  Electric   Bike ')
    expect(p).toHaveLength(27)
    expect(p[0]).toBe('electric bike')
    expect(p[1]).toBe('electric bike a')
    expect(p[26]).toBe('electric bike z')
    expect(amazonAutocompletePrefixes('  ')).toEqual([])
  })
})

describe('WP398 读联想词', () => {
  it('只收 KEYWORD（不收「在某类目里搜」），去重、小写、压空格', () => {
    const got = parseAmazonSuggestions(fx('suggest-electric-bike.json'))
    expect(got).toEqual({
      status: 'ok',
      suggestions: [
        'electric bike for adults',
        'electric bike',
        'electric bike for adults 750w',
        'electric bike folding',
        'voltway electric bike',
      ],
    })
  })

  it('浏览器把 JSON 画成页面（前面多一行字）也读得出', () => {
    const got = parseAmazonSuggestions(fx('suggest-rendered-page.txt'))
    expect(got.status).toBe('ok')
    if (got.status === 'ok')
      expect(got.suggestions).toEqual(['electric bike fat tire', 'electric bike folding'])
  })

  it('验证页 → blocked（调用方停下，不绕）', () => {
    expect(parseAmazonSuggestions(fx('suggest-blocked.txt'))).toEqual({ status: 'blocked' })
  })

  it('截断的 JSON / 不是 JSON → 读不懂，照实说', () => {
    const cut = fx('suggest-electric-bike.json').slice(0, 300)
    expect(parseAmazonSuggestions(`${cut}}`).status).toBe('unreadable')
    expect(parseAmazonSuggestions('<html><body>hello</body></html>').status).toBe('unreadable')
  })
})
