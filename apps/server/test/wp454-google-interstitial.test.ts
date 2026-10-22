/**
 * WP454（docs/110 §2.2 / §3，决策 1433）：内置浏览器搜 Google——过渡页、cookie 同意页、首次热身、每步留痕。
 * 全用替身（不起桌面壳、不联网、不花钱）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CONSENT_HANDOVER_LINE,
  CONSENT_MESSAGE,
  createBrowserWebSearch,
  createSearchThrottle,
  ENGINE_TIMEOUT_MS,
  GOOGLE_HOME,
  type OpenResult,
  SEARCH_TRACE_MAX,
  type SearchBrowserChannel,
  type SearchTraceEntry,
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
  serp: { signals: SIG, items: urls.map((url, i) => ({ url, title: `T${i}` })) },
})
const INTERSTITIAL: OpenResult = {
  ok: true,
  status: 200,
  final_url: 'https://www.google.com.hk/search?q=x&gl=us&hl=en',
  serp: {
    signals: {
      ...SIG,
      interstitial: true,
      text: 'please click here if you are not redirected within a few seconds.',
    },
    items: [],
  },
}
const CONSENT: OpenResult = {
  ok: true,
  status: 200,
  final_url: 'https://consent.google.com/ml?continue=https://www.google.com/search?q%3Dx',
  serp: { signals: { ...SIG, text: 'before you continue to google' }, items: [] },
}
const SORRY: OpenResult = {
  ok: true,
  status: 200,
  final_url: 'https://www.google.com/sorry/index?continue=x',
  serp: { signals: { ...SIG, captcha: true, text: 'unusual traffic' }, items: [] },
}
const HOME: OpenResult = {
  ok: true,
  status: 200,
  final_url: 'https://www.google.com/',
  page: { signals: SIG, text: 'Google', truncated: false },
}

type Opened = {
  url: string
  kind: string
  timeout_ms: number
  settle_ms?: number
  no_read?: boolean
}

function fakeShell(script: (o: Opened) => OpenResult, opts: { google_cookies?: boolean } = {}) {
  const opened: Opened[] = []
  const revealed: { url: string; reason: string; message: string }[] = []
  let verified_at: number | undefined
  let cookies = opts.google_cookies
  const channel: SearchBrowserChannel = {
    open: async (i) => {
      const o: Opened = {
        url: i.url,
        kind: i.kind,
        timeout_ms: i.timeout_ms,
        ...(i.settle_ms === undefined ? {} : { settle_ms: i.settle_ms }),
        ...(i.no_read === undefined ? {} : { no_read: i.no_read }),
      }
      opened.push(o)
      // 开过 Google 的任何一页，partition 里就有了 Google 的 cookie
      if (/google\./.test(i.url)) cookies = true
      return script(o)
    },
    reveal: async (i) => {
      revealed.push({ url: i.url, reason: i.reason, message: i.message })
      return true
    },
    status: async () => ({
      revealed: revealed.length > 0,
      ...(verified_at === undefined ? {} : { verified_at }),
      ...(cookies === undefined ? {} : { google_cookies: cookies }),
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

function setup(channel: SearchBrowserChannel, maxPerHour = 60) {
  let t = Date.parse('2026-10-21T10:00:00Z')
  const throttle = createSearchThrottle({
    now: () => t,
    random: () => 0.5,
    sleep: async (ms) => {
      t += ms
    },
    maxPerHour,
  })
  const dir = mkdtempSync(join(tmpdir(), 'wp454-'))
  dirs.push(dir)
  const search = createBrowserWebSearch({
    workspace_id: 'ws_1',
    dir,
    channel,
    throttle,
    profile: () => ({ markets: ['US'] }),
    keyless: () => ({ search: async () => ({ sources: [{ url: 'https://pub.example/a' }] }) }),
    now: () => t,
  })
  const file = (): {
    engines: Record<string, { hits: number[]; pause?: unknown }>
    trace: SearchTraceEntry[]
    google_last_miss?: { result: string; why?: string }
  } => JSON.parse(readFileSync(join(dir, 'web-search.json'), 'utf8'))
  return {
    search,
    file,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('过渡页（等满 8 秒还是过渡页）', () => {
  it('记「没出结果（过渡页）」、换下一路；不计被拦、不暂停、不亮给人；下一次照样先试 Google', async () => {
    const shell = fakeShell(
      (o) => (o.kind === 'google' ? INTERSTITIAL : serp(['https://b.example/1'])),
      {
        google_cookies: true,
      },
    )
    const { search, file } = setup(shell.channel)
    const r = await search.search('smart glasses review')
    expect(r.via).toBe('bing')
    expect(r.content).toContain('Google 没出结果（过渡页')
    expect(shell.revealed).toEqual([])
    const s = file()
    expect(s.engines.google?.hits ?? []).toEqual([])
    expect(s.engines.google?.pause).toBeUndefined()
    expect(s.google_last_miss).toMatchObject({ result: 'interstitial', why: '没出结果（过渡页）' })
    const again = await search.search('smart glasses case')
    expect(again.via).toBe('bing')
    expect(shell.opened.filter((o) => o.kind === 'google')).toHaveLength(2)
  })

  it('搜索那一页的打开超时是 15 秒；超时记 timeout', async () => {
    const shell = fakeShell(
      (o) =>
        o.kind === 'google'
          ? { ok: false, reason: 'timeout', message: '15 秒内没打开' }
          : serp(['https://b.example/1']),
      { google_cookies: true },
    )
    const { search, file } = setup(shell.channel)
    await search.search('usb c hub')
    expect(ENGINE_TIMEOUT_MS).toBe(15_000)
    expect(shell.opened.map((o) => [o.kind, o.timeout_ms])).toEqual([
      ['google', 15_000],
      ['bing', 15_000],
    ])
    expect(file().trace[0]?.steps.map((s) => [s.via, s.result])).toEqual([
      ['google_warmup', 'skipped'],
      ['google', 'timeout'],
      // WP455：没选「用你正在用的浏览器」，这一步跳过
      ['own_chrome', 'skipped'],
      ['bing', 'ok'],
    ])
  })
})

describe('cookie 同意页', () => {
  it('第一次就亮给人（reason consent、第三栏那一句）；AI 不点；人选过照 verified_at 恢复用 Google', async () => {
    let consented = false
    const shell = fakeShell(
      (o) =>
        o.kind === 'google'
          ? consented
            ? serp(['https://g.example/1'])
            : CONSENT
          : serp(['https://b.example/1']),
      { google_cookies: true },
    )
    const { search, file, advance } = setup(shell.channel)
    const r = await search.search('wireless earbuds')
    expect(r.via).toBe('bing')
    expect(r.handover).toBe(true)
    expect(r.content).toContain(CONSENT_MESSAGE)
    expect(shell.revealed).toEqual([
      {
        url: expect.stringContaining('https://www.google.com/search?'),
        reason: 'consent',
        message: CONSENT_HANDOVER_LINE,
      },
    ])
    expect(CONSENT_HANDOVER_LINE).toContain('Google 要你选一次 cookie 设置')
    // 不算被拦
    expect(file().engines.google?.hits ?? []).toEqual([])
    expect(file().google_last_miss?.result).toBe('consent')
    // 人没选之前：Google 停着，不再开
    advance(60_000)
    const waiting = await search.search('wireless earbuds case')
    expect(waiting.via).toBe('bing')
    expect(shell.opened.filter((o) => o.kind === 'google')).toHaveLength(1)
    expect(file().trace.at(-1)?.steps[0]).toMatchObject({ via: 'google', result: 'skipped' })
    // 人在那页上自己选了：解除，接着用 Google
    advance(60_000)
    consented = true
    shell.verify(Date.parse('2026-10-21T10:01:30Z'))
    const back = await search.search('wireless earbuds charger')
    expect(back.via).toBe('google')
  })
})

describe('首次热身', () => {
  it('partition 里没有 Google 的 cookie：先开一次首页（只开不点，dom-ready 加 1.5 秒）再搜；本进程只热一次', async () => {
    const shell = fakeShell((o) => (o.url === GOOGLE_HOME ? HOME : serp(['https://g.example/1'])), {
      google_cookies: false,
    })
    const { search, file } = setup(shell.channel)
    const r = await search.search('standing desk')
    expect(r.via).toBe('google')
    expect(shell.opened.map((o) => [o.kind, o.url.slice(0, 30)])).toEqual([
      ['page', 'https://www.google.com/'],
      ['google', 'https://www.google.com/search?'],
    ])
    expect(shell.opened[0]).toMatchObject({ settle_ms: 1_500, timeout_ms: 15_000, no_read: true })
    expect(shell.opened[1]?.no_read).toBeUndefined()
    await search.search('standing desk mat')
    expect(shell.opened.filter((o) => o.url === GOOGLE_HOME)).toHaveLength(1)
    const steps = file().trace.map((e) => e.steps.map((s) => `${s.via}:${s.result}`))
    expect(steps).toEqual([['google_warmup:ok', 'google:ok'], ['google:ok']])
  })

  it('同时进来好几条：只热身一次', async () => {
    const shell = fakeShell((o) => (o.url === GOOGLE_HOME ? HOME : serp(['https://g.example/1'])), {
      google_cookies: false,
    })
    const { search } = setup(shell.channel)
    const got = await Promise.all([search.search('desk a'), search.search('desk b')])
    expect(got.map((r) => r.via)).toEqual(['google', 'google'])
    expect(shell.opened.filter((o) => o.url === GOOGLE_HOME)).toHaveLength(1)
  })

  it('已经有 Google 的 cookie：跳过热身（留痕记 skipped）', async () => {
    const shell = fakeShell(() => serp(['https://g.example/1']), { google_cookies: true })
    const { search, file } = setup(shell.channel)
    await search.search('monitor arm')
    expect(shell.opened.map((o) => o.kind)).toEqual(['google'])
    expect(file().trace[0]?.steps[0]).toMatchObject({ via: 'google_warmup', result: 'skipped' })
  })

  it('老壳不说有没有 cookie：照样热身；热身计入每小时上限', async () => {
    const shell = fakeShell((o) => (o.url === GOOGLE_HOME ? HOME : serp(['https://g.example/1'])))
    const { search, file } = setup(shell.channel, 1)
    const r = await search.search('desk lamp')
    // 一小时上限 1 页：热身用掉了，搜索那一页这一小时不开，往后几路照走
    expect(shell.opened.map((o) => o.url)).toEqual([GOOGLE_HOME])
    expect(r.via).toBe('public')
    expect(file().trace[0]?.steps.map((s) => `${s.via}:${s.result}`)).toEqual([
      'google_warmup:ok',
      'google:skipped',
      'own_chrome:skipped',
      'bing:skipped',
      'cloud_google:skipped',
      'public:ok',
    ])
  })

  it('热身那一页就被拦（/sorry）：照被拦处理，不再开搜索页；首页没打开不拦着、照样搜', async () => {
    const shell = fakeShell(
      (o) => (o.url === GOOGLE_HOME ? SORRY : serp(['https://b.example/1'])),
      {
        google_cookies: false,
      },
    )
    const { search, file } = setup(shell.channel)
    const r = await search.search('desk lamp')
    expect(r.via).toBe('bing')
    expect(shell.opened.map((o) => o.kind)).toEqual(['page', 'bing'])
    expect(file().engines.google?.hits).toHaveLength(1)
    expect(file().trace[0]?.steps.map((s) => `${s.via}:${s.result}`)).toEqual([
      'google_warmup:blocked',
      'google:blocked',
      'own_chrome:skipped',
      'bing:ok',
    ])

    const shell2 = fakeShell(
      (o) =>
        o.url === GOOGLE_HOME
          ? { ok: false, reason: 'timeout', message: '15 秒内没打开' }
          : serp(['https://g.example/1']),
      { google_cookies: false },
    )
    const two = setup(shell2.channel)
    expect((await two.search.search('desk lamp')).via).toBe('google')
    expect(two.file().trace[0]?.steps.map((s) => `${s.via}:${s.result}`)).toEqual([
      'google_warmup:timeout',
      'google:ok',
    ])
  })

  it('热身那一页是同意页：亮给人，不再开搜索页', async () => {
    const shell = fakeShell(
      (o) => (o.url === GOOGLE_HOME ? CONSENT : serp(['https://b.example/1'])),
      {
        google_cookies: false,
      },
    )
    const { search } = setup(shell.channel)
    const r = await search.search('desk lamp')
    expect(r.handover).toBe(true)
    expect(shell.revealed.map((x) => x.reason)).toEqual(['consent'])
    expect(shell.opened.map((o) => o.kind)).toEqual(['page', 'bing'])
  })
})

describe('每步留痕（web-search.json）', () => {
  it('0 条结果时分清：页面上有结果标题、一条都没读出来（10-21 真机那种）', async () => {
    const shell = fakeShell(
      (o) =>
        o.kind === 'google'
          ? {
              ok: true,
              status: 200,
              final_url: 'https://www.google.com/search?q=x',
              serp: { signals: SIG, items: [], candidates: 9 },
            }
          : serp(['https://b.example/1']),
      { google_cookies: true },
    )
    const { search, file } = setup(shell.channel)
    await search.search('portable monitor')
    expect(file().trace[0]?.steps[1]).toMatchObject({
      via: 'google',
      result: 'empty',
      why: '0 条结果（页面上有 9 个结果标题，一条都没读出来）',
    })
    expect(file().google_last_miss?.why).toContain('一条都没读出来')
  })

  it('只存查询哈希、不存原文；最近 50 次；缓存命中也记；0 条记 empty', async () => {
    let n = 0
    const shell = fakeShell(
      (o) => (o.kind === 'google' ? serp(n++ === 0 ? [] : ['https://g.example/1']) : serp([])),
      { google_cookies: true },
    )
    const { search, file } = setup(shell.channel)
    await search.search('secret product codename')
    const raw = readFileSync(join(dirs.at(-1) ?? '', 'web-search.json'), 'utf8')
    const first = file().trace[0]
    expect(first?.query_hash).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(file().trace)).not.toContain('codename')
    expect(first?.steps.map((s) => `${s.via}:${s.result}`)).toEqual([
      'google_warmup:skipped',
      'google:empty',
      'own_chrome:skipped',
      'bing:empty',
      'cloud_google:skipped',
      'public:ok',
    ])
    expect(first?.via).toBe('public')
    expect(raw).toContain('"google_last_miss"')
    await search.search('secret product codename')
    expect(file().trace.at(-1)).toMatchObject({ cached: true, via: 'public', steps: [] })
    for (let i = 0; i < SEARCH_TRACE_MAX + 5; i++) await search.search(`q${i}`)
    expect(file().trace).toHaveLength(SEARCH_TRACE_MAX)
  })

  it('没有桌面壳、什么都没接：留痕照记（都 skipped），照旧报用不了', async () => {
    let t = 0
    const dir = mkdtempSync(join(tmpdir(), 'wp454-'))
    dirs.push(dir)
    const search = createBrowserWebSearch({
      workspace_id: 'ws_1',
      dir,
      throttle: createSearchThrottle({ now: () => t, random: () => 0, sleep: async () => {} }),
      profile: () => undefined,
      now: () => (t += 1),
    })
    await expect(search.search('x')).rejects.toThrow('联网搜索用不了')
    const s = JSON.parse(readFileSync(join(dir, 'web-search.json'), 'utf8')) as {
      trace: SearchTraceEntry[]
    }
    expect(s.trace[0]?.steps.map((x) => `${x.via}:${x.result}`)).toEqual([
      'google:skipped',
      'own_chrome:skipped',
      'bing:skipped',
      'cloud_google:skipped',
      'public:skipped',
    ])
  })
})
