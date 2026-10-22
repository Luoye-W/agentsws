/**
 * WP455（docs/110 §3.1 第 5–8 条，决策 1434）：搜索回退链里「用你的 Chrome（插件）搜 Google」那一环。
 * - 解析：桌面壳那份夹具（正常结果页 / 过渡页 / `/sorry` / 没搜到 / 同意页）在服务进程里用同一个提取函数读；
 * - 读页：BrowserSkill 四个读动作，过渡页隔 1 秒重读、最多 8 秒；
 * - 顺序：内置浏览器 Google 没拿到结果才走；拿到了不碰你的 Chrome；
 * - 频率（每小时 20 次、同时计入 60 页）、被拦停到北京时间第二天零点、不可用记 skipped、第一次说一句。
 * 全用替身（不起桌面壳、不调 bsk、不联网）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  type BskJson,
  blockOfHtml,
  createBrowserWebSearch,
  createOwnBrowserReader,
  createOwnChromeGate,
  createSearchThrottle,
  nextBeijingMidnight,
  type OpenResult,
  OWN_BROWSER_SERP_SETTLE_MS,
  OWN_CHROME_MAX_PER_HOUR,
  OWN_CHROME_PAUSED_WHY,
  OWN_CHROME_TELL_LINE,
  type OwnBrowserReader,
  type OwnBrowserSerpRead,
  type SearchBrowserChannel,
  type SearchTraceEntry,
  serpOfHtml,
} from '../src/web-browser/index.js'

const FIX = join(import.meta.dirname, '..', '..', 'desktop', 'test', 'fixtures', 'search')
const fixture = (f: string): string => readFileSync(join(FIX, f), 'utf8')
const SERP_URL = 'https://www.google.com/search?q=desk+lamp&hl=en&num=10&gl=us'
const SORRY_URL = 'https://www.google.com/sorry/index?continue=x'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('解析：服务进程用桌面壳同一个提取函数读 HTML 原文', () => {
  it('正常结果页：读出结果、广告和 Google 自家链接不收；不算被拦', () => {
    const url = 'https://www.google.com.hk/search?q=site%3Areddit.com'
    const got = serpOfHtml(fixture('google-serp.html'), url)
    expect(got.items.map((i) => i.url)).toEqual([
      'https://www.reddit.com/r/SmartGlasses/',
      'https://www.reddit.com/r/SmartGlasses/comments/abc/best_smart_glasses_2026/',
      'https://www.reddit.com/r/augmentedreality/comments/xyz/glasses_compared/',
    ])
    expect(blockOfHtml(fixture('google-serp.html'), url)).toBeUndefined()
  })

  it('几种写法（/url?q=&url=、只有 ping、data-href、#rso）也读得出来', () => {
    const got = serpOfHtml(fixture('google-serp-variants.html'), SERP_URL)
    expect(got.items.map((i) => i.url)).toEqual([
      'https://www.example-monitors.com/review',
      'https://shop.example.org/p/156',
      'https://forum.example.net/t/portable-monitors',
    ])
    expect(got.candidates).toBe(4)
  })

  it('过渡页 → interstitial；/sorry → captcha；同意页 → consent；没搜到 → 0 条、不算被拦', () => {
    const hk = 'https://www.google.com.hk/search?q=smart+glasses&gl=us&hl=en'
    expect(blockOfHtml(fixture('google-interstitial.html'), hk)?.kind).toBe('interstitial')
    expect(blockOfHtml(fixture('google-sorry.html'), SORRY_URL)?.kind).toBe('captcha')
    // 地址拿不准时（读回来时页面已经换了）按页面内容也认得出验证页
    expect(blockOfHtml(fixture('google-sorry.html'), SERP_URL)?.kind).toBe('captcha')
    expect(
      blockOfHtml(fixture('google-consent.html'), 'https://consent.google.com/ml?continue=x')?.kind,
    ).toBe('consent')
    expect(serpOfHtml(fixture('google-noresults.html'), SERP_URL).items).toEqual([])
    expect(blockOfHtml(fixture('google-noresults.html'), SERP_URL)).toBeUndefined()
  })

  it('不跑页面脚本：正文里的脚本字不进「正文开头一截」', () => {
    const html =
      '<html><head><title>x</title></head><body><script>var s="unusual traffic"</script><div id="search"></div></body></html>'
    const got = serpOfHtml(html, SERP_URL)
    expect(got.signals.text).not.toContain('unusual traffic')
    expect(blockOfHtml(html, SERP_URL)).toBeUndefined()
  })
})

/** 假的 bsk：按调用顺序记下参数；`get-html` 按给的一串 HTML 依次回。 */
function fakeBsk(pages: string[], finalUrl = SERP_URL) {
  const calls: string[][] = []
  let i = 0
  const bsk: BskJson = async (args) => {
    calls.push(args)
    if (args[0] === 'session' && args[1] === 'start') return { session_id: 's1' }
    if (args[0] === 'navigate') return { reached: true, url: args.at(-1), final_url: finalUrl }
    if (args[0] === 'get-html') {
      const html = pages[Math.min(i, pages.length - 1)] ?? ''
      i += 1
      return { html, tab_id: 1 }
    }
    return {}
  }
  return { bsk, calls }
}

