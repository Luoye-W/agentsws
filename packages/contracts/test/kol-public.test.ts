/**
 * 48 §5.3 / WP61 公共红人库契约里**在类型这一层就钉死**的那几条：
 * 自足键不带任何一侧的 id、观察是一张白名单、邮箱与插件令牌只有哈希、
 * k 的那个 k 是 20、五条渠道就是 48 §5.1 那五条。
 */
import { describe, expect, it } from 'vitest'
import type {
  AuditReport,
  Benchmark,
  PluginPairing,
  PublicCreatorCard,
  PublicCreatorContact,
  PublicCreatorKey,
  PublicCreatorObservation,
} from '../src/index.js'
import {
  BENCHMARK_MIN_SAMPLES,
  CONTRIBUTION_CREDIT_TTL_DAYS,
  followersBandOf,
  KOL_AUDIT_CAPABILITY,
  KOL_CHANNEL_IDS,
  KOL_LOOKUP_CAPABILITY,
  KOL_PUBLIC_SCOPE,
  MAX_DAILY_REWARD_CREDITS,
  MAX_PLUGIN_OBSERVATIONS_PER_DAY,
  OBSERVATIONS_PER_CREDIT,
  PLUGIN_TOKEN_PREFIX,
  PLUGIN_TOKEN_TTL_MS,
  PUBLIC_OBSERVATION_FIELDS,
  SOCIAL_FETCH_CAPABILITY,
} from '../src/index.js'

describe('WP61 公共红人库契约', () => {
  it('五条渠道就是 48 §5.1 那五条', () => {
    expect(KOL_CHANNEL_IDS).toEqual(['youtube', 'facebook', 'instagram', 'tiktok', 'x'])
  })

  it('指一个红人用的是自足键，不是任何一侧的 id', () => {
    const key: PublicCreatorKey = { channel: 'youtube', handle: 'somecreator' }
    expect(Object.keys(key).sort()).toEqual(['channel', 'handle'])
  })

  it('观察的白名单 = 接口的键；正文类字段一个都不在里面', () => {
    const observation: PublicCreatorObservation = {
      channel: 'instagram',
      handle: 'somecreator',
      followers: 12_000,
      posts_30d: 9,
      engagement_rate: 0.031,
      observed_at: '2026-09-15T00:00:00.000Z',
    }
    for (const key of Object.keys(observation)) {
      expect(PUBLIC_OBSERVATION_FIELDS as readonly string[]).toContain(key)
    }
    for (const forbidden of ['caption', 'comments', 'transcript', 'dm', 'email', 'body']) {
      expect(PUBLIC_OBSERVATION_FIELDS as readonly string[]).not.toContain(forbidden)
    }
  })

  it('卡上没有邮箱，只有"有没有"；联系方式行上没有明文', () => {
    const card: PublicCreatorCard = {
      channel: 'youtube',
      handle: 'somecreator',
      followers: 200_000,
      posts_30d: 4,
      engagement_rate: 0.02,
      categories: ['3c'],
      observed_at: '2026-09-15T00:00:00.000Z',
      source: 'plugin',
      observations: 7,
      confidence: 0.7,
      has_contact: true,
      updated_at: '2026-09-15T00:00:00.000Z',
    }
    expect(Object.keys(card)).not.toContain('email')
    const contact: PublicCreatorContact = {
      channel: 'youtube',
      handle: 'somecreator',
      email_sha256: 'a'.repeat(64),
      email_cipher: 'iv.tag.ct',
      source: 'manual',
      contributed_by: 'ws_1',
      at: '2026-09-15T00:00:00.000Z',
    }
    expect(Object.keys(contact)).not.toContain('email')
  })

  it('插件配对上只有哈希，撤销是一列不是删行；令牌短期', () => {
    const pairing: PluginPairing = {
      id: 'plp_1',
      workspace_id: 'ws_1',
      org_id: 'org_1',
      account_id: 'acc_1',
      label: 'Chrome 采集插件',
      token_sha256: 'b'.repeat(64),
      issued_at: '2026-09-15T00:00:00.000Z',
      expires_at: '2026-10-15T00:00:00.000Z',
      revoked_at: '2026-09-20T00:00:00.000Z',
      valid_observations: 0,
      granted_credits: 0,
    }
    expect(Object.keys(pairing)).not.toContain('token')
    expect(PLUGIN_TOKEN_PREFIX).toBe('plg_')
    expect(PLUGIN_TOKEN_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('样本不够的报告与基准都不给数，只给一句人话', () => {
    const report: AuditReport = {
      channel: 'tiktok',
      handle: 'somecreator',
      depth: 'basic',
      sample_size: 1,
      insufficient_samples: true,
      active_30d: false,
      risk_flags: ['single_source'],
      note: '样本不够',
      generated_at: '2026-09-15T00:00:00.000Z',
    }
    expect(report.follower_authenticity).toBeUndefined()
    const benchmark: Benchmark = {
      channel: 'tiktok',
      category: 'any',
      followers_band: '10k-100k',
      sample_size: 4,
      insufficient_samples: true,
      computed_at: '2026-09-15T00:00:00.000Z',
    }
    expect(benchmark.engagement_rate).toBeUndefined()
    expect(BENCHMARK_MIN_SAMPLES).toBe(20)
  })

  it('粉丝量级分桶的边界', () => {
    expect(followersBandOf(0)).toBe('0-10k')
    expect(followersBandOf(9_999)).toBe('0-10k')
    expect(followersBandOf(10_000)).toBe('10k-100k')
    expect(followersBandOf(100_000)).toBe('100k-1m')
    expect(followersBandOf(1_000_000)).toBe('1m+')
  })

  it('风控参数与价目表里那三条能力名对得上', () => {
    expect(MAX_PLUGIN_OBSERVATIONS_PER_DAY).toBe(500)
    expect(OBSERVATIONS_PER_CREDIT).toBe(100)
    expect(MAX_DAILY_REWARD_CREDITS).toBe(5)
    expect(CONTRIBUTION_CREDIT_TTL_DAYS).toBe(90)
    expect(KOL_LOOKUP_CAPABILITY).toBe('data.kol.lookup')
    expect(KOL_AUDIT_CAPABILITY).toBe('data.kol.audit')
    expect(SOCIAL_FETCH_CAPABILITY).toBe('social.fetch')
    expect(KOL_PUBLIC_SCOPE).toBe('data')
  })
})
