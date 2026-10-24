/**
 * WP500（决策 1758）：红人详情的「体检 / 受众真实性 / 频道估值 / 更新规律 / 粉丝 30 天变化」与云端体检。
 *
 * 钉三件事：
 * 1. 数是插件面板那套算法算的（`creatorMetrics`，移植自 KOLAgents）——同一份资料，详情里与插件 / ego 回执是同一个数；
 * 2. 只出结构化的数，不出插件按浏览器语言拼的句子；
 * 3. 算不出来就不带那一格（没存过资料的账号只有粉丝趋势；什么都没有就没有 `checks`）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock, WorkspaceId } from '@agentsws/contracts'
import { type CreatorSnapshot, creatorMetrics } from '@agentsws/creator-capture'
import { afterEach, describe, expect, it } from 'vitest'
import { createKolStore, type KolProfileSnapshot } from '../src/kol.js'
import { creatorChecksOf, snapshotOf } from '../src/kol-checks.js'
import { createKolService } from '../src/kol-service.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-10-23T10:00:00.000Z'
const clock: Clock = { now: () => NOW }
const actor = {
  workspace_id: WS,
  person_id: 'pr_1',
  assignment_id: 'asg_1',
  role_id: 'kol.youtube',
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const PROFILE: KolProfileSnapshot = {
  country: 'Germany',
  avg_views: 30_000,
  video_count: 120,
  recent_items: [
    { title: 'a', views: 40_000, likes: 1_600, published_at: '2026-10-20T00:00:00.000Z' },
    { title: 'b', views: 30_000, likes: 1_200, published_at: '2026-10-13T00:00:00.000Z' },
    { title: 'c', views: 25_000, likes: 1_000, published_at: '2026-10-06T00:00:00.000Z' },
    { title: 'd', views: 35_000, likes: 1_400, published_at: '2026-09-29T00:00:00.000Z' },
    { title: 'e', views: 20_000, likes: 800, published_at: '2026-09-22T00:00:00.000Z' },
  ],
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wp500-'))
  dirs.push(dir)
  const kol = createKolStore({ workspace_id: WS, dbDir: dir })
  kol.saveCreator({ id: 'cre_1', display_name: 'Desk Fixture', merged_from: [] })
  kol.saveAccount({
    id: 'pa_1',
    creator_id: 'cre_1',
    channel: 'youtube',
    handle: '@deskfixture',
    url: 'https://www.youtube.com/@deskfixture',
    followers: 120_000,
    observed_at: NOW,
  })
  const obs = (id: string, at: string, followers: number, profile?: KolProfileSnapshot) =>
    kol.saveAccountObservation({
      id,
      account_id: 'pa_1',
      creator_id: 'cre_1',
      channel: 'youtube',
      handle: '@deskfixture',
      followers,
      observed_at: at,
      ...(profile === undefined ? {} : { source: 'manual_save' as const, profile }),
    })
  obs('ob_1', '2026-10-03T10:00:00.000Z', 115_000)
  obs('ob_2', NOW, 120_000, PROFILE)
  const port = createKolService({
    workspace_id: WS,
    store: kol,
    secrets: { available: true, get: () => undefined, put: () => ({}) as never } as never,
    clock,
    approvals: {} as never,
    ledger: { stage: undefined as never, list: async () => [] },
    effectiveConfig: () => ({ actions: [], automation: {} }) as never,
    appendEvent: () => {},
    random: () => 0.5,
    assignmentsOf: () => [],
    holdersOf: () => [],
    brandName: () => '测试品牌',
    personName: (id: string) => id,
  } as never).port
  return { kol, port }
}

describe('WP500：红人详情的估算（插件那套算法）', () => {
  it('存入过红人池的账号：体检、点赞率、估值、更新规律、粉丝 30 天变化都在，数与插件算的同一份', async () => {
    const { kol, port } = setup()
    const detail = await port.creator(actor as never, 'cre_1')
    const checks = detail?.checks?.pa_1
    expect(checks).toBeDefined()

    // 与插件面板 / ego 回执同一个入口算出来的数
    const account = kol.accounts({ creator_id: 'cre_1' })[0]
    const m = creatorMetrics(snapshotOf(account as never, PROFILE, 'youtube') as CreatorSnapshot)
    expect(checks?.health).toEqual({
      verdict: m.health.verdict,
      views_to_followers: m.health.viewsToSubsRatio,
      bought_audience_suspected: false,
    })
    expect(checks?.health?.verdict).toBe('excellent') // 30k / 120k = 25%
    expect(checks?.like_rate).toEqual({ median: 0.04, items: 5, level: 'good' })
    expect(checks?.valuation?.kind).toBe('estimated')
    if (checks?.valuation?.kind === 'estimated' && m.valuation.kind === 'estimated') {
      expect(checks.valuation.mid_cents).toBe(m.valuation.midCents)
      expect(checks.valuation.median_views).toBe(30_000)
      expect(checks.valuation.items_used).toBe(5)
    }
    expect(checks?.regularity?.status).toBe('regular')
    expect(checks?.follower_trend).toEqual({ days: 20, delta: 5_000, percent: 4.3 })
    // 只出数，不出插件按浏览器语言拼的句子
    expect(JSON.stringify(checks)).not.toMatch(/[\p{Script=Han}]/u)
  })

  it('疑似刷粉：体检标出来，估值不报价', () => {
    const account = {
      id: 'pa_x',
      creator_id: 'cre_x',
      channel: 'youtube' as const,
      handle: 'x',
      url: 'https://www.youtube.com/@x',
      followers: 2_000_000,
      observed_at: NOW,
    }
    const checks = creatorChecksOf(account, { ...PROFILE, avg_views: 10_000 }, [], NOW)
    expect(checks?.health?.bought_audience_suspected).toBe(true)
    expect(checks?.health?.verdict).toBe('suspicious')
    expect(checks?.valuation).toEqual({ kind: 'insufficient', reason: 'suspected_fake' })
  })

  it('没存过资料：只有粉丝趋势；一个快照都没有就整格不带', async () => {
    const account = {
      id: 'pa_y',
      creator_id: 'cre_y',
      channel: 'tiktok' as const,
      handle: 'y',
      url: 'https://www.tiktok.com/@y',
      followers: 9_000,
      observed_at: NOW,
    }
    expect(creatorChecksOf(account, undefined, [], NOW)).toBeUndefined()
    const trend = creatorChecksOf(
      account,
      undefined,
      [
        {
          id: 'o1',
          account_id: 'pa_y',
          creator_id: 'cre_y',
          channel: 'tiktok',
          handle: 'y',
          followers: 8_000,
          observed_at: '2026-10-13T10:00:00.000Z',
        },
        {
          id: 'o2',
          account_id: 'pa_y',
          creator_id: 'cre_y',
          channel: 'tiktok',
          handle: 'y',
          followers: 9_000,
          observed_at: NOW,
        },
      ],
      NOW,
    )
    expect(trend).toEqual({ follower_trend: { days: 10, delta: 1_000, percent: 12.5 } })
  })

  it('云端体检：自动评分做成了才带 audit；没做成（没关联云账号）不带', async () => {
    const { kol, port } = setup()
    expect((await port.creator(actor as never, 'cre_1'))?.audit).toBeUndefined()
    kol.saveAutoScore({
      id: 'cre_1',
      creator_id: 'cre_1',
      account_id: 'pa_1',
      score: 80,
      scored_at: NOW,
      audit: { status: 'not_linked', at: NOW },
    })
    expect((await port.creator(actor as never, 'cre_1'))?.audit).toBeUndefined()
    kol.saveAutoScore({
      id: 'cre_1',
      creator_id: 'cre_1',
      account_id: 'pa_1',
      score: 80,
      scored_at: NOW,
      audit: { status: 'done', health: 72, findings: ['近 30 天发布正常'], at: NOW },
    })
    expect((await port.creator(actor as never, 'cre_1'))?.audit).toEqual({
      health: 72,
      findings: ['近 30 天发布正常'],
      at: NOW,
    })
  })
})
