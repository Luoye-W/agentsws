/**
 * WP386（docs/103 v2）：信息监控的数据链——多条监控源、到点才拉、满 20 条加拉、本地整词过滤、去重、
 * Reddit 改走取数路由、`list_mentions`、配置卡（规则脑出清单）、贴错链接当场说。
 *
 * 全用录好的 feed 样本（`packages/pr-core/test/fixtures/`，地址都是假的），不联网。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MonitorSource, RunRequest } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createPrStore } from '../src/pr.js'
import { createPrService, urgentNegative } from '../src/pr-service.js'
import {
  createPrMonitorToolExecutor,
  createPrWatch,
  createPrWatchStore,
  draftPlan,
  dueSources,
  nextMonitorRunAt,
  PR_WATCH_TARGET,
  parseRowValue,
  queryFor,
  summaryOf,
} from '../src/pr-watch/index.js'

const WS = 'ws_pw' as never
const fx = (name: string): string =>
  readFileSync(join(__dirname, '../../../packages/pr-core/test/fixtures', name), 'utf8')
const GA = 'https://www.google.com/alerts/feeds/00000000000000000000/0000000000000000000'
const GA2 = 'https://www.google.com/alerts/feeds/00000000000000000000/1111111111111111111'
const SITE = 'https://ebr.example.com/feed'

/** 一个按地址回录好样本的假 fetch（地址不在表里 = 404）。 */
function feeds(routes: Record<string, { status: number; body: string }>) {
  const calls: string[] = []
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url)
      const hit = routes[url] ?? { status: 404, body: '' }
      return { ok: hit.status < 400, status: hit.status, text: async () => hit.body }
    },
  }
}

function harness(opts: {
  routes?: Record<string, { status: number; body: string }>
  now?: () => string
  reddit?: Parameters<typeof createPrWatch>[0]['redditSearch']
  facts?: Parameters<typeof createPrWatch>[0]['facts']
  legacy?: { feed_url?: string; brand_terms?: string }[]
}) {
  let clock = '2026-10-18T10:00:00.000Z'
  const now = opts.now ?? (() => clock)
  const store = createPrWatchStore({ workspace_id: WS })
  const pr = createPrStore({ workspace_id: WS })
  const net = feeds(opts.routes ?? {})
  let n = 0
  const watch = createPrWatch({
    workspace_id: WS,
    store,
    now,
    newId: (p) => `${p}_${++n}`,
    tzOffsetMinutes: () => 480,
    fetch: net.fetch,
    ...(opts.reddit === undefined ? {} : { redditSearch: opts.reddit }),
    ingest: async (rows) => {
      let created = 0
      for (const r of rows) {
        const saved = pr.saveMention({
          id: `mn_${++n}`,
          workspace_id: WS,
          source: r.source,
          origin: r.origin,
          url: r.url ?? '',
          ...(r.title === undefined ? {} : { title: r.title }),
          text: r.text,
          published_at: r.published_at ?? now(),
          observed_at: now(),
          status: 'new',
          dedupe_key: `url:${r.url}`,
          ...(r.group === undefined ? {} : { group: r.group }),
          ...(r.competitor === undefined ? {} : { competitor: r.competitor }),
          ...(r.source_id === undefined ? {} : { source_id: r.source_id }),
          ...(r.guid === undefined ? {} : { guid: r.guid }),
        })
        if (saved.created) created += 1
      }
      return { created }
    },
    facts:
      opts.facts ??
      (() => ({
        name: 'Super73',
        markets: ['US'],
        category: 'electric motorbike',
        competitors: [{ name: 'Aventon', reason: '同价位电助力车' }],
      })),
    ...(opts.legacy === undefined ? {} : { legacyFeeds: () => opts.legacy ?? [] }),
  })
  return { watch, store, pr, net, setNow: (t: string) => (clock = t) }
}

