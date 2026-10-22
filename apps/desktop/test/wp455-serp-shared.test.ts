/**
 * WP455（决策 1434）：Google / Bing 结果页提取挪到 `@agentsws/browser-action/serp`，桌面壳与服务进程共用。
 * - 壳里照旧 `pageScript(extractSerp, …)` 送进页面跑（函数串里不引用模块里的东西，缺省参数就是页面自己的
 *   `document` / `location`）；
 * - 同一份夹具：页面里读出来的（jsdom）与服务进程读 HTML 原文读出来的（linkedom）逐项相同。
 * 全是本地手写夹具，不访问任何真站。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
// 服务进程那一半：读「你的 Chrome」读回来的 HTML 原文
import { serpOfHtml } from '../../server/src/web-browser/serp-html.js'
import { extractSerp, pageScript, type SerpExtract } from '../src/search-extract.js'

const FIX = join(import.meta.dirname, 'fixtures', 'search')

/** 像壳那样：把函数串送进页面里跑。 */
function inPage(file: string, url: string, engine: 'google' | 'bing'): SerpExtract {
  const dom = new JSDOM(readFileSync(join(FIX, file), 'utf8'), { url, runScripts: 'outside-only' })
  return dom.window.eval(pageScript(extractSerp, { engine, limit: 10 })) as SerpExtract
}

const CASES: [string, string, 'google' | 'bing'][] = [
  ['google-serp.html', 'https://www.google.com.hk/search?q=site%3Areddit.com', 'google'],
  ['google-serp-variants.html', 'https://www.google.com.hk/search?q=portable+monitor', 'google'],
  ['google-interstitial.html', 'https://www.google.com.hk/search?q=smart+glasses', 'google'],
  ['google-sorry.html', 'https://www.google.com/sorry/index?continue=x', 'google'],
  ['google-noresults.html', 'https://www.google.com/search?q=zzqx', 'google'],
  ['bing-serp.html', 'https://www.bing.com/search?q=x', 'bing'],
]

describe('壳与服务进程同一套选择器', () => {
  it.each(CASES)('%s：页面里读的与服务进程读 HTML 原文的一样', (file, url, engine) => {
    const page = inPage(file, url, engine)
    const server = serpOfHtml(readFileSync(join(FIX, file), 'utf8'), url, engine)
    expect(server.items).toEqual(page.items)
    expect(server.candidates).toBe(page.candidates)
    expect(server.signals.interstitial).toBe(page.signals.interstitial)
    expect(server.signals.captcha).toBe(page.signals.captcha)
    expect(server.signals.title).toBe(page.signals.title)
  })

  it('函数串送进页面能直接跑（缺省参数取页面自己的 document / location）', () => {
    const got = inPage('google-serp.html', 'https://www.google.com.hk/search?q=x', 'google')
    expect(got.items.length).toBeGreaterThan(0)
  })
})
