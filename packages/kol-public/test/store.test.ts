/**
 * 两份存储（内存 / sqlite）**行为必须一样**——所以同一组断言跑两遍。
 *
 * 这不是凑覆盖率：这个包里所有逻辑都写在服务层，存储只是一层搬运，
 * 而搬运最容易出的错（写进去的字段少一个、筛选条件对不上、JSON 列解不回来）
 * 恰恰不会被服务层的测试发现——服务层用的是内存那份。
 */
import type { Benchmark, PluginPairing } from '@agentsws/contracts'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  type CreatorRow,
  type KolStore,
  MemoryKolStore,
  type ObservationRow,
  SqliteKolStore,
} from '../src/index.js'

const AT = '2026-09-15T00:00:00.000Z'

const card = (overrides: Partial<CreatorRow> = {}): CreatorRow => ({
  channel: 'youtube',
  handle: 'somecreator',
  followers: 50_000,
  posts_30d: 8,
  engagement_rate: 0.04,
  language: 'en',
  region: 'US',
  categories: ['3c', 'gaming'],
  observed_at: AT,
  source: 'plugin',
  observations: 1,
  confidence: 0.7,
  has_contact: false,
  updated_at: AT,
  ...overrides,
})

const obs = (overrides: Partial<ObservationRow> = {}): ObservationRow => ({
  id: 'kob_1',
  channel: 'youtube',
  handle: 'somecreator',
  subject: 'ws:ws_1',
  source: 'plugin',
  followers: 50_000,
  posts_30d: 8,
  engagement_rate: 0.04,
  categories: ['3c'],
  followers_band: '10k-100k',
  observed_at: AT,
  at: AT,
  counted: true,
  ...overrides,
})

const pairing = (): PluginPairing => ({
  id: 'plp_1',
  workspace_id: 'ws_1',
  org_id: 'org_1',
  account_id: 'acc_1',
  label: 'Chrome',
  token_sha256: 'a'.repeat(64),
  issued_at: AT,
  expires_at: '2026-10-15T00:00:00.000Z',
  valid_observations: 0,
  granted_credits: 0,
})

const benchmark = (): Benchmark => ({
  channel: 'youtube',
  category: 'any',
  followers_band: '10k-100k',
  sample_size: 21,
  insufficient_samples: false,
  engagement_rate: { p25: 0.01, p50: 0.02, p75: 0.03 },
  followers: { p25: 20_000, p50: 40_000, p75: 60_000 },
  computed_at: AT,
})

const stores: [string, () => KolStore][] = [
  ['内存', () => new MemoryKolStore()],
  ['sqlite', () => new SqliteKolStore(new Database(':memory:'))],
]

