/**
 * WP353：联网搜索后端——内置浏览器搜 Google → Bing → 云端 Google → 公开搜索服务。
 * 全用替身（不起桌面壳、不联网、不花钱）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  blockOf,
  createBrowserWebSearch,
  createSearchThrottle,
  HANDOVER_MESSAGE,
  type OpenResult,
  SEARCH_CACHE_TTL_MS,
  type SearchBrowserChannel,
  searchBrowserChannelFromEnv,
  searchLocaleLine,
  searchLocaleOf,
} from '../src/web-browser/index.js'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const SIG = { title: 't', text: '', captcha: false, passwordInputs: 0 }
const serp = (urls: string[], final = 'https://www.google.com/search?q=x'): OpenResult => ({
  ok: true,
  status: 200,
  final_url: final,
  serp: { signals: SIG, items: urls.map((url, i) => ({ url, title: `T${i}`, snippet: `S${i}` })) },
})
const SORRY: OpenResult = {
  ok: true,
  status: 200,
  final_url: 'https://www.google.com/sorry/index?continue=x',
  serp: {
    signals: { ...SIG, captcha: true, text: 'our systems have detected unusual traffic' },
    items: [],
  },
}

/**
 * 替身桌面壳：按脚本回每一次 open；记下开过的网址与亮给人的那一页。
 * WP454：默认说「已经有 Google 的 cookie」（不热身），热身那几条测试另给 `google_cookies: false`。
 */
function fakeShell(
  script: (url: string, kind: string) => OpenResult,
  opts: { google_cookies?: boolean } = { google_cookies: true },
) {
  const opened: string[] = []
  const revealed: string[] = []
  let verified_at: number | undefined
  const channel: SearchBrowserChannel = {
    open: async (i) => {
      opened.push(i.url)
      return script(i.url, i.kind)
    },
    reveal: async (i) => {
      revealed.push(i.url)
      return true
    },
    status: async () => ({
      revealed: revealed.length > 0,
      ...(verified_at === undefined ? {} : { verified_at }),
      ...(opts.google_cookies === undefined ? {} : { google_cookies: opts.google_cookies }),
    }),
  }
  return {
    channel,
    opened,
    revealed,
    verify: (at: number) => {
      verified_at = at
    },
  }
}

function setup(over: Partial<Parameters<typeof createBrowserWebSearch>[0]> = {}) {
  let t = Date.parse('2026-10-16T10:00:00Z')
  const sleeps: number[] = []
  const throttle = createSearchThrottle({
    now: () => t,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms)
      t += ms
    },
    maxPerHour: 5,
  })
  const dir = mkdtempSync(join(tmpdir(), 'wp353-'))
  dirs.push(dir)
  const search = createBrowserWebSearch({
    workspace_id: 'ws_1',
    dir,
    throttle,
    profile: () => ({ markets: ['US'] }),
    now: () => t,
    ...over,
  })
  return {
    search,
    sleeps,
    advance: (ms: number) => {
      t += ms
    },
    now: () => t,
    dir,
  }
}