const src = (over: Partial<MonitorSource>): MonitorSource => ({
  id: 'ms_1',
  workspace_id: WS,
  kind: 'google_alerts',
  url: GA,
  group: 'own',
  label: 'Super73',
  every_hours: 24,
  status: 'ok',
  added_via: 'paste',
  created_at: '2026-10-01T00:00:00.000Z',
  ...over,
})
const SETTINGS = { enabled: true, day_start_hour: 9, default_every_hours: 24, reddit_queries: [] }

describe('到点判断（默认一天一次、本地 9 点后）', () => {
  it('9 点前不拉；9 点后今天没拉过就拉', () => {
    // 东八区：UTC 00:30 = 本地 08:30
    const early = { now: '2026-10-18T00:30:00.000Z', tz_offset_minutes: 480, settings: SETTINGS }
    const s = src({ last_ok_at: '2026-10-17T01:30:00.000Z' })
    expect(dueSources({ ...early, sources: [s] })).toEqual([])
    const late = { ...early, now: '2026-10-18T01:30:00.000Z' }
    expect(dueSources({ ...late, sources: [s] }).map((x) => x.id)).toEqual(['ms_1'])
    // 今天已经拉过 → 不拉
    expect(
      dueSources({ ...late, sources: [src({ last_ok_at: '2026-10-18T01:05:00.000Z' })] }),
    ).toEqual([])
  })

  it('关机错过好几天，开机只补一次；失败的隔一小时再试', () => {
    const at = { now: '2026-10-18T02:00:00.000Z', tz_offset_minutes: 480, settings: SETTINGS }
    expect(
      dueSources({ ...at, sources: [src({ last_ok_at: '2026-10-12T02:00:00.000Z' })] }),
    ).toHaveLength(1)
    const failed = src({ status: 'failed', last_try_at: '2026-10-18T01:30:00.000Z' })
    expect(dueSources({ ...at, sources: [failed] })).toEqual([])
    expect(
      dueSources({ ...at, now: '2026-10-18T02:31:00.000Z', sources: [failed] }).map((x) => x.id),
    ).toEqual(['ms_1'])
  })

  it('加拉到每 4 小时的源按小时数算；暂停的不拉；下一次时刻给右栏', () => {
    const at = { now: '2026-10-18T02:00:00.000Z', tz_offset_minutes: 480, settings: SETTINGS }
    expect(
      dueSources({
        ...at,
        sources: [src({ every_hours: 4, last_ok_at: '2026-10-17T21:55:00.000Z' })],
      }),
    ).toHaveLength(1)
    expect(dueSources({ ...at, sources: [src({ paused: true })] })).toEqual([])
    // 今天拉过了 → 下一次是明早 9 点（本地）= UTC 01:00
    expect(
      nextMonitorRunAt({ ...at, sources: [src({ last_ok_at: '2026-10-18T01:10:00.000Z' })] }),
    ).toBe('2026-10-19T01:00:00.000Z')
    expect(
      nextMonitorRunAt({ ...at, settings: { ...SETTINGS, enabled: false }, sources: [src({})] }),
    ).toBeUndefined()
  })
})

