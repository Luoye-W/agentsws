/**
 * WP454（docs/110 §2.2，决策 1433）：内置浏览器搜 Google 的「过渡页」漏洞。
 * - 四份 HTML 夹具（过渡页 / cookie 同意页 / `/sorry` / 正常结果页，外加「没搜到」）：页面探针认对、
 *   读出来交给服务进程的 `detect.ts` 也分类对；
 * - `loadPage()`：第一次 `dom-ready` 是过渡页时接着等二次导航（假 `webContents` 钉住）。
 * 全是本地手写夹具，不访问任何真站。
 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
// 服务进程那一半的判法（只认，不绕）：同一份夹具从页面读出来，交过去分类
import { blockOf } from '../../server/src/web-browser/detect.js'
import {
  isGoogleCookieDomain,
  type SearchBrowserDriver,
  startSearchBrowserChannel,
  validateOpen,
  validateReveal,
} from '../src/search-browser.js'
import { extractSerp, type SerpProbe, type SerpState, serpState } from '../src/search-extract.js'
import { type LoadableContents, loadPage } from '../src/search-load.js'

const FIX = join(import.meta.dirname, 'fixtures', 'search')

function onPage(html: string, url: string): void {
  const dom = new JSDOM(html, { url })
  Object.assign(globalThis, { document: dom.window.document, location: dom.window.location })
}
/** 页面加载完了没有（探针在整页加载完之前就在跑；jsdom 自己的 readyState 不好控）。 */
const loaded = (done: boolean): void => {
  Object.defineProperty(globalThis.document, 'readyState', {
    value: done ? 'complete' : 'interactive',
    configurable: true,
  })
}
const onFixture = (file: string, url: string): void =>
  onPage(readFileSync(join(FIX, file), 'utf8'), url)

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document')
  Reflect.deleteProperty(globalThis, 'location')
})

/** 夹具 → 页面里读一遍 → 服务进程分类。 */
function classify(file: string, url: string) {
  onFixture(file, url)
  const serp = extractSerp({ engine: 'google', limit: 10 })
  return { serp, block: blockOf({ ok: true, status: 200, final_url: url, serp }) }
}

describe('结果页的几种写法都读得出来（10-21 真机：页面上有结果标题、一条都没读出来）', () => {
  it('/url?q=&url=、href=# 只有 ping、data-href、结果在 #rso 而 #search 是空壳；Google 自家链接不收；带回看到几个标题', () => {
    const url = 'https://www.google.com.hk/search?q=portable+monitor'
    onFixture('google-serp-variants.html', url)
    expect(serpState({ engine: 'google' }).state).toBe('results')
    const got = extractSerp({ engine: 'google', limit: 10 })
    expect(got.items.map((i) => i.url)).toEqual([
      'https://www.example-monitors.com/review',
      'https://shop.example.org/p/156',
      'https://forum.example.net/t/portable-monitors',
    ])
    expect(got.items[0]?.snippet).toBe('We tested 12 portable monitors.')
    expect(got.candidates).toBe(4)
    expect(blockOf({ ok: true, status: 200, final_url: url, serp: got })).toBeUndefined()
  })

  it('Bing 也带回看到几个结果', () => {
    onFixture('bing-serp.html', 'https://www.bing.com/search?q=x')
    const got = extractSerp({ engine: 'bing', limit: 10 })
    expect(got.candidates).toBeGreaterThanOrEqual(got.items.length)
  })
})