for (const [name, make] of stores) {
  describe(`${name}档`, () => {
    it('卡：写进去读出来是同一张（JSON 列也回得来）', () => {
      const store = make()
      store.putCreator(card())
      expect(store.creator('youtube', 'somecreator')).toEqual(card())
      // 同一个 handle 在别的渠道是另一行（库按 channel 分区）
      expect(store.creator('tiktok', 'somecreator')).toBeUndefined()
      store.putCreator(card({ followers: 60_000 }))
      expect(store.creator('youtube', 'somecreator')?.followers).toBe(60_000)
      store.close?.()
    })

    it('浏览：按渠道 / 粉丝下限 / 类目 / 关键字筛，按粉丝倒序', () => {
      const store = make()
      store.putCreator(card({ handle: 'big', followers: 900_000, categories: ['3c'] }))
      store.putCreator(card({ handle: 'small', followers: 1_000, categories: ['beauty'] }))
      store.putCreator(
        card({ handle: 'other', channel: 'tiktok', followers: 500_000, categories: ['beauty'] }),
      )
      expect(store.listCreators({ limit: 10 }).map((c) => c.handle)).toEqual([
        'big',
        'other',
        'small',
      ])
      expect(store.listCreators({ channel: 'youtube', limit: 10 }).map((c) => c.handle)).toEqual([
        'big',
        'small',
      ])
      expect(
        store.listCreators({ min_followers: 100_000, limit: 10 }).map((c) => c.handle),
      ).toEqual(['big', 'other'])
      expect(store.listCreators({ category: '3c', limit: 10 }).map((c) => c.handle)).toEqual([
        'big',
      ])
      expect(store.listCreators({ q: 'sma', limit: 10 }).map((c) => c.handle)).toEqual(['small'])
      expect(store.listCreators({ limit: 1 })).toHaveLength(1)
      store.close?.()
    })

    it('观察：按人取、按贡献者取最近一次、按桶取', () => {
      const store = make()
      store.appendObservation(obs())
      store.appendObservation(obs({ id: 'kob_2', at: '2026-09-16T00:00:00.000Z' }))
      store.appendObservation(
        obs({ id: 'kob_3', handle: 'another', subject: 'plg:abc', categories: ['beauty'] }),
      )
      expect(store.observationsOf('youtube', 'somecreator')).toHaveLength(2)
      expect(store.lastObservationAt('ws:ws_1', 'youtube', 'somecreator')).toBe(
        '2026-09-16T00:00:00.000Z',
      )
      expect(store.lastObservationAt('plg:abc', 'youtube', 'somecreator')).toBeUndefined()
      expect(
        store.observationsInBucket({
          channel: 'youtube',
          followers_band: '10k-100k',
          category: 'any',
        }),
      ).toHaveLength(3)
      expect(
        store.observationsInBucket({
          channel: 'youtube',
          followers_band: '10k-100k',
          category: 'beauty',
        }),
      ).toHaveLength(1)
      store.close?.()
    })

    it('联系方式：按哈希去重，取最近一条', () => {
      const store = make()
      const row = {
        channel: 'youtube' as const,
        handle: 'somecreator',
        email_sha256: 'b'.repeat(64),
        email_cipher: 'iv.tag.ct',
        source: 'manual' as const,
        contributed_by: 'ws_1',
        at: AT,
      }
      store.putContact(row)
      expect(store.contactBySha('youtube', 'somecreator', 'b'.repeat(64))).toEqual(row)
      expect(store.contactBySha('youtube', 'somecreator', 'c'.repeat(64))).toBeUndefined()
      store.putContact({ ...row, email_sha256: 'c'.repeat(64), at: '2026-09-16T00:00:00.000Z' })
      expect(store.contactOf('youtube', 'somecreator')?.email_sha256).toBe('c'.repeat(64))
      store.close?.()
    })

    it('配对：撤销是一列不是删行；配额与基准缓存写回读出一致', () => {
      const store = make()
      store.putPairing(pairing())
      store.putPairing({ ...pairing(), revoked_at: AT, valid_observations: 7, granted_credits: 2 })
      const row = store.pairingBySha('a'.repeat(64))
      expect(row?.revoked_at).toBe(AT)
      expect(row?.valid_observations).toBe(7)

      expect(store.quota('plg:abc', '2026-09-15')).toEqual({
        subject: 'plg:abc',
        day: '2026-09-15',
        observations: 0,
        reward_credits: 0,
        units: 0,
      })
      store.putQuota({
        subject: 'plg:abc',
        day: '2026-09-15',
        observations: 12,
        reward_credits: 1,
        units: 100,
      })
      expect(store.quota('plg:abc', '2026-09-15').observations).toBe(12)

      store.putBenchmark(benchmark())
      expect(
        store.cachedBenchmark({ channel: 'youtube', category: 'any', followers_band: '10k-100k' }),
      ).toEqual(benchmark())
      store.close?.()
    })

    /** WP110：云侧那个进程内定时（每 10 分钟）调的就是这一条。 */
    it('基准缓存能按时间扫掉；比截止时刻新的那些留着', () => {
      const store = make()
      const bucket = { channel: 'youtube', category: 'any', followers_band: '10k-100k' } as const
      store.putBenchmark(benchmark())
      // 截止时刻比它还早 → 一条都不该动
      expect(store.sweepBenchmarks?.('2026-09-14T00:00:00.000Z')).toBe(0)
      expect(store.cachedBenchmark(bucket)).toBeDefined()
      expect(store.sweepBenchmarks?.(AT)).toBe(1)
      expect(store.cachedBenchmark(bucket)).toBeUndefined()
      store.close?.()
    })

    it('争议：只记不裁，按人取得回来', () => {
      const store = make()
      store.putDispute({
        id: 'kdp_1',
        channel: 'youtube',
        handle: 'somecreator',
        field: 'followers',
        claim: '粉丝数不对',
        reported_by: 'ws_1',
        org_id: 'org_1',
        status: 'open',
        at: AT,
      })
      expect(store.disputesOf('youtube', 'somecreator')).toHaveLength(1)
      expect(store.disputesOf('tiktok', 'somecreator')).toHaveLength(0)
      store.close?.()
    })
  })
}