describe('贴链接、第一轮、拉取', () => {
  it('贴一条 Google Alerts RSS：当场拉一次，拉到了才算配好；标题里的词当名字', async () => {
    const h = harness({ routes: { [GA]: { status: 200, body: fx('google-alerts-3.atom.xml') } } })
    const [r] = await h.watch.addLinks({ links: GA })
    expect(r?.ok).toBe(true)
    expect(r?.message).toContain('已订上「Super73」')
    const s = h.store.sources()[0]
    expect(s).toMatchObject({
      kind: 'google_alerts',
      label: 'Super73',
      status: 'ok',
      every_hours: 24,
    })
    expect(h.pr.mentions()).toHaveLength(3)
    // 跳转链接已经解开
    expect(h.pr.mentions()[0]?.url).toContain('https://news')
    expect(h.watch.view().summary).toBe('1 条')
    // 地址只出脱敏那一格
    expect(JSON.stringify(h.watch.view())).not.toContain('0000000000000000000/0000')
  })

  it('贴错链接 → 当场说「这条还是邮箱投递」，不存', async () => {
    const h = harness({
      routes: { 'https://shop.example.com/': { status: 200, body: fx('not-a-feed.html') } },
    })
    const res = await h.watch.addLinks({
      links: 'https://www.google.com/alerts?hl=en\nhttps://shop.example.com/',
    })
    expect(res.every((r) => !r.ok && r.message.includes('邮箱投递'))).toBe(true)
    expect(h.store.sources()).toEqual([])
  })

  it('一次贴一批：按 feed 标题对上清单上的哪一行', async () => {
    const competitorFeed = fx('google-alerts-3.atom.xml').replace(
      'Google Alert - Super73',
      'Google Alert - Aventon',
    )
    const h = harness({
      routes: {
        [GA]: { status: 200, body: fx('google-alerts-3.atom.xml') },
        [GA2]: { status: 200, body: competitorFeed },
      },
    })
    const target = h.watch.setupTarget()
    const fields = await target.fields()
    // 规则脑：自家一条、竞品一条、品类一条（每行一个贴 RSS 的格子 + 一次贴一批）
    expect(fields.map((f) => f.key)).toEqual([
      'alert_1',
      'rss_1',
      'alert_2',
      'rss_2',
      'alert_3',
      'rss_3',
      'rss_batch',
    ])
    await target.apply({
      alert_1: '"Super73" -job ｜ en · US',
      alert_2: '"Aventon" OR "Aventon ebike" -job ｜ en · US',
      alert_3: '',
      rss_batch: `${GA2}\n${GA}`,
    })
    const plan = h.store.planItems()
    expect(plan.find((p) => p.label === 'electric motorbike')).toMatchObject({
      selected: false,
      status: 'skipped',
    })
    const aventon = plan.find((p) => p.label === 'Aventon')
    expect(aventon).toMatchObject({ status: 'linked', query: '"Aventon" OR "Aventon ebike" -job' })
    const src2 = h.store.sources().find((s) => s.id === aventon?.source_id)
    expect(src2).toMatchObject({ group: 'competitor', competitor: 'Aventon' })
    expect(h.store.sources()).toHaveLength(2)
  })

  it('配置卡上贴错的那一条：清单照存，错的那条当场说', async () => {
    const h = harness({})
    const target = h.watch.setupTarget()
    await expect(
      target.apply({ alert_1: '"Super73"', rss_1: 'https://www.google.com/alerts/edit?x=1' }),
    ).rejects.toThrow(/邮箱投递/)
    expect(h.store.planItems().length).toBeGreaterThan(0)
  })

  it('feed 404：那一条标红、写一句人话，下一轮简报写「没拉到」（不是 0 条）', async () => {
    const h = harness({ routes: { [GA]: { status: 200, body: fx('google-alerts-3.atom.xml') } } })
    await h.watch.addLinks({ links: GA })
    h.net.calls.length = 0
    // 第二天 9 点后，feed 被删了
    h.setNow('2026-10-19T02:00:00.000Z')
    h.store.putSource({ ...(h.store.sources()[0] as MonitorSource), url: GA2 })
    const pulled = await h.watch.pull()
    expect(pulled.ok).toBe(true)
    if (!pulled.ok) return
    expect(pulled.rows).toEqual([])
    pulled.finish?.({ created: 0 })
    const s = h.store.sources()[0]
    expect(s?.status).toBe('failed')
    expect(s?.last_error).toContain('404')
    const view = h.watch.view()
    expect(view.summary).toBe('1 条 · 1 条拉不到')
    expect(view.last_run?.notes[0]).toContain('没拉到')
  })

  it('满 20 条全是新的 → 这条改成每 4 小时拉一次，简报里写一句', async () => {
    // 上次拉成过（昨天）；这次那条 feed 回满 20 条、全是新的
    const h2 = harness({
      routes: { [GA]: { status: 200, body: fx('google-alerts-full20.atom.xml') } },
    })
    h2.store.putSource(src({ last_ok_at: '2026-10-17T02:00:00.000Z' }))
    h2.setNow('2026-10-18T02:00:00.000Z')
    const pulled = await h2.watch.pull()
    expect(pulled.ok && pulled.rows.length).toBe(20)
    const s = h2.store.sources()[0]
    expect(s?.every_hours).toBe(4)
    expect(s?.boosted_at).toBeDefined()
    expect(h2.store.runs(1)[0]?.notes[0]).toContain('每 4 小时')
    // 第二次拉同一份：见过的不算新的，不再入库
    h2.setNow('2026-10-18T06:30:00.000Z')
    const again = await h2.watch.pull()
    expect(again.ok && again.rows.length).toBe(0)
  })

  it('第一次拉回来 20 条不算「可能漏了」', async () => {
    const h = harness({
      routes: { [GA]: { status: 200, body: fx('google-alerts-full20.atom.xml') } },
    })
    await h.watch.addLinks({ links: GA })
    expect(h.store.sources()[0]?.every_hours).toBe(24)
  })

  it('普通 RSS：按监控项的词整词过滤、排除词生效', async () => {
    const h = harness({ routes: { [SITE]: { status: 200, body: fx('site-rss2.xml') } } })
    const [r] = await h.watch.addLinks({ links: SITE })
    expect(r?.kind).toBe('rss')
    const s = h.store.sources()[0] as MonitorSource
    expect(s.group).toBe('site')
    // 默认按品牌 + 竞品名过滤；这里改成监控项自己的词（再从头拉一次）
    expect(s.keywords).toEqual(['Super73', 'Aventon'])
    const fresh = harness({ routes: { [SITE]: { status: 200, body: fx('site-rss2.xml') } } })
    const { last_ok_at: _ok, last_try_at: _try, ...rest } = s
    fresh.store.putSource({ ...rest, keywords: ['Aventon', 'INMO'], exclude: ['job', 'hiring'] })
    const pulled = await fresh.watch.pull()
    expect(pulled.ok).toBe(true)
    if (!pulled.ok) return
    expect(pulled.rows.map((x) => x.title)).toEqual([
      'Aventon Level 3 long-term review',
      'Lectric XP 4 vs Aventon Sinch',
    ])
  })

  it('老的单条 feed（连接卡上那一格）启动时迁进来；人删了不会又带回来', () => {
    const h = harness({ legacy: [{ feed_url: GA, brand_terms: 'Super73, S73' }] })
    expect(h.watch.migrateLegacy()).toBe(1)
    expect(h.store.sources()[0]).toMatchObject({ url: GA, label: 'Super73', status: 'unchecked' })
    h.watch.removeSource(h.store.sources()[0]?.id as string)
    expect(h.watch.migrateLegacy()).toBe(0)
    expect(h.store.sources()).toEqual([])
  })
})

