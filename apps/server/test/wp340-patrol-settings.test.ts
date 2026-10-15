/**
 * WP340：巡查设置第二版——按版块分频率、重点版块、告警词优先提醒（去重）、本地标签词（可筛）、配置卡 AI 建议值、老设置迁移。
 * 替身 Reddit（本地假 JSON，经 browser-action 的真执行器跑）、替身插件、替身数据渠道、替身模型；不联网、不花钱。
 */
import { type RedditFetched, runRedditRead } from '@agentsws/browser-action'
import type { RedditWatchEntry } from '@agentsws/contracts'
import { queryWatchItems } from '@agentsws/social-core'
import { describe, expect, it, vi } from 'vitest'
import { dueSubs, lastSlotAt } from '../src/reddit-watch/due.js'
import {
  createRedditWatch,
  createRedditWatchStore,
  type RedditWatchOptions,
  redditWatchSourceOf,
} from '../src/reddit-watch/index.js'
import { formatSubList, normalizeSettings, parseSubList } from '../src/reddit-watch/settings.js'
import { parseSuggestion } from '../src/reddit-watch/suggest.js'
import { termHits } from '../src/reddit-watch/terms.js'
import { SetupCardError } from '../src/setup-cards.js'
import { createResearchKit, mergePlan } from '../src/setup-research.js'

const WED_10 = '2026-10-14T02:00:00.000Z' // 东八区周三 10:00
const sec = (iso: string): number => Date.parse(iso) / 1000

const t = (id: string, kind: 't1' | 't3', sub: string, over: Record<string, unknown> = {}) => ({
  kind,
  data: {
    id,
    name: `${kind}_${id}`,
    author: 'alice',
    subreddit: sub,
    created_utc: sec('2026-10-13T00:00:00Z'),
    ...(kind === 't3' ? { title: `post ${id}`, selftext: 'hello' } : { body: `c ${id}` }),
    permalink: `/r/${sub}/comments/p1/x/${id}/`,
    ...over,
  },
})
const listing = (children: unknown[]) => ({ kind: 'Listing', data: { after: null, children } })

/** 替身 Reddit：认得的地址回给定的 JSON；别的版块列表回空（不当 404）。 */
function fakeReddit(routes: Record<string, unknown>, user = 'inmo_official') {
  const calls: string[] = []
  const fetch = async (url: string): Promise<RedditFetched> => {
    calls.push(url)
    const u = new URL(url)
    for (const k of ['limit', 'raw_json', 'after', 'sort']) u.searchParams.delete(k)
    u.searchParams.sort()
    const key = `${u.pathname}${u.search}`
    const body =
      u.pathname === '/api/me.json'
        ? { kind: 't2', data: { name: user } }
        : (routes[key] ??
          (/\/(new|comments)\/\.json$|\/message\/inbox/u.test(u.pathname)
            ? listing([])
            : undefined))
    return body === undefined
      ? { status: 404, url, content_type: 'application/json', body: '{}' }
      : { status: 200, url, content_type: 'application/json', body: JSON.stringify(body) }
  }
  return { fetch, calls }
}

const ACTOR = { person_id: 'p1', assignment_id: 'as1', role_id: 'social.reddit' } as never

function setup(over: Partial<RedditWatchOptions> = {}, start = WED_10) {
  let now = start
  let n = 0
  const store = createRedditWatchStore()
  const cards = { askConnect: vi.fn(async () => undefined), askSetup: vi.fn(async () => undefined) }
  const watch = createRedditWatch({
    workspace_id: 'ws_1' as never,
    store,
    now: () => now,
    newId: (p) => `${p}_${++n}`,
    tzOffsetMinutes: () => 480,
    brandName: () => 'INMO',
    setupCards: async () => cards as never,
    actor: () => ACTOR,
    ...over,
  })
  // 插件配好、连上 Reddit（来问一次）
  watch.next({ connected: true })
  return {
    watch,
    store,
    setNow: (v: string) => {
      now = v
    },
  }
}

/** 替身插件：领一件 → 真执行器读替身 Reddit → 交回；回这件活读了哪几路。 */
async function round(
  w: ReturnType<typeof setup>['watch'],
  reddit: ReturnType<typeof fakeReddit>,
): Promise<string[] | undefined> {
  const got = w.next({ connected: true })
  if (got.job === undefined) return undefined
  const res = await runRedditRead(got.job, {
    fetch: reddit.fetch,
    sleep: async () => {},
    stopped: () => false,
    gapMs: 0,
  })
  expect(await w.result(got.job.id, res)).toEqual({ accepted: true })
  return got.job.reads.map((r) => r.key)
}