describe('搜索语言（工坊这一层定规矩）', () => {
  it('美国品牌：gl=us&hl=en；德国：gl=de&hl=de；日本：gl=jp&hl=ja；中文查询：hl=zh-CN、不带市场', () => {
    expect(searchLocaleOf({ markets: ['US', 'DE'] }, 'smart glasses review')).toEqual({
      market: 'US',
      language: 'en',
    })
    expect(searchLocaleOf({ markets: ['DE'] }, 'Smarte Brille Test')).toEqual({
      market: 'DE',
      language: 'de',
    })
    expect(searchLocaleOf({ markets: ['jp'] }, 'スマートグラス')).toEqual({
      market: 'JP',
      language: 'ja',
    })
    expect(searchLocaleOf({ markets: ['US'] }, 'IVRA 竞品 国内')).toEqual({ language: 'zh-CN' })
    expect(searchLocaleOf({ markets: ['TW'] }, 'smart glasses')).toEqual({
      market: 'TW',
      language: 'zh-TW',
    })
    expect(searchLocaleOf({ markets: ['CA'], market_languages: { CA: 'fr' } }, 'lunettes')).toEqual(
      {
        market: 'CA',
        language: 'fr',
      },
    )
    expect(searchLocaleOf(undefined, 'x')).toEqual({ language: 'en' })
  })

  it('给模型的一行：主市场 + 各市场语言（不塞整份档案）；没市场就没有这一行', () => {
    expect(searchLocaleLine({ markets: ['US', 'DE'] })).toBe(
      '品牌主市场：US；各市场语言：US=en，DE=de',
    )
    expect(searchLocaleLine({})).toBeUndefined()
  })

  it('美国品牌（用户用中文问、AI 用英文写查询）→ 内置浏览器开 Google 带 gl=us&hl=en', async () => {
    const shell = fakeShell(() => serp(['https://www.reddit.com/r/SmartGlasses/']))
    const { search } = setup({ channel: shell.channel })
    await search.search('IVRA Air3 review reddit')
    const u = new URL(shell.opened[0] ?? '')
    expect(u.hostname).toBe('www.google.com')
    expect(u.searchParams.get('gl')).toBe('us')
    expect(u.searchParams.get('hl')).toBe('en')
  })

  it('德国品牌 → gl=de&hl=de；中文查询 → hl=zh-CN（Bing 同理 cc / setlang）', async () => {
    const shell = fakeShell((url) => (url.includes('google') ? SORRY : serp(['https://a.de/x'])))
    const { search } = setup({ channel: shell.channel, profile: () => ({ markets: ['DE'] }) })
    await search.search('smarte Brille Test')
    const g = new URL(shell.opened[0] ?? '')
    expect([g.searchParams.get('gl'), g.searchParams.get('hl')]).toEqual(['de', 'de'])
    const b = new URL(shell.opened[1] ?? '')
    expect([b.hostname, b.searchParams.get('cc'), b.searchParams.get('setlang')]).toEqual([
      'www.bing.com',
      'DE',
      'de',
    ])
    const zh = fakeShell(() => serp(['https://a.cn/x']))
    await setup({ channel: zh.channel, profile: () => ({ markets: ['DE'] }) }).search.search(
      '国内竞品 智能眼镜',
    )
    const z = new URL(zh.opened[0] ?? '')
    expect([z.searchParams.get('hl'), z.searchParams.get('gl')]).toEqual(['zh-CN', null])
  })
})