describe('Reddit 那一路走取数路由', () => {
  it('配了搜索词才跑；走注入的路由（不碰 oauth.reddit.com）；没取到照实说', async () => {
    const asked: string[] = []
    const h = harness({
      reddit: async (q) => {
        asked.push(q)
        return q === 'Super73'
          ? {
              ok: true,
              items: [
                {
                  url: 'https://www.reddit.com/r/ebikes/comments/abc/x/',
                  title: 'Super73 R thoughts?',
                  text: 'Anyone tried it',
                  subreddit: 'ebikes',
                  id: 't3_abc',
                  created_at: '2026-10-17T00:00:00.000Z',
                },
              ],
            }
          : { ok: false, message: '接口中台没开通' }
      },
    })
    expect(h.watch.configured()).toBe(false)
    h.watch.updateSettings({ reddit_queries: ['Super73', 'Aventon'] })
    expect(h.watch.configured()).toBe(true)
    const pulled = await h.watch.pull()
    expect(asked).toEqual(['Super73', 'Aventon'])
    expect(pulled.ok && pulled.rows[0]).toMatchObject({
      source: 'reddit',
      origin: 'r/ebikes',
      source_id: 'reddit',
    })
    expect(h.net.calls.some((u) => u.includes('reddit.com'))).toBe(false)
  })
})

