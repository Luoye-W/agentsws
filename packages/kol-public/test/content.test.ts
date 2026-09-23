/**
 * WP129：公共红人库的**内容**那一格——插件在视频页采到的数经本机转发进云端。
 *
 * 钉住五件事：
 * 1. 窄行：白名单外的键（评论文本 / 页面地址 / 备注）整批拒，一条都不落；
 * 2. 幂等：渠道 + external_id + observed_at 的 UTC 日 = 一条；桶内重复只刷新数字、不算奖励；
 * 3. 旧观测（离线队列补传）不把新数盖回去，但会补上库里空着的格子；
 * 4. 贡献返额度与红人观测同一口径（日配额合算、每 100 条有效 1 积分、`granted` 类）；
 * 5. 两份库（内存 / sqlite）行为一致，含标识旁表与移除时一起删。
 *
 * 全部替身，不联网。
 */
import type { PublicContentObservation, PublicContentSample } from '@agentsws/contracts'
import {
  MAX_PLUGIN_OBSERVATIONS_PER_DAY,
  OBSERVATIONS_PER_CREDIT,
  PUBLIC_CONTENT_OBSERVATION_FIELDS,
} from '@agentsws/contracts'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  isContentStore,
  type KolContentStore,
  MemoryKolStore,
  parseContentObservation,
  SqliteKolStore,
} from '../src/index.js'
import { harness, observation } from './helpers.js'

const content = (overrides: Partial<PublicContentObservation> = {}): PublicContentObservation => ({
  channel: 'youtube',
  handle: 'somecreator',
  external_id: 'dQw4w9WgXcQ',
  content_type: 'video',
  title: 'Keyboard review',
  published_at: '2026-09-10T00:00:00.000Z',
  duration_seconds: 612,
  views: 12_000,
  likes: 800,
  comments: 45,
  paid_promotion: true,
  shoppable: false,
  observed_at: '2026-09-14T08:00:00.000Z',
  ...overrides,
})

const PATH = '/v1/data/kol/content-observations'

