/**
 * WP398（docs/106 §2.1）：内置浏览器访问 Amazon 时 User-Agent 自报 `Agent/AgentsWorkshop`；别的站不加。
 */
import { describe, expect, it } from 'vitest'
import {
  AMAZON_AGENT_TOKEN,
  AMAZON_URL_PATTERNS,
  cleanUserAgent,
  isAmazonHost,
  userAgentFor,
} from '../src/search-browser.js'

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

describe('WP398 Amazon 请求带 Agent 标识', () => {
  it('联想词、前台、图片资源都带；Chromium 原有那几段不去掉', () => {
    for (const url of [
      'https://completion.amazon.com/api/2017/suggestions?prefix=electric%20bike',
      'https://www.amazon.com/dp/B0TEST0001',
      'https://www.amazon.co.uk/s?k=ebike',
      'https://m.media-amazon.com/images/I/x.jpg',
      'https://amazon.de/',
    ]) {
      const ua = userAgentFor(url, CHROME)
      expect(ua.endsWith(` ${AMAZON_AGENT_TOKEN}`)).toBe(true)
      expect(ua.startsWith(CHROME)).toBe(true)
    }
  })

  it('别的站照旧（Google、长得像 Amazon 的假域名）', () => {
    expect(userAgentFor('https://www.google.com/search?q=x', CHROME)).toBe(CHROME)
    expect(userAgentFor('https://amazon.com.evil.test/', CHROME)).toBe(CHROME)
    expect(userAgentFor('https://notamazon.com/', CHROME)).toBe(CHROME)
    expect(isAmazonHost('fakeamazon.com')).toBe(false)
  })

  it('已经带了不重复加；地址坏了原样', () => {
    const once = userAgentFor('https://www.amazon.com/', CHROME)
    expect(userAgentFor('https://www.amazon.com/', once)).toBe(once)
    expect(userAgentFor('not a url', CHROME)).toBe(CHROME)
  })

  it('和 cleanUserAgent 叠用：Electron 字样去掉、Agent 标识留着', () => {
    const raw = `${CHROME} agentsws/0.1.0 Electron/38.0.0`
    const ua = userAgentFor('https://www.amazon.com/', cleanUserAgent(raw))
    expect(ua).not.toMatch(/Electron/)
    expect(ua).toContain(AMAZON_AGENT_TOKEN)
  })

  it('webRequest 过滤写法：每个 Amazon 域名一条', () => {
    expect(AMAZON_URL_PATTERNS).toContain('*://*.amazon.com/*')
    expect(AMAZON_URL_PATTERNS).toContain('*://*.media-amazon.com/*')
    expect(AMAZON_URL_PATTERNS.every((p) => /^\*:\/\/\*\.[a-z.-]+\/\*$/.test(p))).toBe(true)
  })
})
