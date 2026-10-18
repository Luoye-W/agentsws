/**
 * WP420（自查 ads-amazon A1 / A2 / A3 / A12 / A13 / A17）：投放的卡**照实说**。
 *
 * - 投放职责的广告卡都归插件执行那一半：改出价 / 换素材、托管实例（没插件通道）、插件不会点的账户
 *   → 回「没做」，不再掉回内存桩显示已施行；
 * - 同一条广告系列已经排着暂停 → 不再重复排；排着改预算 → 新卡上写一句「前面还排着」；
 * - 插件没连 → 卡底一行「批了先排队」；
 * - 账本每行一句「Live 日预算 200 → 220」。
 */
import type { StagedChange } from '@agentsws/contracts'
import type { StageInput, StageOutcome } from '@agentsws/txn'
import { describe, expect, it } from 'vitest'
import { createAdsStore } from '../src/ads.js'
import type { AdsActionsService } from '../src/ads-actions/service.js'
import { createAdsService, QUEUE_NOTE } from '../src/ads-service.js'
import { createAdsLedger } from '../src/ads-wiring/ledger.js'
import {
  type AdsWiring,
  createAdsWiring,
  isAdsRoleChange,
  NOT_WIRED_ACCOUNT,
  NOT_WIRED_HOSTED,
  NOT_WIRED_KIND,
} from '../src/ads-wiring/service.js'

const NOW = '2026-10-15T09:00:00.000Z'

