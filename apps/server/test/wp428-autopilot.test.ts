/**
 * WP428（决策 1244 改）：够条件 → 建议开全自动（通用积木的接线）+ 红人上真开。
 *
 * - 最近 10 张同类卡（建合作 / 议价 / 寄样）都原样批了 → 出一张建议卡，说清凭什么；
 * - 人点「开全自动」才开；点「先不开」要重新攒满一轮才再提；随时能关；
 * - 开着时这类卡施行失败（出事）→ 自动关；
 * - 红人：开了才能把合作推进到「谈成 / 已寄样」。
 */
import type { ApprovalItem, CreateApprovalInput } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createAutopilot, isAutopilotCard, KOL_AUTOPILOT_SCOPE } from '../src/autopilot.js'
import { createKolToolExecutor } from '../src/kol-tools.js'

const WS = 'ws_1' as never
const ASG = 'asg_kol'

function rig() {
  let ms = Date.parse('2026-10-19T01:00:00.000Z')
  const clock = { now: () => new Date(ms).toISOString(), sleep: async () => undefined }
  const tick = () => {
    ms += 60_000
    return new Date(ms).toISOString()
  }
  const cards: ApprovalItem[] = []
  const created: ApprovalItem[] = []
  const events: { type: string; payload: unknown }[] = []
  const autopilot = createAutopilot({
    clock: clock as never,
    listChangeCards: () => cards,
    createCard: async (input: CreateApprovalInput<unknown>) => {
      const item = {
        ...input,
        id: `ap_auto_${created.length + 1}`,
        state: 'pending',
        created_at: clock.now(),
        updated_at: clock.now(),
      } as unknown as ApprovalItem
      created.push(item)
      return item
    },
    appendEvent: (e) => {
      events.push({ type: String(e.type), payload: e.payload })
    },
  })
  /** 人定了一张同类卡（原样批 / 改了批 / 驳回）。 */
  const decide = async (
    outcome: 'approve' | 'approve_edited' | 'reject',
    over: Partial<ApprovalItem> = {},
  ): Promise<ApprovalItem> => {
    const at = tick()
    const item = {
      id: `ap_${cards.length + 1}`,
      workspace_id: WS,
      kind: 'staged_change',
      role_id: 'kol.youtube',
      payload: { kind: 'kol_collaboration' },
      proposer: { kind: 'person', id: 'p_me', assignment_id: ASG },
      routing: { recipients: [{ person: 'p_me', via: 'owner' }] },
      state:
        outcome === 'approve' ? 'approved' : outcome === 'reject' ? 'rejected' : 'approved_edited',
      decision: { action: outcome, by: 'p_me', at, via: 'workstation' },
      updated_at: at,
      ...over,
    } as unknown as ApprovalItem
    cards.push(item)
    await autopilot.afterDecided(item)
    return item
  }
  const answer = async (card: ApprovalItem, option: 'on' | 'not_now'): Promise<void> => {
    const at = tick()
    await autopilot.afterDecided({
      ...card,
      state: 'approved',
      decision: {
        action: 'approve',
        by: 'p_me',
        at,
        via: 'workstation',
        selected_option_id: option,
      },
      updated_at: at,
    } as ApprovalItem)
  }
  return { autopilot, cards, created, events, decide, answer, clock }
}

