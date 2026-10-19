/**
 * WP316（决策 554）：磨合期——插件在这个账户上做成第一件写操作起 14 天内（之前一直算），
 * 插件执行的 L2 一律升 L1，卡上写一句为什么；托管实例（没有插件通道）不升。
 * 另钉：插件没连这家后台 → 卡照出，回执带 `needs_connection: 'extension'`（WP324 连接卡）。
 *
 * 只测 ads-service 那一跳：账本与生效配置都是替身（服务进程里 `stage_budget_change` 的风险级是 medium，
 * 31 §3.4 已经把它钉在 L1，这条规矩在真进程里要等哪天放开了才看得见）。
 */
import type { StageInput, StageOutcome } from '@agentsws/txn'
import { describe, expect, it } from 'vitest'
import { createAdsStore } from '../src/ads.js'
import { createAdsService } from '../src/ads-service.js'
import type { AdsWiring } from '../src/ads-wiring/service.js'

const NOW = '2026-10-15T09:00:00.000Z'

function make(wiring: Partial<AdsWiring> | undefined) {
  const store = createAdsStore({ workspace_id: 'ws_1' as never })
  store.saveAccount({
    id: 'aa_g',
    workspace_id: 'ws_1' as never,
    platform: 'google',
    external_id: '123-456-7890',
    name: 'G',
    currency: 'USD',
    status: 'active',
    observed_at: NOW,
  })
  store.saveCampaign({
    id: 'cmp_1',
    account_id: 'aa_g',
    platform: 'google',
    external_id: '1001',
    name: 'Live',
    status: 'active',
    daily_budget: 200,
    metrics: { spend: 10, observed_at: NOW },
  })
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
            automation: { level_at_creation: input.level, auto_approved: false },
          } as never,
        }
      },
    },
    effectiveConfig: () =>
      ({
        actions: [{ id: 'stage_budget_change', mandate: { caps: {} } }],
        automation: { stage_budget_change: { level: 'L2' } },
      }) as never,
    appendEvent: () => undefined,
    random: () => 0.5,
    ...(wiring === undefined
      ? {}
      : {
          wiring: {
            available: () => true,
            extensionReady: () => true,
            breakIn: () => ({ active: false }),
            setFollowUps: () => undefined,
            entries: () => [],
            entry: () => undefined,
            ...wiring,
          } as AdsWiring,
        }),
  })
  const actor = {
    workspace_id: 'ws_1' as never,
    person_id: 'p_1' as never,
    assignment_id: 'as_1' as never,
    role_id: 'ads.google' as never,
  }
  return { svc, staged, actor }
}

describe('磨合期（554）', () => {
  it('还在磨合 → L2 升 L1，卡上写一句', async () => {
    const { svc, staged, actor } = make({
      breakIn: () => ({ active: true, until: '2026-10-29T09:00:00.000Z' }),
    })
    const out = await svc.port.changeBudget(actor, 'cmp_1', { value: 210 })
    expect(out.level).toBe('L1')
    expect(staged[0]?.level).toBe('L1')
    expect(staged[0]?.notes.join('')).toContain('磨合期')
    expect(staged[0]?.notes.join('')).toContain('2026-10-29')
  })

  it('过了磨合期 → 照岗位配置的 L2', async () => {
    const { svc, staged, actor } = make({})
    expect((await svc.port.changeBudget(actor, 'cmp_1', { value: 210 })).level).toBe('L2')
    expect(staged[0]?.notes.join('')).not.toContain('磨合期')
  })

  it('托管实例（没有插件通道）不升——而且不出卡，照实说去桌面版（WP420 自查 A3）', async () => {
    const { svc, staged, actor } = make({
      available: () => false,
      breakIn: () => ({ active: true }),
    })
    const hosted = await svc.port.changeBudget(actor, 'cmp_1', { value: 210 })
    expect(hosted.level).toBe('L2')
    expect(hosted.staged).toBe(false)
    expect(hosted.message).toContain('桌面版')
    expect(staged).toHaveLength(0)
    const plain = make(undefined)
    expect((await plain.svc.port.changeBudget(plain.actor, 'cmp_1', { value: 210 })).level).toBe(
      'L2',
    )
  })
})

describe('插件没连（WP324 连接卡）', () => {
  it('卡照出，回执带 needs_connection 与一句话', async () => {
    const { svc, actor } = make({ extensionReady: () => false })
    const out = await svc.port.changeBudget(actor, 'cmp_1', { value: 190 })
    expect(out.staged).toBe(true)
    expect(out.needs_connection).toBe('extension')
    expect(out.message).toContain('插件')
  })
})
