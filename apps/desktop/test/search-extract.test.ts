/**
 * WP353：应用内搜索浏览器的只读 DOM 提取——本地手写夹具（不访问任何真站）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import { extractReadable, extractSerp, pageScript } from '../src/search-extract.js'

const FIX = join(import.meta.dirname, 'fixtures', 'search')

/** 把夹具装成「当前页面」（`document` / `location` 指过去），跑完复原。 */
function onPage(file: string, url: string): void {
  const dom = new JSDOM(readFileSync(join(FIX, file), 'utf8'), { url })
  Object.assign(globalThis, { document: dom.window.document, location: dom.window.location })
}
afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document')
  Reflect.deleteProperty(globalThis, 'location')
})

describe('extractSerp', () => {
  it('Google：标题 / 真实链接 / 摘要；/url?q= 还原；广告、Google 自家链接、重复的不收', () => {
    onPage('google-serp.html', 'https://www.google.com.hk/search?q=site%3Areddit.com')
    const got = extractSerp({ engine: 'google', limit: 10 })
    expect(got.items.map((i) => i.url)).toEqual([
      'https://www.reddit.com/r/SmartGlasses/',
      'https://www.reddit.com/r/SmartGlasses/comments/abc/best_smart_glasses_2026/',
      'https://www.reddit.com/r/augmentedreality/comments/xyz/glasses_compared/',
    ])
    expect(got.items[0]).toEqual({
      url: 'https://www.reddit.com/r/SmartGlasses/',
      title: 'r/SmartGlasses - Reddit',
      snippet: 'A community for smart glasses owners and fans.',
    })
    expect(got.items[2]?.snippet).toBe('Detailed comparison table.')
    expect(got.signals.captcha).toBe(false)
  })

  it('Google：条数上限', () => {
    onPage('google-serp.html', 'https://www.google.com/search?q=x')
    expect(extractSerp({ engine: 'google', limit: 1 }).items).toHaveLength(1)
  })

  it('Bing：/ck/a 的 u=a1<base64> 还原成目标网址；直接链接照收；广告不收', () => {
    onPage('bing-serp.html', 'https://www.bing.com/search?q=x')
    const got = extractSerp({ engine: 'bing', limit: 10 })
    expect(got.items).toEqual([
      {
        url: 'https://www.reddit.com/r/SmartGlasses/',
        title: 'r/SmartGlasses - Reddit',
        snippet: 'Smart glasses community.',
      },
      {
        url: 'https://www.reddit.com/r/augmentedreality/',
        title: 'r/augmentedreality',
        snippet: 'AR news and discussion.',
      },
    ])
  })

  it('人机验证页：一条都不认、迹象里标出验证挂件与那句话', () => {
    onPage('google-sorry.html', 'https://www.google.com/sorry/index?continue=x')
    const got = extractSerp({ engine: 'google', limit: 10 })
    expect(got.items).toEqual([])
    expect(got.signals.captcha).toBe(true)
    expect(got.signals.text).toContain('unusual traffic')
  })
})

describe('extractReadable', () => {
  it('正文优先取 main；超长截断', () => {
    onPage('reddit-thread.html', 'https://www.reddit.com/r/SmartGlasses/comments/abc/')
    const got = extractReadable({ maxChars: 1000 })
    expect(got.signals.title).toBe('Best smart glasses 2026? : r/SmartGlasses')
    expect(got.text).toContain('Battery life was the biggest difference.')
    expect(got.text).not.toContain('Popular')
    expect(got.truncated).toBe(false)
    const short = extractReadable({ maxChars: 10 })
    expect(short.text).toHaveLength(10)
    expect(short.truncated).toBe(true)
  })
})

describe('pageScript', () => {
  it('函数源码 + 参数 JSON（参数只是数据）', () => {
    const s = pageScript((a: { n: number }) => a.n + 1, { n: 2 })
    expect(s).toContain('({"n":2})')
    expect(new Function(`return ${s}`)()).toBe(3)
  })
})