describe('按版块分频率（纯函数）', () => {
  it('一周几次 → 最近一个到点时刻（本地周一起：7 每天、3 一三五、2 一四、1 周一）', () => {
    const now = Date.parse(WED_10)
    expect(new Date(lastSlotAt(now, 480, 7, 9)).toISOString()).toBe('2026-10-14T01:00:00.000Z')
    expect(new Date(lastSlotAt(now, 480, 3, 9)).toISOString()).toBe('2026-10-14T01:00:00.000Z')
    expect(new Date(lastSlotAt(now, 480, 2, 9)).toISOString()).toBe('2026-10-12T01:00:00.000Z')
    expect(new Date(lastSlotAt(now, 480, 1, 9)).toISOString()).toBe('2026-10-12T01:00:00.000Z')
    // 本地 8 点（还没到 9 点）：每天的那个点是昨天
    const early = Date.parse('2026-10-14T00:00:00.000Z')
    expect(new Date(lastSlotAt(early, 480, 7, 9)).toISOString()).toBe('2026-10-13T01:00:00.000Z')
  })

  it('每周的版块：读过就等下周一；没设的跟总频率（每天）；关机错过只补一次；失败隔一小时再试', () => {
    const settings = normalizeSettings({
      own_subreddits: ['inmoxr'],
      watch_subreddits: ['SmartGlasses', 'Xreal'],
      sub_per_week: { xreal: 1 },
    })
    const clocks = {
      inmoxr: { last_ok_at: '2026-10-13T02:00:00.000Z' },
      smartglasses: { last_ok_at: '2026-10-14T01:30:00.000Z' },
      xreal: { last_ok_at: '2026-10-12T02:00:00.000Z' },
    }
    const subs = ['inmoxr', 'SmartGlasses', 'Xreal']
    const due = (now: string, c: Record<string, object> = clocks) =>
      dueSubs({ now, tz_offset_minutes: 480, settings, subs, clocks: c })
    expect(due(WED_10)).toEqual(['inmoxr'])
    // 下周一 10 点：每周那个也到了；一个多星期没开机（上次读成是两周前）也只算该读一次
    expect(due('2026-10-19T02:00:00.000Z')).toEqual(['inmoxr', 'SmartGlasses', 'Xreal'])
    // 刚试过（失败）：一小时内不再试
    expect(
      due('2026-10-19T02:00:00.000Z', {
        ...clocks,
        xreal: { ...clocks.xreal, last_try_at: '2026-10-19T01:30:00.000Z' },
      }),
    ).toEqual(['inmoxr', 'SmartGlasses'])
  })
})

describe('版块后面写频率（配置卡那一格）', () => {
  it('认「（每周）」「每周3次」「weekly」「:每天」；格式不对的照原样回', () => {
    const got = parseSubList(
      'r/inmoxr, SmartGlasses（每周3次）, Xreal 每周, AR_MR_XR(weekly), RayNeo:每天, bad name!',
    )
    expect(got.subs).toEqual(['inmoxr', 'SmartGlasses', 'Xreal', 'AR_MR_XR', 'RayNeo'])
    expect(got.per_week).toEqual({ smartglasses: 3, xreal: 1, ar_mr_xr: 1, rayneo: 7 })
    expect(got.bad).toEqual(['bad name!'])
    expect(formatSubList(got.subs, got.per_week)).toBe(
      'inmoxr, SmartGlasses（每周3次）, Xreal（每周）, AR_MR_XR（每周）, RayNeo（每天）',
    )
    expect(parseSubList(formatSubList(got.subs, got.per_week)).per_week).toEqual(got.per_week)
  })
})

describe('本地词匹配', () => {
  it('标签词：空格 / 连字符可有可无；告警词放过常见词尾；拉丁字母按整词', () => {
    expect(termHits('My INMO Air 3 arrived', ['Air3'], false)).toEqual(['Air3'])
    expect(termHits('air-3 vs go2', ['Air3', 'Go 2'], false)).toEqual(['Air3', 'Go 2'])
    expect(termHits('they refunded me; it was overheating', ['refund', 'overheat'], true)).toEqual([
      'refund',
      'overheat',
    ])
    expect(termHits('a refundable deposit', ['refund'], true)).toEqual([])
    expect(termHits('inmobiliaria', ['INMO'], true)).toEqual([])
    expect(termHits('眼镜被召回了', ['召回'], true)).toEqual(['召回'])
  })
})