describe('回退链', () => {
  it('Google 搜到：照实标来自 Google；site: 限定外的不算', async () => {
    const shell = fakeShell(() =>
      serp(['https://www.reddit.com/r/a/', 'https://old.reddit.com/r/b/', 'https://pcmag.com/x']),
    )
    const { search } = setup({ channel: shell.channel })
    const r = await search.search('site:reddit.com smart glasses')
    expect(r.via).toBe('google')
    expect(r.sources.map((s) => s.url)).toEqual([
      'https://www.reddit.com/r/a/',
      'https://old.reddit.com/r/b/',
    ])
    expect(r.content).toContain('Google（工坊内置浏览器）')
  })

  it('Google 打不开（超时）→ 换 Bing，说清楚为什么', async () => {
    const shell = fakeShell((url) =>
      url.includes('google')
        ? { ok: false, reason: 'timeout', message: '8 秒内没打开' }
        : serp(['https://www.reddit.com/r/a/'], 'https://www.bing.com/search?q=x'),
    )
    const { search } = setup({ channel: shell.channel })
    const r = await search.search('smart glasses')
    expect(r.via).toBe('bing')
    expect(r.content).toContain('Google 这次没打开（8 秒内没打开）')
  })

  it('Google 进验证页：第一次记暂停、换 Bing；同一天第二次亮给人、结果里说一句；人点过就恢复 Google', async () => {
    let google: OpenResult = SORRY
    const shell = fakeShell((url) => (url.includes('google') ? google : serp(['https://b.com/1'])))
    const { search, advance, now } = setup({ channel: shell.channel })
    const first = await search.search('q1')
    expect(first.via).toBe('bing')
    expect(first.content).toContain('Google 要人机验证，先暂停到')
    expect(shell.revealed).toEqual([])
    // 暂停中：不再开 Google
    await search.search('q2')
    expect(shell.opened.filter((u) => u.includes('google'))).toHaveLength(1)
    // 暂停过了又被拦：亮给人
    advance(31 * 60_000)
    const second = await search.search('q3')
    expect(second.via).toBe('bing')
    expect(second.handover).toBe(true)
    expect(second.content).toContain(HANDOVER_MESSAGE)
    expect(shell.revealed).toHaveLength(1)
    // 人点过验证（壳记下时刻）→ 下一次搜索解除暂停、回到 Google
    shell.verify(now() + 1)
    // 过了一小时（节流上限 5 页 / 小时，前面开了 5 页）
    advance(61 * 60_000)
    google = serp(['https://g.com/1'])
    const back = await search.search('q4')
    expect(back.via).toBe('google')
  })

  it('没有桌面壳 → 云端 Google；云端没接 → 公开搜索服务；照实标来源', async () => {
    const cloud = {
      available: async () => true,
      serp: async () => ({
        query: { query: 'x', engine: 'google' as const, country: 'us', language: 'en' },
        items: [
          {
            position: 1,
            url: 'https://c.com/1',
            domain: 'c.com',
            title: 'C',
            type: 'organic' as const,
          },
        ],
        fetched_at: '2026-10-16T10:00:00Z',
        source: 'official',
      }),
    }
    const viaCloud = await setup({ cloud }).search.search('x')
    expect(viaCloud.via).toBe('cloud_google')
    expect(viaCloud.content).toContain('云端 Google')
    const keyless = () => ({
      search: async () => ({ sources: [{ url: 'https://p.com/1', title: 'P' }] }),
    })
    const viaPublic = await setup({
      cloud: { ...cloud, available: async () => false },
      keyless,
    }).search.search('y')
    expect(viaPublic.via).toBe('public')
    expect(viaPublic.content).toContain('公开搜索服务')
  })

  it('一路都没有 → 照实说「这里没有内置浏览器」；都失败 → 把每一路的原因说出来', async () => {
    const { search } = setup()
    expect(search.available()).toBe(false)
    await expect(search.search('x')).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
    const shell = fakeShell(() => ({ ok: false, reason: 'failed', message: '断网' }))
    const keyless = () => ({
      search: async () => {
        throw new Error('429')
      },
    })
    await expect(
      setup({ channel: shell.channel, keyless }).search.search('x'),
    ).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: expect.stringContaining('Bing 这次没打开（断网）'),
    })
  })

  it('都打开了但都没结果：回空、不报错', async () => {
    const shell = fakeShell(() => serp([]))
    const r = await setup({ channel: shell.channel }).search.search('zzz')
    expect(r.sources).toEqual([])
    expect(r.content).toContain('没搜到相关结果')
  })
})

describe('缓存与节流', () => {
  it('同一句 7 天内命中缓存（不再开页面）；过了 7 天重新搜；落盘、换一个实例也认', async () => {
    const shell = fakeShell(() => serp(['https://a.com/1']))
    const { search, advance, dir } = setup({ channel: shell.channel })
    await search.search('Smart Glasses')
    const again = await search.search('smart glasses ')
    expect(again.cached).toBe(true)
    expect(shell.opened).toHaveLength(1)
    const other = createBrowserWebSearch({
      workspace_id: 'ws_1',
      dir,
      channel: shell.channel,
      throttle: createSearchThrottle({
        now: () => Date.now(),
        random: () => 0,
        sleep: async () => undefined,
      }),
      profile: () => ({ markets: ['US'] }),
      now: () => Date.parse('2026-10-16T11:00:00Z'),
    })
    expect((await other.search('smart glasses')).cached).toBe(true)
    advance(SEARCH_CACHE_TTL_MS + 1)
    await search.search('smart glasses')
    expect(shell.opened).toHaveLength(2)
  })

  it('一次只开一页、两次之间随机隔 2–4 秒；每小时上限满了不开内置浏览器、往后几路照走', async () => {
    const shell = fakeShell((url) => (url.includes('google') ? SORRY : serp(['https://a.com/1'])))
    const keyless = () => ({ search: async () => ({ sources: [{ url: 'https://p.com/1' }] }) })
    const { search, sleeps } = setup({ channel: shell.channel, keyless })
    await Promise.all([search.search('a'), search.search('b'), search.search('c')])
    expect(sleeps.length).toBeGreaterThan(0)
    for (const s of sleeps) expect(s).toBeLessThanOrEqual(4_000)
    expect(sleeps.every((s) => s >= 0)).toBe(true)
    // 上限 5 页：Google 1 页 + Bing 3 页 + … 到上限之后直接走公开搜索服务
    const many = await Promise.all(['d', 'e', 'f'].map((q) => search.search(q)))
    expect(shell.opened.length).toBeLessThanOrEqual(5)
    expect(many.at(-1)?.via).toBe('public')
    expect(many.at(-1)?.content).toContain('上限')
  })
})

