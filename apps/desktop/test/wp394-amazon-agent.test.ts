/**
 * WP394（docs/106 §13 A9，Amazon Agent Policy）：内置浏览器访问 Amazon 时**每个请求**自报 `Agent/AgentsWorkshop`；
 * 读 Amazon 页 HTML 原文只认 Amazon 的网址；设「配送到」邮编那条通道只认 Amazon 站点首页。不起 Electron。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AMAZON_AGENT_TOKEN,
  AMAZON_SITE_SUFFIXES,
  amazonUserAgent,
  isAmazonUrl,
  type SearchBrowserDriver,
  startSearchBrowserChannel,
  userAgentFor,
  validateAmazonDelivery,
  validateOpen,
} from '../src/search-browser.js'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @agentsws/desktop/0.3.1 Chrome/146.0.7680.80 Electron/44.3.0 Safari/537.36'
const CLEAN =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.80 Safari/537.36'

describe('WP394 · Amazon 请求自报身份', () => {
  it('Amazon 各站、联想词、图片资源域：UA 末尾一定带 Agent/AgentsWorkshop，Chromium 原有段照留', () => {
    for (const url of [
      'https://www.amazon.com/dp/B0TESTRG01',
      'https://www.amazon.co.uk/s?k=ebike',
      'https://www.amazon.co.jp/',
      'https://completion.amazon.com/api/2017/suggestions?prefix=a',
      'https://m.media-amazon.com/images/I/71x.jpg',
      'https://images-na.ssl-images-amazon.com/images/G/01/x.js',
      'https://fls-na.amazon.com/1/batch/1/OE/',
    ]) {
      const ua = userAgentFor(url, UA)
      expect(ua.endsWith(` ${AMAZON_AGENT_TOKEN}`)).toBe(true)
      expect(ua.startsWith(CLEAN)).toBe(true)
    }
    expect(AMAZON_AGENT_TOKEN).toBe('Agent/AgentsWorkshop')
  })

  it('别的域名照旧是干净的 UA（不带标识）；冒名的域名不算 Amazon', () => {
    for (const url of [
      'https://www.google.com/search?q=x',
      'https://aventon.com/products.json',
      'https://amazon.com.evil.test/',
      'https://notamazon.com/',
      'https://aws.amazon.com.example.org/',
      'not a url',
    ]) {
      expect(isAmazonUrl(url)).toBe(false)
      expect(userAgentFor(url, UA)).toBe(CLEAN)
    }
  })

  it('标识只加一次（UA 里已经有了不重复）', () => {
    const once = amazonUserAgent(UA)
    expect(amazonUserAgent(once)).toBe(once)
    expect(once.split(AMAZON_AGENT_TOKEN)).toHaveLength(2)
  })

  it('站点表和 brand-intake 的 Amazon 站点表对得上（那边加了站，这边一起加）', () => {
    const src = readFileSync(
      join(import.meta.dirname, '../../../packages/brand-intake/src/amazon.ts'),
      'utf8',
    )
    const table = /const HOST_COUNTRY[\s\S]*?\n\]/.exec(src)?.[0] ?? ''
    const suffixes = [...table.matchAll(/\['(amazon\.[a-z.]+)'/g)].map((m) => m[1])
    expect(suffixes.length).toBeGreaterThan(15)
    expect([...AMAZON_SITE_SUFFIXES].sort()).toEqual([...suffixes].sort())
  })
})

describe('WP394 · 读 HTML 原文与设配送邮编只认 Amazon', () => {
  it('html 只开 Amazon 的网址', () => {
    expect(validateOpen({ workspace_id: 'ws_1', url: 'https://example.com/', kind: 'html' })).toBe(
      'html 只开 Amazon 的网址',
    )
    const ok = validateOpen({
      workspace_id: 'ws_1',
      url: 'https://www.amazon.com/dp/B0TESTRG01',
      kind: 'html',
    })
    expect(typeof ok === 'object' && ok.kind === 'html' && ok.max_chars > 1_000_000).toBe(true)
  })

  it('配送邮编：只认 Amazon 站点首页、邮编只许字母数字空格横线', () => {
    expect(
      validateAmazonDelivery({
        workspace_id: 'ws_1',
        url: 'https://www.amazon.com/',
        zip: '10001',
      }),
    ).toMatchObject({ url: 'https://www.amazon.com', zip: '10001' })
    expect(
      validateAmazonDelivery({ workspace_id: 'ws_1', url: 'https://evil.test/', zip: '10001' }),
    ).toBe('只认 Amazon 站点首页')
    expect(
      validateAmazonDelivery({ workspace_id: 'ws_1', url: 'https://www.amazon.com/', zip: '<x>' }),
    ).toBe('邮编格式不对')
  })

  let close: (() => Promise<void>) | undefined
  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it('通道 POST /amazon-delivery 交给壳那一半；壳不会设就照实回', async () => {
    const seen: string[] = []
    const base: SearchBrowserDriver = {
      open: async () => ({ ok: false, reason: 'failed', message: 'x' }),
      reveal: async () => ({ shown: false }),
      status: () => ({ revealed: false }),
    }
    const ch = await startSearchBrowserChannel({
      driver: {
        ...base,
        amazonDelivery: async (req) => {
          seen.push(`${req.url}|${req.zip}`)
          return { ok: true, deliver_to: 'New York 10001' }
        },
      },
      token: 'tok',
    })
    close = ch.close
    const post = (body: unknown) =>
      fetch(`${ch.url}/amazon-delivery`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json())
    expect(
      await post({ workspace_id: 'ws_1', url: 'https://www.amazon.com/', zip: '10001' }),
    ).toEqual({ ok: true, deliver_to: 'New York 10001' })
    expect(seen).toEqual(['https://www.amazon.com|10001'])
    await ch.close()
    const bare = await startSearchBrowserChannel({ driver: base, token: 'tok' })
    close = bare.close
    const r = await fetch(`${bare.url}/amazon-delivery`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: 'ws_1', url: 'https://www.amazon.com/', zip: '10001' }),
    }).then((x) => x.json())
    expect(r).toMatchObject({ ok: false, reason: 'failed' })
  })
})
