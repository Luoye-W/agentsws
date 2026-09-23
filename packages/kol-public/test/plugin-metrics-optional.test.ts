/**
 * WP130（修 WP129 发现的 bug）：插件来源的观察可以不带 `posts_30d` / `engagement_rate`。
 *
 * 之前本机转发只送粉丝数，这里要求那两格必须是数——于是本机的红人观测一条都没进过
 * 公共库。修法（Luoye / 审核方定）：**对插件来源放宽为可选**，但：
 * 1. 缺不是 0：k-匿名基准跳过缺格的行，也不让它凑 k；
 * 2. 体检不拿卡上垫的 0 下判断（不标「近 30 天没发」、不出互动率分位）；
 * 3. 其余来源（工作区手填、官方、apify）照旧必须给；
 * 4. sqlite 档不 ALTER 老表：缺格记在旁表，读回来是「没有」，不是 0。
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  buildAudit,
  computeBenchmark,
  parseObservation,
  SqliteKolStore,
  type ObservationRow as StoreObservationRow,
} from '../src/index.js'
import { KOL_PREFIX } from '../src/routes.js'
import { harness, observation } from './helpers.js'

const AT = '2026-09-15T00:00:00.000Z'
const principal = { account_id: 'acc_1', org_id: 'org_1', workspace_id: 'ws_1' } as never

const bare = (handle: string) => ({
  channel: 'tiktok',
  handle,
  followers: 12_000,
  observed_at: '2026-09-14T00:00:00.000Z',
})

describe('parseObservation：插件来源两格可缺', () => {
  it('插件来源：缺就不给这两格（不补 0）；给了照样校验范围', () => {
    const out = parseObservation(bare('gymchef'), AT, { metricsOptional: true })
    expect(out).not.toHaveProperty('posts_30d')
    expect(out).not.toHaveProperty('engagement_rate')
    expect(
      parseObservation({ ...bare('gymchef'), engagement_rate: 0.05 }, AT, {
        metricsOptional: true,
      }).engagement_rate,
    ).toBe(0.05)
    expect(() =>
      parseObservation({ ...bare('gymchef'), engagement_rate: 3.1 }, AT, { metricsOptional: true }),
    ).toThrow(/engagement_rate/)
  })

  it('别的来源照旧必须给', () => {
    expect(() => parseObservation(bare('gymchef'), AT)).toThrow(/posts_30d/)
  })
})

describe('贡献：本机转发（via: extension）记为插件来源', () => {
  it('路由带 via=extension：缺两格也收；卡建起来、来源是 plugin、观察里没有那两格', async () => {
    const h = harness()
    const res = await h.call(`${KOL_PREFIX}/creators/tiktok/gymchef/observations`, {
      method: 'POST',
      body: { via: 'extension', observations: [bare('gymchef')] },
    })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ kind: 'observation', received: 1, accepted: 1 })
    const card = h.store.creator('tiktok', 'gymchef')
    expect(card).toMatchObject({ followers: 12_000, source: 'plugin' })
    const [row] = h.store.observationsOf('tiktok', 'gymchef')
    expect(row?.source).toBe('plugin')
    expect(row).not.toHaveProperty('posts_30d')
    expect(row).not.toHaveProperty('engagement_rate')
  })

  it('不带 via 就是工作区手填：缺两格整批拒（老口径不变）', async () => {
    const h = harness()
    const res = await h.call(`${KOL_PREFIX}/creators/tiktok/gymchef/observations`, {
      method: 'POST',
      body: { observations: [bare('gymchef')] },
    })
    expect(res.status).toBe(400)
    expect(h.store.creator('tiktok', 'gymchef')).toBeUndefined()
  })

  it('卡上已有的数不会被一条缺格的插件观察冲掉', () => {
    const h = harness()
    h.service.contributeAs(principal, [
      observation({ channel: 'tiktok', handle: 'gymchef', posts_30d: 9, engagement_rate: 0.07 }),
    ])
    h.clock.advance(60_000)
    h.service.contributeAs(
      principal,
      [{ ...bare('gymchef'), followers: 13_000, observed_at: h.clock.now() }],
      { via: 'extension' },
    )
    expect(h.store.creator('tiktok', 'gymchef')).toMatchObject({
      followers: 13_000,
      posts_30d: 9,
      engagement_rate: 0.07,
    })
  })
})

const row = (i: number, engagement: number | undefined): StoreObservationRow => ({
  id: `kob_${i}`,
  channel: 'tiktok',
  handle: `creator${i}`,
  subject: 'ws:ws_1',
  source: 'plugin',
  followers: 20_000 + i,
  ...(engagement === undefined ? {} : { engagement_rate: engagement, posts_30d: 5 }),
  categories: [],
  followers_band: '10k-100k',
  observed_at: AT,
  at: AT,
  counted: true,
})

describe('k-匿名基准：缺格的行跳过，不当 0、也不凑 k', () => {
  const filter = {
    channel: 'tiktok' as const,
    followers_band: '10k-100k' as const,
    category: 'any',
  }

  it('19 个带数的 + 10 个缺格的：不到 20，照样不出数（缺格的不凑 k）', () => {
    const rows = [
      ...Array.from({ length: 19 }, (_, i) => row(i, 0.05)),
      ...Array.from({ length: 10 }, (_, i) => row(100 + i, undefined)),
    ]
    const out = computeBenchmark(rows, filter, AT)
    expect(out.insufficient_samples).toBe(true)
    expect(out.sample_size).toBe(19)
  })

  it('20 个带数的 + 30 个缺格的：分位数只由那 20 个算（缺的要是当 0，p25 会塌到 0）', () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => row(i, 0.04 + i * 0.001)),
      ...Array.from({ length: 30 }, (_, i) => row(100 + i, undefined)),
    ]
    const out = computeBenchmark(rows, filter, AT)
    expect(out.insufficient_samples).toBe(false)
    expect(out.sample_size).toBe(20)
    expect(out.engagement_rate?.p25).toBeGreaterThan(0.04)
  })

  it('同一个人最新那条缺格：用他最近一条带数的，不让缺格的把他挤出去', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i, 0.05))
    rows.push({ ...row(0, undefined), id: 'kob_new', at: '2026-09-16T00:00:00.000Z' })
    expect(computeBenchmark(rows, filter, AT).sample_size).toBe(20)
  })
})

describe('体检：卡上垫的 0 不拿来下判断', () => {
  it('观察里从没带过发布数：不标「近 30 天没发」，也不出互动率分位', () => {
    const observations = Array.from({ length: 5 }, (_, i) => ({
      ...row(0, undefined),
      id: `kob_${i}`,
      observed_at: `2026-09-1${i}T00:00:00.000Z`,
    }))
    const report = buildAudit({
      card: {
        channel: 'tiktok',
        handle: 'creator0',
        followers: 20_000,
        posts_30d: 0,
        engagement_rate: 0,
        categories: [],
        observed_at: AT,
        source: 'plugin',
        observations: 5,
        confidence: 0.7,
        has_contact: false,
        updated_at: AT,
      },
      observations,
      benchmark: {
        channel: 'tiktok',
        category: 'any',
        followers_band: '10k-100k',
        sample_size: 40,
        insufficient_samples: false,
        engagement_rate: { p25: 0.02, p50: 0.04, p75: 0.06 },
        followers: { p25: 1, p50: 2, p75: 3 },
        computed_at: AT,
      },
      at: AT,
      depth: 'basic',
    })
    expect(report.risk_flags).not.toContain('no_recent_posts')
    expect(report.risk_flags).not.toContain('engagement_far_below_peers')
    expect(report).not.toHaveProperty('engagement_percentile')
  })
})

describe('sqlite 档：缺格记在旁表，读回来是「没有」', () => {
  it('写一条缺格的、一条完整的；读回来一条没有那两格、一条原样；清除时旁表一起删', () => {
    const store = new SqliteKolStore(new Database(':memory:'))
    store.appendObservation(row(1, undefined))
    store.appendObservation({ ...row(2, 0.03), handle: 'creator1', id: 'kob_2' })
    const rows = store.observationsOf('tiktok', 'creator1')
    expect(rows).toHaveLength(2)
    expect(rows[0]).not.toHaveProperty('posts_30d')
    expect(rows[0]).not.toHaveProperty('engagement_rate')
    expect(rows[1]).toMatchObject({ posts_30d: 5, engagement_rate: 0.03 })
    const bucket = store.observationsInBucket({
      channel: 'tiktok',
      followers_band: '10k-100k',
      category: 'any',
    })
    expect(bucket.filter((r) => r.engagement_rate === undefined)).toHaveLength(1)

    store.purgeCreator('tiktok', 'creator1')
    expect(store.observationsOf('tiktok', 'creator1')).toEqual([])
  })
})