describe('WP428 全自动：够条件 → 建议开', () => {
  it('连着原样批满 10 张 → 一张建议卡（说清凭什么）；点「开全自动」才开；随时能关', async () => {
    const r = rig()
    for (let i = 0; i < 9; i++) await r.decide('approve')
    expect(r.created).toHaveLength(0)
    expect(r.autopilot.status(WS, ASG, 'kol.youtube')[0]?.why).toContain('还差 1 张')
    await r.decide('approve')
    expect(r.created).toHaveLength(1)
    const card = r.created[0] as ApprovalItem
    expect(isAutopilotCard(card)).toBe(true)
    expect(card.title).toContain('这类可以交给 AI 全自动了')
    expect(card.summary).toContain('凭什么')
    expect(card.summary).toContain('额度')
    expect(r.autopilot.isOn(WS, ASG, KOL_AUTOPILOT_SCOPE)).toBe(false)
    // 再批一张不重复出建议卡
    await r.decide('approve')
    expect(r.created).toHaveLength(1)
    await r.answer(card, 'on')
    expect(r.autopilot.isOn(WS, ASG, KOL_AUTOPILOT_SCOPE)).toBe(true)
    expect(r.events.some((e) => e.type === 'autopilot.turned_on')).toBe(true)
    // 关
    const off = r.autopilot.set({
      workspace_id: WS,
      assignment_id: ASG,
      role_id: 'kol.youtube',
      scope_id: KOL_AUTOPILOT_SCOPE,
      on: false,
      by: 'p_me' as never,
    })
    expect(off.on).toBe(false)
    expect(r.autopilot.isOn(WS, ASG, KOL_AUTOPILOT_SCOPE)).toBe(false)
  })

  it('改过 / 驳回过断掉连续；点「先不开」要重新攒满一轮才再提', async () => {
    const r = rig()
    for (let i = 0; i < 9; i++) await r.decide('approve')
    await r.decide('approve_edited')
    expect(r.created).toHaveLength(0)
    for (let i = 0; i < 10; i++) await r.decide('approve')
    expect(r.created).toHaveLength(1)
    await r.answer(r.created[0] as ApprovalItem, 'not_now')
    expect(r.autopilot.isOn(WS, ASG, KOL_AUTOPILOT_SCOPE)).toBe(false)
    for (let i = 0; i < 9; i++) await r.decide('approve')
    expect(r.created).toHaveLength(1)
    await r.decide('approve')
    expect(r.created).toHaveLength(2)
  })

  it('不够条件时开不了；开着时这类卡施行失败（出事）→ 自动关', async () => {
    const r = rig()
    expect(() =>
      r.autopilot.set({
        workspace_id: WS,
        assignment_id: ASG,
        role_id: 'kol.youtube',
        scope_id: KOL_AUTOPILOT_SCOPE,
        on: true,
        by: 'p_me' as never,
      }),
    ).toThrow(/还不够条件/)
    for (let i = 0; i < 10; i++) await r.decide('approve')
    await r.answer(r.created[0] as ApprovalItem, 'on')
    expect(r.autopilot.isOn(WS, ASG, KOL_AUTOPILOT_SCOPE)).toBe(true)
    await r.decide('approve', { state: 'apply_failed' } as Partial<ApprovalItem>)
    expect(r.autopilot.isOn(WS, ASG, KOL_AUTOPILOT_SCOPE)).toBe(false)
    expect(
      r.events.some(
        (e) =>
          e.type === 'autopilot.turned_off' &&
          (e.payload as { reason?: string }).reason === 'incident',
      ),
    ).toBe(true)
  })

  it('别的职责没有这一类；红人以外的卡不算样本', async () => {
    const r = rig()
    expect(r.autopilot.status(WS, 'asg_x', 'dtc.support')).toEqual([])
    for (let i = 0; i < 12; i++)
      await r.decide('approve', { payload: { kind: 'price_change' } } as Partial<ApprovalItem>)
    expect(r.created).toHaveLength(0)
  })
})

describe('WP428 红人：开了全自动才能推进到「谈成 / 已寄样」', () => {
  const request = {
    actor: { person_id: 'p_1', assignment_id: 'asg_1', role_id: 'kol.youtube' },
  } as never
  const port = {
    advanceCollaboration: async (_a: unknown, id: string, i: { stage: string }) => ({
      id,
      stage: i.stage,
    }),
  }
  it('没开 → blocked；开了 → 推进，回执照实说花钱的另走卡', async () => {
    let on = false
    const run = createKolToolExecutor({
      workspace_id: 'ws_1' as never,
      port: () => port as never,
      now: () => '2026-10-19T01:00:00.000Z',
      autopilot: () => on,
    })
    const blocked = await run({
      name: 'advance_collaboration',
      input: { collaboration_id: 'cb_1', stage: 'agreed' },
      request,
    })
    expect(blocked.status).toBe('blocked')
    on = true
    for (const stage of ['agreed', 'sample_sent']) {
      const ok = await run({
        name: 'advance_collaboration',
        input: { collaboration_id: 'cb_1', stage },
        request,
      })
      expect(ok.status).toBe('ok')
      expect((ok.data as { autopilot?: boolean; note?: string }).autopilot).toBe(true)
      expect((ok.data as { note?: string }).note).toContain('额度')
    }
  })
})