describe('list_mentions', () => {
  const request = { workspace_id: WS, id: 'run_1' } as unknown as RunRequest
  const exec = (h: ReturnType<typeof harness>, googleReady = true) =>
    createPrMonitorToolExecutor({
      of: async () => ({
        watch: h.watch,
        mentions: (f) => h.pr.mentions(f),
        sources: () => h.store.sources(),
      }),
      now: () => '2026-10-18T10:00:00.000Z',
      googleReady: () => googleReady,
    })

  it('还没配：先引导登录 Google（问一次），再出配置卡', async () => {
    const h = harness({})
    const first = await exec(h, false)({ name: 'list_mentions', input: {}, request })
    expect(first.reason).toMatch(/^needs_connection:google_account/)
    const second = await exec(h, true)({ name: 'list_mentions', input: {}, request })
    expect(second.reason).toMatch(new RegExp(`^needs_setup:${PR_WATCH_TARGET}`))
  })

  it('按组 / 竞品筛；拉不到的源照实列（missing），不当 0 条', async () => {
    const competitorFeed = fx('google-alerts-3.atom.xml')
      .replace('Google Alert - Super73', 'Google Alert - Aventon')
      .replaceAll('news', 'press')
    const h = harness({
      routes: {
        [GA]: { status: 200, body: fx('google-alerts-3.atom.xml') },
        [GA2]: { status: 200, body: competitorFeed },
      },
    })
    await h.watch.addLinks({ links: `${GA} ${GA2}` })
    const comp = await exec(h)({
      name: 'list_mentions',
      input: { group: 'competitor', days: 30 },
      request,
    })
    const data = comp.data as { rows: number; items: { competitor?: string }[]; missing?: string }
    expect(data.rows).toBe(3)
    expect(data.items.every((i) => i.competitor === 'Aventon')).toBe(true)
    const byName = await exec(h)({
      name: 'list_mentions',
      input: { competitor: 'aventon', days: 30 },
      request,
    })
    expect((byName.data as { rows: number }).rows).toBe(3)
    // 一条源坏了
    const s = h.store.sources()[0] as MonitorSource
    h.store.putSource({ ...s, status: 'failed', last_error: '404' })
    const all = await exec(h)({ name: 'list_mentions', input: { days: 30 }, request })
    expect((all.data as { missing?: string }).missing).toContain('没拉到')
  })
})

describe('配置卡：规则脑出清单', () => {
  it('自家（每个主要语言一条）、竞品（档案 + GEO 合并别名）、品类；每条带查询语句和理由', () => {
    const drafts = draftPlan({
      facts: {
        name: 'Super73',
        markets: ['US', 'DE'],
        subcategory: 'e-moto',
        competitors: [{ name: 'Aventon', reason: '同价位' }],
      },
      geo: { competitors: [{ name: 'Aventon', aliases: ['Aventon ebike'] }, { name: 'Ride1Up' }] },
    })
    expect(drafts.map((d) => [d.group, d.label, d.language, d.region])).toEqual([
      ['own', 'Super73', 'en', 'US'],
      ['own', 'Super73', 'de', 'DE'],
      ['competitor', 'Aventon', 'en', 'US'],
      ['competitor', 'Ride1Up', 'en', 'US'],
      ['industry', 'e-moto', 'en', 'US'],
    ])
    expect(drafts[2]?.query).toBe('"Aventon" OR "Aventon ebike" -job')
    expect(drafts.every((d) => d.why !== '')).toBe(true)
  })

  it('卡上那一格：查询语句 ｜ 语言 · 地区；清空 = 不建', () => {
    expect(parseRowValue('"Aventon" -job ｜ de · DE', { language: 'en', region: 'US' })).toEqual({
      query: '"Aventon" -job',
      language: 'de',
      region: 'DE',
    })
    expect(parseRowValue('"Aventon"', { language: 'en', region: 'US' })?.region).toBe('US')
    expect(parseRowValue('  ', { language: 'en', region: 'US' })).toBeUndefined()
    expect(queryFor('Aventon')).toBe('"Aventon" -job')
    expect(summaryOf(17, 1)).toBe('17 条 · 1 条拉不到')
  })
})