describe('读页：BrowserSkill 四个读动作；过渡页隔 1 秒重读、最多 8 秒', () => {
  const pending = (html: string, url: string): boolean =>
    blockOfHtml(html, url)?.kind === 'interstitial'

  it('后台开窗口、等 domcontentloaded、读回；过渡页之后变成结果页就交回结果页', async () => {
    let t = 0
    const slept: number[] = []
    const { bsk, calls } = fakeBsk([
      fixture('google-interstitial.html'),
      fixture('google-interstitial.html'),
      fixture('google-serp.html'),
    ])
    const reader = createOwnBrowserReader({
      bsk,
      newId: () => 'r1',
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms)
        t += ms
      },
    })
    const got = await reader.serp?.(SERP_URL, { pending })
    expect(got?.ok).toBe(true)
    const ok = got as Extract<OwnBrowserSerpRead, { ok: true }>
    expect(ok.rereads).toBe(2)
    expect(ok.settled).toBe(true)
    expect(serpOfHtml(ok.html, ok.final_url).items).toHaveLength(3)
    expect(slept).toEqual([1_000, 1_000])
    expect(calls[0]).toEqual(['session', 'start', '--request-id', 'r1', '--no-focus'])
    expect(calls[1]?.slice(0, 5)).toEqual([
      'navigate',
      '--session',
      's1',
      '--wait-until',
      'domcontentloaded',
    ])
    expect(calls[1]?.at(-1)).toBe(SERP_URL)
    // 只用读动作：不点、不填、不跑脚本
    expect(new Set(calls.map((c) => c[0]))).toEqual(new Set(['session', 'navigate', 'get-html']))
    await reader.close()
    expect(calls.at(-1)).toEqual(['session', 'stop', 's1'])
  })

  it('等满 8 秒还是过渡页：交回最后那一页、settled=false（调用方记「过渡页」）', async () => {
    let t = 0
    const { bsk, calls } = fakeBsk([fixture('google-interstitial.html')])
    const reader = createOwnBrowserReader({
      bsk,
      now: () => t,
      sleep: async (ms) => {
        t += ms
      },
    })
    const got = (await reader.serp?.(SERP_URL, { pending })) as Extract<
      OwnBrowserSerpRead,
      { ok: true }
    >
    expect(got.settled).toBe(false)
    expect(got.rereads).toBe(OWN_BROWSER_SERP_SETTLE_MS / 1_000)
    expect(calls.filter((c) => c[0] === 'get-html')).toHaveLength(1 + got.rereads)
    await reader.close()
  })

  it('bsk 出错：关窗口、照实说（超时记 timeout）', async () => {
    const calls: string[][] = []
    const reader = createOwnBrowserReader({
      bsk: async (args) => {
        calls.push(args)
        if (args[0] === 'session' && args[1] === 'start') return { session_id: 's9' }
        if (args[0] === 'navigate') throw new Error('navigation timed out after 30000ms')
        return {}
      },
    })
    const got = await reader.serp?.(SERP_URL, { pending })
    expect(got).toMatchObject({ ok: false, reason: 'timeout' })
    expect(calls.at(-1)).toEqual(['session', 'stop', 's9'])
  })
})

// ── 回退链里的这一环 ─────────────────────────────────────────────────────

const SIG = { title: 't', text: '', captcha: false, passwordInputs: 0 }
const builtinSerp = (urls: string[]): OpenResult => ({
  ok: true,
  status: 200,
  final_url: 'https://www.google.com/search?q=x',
  serp: { signals: SIG, items: urls.map((url, i) => ({ url, title: `T${i}` })) },
})