describe('四份夹具：页面探针 + detect.ts 分类', () => {
  it('过渡页：探针说 interstitial；读出 0 条、带过渡页迹象；分类 interstitial（不是被拦）', () => {
    const url = 'https://www.google.com.hk/search?q=smart+glasses&gl=us&hl=en'
    onFixture('google-interstitial.html', url)
    expect(serpState({ engine: 'google' }).state).toBe('interstitial')
    const { serp, block } = classify('google-interstitial.html', url)
    expect(serp.items).toEqual([])
    expect(serp.signals.interstitial).toBe(true)
    expect(serp.signals.captcha).toBe(false)
    expect(block).toEqual({ kind: 'interstitial', message: '没出结果（过渡页）' })
  })

  it('过渡页：老壳没给迹象，只凭那两句话也认得；不是 Google 的地址不认', () => {
    const sig = {
      title: 'Google Search',
      text: "please click here if you are not redirected within a few seconds. if you're having trouble accessing google search",
      captcha: false,
      passwordInputs: 0,
    }
    const at = (final_url: string) =>
      blockOf({ ok: true, status: 200, final_url, serp: { signals: sig, items: [] } })
    expect(at('https://www.google.de/search?q=x')?.kind).toBe('interstitial')
    expect(at('https://example.com/search?q=x')).toBeUndefined()
  })

  it('cookie 同意页：探针说 consent；分类 consent（要人选一次）', () => {
    const url = 'https://consent.google.com/ml?continue=https://www.google.com/search?q%3Dx'
    onFixture('google-consent.html', url)
    expect(serpState({ engine: 'google' }).state).toBe('consent')
    const { block } = classify('google-consent.html', url)
    expect(block).toEqual({ kind: 'consent', message: 'Google 要你选一次 cookie 设置' })
    // 同意表单嵌在 www.google.* 上也认（探针看表单去向）
    onFixture('google-consent.html', 'https://www.google.com/search?q=x')
    expect(serpState({ engine: 'google' }).state).toBe('consent')
  })

  it('/sorry：探针说 blocked；分类 captcha（照旧）', () => {
    const url = 'https://www.google.com/sorry/index?continue=x'
    onFixture('google-sorry.html', url)
    expect(serpState({ engine: 'google' }).state).toBe('blocked')
    expect(classify('google-sorry.html', url).block?.kind).toBe('captcha')
    // 不在 /sorry 上、只有那句话也算被拦
    onPage(
      '<html><body>Our systems have detected unusual traffic</body></html>',
      'https://www.google.com/search?q=x',
    )
    expect(serpState({ engine: 'google' }).state).toBe('blocked')
  })

  it('正常结果页：探针说 results；读出结果、不算被拦、没有过渡页迹象', () => {
    const url = 'https://www.google.com/search?q=site%3Areddit.com'
    onFixture('google-serp.html', url)
    expect(serpState({ engine: 'google' }).state).toBe('results')
    const { serp, block } = classify('google-serp.html', url)
    expect(serp.items.length).toBeGreaterThan(0)
    expect(serp.signals.interstitial).toBe(false)
    expect(block).toBeUndefined()
  })

  it('没搜到：探针说 no_results（就读，不再等）；空白页还没出来说 pending', () => {
    onFixture('google-noresults.html', 'https://www.google.com/search?q=zzqxv')
    expect(serpState({ engine: 'google' }).state).toBe('no_results')
    onPage('<html><body></body></html>', 'https://www.google.com/search?q=x')
    const p = serpState({ engine: 'google' })
    expect(p.state).toBe('pending')
    // 核实用的那三样照实带回（jsdom 里没有视口 = 0）
    expect(typeof p.visibility).toBe('string')
    expect(p.width).toBeGreaterThanOrEqual(0)
    expect(p.height).toBeGreaterThanOrEqual(0)
  })

  it('只有结果容器、没有「没搜到」卡片：页面加载完了才算 no_results；没有 body 的页面不出错', () => {
    onPage('<html><body><div id="search"></div></body></html>', 'https://www.google.com/search?q=x')
    loaded(false)
    expect(serpState({ engine: 'google' }).state).toBe('pending')
    loaded(true)
    expect(serpState({ engine: 'google' }).state).toBe('no_results')
    const dom = new JSDOM('<feed xmlns="http://www.w3.org/2005/Atom"/>', {
      url: 'https://www.google.com/search?q=x',
      contentType: 'application/xml',
    })
    Object.assign(globalThis, { document: dom.window.document, location: dom.window.location })
    expect(serpState({ engine: 'google' }).state).toBe('pending')
  })

  it('Bing：有结果 results；加载完了还没结果才算 no_results（dom-ready 那一刻没有不算）；不认过渡页', () => {
    onFixture('bing-serp.html', 'https://www.bing.com/search?q=x')
    expect(serpState({ engine: 'bing' }).state).toBe('results')
    onPage(
      '<html><body><ol id="b_results"><li class="b_no">There are no results</li></ol></body></html>',
      'https://www.bing.com/search?q=x',
    )
    loaded(false)
    expect(serpState({ engine: 'bing' }).state).toBe('pending')
    loaded(true)
    expect(serpState({ engine: 'bing' }).state).toBe('no_results')
    onPage('<html><body></body></html>', 'https://www.bing.com/search?q=x')
    expect(serpState({ engine: 'bing' }).state).toBe('pending')
    onFixture('google-interstitial.html', 'https://www.bing.com/search?q=x')
    expect(serpState({ engine: 'bing' }).state).toBe('pending')
  })
})