describe('提及库：竞品不出卡；R8 只有扩散 / 召回 / 诉讼立即推', () => {
  const make = () => {
    const store = createPrStore({ workspace_id: WS })
    const cards: { priority: string; payload: { form: string } }[] = []
    const svc = createPrService({
      workspace_id: WS,
      store,
      clock: { now: () => '2026-10-18T10:00:00.000Z' },
      approvals: {
        create: async (x: never) => {
          cards.push(x)
          return { id: `ap_${cards.length}`, state: 'pending' }
        },
      } as never,
      ledger: { stage: async () => ({ ok: false, message: 'x' }) as never, list: async () => [] },
      effectiveConfig: () => {
        throw new Error('no config')
      },
      appendEvent: () => {},
      random: () => 0.5,
      holdersOf: () => [],
      owner: async () => undefined,
    })
    return { svc, store, cards }
  }
  const actor = {
    workspace_id: WS,
    person_id: 'p',
    assignment_id: 'as',
    role_id: 'pr.monitoring',
  } as never

  it('竞品被骂：入表、带组和竞品名，不出预警卡', async () => {
    const { svc, store, cards } = make()
    const v = await svc.port.ingestMention(actor, {
      source: 'news',
      origin: 'x.example',
      url: 'https://x.example/a',
      title: 'Aventon recall',
      text: 'Aventon announces a recall, avoid',
      group: 'competitor',
      competitor: 'Aventon',
      source_id: 'ms_2',
    })
    expect(v.card).toBe('archive')
    expect(cards).toHaveLength(0)
    expect(store.mentions({ group: 'competitor' })[0]).toMatchObject({
      competitor: 'Aventon',
      source_id: 'ms_2',
    })
  })

  it('自家负面：召回立即推，一般差评进队列', async () => {
    const { svc, cards } = make()
    await svc.port.ingestMention(actor, {
      source: 'news',
      origin: 'x.example',
      url: 'https://x.example/b',
      text: 'Super73 recall over brakes',
    })
    await svc.port.ingestMention(actor, {
      source: 'news',
      origin: 'y.example',
      url: 'https://y.example/c',
      text: 'Super73 is terrible',
    })
    expect(cards.map((c) => c.priority)).toEqual(['immediate', 'queue'])
    expect(urgentNegative(['negative:terrible'], 3)).toBe(true)
  })

  it('去重：同一条源里 guid 一样、同站相近标题，都合并成一条（被转了几次照旧加）', () => {
    const store = createPrStore({ workspace_id: WS })
    const base = {
      workspace_id: WS,
      source: 'news' as const,
      origin: 'news.example',
      text: 'x',
      published_at: '2026-10-17T00:00:00.000Z',
      observed_at: '2026-10-18T00:00:00.000Z',
      status: 'new' as const,
    }
    store.saveMention({
      ...base,
      id: 'a',
      url: 'https://news.example/a',
      title: 'Aventon recalls 2,000 e-bikes over brakes',
      dedupe_key: 'url:a',
      source_id: 'ms',
      guid: 'g1',
    })
    const byGuid = store.saveMention({
      ...base,
      id: 'b',
      url: 'https://news.example/a2',
      dedupe_key: 'url:b',
      source_id: 'ms',
      guid: 'g1',
    })
    expect(byGuid.created).toBe(false)
    const byTitle = store.saveMention({
      ...base,
      id: 'c',
      url: 'https://news.example/a3',
      title: 'Aventon recalls 2000 e-bikes over brakes - News Example',
      dedupe_key: 'url:c',
    })
    expect(byTitle.created).toBe(false)
    expect(store.mentions()[0]?.seen_count).toBe(3)
  })
})