describe('巡查：按版块分频率（替身插件 × 替身 Reddit）', () => {
  it('第一次全读；第二天每周的那个不读；下周一再读', async () => {
    const s = setup()
    s.watch.updateSettings({
      own_subreddits: ['inmoxr'],
      watch_subreddits: ['SmartGlasses', 'Xreal'],
      sub_per_week: { xreal: 1 },
      brand_username: 'inmo_official',
    })
    const reddit = fakeReddit({
      '/r/SmartGlasses/new/.json': listing([t('g1', 't3', 'SmartGlasses')]),
    })
    expect(await s.watch.tick()).toMatchObject({ ran: true })
    const first = await round(s.watch, reddit)
    expect(first).toEqual(
      expect.arrayContaining([
        'inbox',
        'sub_new:inmoxr',
        'sub_comments:inmoxr',
        'watch_new:smartglasses',
        'watch_new:xreal',
      ]),
    )
    // 重点版块只读新帖（不读整版评论）
    expect(first).not.toContain('sub_comments:smartglasses')
    const last = s.watch.view().last_run
    expect(last?.parts.map((p) => `${p.part}:${p.status}`)).toEqual([
      'inbox:ok',
      'own_sub:ok',
      'watch_sub:ok',
    ])
    // 重点版块读到的进「外部」那一类，话题先按版块归
    const g1 = s.watch.items({ source: 'external' }).find((x) => x.fullname === 't3_g1')
    expect(g1?.judgement).toMatchObject({ verdict: 'no_action', topic: 'r/SmartGlasses' })

    s.setNow('2026-10-15T02:00:00.000Z') // 周四 10 点
    expect(await s.watch.tick()).toMatchObject({ ran: true })
    const second = await round(s.watch, reddit)
    expect(second).toContain('watch_new:smartglasses')
    expect(second).not.toContain('watch_new:xreal')

    s.setNow('2026-10-19T02:00:00.000Z') // 下周一 10 点
    expect(await s.watch.tick()).toMatchObject({ ran: true })
    expect(await round(s.watch, reddit)).toContain('watch_new:xreal')
  })

  it('一件活排不下的版块留到下一拍（一件最多 12 路）', async () => {
    const s = setup()
    s.watch.updateSettings({
      own_subreddits: ['a1', 'a2', 'a3', 'a4', 'a5'],
      watch_subreddits: ['w1', 'w2', 'w3'],
      brand_username: 'inmo_official',
    })
    const reddit = fakeReddit({})
    await s.watch.tick()
    const first = (await round(s.watch, reddit)) ?? []
    expect(first).toHaveLength(12)
    expect(first.filter((k) => k.startsWith('watch_new:'))).toEqual(['watch_new:w1'])
    s.setNow('2026-10-14T03:05:00.000Z')
    expect(await s.watch.tick()).toMatchObject({ ran: true })
    expect(await round(s.watch, reddit)).toEqual(['watch_new:w2', 'watch_new:w3'])
  })

  it('老设置原样保留：没有新格子 = 空；自家版块借原来那一个钟，升级后不会马上重读', async () => {
    const s = setup()
    // 老版本存下的设置与「自家版块」那一块的钟
    s.store.setKv('ws_1' as never, 'settings', {
      own_subreddits: ['inmoxr'],
      keywords: [],
      every_hours: 24,
      day_start_hour: 9,
      keyword_limit: 10,
      enabled: true,
    })
    s.store.setKv('ws_1' as never, 'parts', {
      inbox: { last_ok_at: '2026-10-14T01:30:00.000Z' },
      own_sub: { last_ok_at: '2026-10-14T01:30:00.000Z' },
    })
    expect(s.watch.settings()).toMatchObject({
      own_subreddits: ['inmoxr'],
      watch_subreddits: [],
      sub_per_week: {},
      alert_words: [],
      tag_words: [],
      every_hours: 24,
    })
    expect(await s.watch.tick()).toMatchObject({ ran: false, skipped: 'not_due' })
    s.setNow('2026-10-15T02:00:00.000Z')
    expect(await s.watch.tick()).toMatchObject({ ran: true })
  })
})

const SEARCH = vi.fn(async () => ({
  ok: true as const,
  items: [
    {
      kind: 'post' as const,
      url: 'https://www.reddit.com/r/smartglasses/comments/aa1/x/',
      id: 'aa1',
      title: 'INMO Air 3 overheating?',
      text: 'gets hot after 10 min',
      subreddit: 'smartglasses',
      author: 'zed',
      created_at: '2026-10-13T10:00:00.000Z',
    },
    {
      kind: 'post' as const,
      url: 'https://www.reddit.com/r/smartglasses/comments/aa2/x/',
      id: 'aa2',
      title: 'INMO Go 2 review',
      text: 'solid',
      subreddit: 'smartglasses',
      author: 'yan',
      created_at: '2026-10-13T11:00:00.000Z',
    },
  ],
}))

