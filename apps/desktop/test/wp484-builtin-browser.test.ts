/**
 * WP484（WP464 §8）：内置浏览器的四个毛病。
 *
 * - Google 结果读不出来：`google-goto.html` 是 10-23 在内置浏览器（没 cookie、没登录）里**真实存下**的 Google 结果页
 *   （去掉了脚本、样式、图片和埋点属性，结构原样）——结果链接只剩 `/goto?url=<不透明的一串>`；
 * - 跳转地址换目标网址（{@link resolveSerpRedirects}）；
 * - `loadPage` 超时但页面已经显示出来 → 读到多少算多少；读正文前等字数稳住；一页的总上限。
 * 串页 / 卡住之后连着「连不上」那两条的根子在 Electron 那一半（每页现开一个离屏窗口、读前停下加载），由真机重跑钉住。
 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import { blockOf } from '../../server/src/web-browser/detect.js'
import { serpOfHtml } from '../../server/src/web-browser/serp-html.js'
import { searchNavigationAllowed } from '../src/search-browser.js'
import { extractSerp, pageScript, type SerpExtract, serpState } from '../src/search-extract.js'
import {
  isTransientLoadFailure,
  type LoadableContents,
  loadPage,
  settleText,
  withDeadline,
} from '../src/search-load.js'
import { REDIRECT_CONCURRENCY, resolveSerpRedirects, usableTarget } from '../src/search-redirect.js'

const FIX = join(import.meta.dirname, 'fixtures', 'search')
const GOTO_URL = 'https://www.google.com.hk/search?q=best+standing+desk+2026&hl=en&num=10&gl=us'
const html = (): string => readFileSync(join(FIX, 'google-goto.html'), 'utf8')

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document')
  Reflect.deleteProperty(globalThis, 'location')
})

function onGoto(): void {
  const dom = new JSDOM(html(), { url: GOTO_URL })
  Object.assign(globalThis, { document: dom.window.document, location: dom.window.location })
}

describe('Google 结果页只有跳转地址（10-23 真实页面）', () => {
  it('原来的读法：页面上 9 个结果标题、一条都读不出来（WP464 那 9 次）', () => {
    onGoto()
    expect(serpState({ engine: 'google' }).state).toBe('results')
    const got = extractSerp({ engine: 'google', limit: 10 })
    expect(got.candidates).toBe(9)
    expect(got.items).toEqual([])
  })

  it('redirects: true：9 条都收下，链接是 Google 的跳转地址、标了 redirect，标题 / 摘要照读', () => {
    onGoto()
    const got = extractSerp({ engine: 'google', limit: 10, redirects: true })
    expect(got.items).toHaveLength(9)
    for (const item of got.items) {
      expect(item.redirect).toBe(true)
      expect(item.url).toMatch(/^https:\/\/www\.google\.com\.hk\/goto\?url=CAES/)
    }
    expect(got.items[0]?.title).toBe('The 3 Best Standing Desks in 2026 | Reviews by Wirecutter')
    expect(got.items[0]?.snippet).toContain('After testing more than 30 standing desks')
    expect(got.items[1]?.title).toBe('Best standing desks in 2026 so far? : r/StandingDesks')
    expect(new Set(got.items.map((i) => i.url)).size).toBe(9)
    // 条数上限照样管
    expect(extractSerp({ engine: 'google', limit: 3, redirects: true }).items).toHaveLength(3)
  })

  it('函数串送进页面里跑也一样（壳里就是这么用的）', () => {
    const dom = new JSDOM(html(), { url: GOTO_URL, runScripts: 'outside-only' })
    const got = dom.window.eval(
      pageScript(extractSerp, { engine: 'google', limit: 10, redirects: true }),
    ) as SerpExtract
    expect(got.items).toHaveLength(9)
    expect(got.items.every((i) => i.redirect === true)).toBe(true)
  })

  it('不传 redirects 的那一路（服务进程读「你的 Chrome」的 HTML）行为不变：不收跳转地址', () => {
    const server = serpOfHtml(html(), GOTO_URL, 'google')
    expect(server.items).toEqual([])
    expect(server.candidates).toBe(9)
  })

  it('认得出来的才算跳转地址：/url?q=<网址> 照旧直接还原，别的站的 /goto 不算', () => {
    const page = `<html><body><div id="search">
      <div class="g"><a href="/url?q=https://a.example.com/x&sa=U"><h3>A</h3></a></div>
      <div class="g"><a href="/url?sa=t&url=CAESabc"><h3>B</h3></a></div>
      <div class="g"><a href="https://other.example.com/goto?url=CAESxyz"><h3>C</h3></a></div>
      <div class="g"><a href="/goto?url="><h3>D</h3></a></div>
      <div class="g"><a href="http://[bad"><h3>E</h3></a></div>
    </div></body></html>`
    const dom = new JSDOM(page, { url: 'https://www.google.com/search?q=x' })
    const got = extractSerp(
      { engine: 'google', limit: 10, redirects: true },
      dom.window.document,
      'https://www.google.com/search?q=x',
    )
    expect(got.items).toEqual([
      { url: 'https://a.example.com/x', title: 'A' },
      { url: 'https://www.google.com/url?sa=t&url=CAESabc', title: 'B', redirect: true },
      { url: 'https://other.example.com/goto?url=CAESxyz', title: 'C' },
    ])
  })
})

describe('跳转地址换目标网址', () => {
  it('usableTarget：只认 http / https、不认 Google 自己的地址；相对地址按跳转地址补全', () => {
    const from = 'https://www.google.com/goto?url=x'
    expect(usableTarget(undefined, from)).toBeUndefined()
    expect(usableTarget('', from)).toBeUndefined()
    expect(usableTarget('http://[bad', from)).toBeUndefined()
    expect(usableTarget('javascript:alert(1)', from)).toBeUndefined()
    expect(usableTarget('https://www.google.com/sorry/index', from)).toBeUndefined()
    expect(usableTarget('https://support.google.com/x', from)).toBeUndefined()
    expect(usableTarget('/search?q=y', from)).toBeUndefined()
    expect(usableTarget('https://www.nytimes.com/wirecutter/x/', from)).toBe(
      'https://www.nytimes.com/wirecutter/x/',
    )
  })

  it('换得出来的换上、换不出来的不要；顺序不变、重复的只留第一条；不是跳转地址的原样留着', async () => {
    const items = [
      { url: 'https://g/goto?1', title: 'one', snippet: 's1', redirect: true as const },
      { url: 'https://direct.example.com/', title: 'direct' },
      { url: 'https://g/goto?2', title: 'two', redirect: true as const },
      { url: 'https://g/goto?3', title: 'three', redirect: true as const },
      { url: 'https://g/goto?4', title: 'dup', redirect: true as const },
      { url: 'https://g/goto?5', title: 'boom', redirect: true as const },
    ]
    const map: Record<string, string | undefined> = {
      'https://g/goto?1': 'https://a.example.com/1',
      'https://g/goto?2': undefined,
      'https://g/goto?3': 'https://www.google.com/search?q=loop',
      'https://g/goto?4': 'https://a.example.com/1',
    }
    const asked: string[] = []
    const got = await resolveSerpRedirects(items, async (url) => {
      asked.push(url)
      if (url.endsWith('5')) throw new Error('net')
      return map[url]
    })
    expect(got.items).toEqual([
      { url: 'https://a.example.com/1', title: 'one', snippet: 's1' },
      { url: 'https://direct.example.com/', title: 'direct' },
    ])
    expect(got.resolved).toBe(1)
    expect(got.dropped).toBe(4)
    expect(asked).toHaveLength(5)
  })

  it('同时最多 REDIRECT_CONCURRENCY 个；并发给 0 也至少一个一个地换', async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      url: `https://g/goto?${i}`,
      title: `t${i}`,
      redirect: true as const,
    }))
    let live = 0
    let peak = 0
    const hop = async (url: string): Promise<string> => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 2))
      live -= 1
      return `https://site.example.com/${url.split('?')[1]}`
    }
    const got = await resolveSerpRedirects(items, hop)
    expect(got.items.map((i) => i.url)).toEqual(
      items.map((_, i) => `https://site.example.com/${i}`),
    )
    expect(peak).toBe(REDIRECT_CONCURRENCY)
    peak = 0
    expect((await resolveSerpRedirects(items.slice(0, 3), hop, 0)).resolved).toBe(3)
    expect(peak).toBe(1)
  })

  it('换好之后交给服务进程：认得出结果、不再是 0 条', async () => {
    onGoto()
    const raw = extractSerp({ engine: 'google', limit: 10, redirects: true })
    const r = await resolveSerpRedirects(
      raw.items,
      async (u) => `https://site.example.com/${u.length}`,
    )
    const serp = { ...raw, items: r.items }
    expect(serp.items.length).toBeGreaterThan(0)
    expect(blockOf({ ok: true, status: 200, final_url: GOTO_URL, serp })).toBeUndefined()
  })
})

function fakeContents() {
  const em = new EventEmitter()
  let stopped = 0
  const wc: LoadableContents = {
    on: (e, l) => em.on(e, l as (...a: unknown[]) => void),
    once: (e, l) => em.once(e, l as (...a: unknown[]) => void),
    removeListener: (e, l) => em.removeListener(e, l as (...a: unknown[]) => void),
    loadURL: async () => undefined,
    stop: () => {
      stopped += 1
    },
  }
  return {
    wc,
    stopped: () => stopped,
    navigate: (url: string, code: number) => em.emit('did-navigate', {}, url, code),
    ready: () => em.emit('dom-ready'),
    listeners: () => em.eventNames().length,
  }
}

describe('loadPage：超时但页面已经显示出来', () => {
  it('partial_on_timeout + 主文档到了：停下加载、照样交回去读（partial），监听全收走', async () => {
    const f = fakeContents()
    const p = loadPage(f.wc, 'https://shop.example.com/collections/all', 30, {
      partial_on_timeout: true,
    })
    f.navigate('https://shop.example.com/collections/all', 200)
    expect(await p).toEqual({ ok: true, status: 200, partial: true })
    expect(f.stopped()).toBe(1)
    expect(f.listeners()).toBe(0)
  })

  it('主文档都没到：照旧算打不开', async () => {
    const f = fakeContents()
    const got = await loadPage(f.wc, 'https://shop.example.com/', 20, { partial_on_timeout: true })
    expect(got).toMatchObject({ ok: false, reason: 'timeout' })
  })

  it('不传 partial_on_timeout（搜索结果页、数据原文）：到了也照旧算打不开', async () => {
    const f = fakeContents()
    const p = loadPage(f.wc, 'https://shop.example.com/', 20)
    f.navigate('https://shop.example.com/', 200)
    expect(await p).toMatchObject({ ok: false, reason: 'timeout' })
  })
})

describe('内置浏览器里页面自己发起的跳转', () => {
  it('http / https 就在那一页里接着走（Bing &rdr=1、Reddit ?solution=）；别的协议不跳', () => {
    expect(
      searchNavigationAllowed('https://www.bing.com/search?q=x&rdr=1&rdrig=C0D84D409BC1'),
    ).toBe(true)
    expect(searchNavigationAllowed('https://www.reddit.com/r/x/comments/1/?solution=ed89')).toBe(
      true,
    )
    expect(searchNavigationAllowed('http://example.com/')).toBe(true)
    expect(searchNavigationAllowed('mailto:a@example.com')).toBe(false)
    expect(searchNavigationAllowed('zoommtg://join?x=1')).toBe(false)
    expect(searchNavigationAllowed('https://user:pw@example.com/')).toBe(false)
    expect(searchNavigationAllowed('not a url')).toBe(false)
  })
})

describe('连接抖一下的那几种才重开', () => {
  it('-100 / -101 / -21 算；别的错误码、超时、成功都不算', () => {
    for (const code of [-100, -101, -21])
      expect(isTransientLoadFailure({ ok: false, code })).toBe(true)
    expect(isTransientLoadFailure({ ok: false, code: -105 })).toBe(false)
    expect(isTransientLoadFailure({ ok: false })).toBe(false)
    expect(isTransientLoadFailure({ ok: true })).toBe(false)
  })
})

describe('settleText：读正文前等字数稳住', () => {
  /** 合成时钟：sleep 只往前拨。 */
  const clock = () => {
    let t = 0
    return {
      now: () => t,
      sleep: async (ms: number): Promise<void> => {
        t += ms
      },
    }
  }

  it('先等 min_ms，之后连着两次一样（且不是 0）就算稳了', async () => {
    const c = clock()
    const seen = [0, 266, 2091, 2121, 2121]
    let i = 0
    const got = await settleText({
      min_ms: 800,
      max_ms: 8_000,
      interval_ms: 500,
      probe: async () => seen[i++] ?? 0,
      ...c,
    })
    expect(got).toEqual({ waited_ms: 800 + 4 * 500, chars: 2121, stable: true })
  })

  it('一直在变：到 max_ms 交回去，读到多少算多少；探针抛错当作还没稳', async () => {
    const c = clock()
    let n = 0
    const got = await settleText({
      min_ms: 0,
      max_ms: 1_000,
      interval_ms: 400,
      probe: async () => {
        n += 1
        if (n === 2) throw new Error('navigating')
        return n * 100
      },
      ...c,
    })
    expect(got).toEqual({ waited_ms: 1_200, chars: 400, stable: false })
  })

  it('页面一直是空的：不算稳，字数记 0', async () => {
    const c = clock()
    const got = await settleText({
      min_ms: 0,
      max_ms: 300,
      interval_ms: 200,
      probe: async () => Promise.reject(new Error('gone')),
      ...c,
    })
    expect(got).toEqual({ waited_ms: 400, chars: 0, stable: false })
  })

  it('不给时钟就用真的（只等一下下）', async () => {
    const got = await settleText({ min_ms: 1, max_ms: 50, interval_ms: 1, probe: async () => 5 })
    expect(got.stable).toBe(true)
  })
})

describe('withDeadline：一页的总上限', () => {
  it('按时完成：原样交回', async () => {
    expect(await withDeadline(Promise.resolve('ok'), 50, () => 'late')).toBe('ok')
  })

  it('到点没完：交回 late()，那件事之后再完 / 再出错都不管', async () => {
    let finish: (v: string) => void = () => undefined
    const work = new Promise<string>((r) => {
      finish = r
    })
    expect(await withDeadline(work, 5, () => 'late')).toBe('late')
    finish('too late')
    const failing = new Promise<string>((_r, j) => setTimeout(() => j(new Error('x')), 15))
    expect(await withDeadline(failing, 5, () => 'late')).toBe('late')
    await new Promise((r) => setTimeout(r, 20))
  })

  it('按时出错：错照样往外抛', async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), 50, () => 'late')).rejects.toThrow(
      'boom',
    )
  })
})