describe('WP129 内容观测：白名单（窄行）', () => {
  it('评论文本、页面地址、封面地址、备注一个键都进不来——整批拒，一条不落', async () => {
    const h = harness()
    for (const extra of [
      { captured_comments: [{ text: 'nice' }] },
      { comment_text: 'nice' },
      { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc' },
      { thumbnail_url: 'https://i.ytimg.com/x.jpg' },
      { note: '我觉得他适合做开箱' },
    ]) {
      const res = await h.call(PATH, {
        method: 'POST',
        body: { observations: [content({ external_id: 'ok1' }), { ...content(), ...extra }] },
      })
      expect(res.status).toBe(400)
      expect(String(res.body.message)).toContain('第 2 条不合格')
    }
    // 第 1 条也没进：整批拒不是"丢掉坏的收下好的"
    expect(h.store.content('youtube', 'ok1')).toBeUndefined()
  })

  it('白名单里没有评论这一格；`comments` 只收一个非负整数', () => {
    expect(PUBLIC_CONTENT_OBSERVATION_FIELDS as readonly string[]).not.toContain(
      'captured_comments',
    )
    const at = '2026-09-15T00:00:00.000Z'
    expect(() => parseContentObservation(content({ comments: -1 }), at)).toThrow()
    expect(() =>
      parseContentObservation({ ...content(), comments: 'great video' as unknown as number }, at),
    ).toThrow()
    expect(() => parseContentObservation({ ...content(), paid_promotion: 'yes' }, at)).toThrow()
    // 未来的观测不收
    expect(() =>
      parseContentObservation(content({ observed_at: '2026-09-16T00:00:00.000Z' }), at),
    ).toThrow()
    // handle 归一（@ 与大小写）
    expect(parseContentObservation(content({ handle: '@SomeCreator' }), at).handle).toBe(
      'somecreator',
    )
  })

  it('要工作区令牌；插件那条要插件令牌', async () => {
    const h = harness()
    const anonymous = await h.call(PATH, {
      method: 'POST',
      token: '',
      body: { observations: [content()] },
    })
    expect(anonymous.status).toBe(401)
    const wrong = await h.call('/v1/data/kol/plugins/content-observations', {
      method: 'POST',
      body: { observations: [content()] },
    })
    expect(wrong.status).toBe(401)

    const paired = await h.call('/v1/data/kol/plugins/pair', { method: 'POST', body: {} })
    const { token } = paired.body.data as { token: string }
    const viaPlugin = await h.call('/v1/data/kol/plugins/content-observations', {
      method: 'POST',
      token,
      body: { observations: [content()] },
    })
    expect(viaPlugin.status).toBe(201)
    expect((viaPlugin.body.data as { kind: string; accepted: number }).accepted).toBe(1)
  })
})

describe('WP129 内容观测：落库与幂等', () => {
  it('落进内容卡（含带货 / 广告标识）并记一行指标；回执 kind=content', async () => {
    const h = harness()
    const res = await h.call(PATH, { method: 'POST', body: { observations: [content()] } })
    expect(res.status).toBe(201)
    const event = res.body.data as { kind: string; received: number; accepted: number }
    expect(event).toMatchObject({ kind: 'content', received: 1, accepted: 1 })
    const card = h.store.content('youtube', 'dQw4w9WgXcQ')
    expect(card).toMatchObject({
      handle: 'somecreator',
      views: 12_000,
      comments: 45,
      duration_seconds: 612,
      published_at: '2026-09-10T00:00:00.000Z',
      paid_promotion: true,
      shoppable: false,
      source: 'plugin',
    })
    expect(h.store.contentMetricOnDay('youtube', 'dQw4w9WgXcQ', '2026-09-14')).toBe(true)
  })

  it('同一条内容同一个 UTC 日：只算一条（不算奖励），但卡上的数刷新', async () => {
    const h = harness()
    await h.call(PATH, { method: 'POST', body: { observations: [content()] } })
    const again = await h.call(PATH, {
      method: 'POST',
      body: {
        observations: [content({ views: 15_000, observed_at: '2026-09-14T20:00:00.000Z' })],
      },
    })
    const event = again.body.data as {
      accepted: number
      rejected: { reason: string; count: number }[]
    }
    expect(event.accepted).toBe(0)
    expect(event.rejected[0]?.count).toBe(1)
    expect(event.rejected[0]?.reason).toContain('不算奖励')
    expect(h.store.content('youtube', 'dQw4w9WgXcQ')?.views).toBe(15_000)

    // 同一批里两次也一样
    const batch = await h.call(PATH, {
      method: 'POST',
      body: {
        observations: [
          content({ external_id: 'twice', observed_at: '2026-09-14T01:00:00.000Z' }),
          content({ external_id: 'twice', observed_at: '2026-09-14T02:00:00.000Z' }),
        ],
      },
    })
    expect((batch.body.data as { accepted: number }).accepted).toBe(1)

    // 换一天就是新的一条
    h.clock.advance(24 * 60 * 60 * 1000)
    const nextDay = await h.call(PATH, {
      method: 'POST',
      body: { observations: [content({ observed_at: '2026-09-15T08:00:00.000Z' })] },
    })
    expect((nextDay.body.data as { accepted: number }).accepted).toBe(1)
  })

  it('离线队列补传的旧观测不把新数盖回去，但补上库里空着的格子', async () => {
    const h = harness()
    await h.call(PATH, {
      method: 'POST',
      body: {
        observations: [
          content({
            views: 20_000,
            observed_at: '2026-09-14T12:00:00.000Z',
            paid_promotion: undefined,
            shoppable: undefined,
          }),
        ],
      },
    })
    await h.call(PATH, {
      method: 'POST',
      body: {
        observations: [
          content({ views: 9_000, observed_at: '2026-09-12T12:00:00.000Z', shoppable: true }),
        ],
      },
    })
    const card = h.store.content('youtube', 'dQw4w9WgXcQ')
    expect(card?.views).toBe(20_000)
    expect(card?.observed_at).toBe('2026-09-14T12:00:00.000Z')
    expect(card?.shoppable).toBe(true)
    // 旧的那一天是一个新桶：指标照记，贡献照算
    expect(h.store.contentMetricOnDay('youtube', 'dQw4w9WgXcQ', '2026-09-12')).toBe(true)
  })
})

describe('WP129 内容观测：贡献返额度（口径同红人观测）', () => {
  it(`每 ${OBSERVATIONS_PER_CREDIT} 条有效内容观测发 1 积分（granted 类）`, async () => {
    const h = harness()
    const batch = Array.from({ length: OBSERVATIONS_PER_CREDIT }, (_, i) =>
      content({ external_id: `vid${i}` }),
    )
    const res = await h.call(PATH, { method: 'POST', body: { observations: batch } })
    expect((res.body.data as { credits_granted: number }).credits_granted).toBe(1)
    expect(h.wallet.balance('org_1').available).toBe(1)
  })

  it('日配额与红人观测合算', async () => {
    const h = harness()
    h.store.putQuota({
      subject: 'ws:ws_1',
      day: '2026-09-15',
      observations: MAX_PLUGIN_OBSERVATIONS_PER_DAY - 1,
      reward_credits: 0,
    })
    const over = await h.call(PATH, {
      method: 'POST',
      body: { observations: [content({ external_id: 'a' }), content({ external_id: 'b' })] },
    })
    expect(over.status).toBe(429)
    expect(String(over.body.message)).toContain('红人与内容合算')
    // 红人观测那条路也看同一个数
    const creator = await h.call('/v1/data/kol/creators/youtube/somecreator/observations', {
      method: 'POST',
      body: { observations: [observation(), observation({ observed_at: '2026-09-14T01:00:00Z' })] },
    })
    expect(creator.status).toBe(429)
  })

  it('不收费：一笔扣费事件都没有', async () => {
    const h = harness({ credits: 10 })
    await h.call(PATH, { method: 'POST', body: { observations: [content()] } })
    expect(h.wallet.balance('org_1').available).toBe(10)
    expect(h.walletStore.events({ org_id: 'org_1' }).filter((e) => e.credits > 0)).toHaveLength(0)
  })
})

describe('WP129 内容写路：两份库行为一致', () => {
  const stores: [string, () => KolContentStore & { close?: () => void }][] = [
    ['memory', () => new MemoryKolStore()],
    ['sqlite', () => new SqliteKolStore(new Database(':memory:'))],
  ]
  const sample = (overrides: Partial<PublicContentSample> = {}): PublicContentSample => ({
    channel: 'youtube',
    handle: 'somecreator',
    external_id: 'v1',
    content_type: 'video',
    title: 'T',
    tags: ['keyboard'],
    views: 10,
    paid_promotion: true,
    observed_at: '2026-09-14T00:00:00.000Z',
    source: 'plugin',
    updated_at: '2026-09-14T00:00:00.000Z',
    ...overrides,
  })

  for (const [name, make] of stores) {
    it(`${name}：标识往返、没给的格子不擦、按 UTC 日判桶`, () => {
      const store = make()
      expect(isContentStore(store as never)).toBe(true)
      store.putContent(sample())
      store.putContent(
        sample({ views: 20, paid_promotion: undefined, shoppable: false, title: undefined }),
      )
      const row = store.content('youtube', 'v1')
      expect(row).toMatchObject({ views: 20, title: 'T', paid_promotion: true, shoppable: false })
      expect(row?.tags).toEqual(['keyboard'])

      expect(store.contentMetricOnDay('youtube', 'v1', '2026-09-14')).toBe(false)
      store.putContentMetric({
        channel: 'youtube',
        handle: 'somecreator',
        content_external_id: 'v1',
        views: 20,
        observed_at: '2026-09-14T23:59:59.000Z',
        source: 'plugin',
        at: '2026-09-15T00:00:00.000Z',
      })
      expect(store.contentMetricOnDay('youtube', 'v1', '2026-09-14')).toBe(true)
      expect(store.contentMetricOnDay('youtube', 'v1', '2026-09-15')).toBe(false)
      expect(store.contentMetricOnDay('tiktok', 'v1', '2026-09-14')).toBe(false)
      store.close?.()
    })
  }

  it('sqlite：移除一个人时标识旁表一起删；移除过的人内容不收', async () => {
    const store = new SqliteKolStore(new Database(':memory:'))
    store.putContent(sample())
    expect(store.purgeCreator('youtube', 'somecreator')).toBeGreaterThanOrEqual(2)
    expect(store.content('youtube', 'v1')).toBeUndefined()
    store.putOptOut({
      channel: 'youtube',
      handle: 'somecreator',
      reason: 'creator asked',
      removed_by: 'owner',
      at: '2026-09-15T00:00:00.000Z',
    })
    store.putContent(sample())
    expect(store.content('youtube', 'v1')).toBeUndefined()
    store.close()
  })
})
