/**
 * WP420（自查 ads-amazon A4 / A9）：止损**数据到了就判**、判据按昨天整天；白天加导；日报定时有人担就种。
 *
 * 样例行是手写的（假名字、假编号），没碰任何真广告后台。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdsActor, AdsPort, AdsStagedView } from '@agentsws/api'
import type { AdCampaign } from '@agentsws/contracts'
import type { StageInput, StageOutcome } from '@agentsws/txn'
import { describe, expect, it } from 'vitest'
import { createAdsStore } from '../src/ads.js'
import { memoryEvidenceStore } from '../src/ads-actions/evidence-store.js'
import { createAdsActionsService } from '../src/ads-actions/service.js'
import { createAdsDataService } from '../src/ads-data/service.js'
import {
  autoStopLoss,
  campaignDayTotals,
  dayBefore,
  judgeCampaign,
  yesterdayBasis,
} from '../src/ads-data/stop-loss.js'
import { type AdsDataRow, createAdsDataStore } from '../src/ads-data/store.js'
import { createAdsService } from '../src/ads-service.js'

const NOW = '2026-10-15T02:00:00.000Z'

const row = (over: Partial<AdsDataRow>): AdsDataRow =>
  ({
    platform: 'google',
    account: '1234567890',
    day: '2026-10-14',
    key: 'k',
    import_id: 'imp_1',
    level: 'campaign',
    status: 'enabled',
    campaign_id: '111',
    campaign: 'Spring Sale',
    metrics: { cost: 400, roas: 0.6 },
    ...over,
  }) as AdsDataRow

const campaign = (over: Partial<AdCampaign> = {}): AdCampaign => ({
  id: 'google:1234567890:111',
  account_id: 'google:1234567890',
  platform: 'google',
  external_id: '111',
  name: 'Spring Sale',
  status: 'active',
  daily_budget: 1000,
  // 今天早上才花了一点（以前按它判，永远不会止损）
  metrics: { spend: 40, roas: 0.5, observed_at: NOW },
  ...over,
})

describe('判据按昨天整天（A4 ①）', () => {
  it('前一天', () => {
    expect(dayBefore('2026-10-01')).toBe('2026-09-30')
  })

  it('按广告系列加起来（Meta 一行一条广告也能合成广告系列）', () => {
    const totals = campaignDayTotals(
      [
        row({
          platform: 'meta',
          level: 'ad',
          ad: 'a1',
          ad_id: '1',
          metrics: { cost: 100, conversion_value: 30 },
        }),
        row({
          platform: 'meta',
          level: 'ad',
          ad: 'a2',
          ad_id: '2',
          metrics: { cost: 300, conversion_value: 30 },
        }),
        row({ day: '2026-10-13', metrics: { cost: 999 } }),
      ],
      '2026-10-14',
    )
    expect(totals.get('meta:1234567890:111')).toEqual({ spend: 400, roas: 0.15 })
  })

  it('昨天整天越线、今天才花一点 → 照样判止损（按昨天）', () => {
    const basis = yesterdayBasis([row({})], '2026-10-15', 'google:1234567890:111')
    expect(basis).toMatchObject({ day: '2026-10-14', spend: 400, roas: 0.6, label: '昨天整天' })
    expect(judgeCampaign(campaign(), undefined, {}).trigger).toBe(false)
    expect(judgeCampaign(campaign(), basis, {})).toEqual({ trigger: true, by: 'yesterday' })
  })

  it('昨天 ROAS 还好 → 不止损', () => {
    const basis = yesterdayBasis(
      [row({ metrics: { cost: 400, roas: 3 } })],
      '2026-10-15',
      'google:1234567890:111',
    )
    expect(judgeCampaign(campaign(), basis, {}).trigger).toBe(false)
  })
})

describe('止损卡按昨天那份数出（guardrail 拿同一份数再核）', () => {
  it('卡上写「昨天整天花了」，after 里是昨天的花费与 ROAS', async () => {
    const store = createAdsStore({ workspace_id: 'ws_1' as never })
    store.saveAccount({
      id: 'google:1234567890',
      workspace_id: 'ws_1' as never,
      platform: 'google',
      external_id: '1234567890',
      name: 'G',
      currency: 'USD',
      status: 'active',
      observed_at: NOW,
    })
    store.saveCampaign(campaign())
    const staged: StageInput[] = []
    const svc = createAdsService({
      workspace_id: 'ws_1' as never,
      clock: { now: () => NOW },
      store,
      ledger: {
        stage: async (input): Promise<StageOutcome> => {
          staged.push(input)
          return {
            ok: true,
            change: { id: 'chg_1' } as never,
            approval: {
              id: 'ap_1',
              automation: { level_at_creation: input.level, auto_approved: true },
            } as never,
          }
        },
      },
      effectiveConfig: () => ({ actions: [], automation: {} }) as never,
      appendEvent: () => undefined,
      random: () => 0.5,
      stopLossBasis: (c) => yesterdayBasis([row({})], '2026-10-15', c.id),
    })
    await svc.port.pauseCampaign(
      {
        workspace_id: 'ws_1' as never,
        person_id: 'p_1' as never,
        assignment_id: 'as_1' as never,
        role_id: 'ads.google' as never,
      },
      'google:1234567890:111',
      { reason: 'stop_loss' },
    )
    const after = (staged[0]?.after ?? {}) as Record<string, unknown>
    expect(after.spend).toBe(400)
    expect(after.roas).toBe(0.6)
    expect(after.stop_loss_basis).toBe('2026-10-14')
    expect(String(after.stop_loss_reason)).toContain('昨天整天花了 400')
    expect(String(after.stop_loss_reason)).toContain('两条判据都成立')
  })
})

describe('数一入库就判（A4 ②）', () => {
  const actor = {
    workspace_id: 'ws_1',
    person_id: 'p_1',
    assignment_id: 'as_1',
    role_id: 'ads.google',
  } as unknown as AdsActor

  it('判据成立的出止损卡；同一条一天只提一次；停着的不提', async () => {
    const ads = createAdsStore({ workspace_id: 'ws_1' as never })
    ads.saveCampaign(campaign())
    ads.saveCampaign(
      campaign({ id: 'google:1234567890:222', external_id: '222', status: 'paused' }),
    )
    const calls: string[] = []
    const port = {
      pauseCampaign: async (_a: AdsActor, id: string, input: { reason: string; note?: string }) => {
        calls.push(`${id}:${input.reason}`)
        return { staged: true } as AdsStagedView
      },
    } as unknown as AdsPort
    const done = new Set<string>()
    const run = () =>
      autoStopLoss({
        platform: 'google',
        ads,
        rows: [row({}), row({ campaign_id: '222' })],
        today: '2026-10-15',
        caps: {},
        port,
        actor,
        done: (id) => done.has(id),
        markDone: (id) => done.add(id),
      })
    expect(await run()).toHaveLength(1)
    expect(calls).toEqual(['google:1234567890:111:stop_loss'])
    expect(await run()).toHaveLength(0)
  })

  it('没人担这家 / 没装广告库那一面 → 不判', async () => {
    const ads = createAdsStore({ workspace_id: 'ws_1' as never })
    ads.saveCampaign(campaign())
    const out = await autoStopLoss({
      platform: 'google',
      ads,
      rows: [row({})],
      today: '2026-10-15',
      caps: {},
      port: undefined,
      actor,
      done: () => false,
      markDone: () => undefined,
    })
    expect(out).toEqual([])
  })

  it('看数据入库之后调 afterIngest（插件 / 邮箱都算）；有人担投放就种日报定时（A9）', async () => {
    const ads = createAdsStore({ workspace_id: 'ws_1' as never })
    const ingested: string[] = []
    const seeds: number[] = []
    const svc = createAdsDataService({
      workspace_id: 'ws_1',
      store: createAdsDataStore({}),
      ads,
      now: () => NOW,
      newId: (p) => `${p}_1`,
      tzOffsetMinutes: () => 480,
      wanted: () => ['google'],
      afterIngest: (p) => {
        ingested.push(p)
      },
      seedDailyReport: async () => {
        seeds.push(1)
        return { matter_id: 'mt_1' }
      },
    })
    // 没设账户、没有数：日报定时照种（数据没到时日报照常出、写清哪家没到）
    await svc.tick()
    await svc.tick()
    expect(seeds).toEqual([1])
    const bytes = new Uint8Array(
      readFileSync(join(import.meta.dirname, 'fixtures', 'wp315', 'google-campaign.csv')),
    )
    const out = svc.ingest({
      bytes,
      name: 'google-campaign.csv',
      platform: 'google',
      source: 'manual',
    })
    expect(out.ok).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(ingested).toEqual(['google'])
  })
})

describe('白天加导（A4 ③）', () => {
  it('今天导过了：3 小时内不再导，隔 3 小时再导一次；晚上 10 点以后不导', async () => {
    let iso = '2026-10-15T01:30:00.000Z' // 东八区 9:30
    const acts = createAdsActionsService({
      workspace_id: 'ws_1',
      nowMs: () => Date.parse(iso),
      evidence: memoryEvidenceStore({ nowMs: () => Date.parse(iso) }),
      onEvent: () => undefined,
      wait: async (_ms, woke) => woke,
    })
    acts.consent('google_ads', (await import('@agentsws/browser-action')).ADS_CONSENT_TEXT_VERSION)
    await acts.next(['google_ads'], 0)
    const store = createAdsDataStore({})
    const svc = createAdsDataService({
      workspace_id: 'ws_1',
      store,
      ads: createAdsStore({ workspace_id: 'ws_1' as never }),
      now: () => iso,
      newId: (p) => `${p}_${Math.random().toString(36).slice(2, 8)}`,
      tzOffsetMinutes: () => 480,
      wanted: () => ['google'],
      actions: () => acts,
    })
    svc.setAccounts({ google: { id: '1234567890' } })
    store.setState('setup', { google: { status: 'done', at: iso } })
    store.setState('exports', {
      google: { last_ok_at: iso, last_ok_day: '2026-10-15', last_try_at: iso },
    })
    iso = '2026-10-15T03:30:00.000Z' // 11:30，才过 2 小时
    expect((await svc.tick()).queued).toEqual([])
    iso = '2026-10-15T04:40:00.000Z' // 12:40，过了 3 小时
    expect((await svc.tick()).queued).toHaveLength(1)
    store.setState('exports', {
      google: { last_ok_at: '2026-10-15T10:00:00.000Z', last_ok_day: '2026-10-15' },
    })
    iso = '2026-10-15T14:30:00.000Z' // 22:30
    for (const j of acts.jobs()) acts.stop(j.id)
    expect((await svc.tick()).queued).toEqual([])
  })
})