describe('读正文（web_fetch 分流到内置浏览器的那几家）', () => {
  it('Reddit 一页：标题 + 正文；要登录的照实说；没有桌面壳就不分流', async () => {
    const shell = fakeShell((url) =>
      url.includes('login')
        ? {
            ok: true,
            status: 200,
            final_url: 'https://www.linkedin.com/authwall?x',
            page: { signals: { ...SIG, passwordInputs: 1 }, text: 'Sign in', truncated: false },
          }
        : {
            ok: true,
            status: 200,
            final_url: url,
            page: {
              signals: { ...SIG, title: 'Best glasses' },
              text: 'Battery life',
              truncated: false,
            },
          },
    )
    const { search } = setup({ channel: shell.channel })
    expect(search.fetchHosts).toContain('*.reddit.com')
    const page = await search.fetch('https://www.reddit.com/r/a/comments/1/')
    expect(page.body).toEqual({ kind: 'text', content: 'Best glasses\n\nBattery life' })
    await expect(search.fetch('https://www.linkedin.com/login-wall')).rejects.toMatchObject({
      code: 'WEB_FETCH_BLOCKED',
    })
    const none = setup().search
    expect(none.fetchHosts).toEqual([])
    await expect(none.fetch('https://www.reddit.com/')).rejects.toMatchObject({
      code: 'WEB_PROVIDER_UNAVAILABLE',
    })
  })
})

describe('认拦截 / 本机通道', () => {
  it('结果页里的摘要提到 unusual traffic 不算被拦；验证页算', () => {
    const ok = serp(['https://a.com/1'])
    if (ok.ok && ok.serp) ok.serp.signals.text = 'unusual traffic report'
    expect(blockOf(ok as Extract<OpenResult, { ok: true }>)).toBeUndefined()
    expect(blockOf(SORRY as Extract<OpenResult, { ok: true }>)?.kind).toBe('captcha')
  })

  it('通道只认本机回环地址 + 口令；连不上照实说', async () => {
    expect(searchBrowserChannelFromEnv({})).toBeUndefined()
    expect(
      searchBrowserChannelFromEnv({
        AGENTSWS_SEARCH_BROWSER_URL: 'http://10.0.0.2:1',
        AGENTSWS_SEARCH_BROWSER_TOKEN: 't',
      }),
    ).toBeUndefined()
    const seen: { url: string; auth: string }[] = []
    const ch = searchBrowserChannelFromEnv(
      { AGENTSWS_SEARCH_BROWSER_URL: 'http://127.0.0.1:9', AGENTSWS_SEARCH_BROWSER_TOKEN: 'tok' },
      async (url, init) => {
        seen.push({ url, auth: (init.headers as Record<string, string>).authorization ?? '' })
        if (url.endsWith('/open')) throw new Error('ECONNREFUSED')
        return new Response(JSON.stringify({ revealed: false }), { status: 200 })
      },
    )
    expect(await ch?.status('ws_1')).toEqual({ revealed: false })
    const got = await ch?.open({
      workspace_id: 'ws_1',
      url: 'https://a.com',
      kind: 'page',
      timeout_ms: 1000,
    })
    expect(got).toMatchObject({ ok: false, reason: 'unreachable' })
    expect(seen.every((s) => s.auth === 'Bearer tok')).toBe(true)
  })
})