describe('告警词：标「优先」、单独提醒一次；标签词可筛', () => {
  const routes = {
    '/message/inbox/.json?mark=false': listing([
      t('c7', 't1', 'inmoxr', { type: 'comment_reply', body: 'I want a refund please' }),
    ]),
    // 同一条评论在自家版块的评论流里也读到了
    '/r/inmoxr/comments/.json': listing([
      t('c7', 't1', 'inmoxr', { body: 'I want a refund please' }),
      t('c6', 't1', 'inmoxr', { author: 'inmo_official', body: 'refund policy is 30 days' }),
    ]),
  }

  it('同一条从几处读到只提醒一次；我们自己发的不标；收起后不再出', async () => {
    const s = setup({ search: SEARCH })
    s.watch.updateSettings({
      own_subreddits: ['inmoxr'],
      keywords: ['INMO'],
      alert_words: ['refund', 'overheat'],
      tag_words: ['Air3'],
      brand_username: 'inmo_official',
    })
    const alerts: RedditWatchEntry[][] = []
    s.watch.onAlert((items) => alerts.push(items))
    await s.watch.runNow()
    // 外部关键词那一路先到：overheating 命中 overheat
    expect(alerts[0]?.map((x) => [x.fullname, x.alert_hits])).toEqual([['t3_aa1', ['overheat']]])
    await round(s.watch, fakeReddit(routes))
    expect(alerts).toHaveLength(2)
    expect(alerts[1]?.map((x) => x.fullname)).toEqual(['t1_c7'])
    const c7 = s.watch.items().filter((x) => x.fullname === 't1_c7')
    expect(c7).toHaveLength(2)
    expect(c7.every((x) => x.priority === true)).toBe(true)
    expect(s.watch.items().find((x) => x.fullname === 't1_c6')?.priority).toBeUndefined()
    // 提醒条：同一条只一行
    const view = s.watch.view()
    expect(view.alerts?.map((x) => x.fullname).sort()).toEqual(['t1_c7', 't3_aa1'])
    const one = c7[0]?.id ?? ''
    expect(s.watch.dismissAlert(one)?.alert_seen).toBe(true)
    expect(s.watch.view().alerts?.map((x) => x.fullname)).toEqual(['t3_aa1'])
    expect(s.watch.dismissAlert('rw_nope')).toBeUndefined()
  })

  it('查巡查数据：按「优先」、按标签筛；后加的标签词对老条目也生效', async () => {
    const s = setup({ search: SEARCH })
    s.watch.updateSettings({
      keywords: ['INMO'],
      alert_words: ['overheat'],
      tag_words: ['Air3'],
    })
    await s.watch.runNow()
    const source = redditWatchSourceOf(s.watch)
    const window = { since: '2026-10-07T00:00:00.000Z', until: WED_10 }
    const q = async (filter: Parameters<typeof queryWatchItems>[0]['filter']) =>
      queryWatchItems({
        items: await source.items(window),
        ownPlaces: [],
        window,
        ...(filter === undefined ? {} : { filter }),
      })
    expect((await q({ priority: true })).items.map((x) => x.id)).toEqual(['t3_aa1'])
    expect((await q(undefined)).totals.priority).toBe(1)
    expect((await q({ tag: 'air3' })).items.map((x) => [x.id, x.tags])).toEqual([
      ['t3_aa1', ['Air3']],
    ])
    expect((await q({ tag: 'Go2' })).items).toEqual([])
    s.watch.updateSettings({ tag_words: ['Air3', 'Go2'] })
    expect((await q({ tag: 'Go2' })).items.map((x) => x.id)).toEqual(['t3_aa2'])
  })
})

const AI_REPLY = JSON.stringify({
  own_subreddits: ['inmoxr'],
  watch_subreddits: [
    { name: 'SmartGlasses', per_week: 7 },
    { name: 'r/Xreal', per_week: 1 },
    { name: 'not a sub!', per_week: 1 },
  ],
  keywords: ['INMO', 'AI glasses'],
  alert_words: ['recall', 'refund'],
  tag_words: ['Air3', 'Go2'],
  why: {
    own_subreddits: '品牌名 + xr',
    watch_subreddits: '品类用户聚集',
    keywords: '品牌与品类词',
    alert_words: '售后风险',
    tag_words: '型号写法',
  },
})