/** 假 webContents：记下 loadURL；测试自己按顺序发 did-navigate / dom-ready / did-fail-load。 */
function fakeContents() {
  const em = new EventEmitter()
  const loads: { url: string; options?: { userAgent?: string } }[] = []
  let stopped = 0
  const wc: LoadableContents = {
    on: (e, l) => em.on(e, l as (...a: unknown[]) => void),
    once: (e, l) => em.once(e, l as (...a: unknown[]) => void),
    removeListener: (e, l) => em.removeListener(e, l as (...a: unknown[]) => void),
    loadURL: async (url, options) => {
      loads.push({ url, ...(options === undefined ? {} : { options }) })
    },
    stop: () => {
      stopped += 1
    },
  }
  return {
    wc,
    loads,
    stopped: () => stopped,
    navigate: (url: string, code: number) => em.emit('did-navigate', {}, url, code),
    ready: () => em.emit('dom-ready'),
    fail: (code: number, mainFrame = true) =>
      em.emit('did-fail-load', {}, code, 'ERR', 'https://x', mainFrame),
    listeners: () => em.eventNames().length,
  }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const probeOf = (state: SerpState): SerpProbe => ({
  state,
  visibility: 'visible',
  width: 0,
  height: 0,
})

describe('loadPage：等到真结果页再读', () => {
  it('不传 ready（读正文那几种）：第一次 dom-ready 就交回，状态码取主文档导航；监听全收走', async () => {
    const f = fakeContents()
    const p = loadPage(f.wc, 'https://www.reddit.com/r/x', 1_000, { userAgent: 'UA' })
    f.navigate('https://www.reddit.com/r/x', 200)
    f.ready()
    expect(await p).toEqual({ ok: true, status: 200 })
    expect(f.loads).toEqual([{ url: 'https://www.reddit.com/r/x', options: { userAgent: 'UA' } }])
    expect(f.listeners()).toBe(0)
  })

  it('过渡页：第一次 dom-ready 不算完——接着等 sei= 的二次导航，那一页出结果才交回', async () => {
    const f = fakeContents()
    const states: SerpState[] = []
    let current: SerpState = 'interstitial'
    let probes = 0
    const p = loadPage(f.wc, 'https://www.google.com/search?q=a', 1_000, {
      ready: {
        max_wait_ms: 5_000,
        interval_ms: 5,
        probe: async () => {
          probes += 1
          states.push(current)
          return probeOf(current)
        },
      },
    })
    let settled = false
    void p.then(() => {
      settled = true
    })
    f.navigate('https://www.google.com.hk/search?q=a', 200)
    f.ready()
    await tick(30)
    // 过渡页上一直在等，没交回
    expect(settled).toBe(false)
    expect(states.every((s) => s === 'interstitial')).toBe(true)
    // 页面脚本跑完：带 sei= 再导航一次；dom-ready 之前不探
    f.navigate('https://www.google.com.hk/search?q=a&sei=abc', 200)
    const before = probes
    await tick(30)
    expect(probes).toBe(before)
    expect(settled).toBe(false)
    current = 'results'
    f.ready()
    const got = await p
    expect(got).toMatchObject({ ok: true, status: 200, state: 'results', renavigations: 1 })
    expect(f.listeners()).toBe(0)
  })

  it('等满了还是过渡页：照样交回（状态 interstitial，让服务进程记「没出结果」）', async () => {
    const f = fakeContents()
    let t = 0
    const p = loadPage(f.wc, 'https://www.google.com/search?q=a', 1_000, {
      ready: {
        max_wait_ms: 8_000,
        interval_ms: 250,
        probe: async () => probeOf('interstitial'),
        now: () => t,
        sleep: async (ms) => {
          t += ms
        },
      },
    })
    f.ready()
    const got = await p
    expect(got).toMatchObject({
      ok: true,
      state: 'interstitial',
      waited_ms: 8_000,
      renavigations: 0,
    })
  })

  it('探针出错（页面正在换）当作还没出来；探的时候页面跳了，这次看到的不算', async () => {
    const f = fakeContents()
    let n = 0
    const p = loadPage(f.wc, 'https://www.google.com/search?q=a', 1_000, {
      ready: {
        max_wait_ms: 5_000,
        interval_ms: 5,
        probe: async () => {
          n += 1
          if (n === 1) throw new Error('页面正在换')
          if (n === 2) {
            // 探针还没回来，页面又导航了：这次的 results 是上一页的，不算
            f.navigate('https://www.google.com/search?q=a&sei=1', 200)
            return probeOf('results')
          }
          return probeOf('no_results')
        },
      },
    })
    f.ready()
    await tick(30)
    f.ready()
    expect(await p).toMatchObject({ ok: true, state: 'no_results', renavigations: 1 })
  })

  it('同意页 / 被拦：马上交回（不等满）', async () => {
    for (const s of ['consent', 'blocked'] as const) {
      const f = fakeContents()
      const p = loadPage(f.wc, 'https://www.google.com/search?q=a', 1_000, {
        ready: { max_wait_ms: 60_000, interval_ms: 5, probe: async () => probeOf(s) },
      })
      f.ready()
      expect(await p).toMatchObject({ ok: true, state: s, renavigations: 0 })
    }
  })

  it('打开超时：停下加载，回 timeout；主文档出错回 failed；跳转顶掉（-3）和子框架出错不算', async () => {
    const f = fakeContents()
    expect(await loadPage(f.wc, 'https://www.google.com/', 20)).toEqual({
      ok: false,
      reason: 'timeout',
      message: '0 秒内没打开',
    })
    expect(f.stopped()).toBe(1)
    const g = fakeContents()
    const p = loadPage(g.wc, 'https://www.google.com/', 1_000)
    g.fail(-3)
    g.fail(-105, false)
    g.fail(-105)
    expect(await p).toEqual({ ok: false, reason: 'failed', message: 'ERR（-105）', code: -105 })
    expect(g.listeners()).toBe(0)
  })
})

describe('热身判法与通道（WP454）', () => {
  it('Google 的 cookie 域都认；别的不认', () => {
    for (const d of [
      '.google.com',
      'www.google.com',
      '.google.com.hk',
      'google.de',
      '.google.co.uk',
    ])
      expect(isGoogleCookieDomain(d)).toBe(true)
    for (const d of ['.youtube.com', 'notgoogle.com', 'google.example.org', ''])
      expect(isGoogleCookieDomain(d)).toBe(false)
  })

  it('open 认 no_read（热身只开不读）；别的值不当真', () => {
    const base = { workspace_id: 'ws_1', url: 'https://www.google.com/', kind: 'page' }
    expect(validateOpen({ ...base, no_read: true })).toMatchObject({ no_read: true })
    expect(validateOpen({ ...base, no_read: 'yes' })).not.toHaveProperty('no_read')
  })

  it('reveal 认 consent；status 带上 google_cookies（壳不给就不带）', async () => {
    expect(
      validateReveal({
        workspace_id: 'ws_1',
        url: 'https://www.google.com/',
        reason: 'consent',
        message: 'x',
      }),
    ).toMatchObject({ reason: 'consent' })
    expect(
      typeof validateReveal({ workspace_id: 'ws_1', url: 'https://a.com', reason: 'other' }),
    ).toBe('string')
    const driver: SearchBrowserDriver = {
      open: async (req) => ({ ok: true, status: 200, final_url: req.url }),
      reveal: async () => ({ shown: true }),
      status: () => ({ revealed: false }),
      googleCookies: async (ws) => {
        if (ws === 'ws_err') throw new Error('x')
        return ws === 'ws_1'
      },
    }
    const ch = await startSearchBrowserChannel({ driver, token: 'tok' })
    try {
      const get = async (ws: string) =>
        (
          await fetch(`${ch.url}/status?workspace_id=${ws}`, {
            headers: { authorization: 'Bearer tok' },
          })
        ).json()
      expect(await get('ws_1')).toEqual({ revealed: false, google_cookies: true })
      expect(await get('ws_2')).toEqual({ revealed: false, google_cookies: false })
      expect(await get('ws_err')).toEqual({ revealed: false })
    } finally {
      await ch.close()
    }
  })
})