/** 内置浏览器替身：Google 回什么由 `google` 定，Bing 一律有结果；已经有 Google cookie（不热身）。 */
function fakeShell(google: () => OpenResult) {
  const opened: string[] = []
  const channel: SearchBrowserChannel = {
    open: async (i) => {
      opened.push(i.kind)
      return i.kind === 'google' ? google() : builtinSerp(['https://bing.example/1'])
    },
    reveal: async () => true,
    status: async () => ({ revealed: false, google_cookies: true }),
  }
  return { channel, opened }
}

/** 你的 Chrome 替身：`serp` 按给的 HTML 回（`undefined` = 没有这一口）。 */
function fakeOwnChrome(page: () => OwnBrowserSerpRead) {
  const urls: string[] = []
  const reader: OwnBrowserReader = {
    read: async () => ({ ok: false, message: '不用' }),
    dataRead: async () => ({ ok: false, message: '不用' }),
    serp: async (url) => {
      urls.push(url)
      return page()
    },
    close: async () => {},
  }
  return { reader, urls }
}
const okPage = (file: string, final_url = SERP_URL): OwnBrowserSerpRead => ({
  ok: true,
  final_url,
  html: fixture(file),
  rereads: 0,
  settled: true,
})

function setup(o: {
  channel?: SearchBrowserChannel
  reader?: () => OwnBrowserReader | undefined
  maxPerHour?: number
  ownPerHour?: number
  start?: string
  gateFile?: string
  dir?: string
}) {
  let t = Date.parse(o.start ?? '2026-10-22T03:00:00Z')
  const now = (): number => t
  const throttle = createSearchThrottle({
    now,
    random: () => 0,
    sleep: async (ms) => {
      t += ms
    },
    maxPerHour: o.maxPerHour ?? 60,
    minGapMs: 0,
    maxGapMs: 0,
  })
  const gate = createOwnChromeGate({
    now,
    ...(o.ownPerHour === undefined ? {} : { maxPerHour: o.ownPerHour }),
    ...(o.gateFile === undefined ? {} : { file: o.gateFile }),
  })
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'wp455-'))
  dirs.push(dir)
  const search = createBrowserWebSearch({
    workspace_id: 'ws_1',
    dir,
    ...(o.channel === undefined ? {} : { channel: o.channel }),
    throttle,
    profile: () => ({ markets: ['US'] }),
    keyless: () => ({ search: async () => ({ sources: [{ url: 'https://pub.example/a' }] }) }),
    ownChrome: { reader: o.reader ?? (() => undefined), gate },
    now,
  })
  const steps = (n = -1): string[] => {
    const s = JSON.parse(readFileSync(join(dir, 'web-search.json'), 'utf8')) as {
      trace: SearchTraceEntry[]
    }
    // 热身那一步（已经有 Google cookie 记 skipped）不是这一单的事，略过
    return (s.trace.at(n)?.steps ?? [])
      .filter((x) => x.via !== 'google_warmup')
      .map((x) => `${x.via}:${x.result}`)
  }
  const why = (via: string, n = -1): string | undefined => {
    const s = JSON.parse(readFileSync(join(dir, 'web-search.json'), 'utf8')) as {
      trace: SearchTraceEntry[]
    }
    return s.trace.at(n)?.steps.find((x) => x.via === via)?.why
  }
  return {
    search,
    steps,
    why,
    gate,
    throttle,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('顺序：内置浏览器 Google 没拿到结果才走你的 Chrome；只搜 Google', () => {
  it('内置 Google 有结果：不碰你的 Chrome', async () => {
    const shell = fakeShell(() => builtinSerp(['https://g.example/1']))
    const own = fakeOwnChrome(() => okPage('google-serp.html'))
    const { search, steps } = setup({ channel: shell.channel, reader: () => own.reader })
    const r = await search.search('desk lamp')
    expect(r.via).toBe('google')
    expect(own.urls).toEqual([])
    expect(steps()).toEqual(['google:ok'])
  })

  it.each([
    ['0 条', () => builtinSerp([])],
    ['超时', (): OpenResult => ({ ok: false, reason: 'timeout', message: '15 秒内没打开' })],
    [
      '被拦',
      (): OpenResult => ({
        ok: true,
        status: 200,
        final_url: SORRY_URL,
        serp: { signals: { ...SIG, captcha: true }, items: [] },
      }),
    ],
  ])(
    '内置 Google %s → 你的 Chrome 搜 Google（同一份 gl / hl），有结果就不往下走',
    async (_n, g) => {
      const shell = fakeShell(g)
      const own = fakeOwnChrome(() => okPage('google-serp.html'))
      const { search, steps } = setup({ channel: shell.channel, reader: () => own.reader })
      const r = await search.search('desk lamp')
      expect(r.via).toBe('own_chrome')
      expect(r.sources).toHaveLength(3)
      expect(r.content).toContain('这次的结果来自 Google（你的 Chrome）')
      expect(own.urls).toEqual([SERP_URL])
      expect(new URL(own.urls[0] ?? '').hostname).toBe('www.google.com')
      expect(shell.opened).not.toContain('bing')
      expect(steps().slice(-1)).toEqual(['own_chrome:ok'])
    },
  )

  it('这台没有内置浏览器（没有桌面壳）也照样走你的 Chrome', async () => {
    const own = fakeOwnChrome(() => okPage('google-serp.html'))
    const { search, steps } = setup({ reader: () => own.reader })
    const r = await search.search('desk lamp')
    expect(r.via).toBe('own_chrome')
    expect(steps()).toEqual(['google:skipped', 'own_chrome:ok'])
  })

  it('你的 Chrome 也 0 条 / 过渡页：记下、接着 Bing', async () => {
    const shell = fakeShell(() => builtinSerp([]))
    let page = okPage('google-noresults.html')
    const own = fakeOwnChrome(() => page)
    const { search, steps } = setup({ channel: shell.channel, reader: () => own.reader })
    expect((await search.search('desk lamp')).via).toBe('bing')
    expect(steps()).toEqual(['google:empty', 'own_chrome:empty', 'bing:ok'])
    page = { ...okPage('google-interstitial.html'), settled: false }
    const r = await search.search('desk lamp 2')
    expect(r.via).toBe('bing')
    expect(r.content).toContain('过渡页')
    expect(steps()).toEqual(['google:empty', 'own_chrome:interstitial', 'bing:ok'])
  })
})

describe('不可用 → skipped', () => {
  it('没选「用你正在用的浏览器」/ 插件没装好 / 老替身没有 serp 这一口：记 skipped，不出声', async () => {
    const shell = fakeShell(() => builtinSerp([]))
    const { search, steps, why } = setup({ channel: shell.channel })
    const r = await search.search('desk lamp')
    expect(r.via).toBe('bing')
    expect(steps()).toEqual(['google:empty', 'own_chrome:skipped', 'bing:ok'])
    expect(why('own_chrome')).toContain('用你正在用的浏览器')
    expect(r.content).not.toContain('你的 Chrome')

    const old: OwnBrowserReader = {
      read: async () => ({ ok: false, message: 'x' }),
      dataRead: async () => ({ ok: false, message: 'x' }),
      close: async () => {},
    }
    const s2 = setup({ channel: shell.channel, reader: () => old })
    await s2.search.search('desk lamp')
    expect(s2.steps()).toEqual(['google:empty', 'own_chrome:skipped', 'bing:ok'])
  })
})

describe('频率：每小时最多 20 次，同时计入每小时 60 页', () => {
  it('第 21 次这一小时不开你的 Chrome；过了一小时恢复', async () => {
    expect(OWN_CHROME_MAX_PER_HOUR).toBe(20)
    const own = fakeOwnChrome(() => okPage('google-serp.html'))
    const { search, steps, why, advance } = setup({ reader: () => own.reader })
    for (let i = 0; i < 20; i += 1) await search.search(`q${i}`)
    expect(own.urls).toHaveLength(20)
    const r = await search.search('q20')
    expect(own.urls).toHaveLength(20)
    expect(r.via).toBe('public')
    expect(steps()).toContain('own_chrome:skipped')
    expect(why('own_chrome')).toContain('20 次（上限）')
    advance(3_600_001)
    expect((await search.search('q21')).via).toBe('own_chrome')
  })

  it('总上限 60 页满了：你的 Chrome 也不开（这一页算在总数里）', async () => {
    const shell = fakeShell(() => builtinSerp([]))
    const own = fakeOwnChrome(() => okPage('google-serp.html'))
    // 总上限 2 页：内置 Google 用掉 1 页、你的 Chrome 用掉 1 页
    const { search, steps, why, throttle } = setup({
      channel: shell.channel,
      reader: () => own.reader,
      maxPerHour: 2,
    })
    expect((await search.search('a')).via).toBe('own_chrome')
    expect(throttle.usedThisHour()).toBe(2)
    await search.search('b')
    expect(own.urls).toHaveLength(1)
    expect(steps()).toContain('own_chrome:skipped')
    expect(why('own_chrome')).toContain('页（上限）')
  })
})

describe('被 Google 拦：不亮给人、不点，停到北京时间第二天零点', () => {
  it('北京时间零点的算法', () => {
    // 北京 10-22 11:00 → 10-23 00:00（= UTC 10-22 16:00）
    expect(nextBeijingMidnight(Date.parse('2026-10-22T03:00:00Z'))).toBe(
      Date.parse('2026-10-22T16:00:00Z'),
    )
    // 北京 10-22 23:59 → 10-23 00:00
    expect(nextBeijingMidnight(Date.parse('2026-10-22T15:59:00Z'))).toBe(
      Date.parse('2026-10-22T16:00:00Z'),
    )
    // 北京 10-23 00:00 整 → 10-24 00:00
    expect(nextBeijingMidnight(Date.parse('2026-10-22T16:00:00Z'))).toBe(
      Date.parse('2026-10-23T16:00:00Z'),
    )
  })

  it('/sorry：这一路停用、不亮给人；停用期间记 skipped（今天在你的 Chrome 里被 Google 拦过）；过了零点恢复；重启也记得', async () => {
    const gateDir = mkdtempSync(join(tmpdir(), 'wp455-gate-'))
    dirs.push(gateDir)
    const gateFile = join(gateDir, 'web-search-own-chrome.json')
    let page = okPage('google-sorry.html', SORRY_URL)
    const own = fakeOwnChrome(() => page)
    const revealed: string[] = []
    const shell = fakeShell(() => builtinSerp([]))
    shell.channel.reveal = async (i) => {
      revealed.push(i.url)
      return true
    }
    const s = setup({ channel: shell.channel, reader: () => own.reader, gateFile })
    const r = await s.search.search('desk lamp')
    expect(r.via).toBe('bing')
    expect(r.handover).toBeUndefined()
    expect(revealed).toEqual([])
    expect(r.content).toContain('你的 Chrome 里 Google 要人机验证，这一路今天先不用了')
    expect(s.steps()).toEqual(['google:empty', 'own_chrome:blocked', 'bing:ok'])
    expect(s.gate.pausedUntil()).toBe(Date.parse('2026-10-22T16:00:00Z'))

    page = okPage('google-serp.html')
    await s.search.search('desk lamp 2')
    expect(own.urls).toHaveLength(1)
    expect(s.steps()).toEqual(['google:empty', 'own_chrome:skipped', 'bing:ok'])
    expect(s.why('own_chrome')).toBe(OWN_CHROME_PAUSED_WHY)

    // 重启（新的一份）也记得停到几点
    const again = createOwnChromeGate({
      now: () => Date.parse('2026-10-22T05:00:00Z'),
      file: gateFile,
    })
    expect(again.pausedUntil()).toBe(Date.parse('2026-10-22T16:00:00Z'))

    s.advance(Date.parse('2026-10-22T16:00:01Z') - Date.parse('2026-10-22T03:00:00Z'))
    expect((await s.search.search('desk lamp 3')).via).toBe('own_chrome')
  })

  it('cookie 同意页：一样不点、不亮给人，停到零点', async () => {
    const own = fakeOwnChrome(() =>
      okPage('google-consent.html', 'https://consent.google.com/ml?continue=x'),
    )
    const s = setup({ reader: () => own.reader })
    await s.search.search('desk lamp')
    expect(s.steps()).toEqual([
      'google:skipped',
      'own_chrome:consent',
      'bing:skipped',
      'cloud_google:skipped',
      'public:ok',
    ])
    expect(s.gate.pausedUntil()).toBeDefined()
  })
})

describe('告诉用户：每个品牌第一次走这一路时说一句，之后不再说', () => {
  it('第一次（不管有没有结果）说「这次用了你的 Chrome 搜 Google（后台窗口，读完自动关）」；第二次不说；换个品牌目录再说一次', async () => {
    const own = fakeOwnChrome(() => okPage('google-serp.html'))
    const s = setup({ reader: () => own.reader })
    const first = await s.search.search('desk lamp')
    expect(first.content).toContain(OWN_CHROME_TELL_LINE)
    const second = await s.search.search('desk lamp 2')
    expect(second.content).not.toContain(OWN_CHROME_TELL_LINE)
    expect(second.via).toBe('own_chrome')
    const other = setup({ reader: () => own.reader })
    expect((await other.search.search('desk lamp')).content).toContain(OWN_CHROME_TELL_LINE)
  })

  it('没开你的 Chrome（不可用 / 停着）就不说', async () => {
    const shell = fakeShell(() => builtinSerp([]))
    const s = setup({ channel: shell.channel })
    expect((await s.search.search('desk lamp')).content).not.toContain(OWN_CHROME_TELL_LINE)
  })
})