describe('配置卡默认带 AI 建议值', () => {
  it('第一次出卡：五样都带建议与一句理由；只问一次模型；保存按卡上写的频率存', async () => {
    const complete = vi.fn(async () => `好的：${AI_REPLY}`)
    const s = setup({
      complete: () => complete,
      brandBrief: () => ({ name: 'INMO', one_liner: 'AR translation glasses', markets: ['US'] }),
    })
    const target = s.watch.setupTarget()
    // WP348：AI 的方案由「怎么查」在出卡前给（fields() 只给已存的与事实）
    const plan = async () =>
      mergePlan(
        await target.fields(),
        (await target.research?.(createResearchKit({ profile: () => ({}) }).kit)) ?? {},
        { ...(target.noGuess === undefined ? {} : { noGuess: target.noGuess }) },
      )
    const fields = await plan()
    const by = (k: string) => fields.find((f) => f.key === k)
    expect(by('own_subreddits')).toMatchObject({
      suggested: 'inmoxr',
      suggested_why: '品牌名 + xr',
    })
    expect(by('watch_subreddits')?.suggested).toBe('SmartGlasses, Xreal（每周）')
    expect(by('keywords')?.suggested).toBe('INMO, AI glasses')
    expect(by('alert_words')).toMatchObject({
      suggested: 'recall, refund',
      suggested_why: '售后风险',
    })
    expect(by('tag_words')?.suggested).toBe('Air3, Go2')
    // 品牌号不让 AI 猜：插件没配对 → 需要你填
    expect(by('brand_username')?.needs_you).toBe(true)
    // 品牌档案进提示词时包在围栏里
    expect(String(complete.mock.calls[0]?.[0])).toContain('<external_data>')
    await plan()
    expect(complete).toHaveBeenCalledTimes(1)

    // 人确认（不改直接保存 = 用建议值）
    const values = Object.fromEntries(
      fields.filter((f) => f.suggested !== undefined).map((f) => [f.key, f.suggested as string]),
    )
    await target.apply(values)
    expect(s.watch.settings()).toMatchObject({
      own_subreddits: ['inmoxr'],
      watch_subreddits: ['SmartGlasses', 'Xreal'],
      sub_per_week: { xreal: 1 },
      keywords: ['INMO', 'AI glasses'],
      alert_words: ['recall', 'refund'],
      tag_words: ['Air3', 'Go2'],
    })
    expect(await target.satisfied()).toBe(true)
    // 配好之后再开卡（AI 自己要卡时）：显示现在的值，不再问模型
    const again = await target.fields()
    expect(again.find((f) => f.key === 'watch_subreddits')?.suggested).toBe(
      'SmartGlasses, Xreal（每周）',
    )
    expect(again.find((f) => f.key === 'watch_subreddits')?.suggested_why).toBeUndefined()
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('没模型：留空；连接里登记的自家版照样预填；写错了照实说', async () => {
    const s = setup({ suggestions: () => ({ own_subreddits: ['inmoxr'] }) })
    const target = s.watch.setupTarget()
    const fields = await target.fields()
    expect(fields.find((f) => f.key === 'own_subreddits')).toMatchObject({
      suggested: 'inmoxr',
      suggested_why: '连接里登记的自家版',
    })
    for (const k of ['watch_subreddits', 'keywords', 'alert_words', 'tag_words'])
      expect(fields.find((f) => f.key === k)?.suggested).toBeUndefined()
    await expect(target.apply({ watch_subreddits: 'Xreal（每月）' })).rejects.toBeInstanceOf(
      SetupCardError,
    )
    await expect(target.apply({ alert_words: 'recall' })).rejects.toThrow('至少填一样')
  })

  it('模型回话认不出 / 档案全空：不建议、不记下（下次再问）', async () => {
    const complete = vi.fn(async () => 'sorry')
    const s = setup({ complete: () => complete, brandBrief: () => ({ name: 'INMO' }) })
    expect(await s.watch.aiSuggestions()).toBeUndefined()
    expect(await s.watch.aiSuggestions()).toBeUndefined()
    expect(complete).toHaveBeenCalledTimes(2)
    const empty = setup({ complete: () => complete, brandBrief: () => ({}) })
    expect(await empty.watch.aiSuggestions()).toBeUndefined()
    expect(complete).toHaveBeenCalledTimes(2)
    expect(parseSuggestion(AI_REPLY)?.watch_subreddits).toEqual([
      { name: 'SmartGlasses' },
      { name: 'Xreal', per_week: 1 },
    ])
  })
})