function seededStore() {
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
  store.saveAccount({
    id: 'aa_x',
    workspace_id: 'ws_1' as never,
    platform: 'x',
    external_id: 'x-1',
    name: 'X',
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
  store.saveCampaign({
    id: 'cmp_x',
    account_id: 'aa_x',
    platform: 'x',
    external_id: 'x-c1',
    name: 'On X',
    status: 'active',
    daily_budget: 50,
  })
  return store
}

/** 一个只会收活的假插件通道（进了队就算 ok）。 */
function fakeActions(): AdsActionsService {
  const jobs: { id: string; status: string }[] = []
  return {
    enqueue: async (job: { id: string }) => {
      jobs.push({ id: job.id, status: 'queued' })
      return { ok: true, job: { ...job, status: 'queued' } }
    },
    jobs: () => jobs,
    lastSeen: () => undefined,
    settings: () => ({ consent: {} }),
  } as unknown as AdsActionsService
}

function change(over: Partial<StagedChange>): StagedChange {
  return {
    id: 'chg_1',
    workspace_id: 'ws_1',
    role_id: 'ads.google',
    assignment_id: 'as_1',
    kind: 'budget_change',
    target: { type: 'campaign', id: 'cmp_1' },
    before: { value: 200 },
    after: { value: 220 },
    created_by: { kind: 'person', id: 'p_1' },
    approval: { item_id: 'ap_1', by: 'person' },
    ...over,
  } as unknown as StagedChange
}

function wiringOf(actions: AdsActionsService | undefined) {
  let n = 0
  return createAdsWiring({
    workspace_id: 'ws_1',
    nowMs: () => Date.parse(NOW),
    store: seededStore(),
    ledger: createAdsLedger({ nowMs: () => Date.parse(NOW) }),
    actions: () => actions,
    appendEvent: () => undefined,
    id: () => `j${++n}`,
  })
}

describe('批了之后：没有真执行器的一律回「没做」（A1 / A2 / A3）', () => {
  it('改出价 / 换素材 → failed「还没接通」', async () => {
    const w = wiringOf(fakeActions())
    for (const kind of ['bid_change', 'creative_swap'] as const) {
      const out = await w.apply(change({ kind }))
      expect(out?.status).toBe('failed')
      expect(out?.status === 'failed' ? out.error.message : '').toBe(NOT_WIRED_KIND)
    }
  })

  it('托管实例（没有插件通道）批改预算 → failed，不进内存桩', async () => {
    const out = await wiringOf(undefined).apply(change({}))
    expect(out?.status).toBe('failed')
    expect(out?.status === 'failed' ? out.error.message : '').toBe(NOT_WIRED_HOSTED)
  })

  it('插件不会点的账户（X）→ failed', async () => {
    const out = await wiringOf(fakeActions()).apply(
      change({ role_id: 'ads.x' as never, target: { type: 'campaign', id: 'cmp_x' } }),
    )
    expect(out?.status === 'failed' ? out.error.message : '').toBe(NOT_WIRED_ACCOUNT)
  })

  it('不是投放职责的同名卡不归这里（回 undefined，交给别的执行器）', async () => {
    expect(isAdsRoleChange({ kind: 'budget_change', role_id: 'dtc.ops' as never })).toBe(false)
    expect(await wiringOf(fakeActions()).apply(change({ role_id: 'dtc.ops' as never }))).toBe(
      undefined,
    )
  })

  it('改预算进了插件的队 → 账本一行人话「Live 日预算 200 → 220」', async () => {
    const w = wiringOf(fakeActions())
    const out = await w.apply(change({}))
    expect(out?.status).toBe('ok')
    const row = w.entries()[0]
    expect(row?.line).toBe('Live 日预算 200 → 220')
    expect(row?.state).toBe('queued')
  })
})

describe('出卡那一跳（A12 / A13 / U4）', () => {
  function svcWith(wiring: Partial<AdsWiring>) {
    const store = seededStore()
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
            change: { id: `chg_${staged.length}` } as never,
            approval: {
              id: 'ap_1',
              automation: { level_at_creation: input.level, auto_approved: false },
            } as never,
          }
        },
      },
      effectiveConfig: () => ({ actions: [], automation: {} }) as never,
      appendEvent: () => undefined,
      random: () => 0.5,
      wiring: {
        available: () => true,
        extensionReady: () => true,
        breakIn: () => ({ active: false }),
        setFollowUps: () => undefined,
        entries: () => [],
        entry: () => undefined,
        ...wiring,
      } as AdsWiring,
    })
    const actor = {
      workspace_id: 'ws_1' as never,
      person_id: 'p_1' as never,
      assignment_id: 'as_1' as never,
      role_id: 'ads.google' as never,
    }
    return { svc, staged, actor }
  }

  it('插件没连 → 卡上带「批了先排队」那一行（after.queue_note + notes）', async () => {
    const { svc, staged, actor } = svcWith({ extensionReady: () => false })
    const out = await svc.port.changeBudget(actor, 'cmp_1', { value: 210 })
    expect(out.staged).toBe(true)
    expect(((staged[0]?.after ?? {}) as { queue_note?: string }).queue_note).toBe(QUEUE_NOTE)
    expect(staged[0]?.notes).toContain(QUEUE_NOTE)
    expect(((staged[0]?.after ?? {}) as { currency?: string }).currency).toBe('USD')
  })

  const queuedPause = {
    entries: () => [
      {
        change_id: 'chg_old',
        account_id: 'aa_g',
        kind: 'pause_ad',
        state: 'queued',
        title: '暂停',
      },
    ],
    entry: () => ({ form: [{ action: 'pause', level: 'campaign', entity_id: '1001' }] }) as never,
  } as unknown as Partial<AdsWiring>

  it('同一条已经排着暂停 → 不再排第二件', async () => {
    const { svc, staged, actor } = svcWith(queuedPause)
    const out = await svc.port.pauseCampaign(actor, 'cmp_1', { reason: 'stop_loss' })
    expect(out.staged).toBe(false)
    expect(out.message).toContain('已经排着暂停')
    expect(staged).toHaveLength(0)
  })

  it('同一条排着改预算 → 新卡照出，卡上写「前面还排着」', async () => {
    const { svc, staged, actor } = svcWith({
      entries: () =>
        [
          {
            change_id: 'chg_old',
            account_id: 'aa_g',
            kind: 'budget_change',
            state: 'queued',
            title: '改预算',
          },
        ] as never,
      entry: () =>
        ({ form: [{ action: 'set_budget', entity_id: '1001', amount: '230' }] }) as never,
    })
    const out = await svc.port.changeBudget(actor, 'cmp_1', { value: 240 })
    expect(out.staged).toBe(true)
    expect(((staged[0]?.after ?? {}) as { queued_ahead?: string }).queued_ahead).toBe(
      '改日预算 → 230',
    )
    expect(staged[0]?.notes.join('')).toContain('前面还排着')
  })

  it('X 账户上的广告系列 → 不出卡，照实说', async () => {
    const { svc, staged } = svcWith({})
    const out = await svc.port.changeBudget(
      {
        workspace_id: 'ws_1' as never,
        person_id: 'p_1' as never,
        assignment_id: 'as_1' as never,
        role_id: 'ads.x' as never,
      },
      'cmp_x',
      { value: 40 },
    )
    expect(out.staged).toBe(false)
    expect(out.message).toContain('还没接通')
    expect(staged).toHaveLength(0)
  })
})
