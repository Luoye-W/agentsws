import { describe, expect, it } from 'vitest'
import type { DeckCard, ProjectContext } from '../src/index.js'
import {
  actionsFor,
  estimatedMinutes,
  evidenceChipsOf,
  highlightsOf,
  labelsFor,
  minutesFor,
  optionsOf,
  priorityBandOf,
  projectCard,
  riskClassFor,
  sortCards,
} from '../src/index.js'
import { item, NOW, policyItem, refundItem } from './fixtures.js'

const ctx: ProjectContext = { now: NOW, position_id: 'asg_1' }

describe('projectCard（36 §2 审批项 → 卡片）', () => {
  it('回复草稿卡：动词是「发送 / 不发 / 指导」，不是「批准」', () => {
    const card = projectCard(item(), ctx)
    expect(card.kind).toBe('outbound_draft')
    expect(card.available_actions).toEqual(['approve', 'reject', 'instruct', 'snooze', 'open'])
    expect(card.action_labels?.approve).toBe('发送')
    expect(card.action_labels?.reject).toBe('不发')
    expect(card.action_labels?.instruct).toBe('指导')
    expect(card.channel).toBe('email')
    expect(card.version).toBe(1)
    expect(card.position_id).toBe('asg_1')
  })

  it('快捷行取前三个，永远 ≤ 3（36 §2.1 FR-015）', () => {
    for (const kind of ['outbound_draft', 'staged_change', 'policy_change', 'claim'] as const) {
      const actions = actionsFor(kind, 'pending').filter((a) => a !== 'open')
      expect(actions.slice(0, 3).length).toBeLessThanOrEqual(3)
    }
  })

  it('客户标签走 label 回调，前端不猜', () => {
    const card = projectCard(item(), {
      ...ctx,
      label: (ref) => (ref.id === 'cus_anna' ? 'Anna Meyer' : undefined),
    })
    expect(card.customer_label).toBe('Anna Meyer')
  })

  it('37 §1 第 5 行：没有展示名就没有客户标签，绝不退化成裸 id', () => {
    expect(projectCard(item(), ctx).customer_label).toBeUndefined()
  })

  it('subject 是客户、payload 没有 to 时也能出客户标签', () => {
    const card = projectCard(
      item({ payload: {}, subject: { object: { type: 'customer', id: 'cus_bob' } } }),
      { ...ctx, label: (ref) => (ref.id === 'cus_bob' ? 'Bob' : undefined) },
    )
    expect(card.customer_label).toBe('Bob')
  })

  it('既没有 to 也不是客户 subject → 没有客户标签、没有 channel', () => {
    const card = projectCard(item({ payload: { body: 'x' } }), ctx)
    expect(card.customer_label).toBeUndefined()
    expect(card.channel).toBeUndefined()
  })

  it('非对象 payload 也不炸', () => {
    const card = projectCard(item({ payload: 'plain string' }), ctx)
    expect(card.customer_label).toBeUndefined()
    expect(card.highlights.some((h) => h.type === 'amount')).toBe(false)
  })

  it('已决定的卡只剩「打开」', () => {
    const card = projectCard(item({ state: 'applied' }), ctx)
    expect(card.available_actions).toEqual(['open'])
  })

  it('deferred 卡带 snoozed_until 与计数', () => {
    const card = projectCard(
      item({
        state: 'deferred',
        decision: {
          action: 'defer',
          by: 'p_wang',
          at: NOW,
          via: 'workstation',
          defer_until: '2026-09-07T05:00:00.000Z',
        },
      }),
      ctx,
    )
    expect(card.snoozed_until).toBe('2026-09-07T05:00:00.000Z')
    expect(card.snooze_count).toBe(1)
  })

  it('snooze 计数可以由宿主接管', () => {
    const card = projectCard(item(), { ...ctx, snoozeCount: () => 3 })
    expect(card.snooze_count).toBe(3)
  })

  it('deferred 但没有 defer_until 时不编造 snoozed_until', () => {
    const card = projectCard(item({ state: 'deferred' }), ctx)
    expect(card.snoozed_until).toBeUndefined()
    expect(card.snooze_count).toBe(1)
  })

  it('risk_class 可由宿主给（真源在账本上）', () => {
    expect(projectCard(item(), { ...ctx, riskClass: () => 'high' }).risk_class).toBe('high')
    expect(projectCard(item(), { ...ctx, riskClass: () => undefined }).risk_class).toBe('medium')
  })
})

describe('highlights（只从结构化字段挖，不从模型的话里挖数字）', () => {
  it('退款卡带金额、订单号、期限', () => {
    const card = projectCard(refundItem({ expires_at: '2026-09-14T00:00:00.000Z' }), ctx)
    const types = card.highlights.map((h) => h.type)
    expect(types).toContain('amount')
    expect(types).toContain('order_ref')
    expect(types).toContain('deadline')
    expect(card.highlights.find((h) => h.type === 'amount')?.text).toBe('42 USD')
  })

  it('after.refund_amount 没有币种时回落到 USD', () => {
    const hs = highlightsOf(
      refundItem({ payload: { kind: 'refund', after: { refund_amount: 7 } } }),
      ctx,
    )
    expect(hs.find((h) => h.type === 'amount')?.text).toBe('7 USD')
  })

  it('after.currency 会被读到', () => {
    const hs = highlightsOf(
      refundItem({ payload: { kind: 'refund', after: { refunded: 9, currency: 'EUR' } } }),
      ctx,
    )
    expect(hs.find((h) => h.type === 'amount')?.text).toBe('9 EUR')
  })

  it('money 缺币种时不算金额', () => {
    const hs = highlightsOf(refundItem({ payload: { money: { amount: 1 } } }), ctx)
    expect(hs.some((h) => h.type === 'amount')).toBe(false)
  })

  it('承诺词与风险词各出一条', () => {
    const hs = highlightsOf(item({ title: '我们保证退款', summary: '客户说要投诉' }), ctx)
    expect(hs.filter((h) => h.type === 'commitment')).toHaveLength(1)
    expect(hs.filter((h) => h.type === 'risk_term')).toHaveLength(1)
  })

  it('caps_hit 一律进风险词', () => {
    const hs = highlightsOf(
      refundItem({
        automation: {
          level_at_creation: 'L1',
          auto_approved: false,
          mandate_check: { within: false, caps_hit: ['max_auto_refund_amount'] },
          sampling: { selected: false },
        },
      }),
      ctx,
    )
    expect(hs.some((h) => h.text === 'max_auto_refund_amount')).toBe(true)
  })

  it('due_at 优先于 expires_at', () => {
    const hs = highlightsOf(item({ due_at: '2026-09-08T00:00:00.000Z', expires_at: NOW }), ctx)
    expect(hs.find((h) => h.type === 'deadline')?.text).toBe('2026-09-08T00:00:00.000Z')
  })

  it('订单号走 label 回调', () => {
    const hs = highlightsOf(refundItem(), { ...ctx, label: () => '#1001' })
    expect(hs.find((h) => h.type === 'order_ref')?.text).toBe('#1001')
  })
})

describe('证据芯片（37 §1 第 5 行：i18n key + 参数，永不裸 id）', () => {
  it('预检绿、引用条数、查过的单、读过的记录都在；run id 不在', () => {
    const chips = evidenceChipsOf(item(), { ...ctx, label: () => '#1001' })
    expect(chips[0]?.label_key).toBe('evidence.precheck.ok')
    expect(chips.find((c) => c.label_key === 'evidence.citation')?.params).toEqual({ count: 1 })
    expect(chips.find((c) => c.label_key === 'evidence.order_checked')?.params).toEqual({
      order: '#1001',
    })
    expect(chips.find((c) => c.label_key === 'evidence.records_read')?.params).toEqual({ count: 4 })
    expect(chips.some((c) => c.label_key === 'evidence.run')).toBe(false)
    for (const c of chips) expect(c.label_key.startsWith('evidence.')).toBe(true)
    // 一条裸 id 都不许出现在芯片里
    expect(JSON.stringify(chips)).not.toMatch(/ord_|cus_|fc_|run_|thr_|prod_/)
  })

  it('订单查不到展示名就报条数，不报 id', () => {
    const chips = evidenceChipsOf(refundItem(), ctx)
    expect(chips.find((c) => c.label_key === 'evidence.orders_checked')?.params).toEqual({
      count: 1,
    })
    expect(JSON.stringify(chips)).not.toContain('ord_1001')
  })

  it('上限 10 条', () => {
    const many = item({
      evidence: {
        ...item().evidence,
        provenance: {
          seen: Array.from({ length: 40 }, (_, i) => ({ type: 'order' as const, id: `o_${i}` })),
        },
      },
    })
    expect(evidenceChipsOf(many, ctx).length).toBeLessThanOrEqual(10)
  })

  it('run id 只进详情', () => {
    const card = projectCard(item(), ctx)
    expect(card.detail.run_id).toBe('run_1')
    expect(JSON.stringify(card.evidence_chips)).not.toContain('run_1')
  })

  it('预检红 / 黄各有自己的 key', () => {
    expect(
      evidenceChipsOf(
        item({
          evidence: { ...item().evidence, precheck: { provenance: 'fail' } },
        }),
      )[0]?.label_key,
    ).toBe('evidence.precheck.fail')
    expect(
      evidenceChipsOf(
        item({ evidence: { ...item().evidence, precheck: { mandate: 'review' } } }),
      )[0]?.label_key,
    ).toBe('evidence.precheck.warn')
  })

  it('没有预检结果就不出预检芯片；有 diff 就出 diff 芯片', () => {
    const chips = evidenceChipsOf(
      item({
        evidence: {
          source_events: [],
          provenance: { seen: [] },
          precheck: {},
          diff: { before: 1, after: 2 },
        },
      }),
    )
    expect(chips.some((c) => c.label_key.startsWith('evidence.precheck'))).toBe(false)
    expect(chips[0]?.label_key).toBe('evidence.diff')
  })

  it('precheck.notes 不算判定值', () => {
    const chips = evidenceChipsOf(
      item({ evidence: { ...item().evidence, precheck: { notes: ['a'] } } }),
    )
    expect(chips.some((c) => c.label_key.startsWith('evidence.precheck'))).toBe(false)
  })
})

describe('选择题卡（36 §2.2 policy_change 是问句形态）', () => {
  it('payload.options 原样带出', () => {
    const card = projectCard(policyItem(), ctx)
    expect(card.options?.map((o) => o.id)).toEqual(['grace_7', 'store_credit', 'refuse'])
    expect(card.action_labels?.approve).toBe('就这么定')
    expect(card.action_labels?.instruct).toBe('其他…')
  })

  it('没写 options 的 policy_change 由 before/after 生成两个选项', () => {
    const opts = optionsOf(policyItem({ payload: { before: { a: 1 }, after: { a: 2 } } }))
    expect(opts?.map((o) => o.id)).toEqual(['after', 'before'])
  })

  it('options 里的坏条目被丢掉；全坏就回落', () => {
    const opts = optionsOf(
      policyItem({
        payload: { options: [{ id: 'x' }, 'nope', { id: 'y', label: 'Y' }], after: 1 },
      }),
    )
    expect(opts).toEqual([{ id: 'y', label: 'Y' }])
    const fallback = optionsOf(policyItem({ payload: { options: [{ id: 'x' }], after: 1 } }))
    expect(fallback?.map((o) => o.id)).toEqual(['after', 'before'])
  })

  it('policy_change 连 before/after 都没有 → 不是选择题', () => {
    expect(optionsOf(policyItem({ payload: { target: 'role' } }))).toBeUndefined()
    expect(optionsOf(policyItem({ payload: 'x' }))).toBeUndefined()
  })

  it('非 policy_change 没有 options 就是没有', () => {
    expect(optionsOf(item())).toBeUndefined()
  })
})

describe('priority_band 与排序（14 §8）', () => {
  const base = { priority: 'queue' as const }
  it('immediate → P0', () => {
    expect(priorityBandOf({ ...base, priority: 'immediate' }, 'low', NOW)).toBe('P0')
  })
  it('4 小时内过期 → P0', () => {
    expect(priorityBandOf({ ...base, expires_at: '2026-09-07T03:00:00.000Z' }, 'low', NOW)).toBe(
      'P0',
    )
  })
  it('高风险 → P1', () => {
    expect(priorityBandOf(base, 'high', NOW)).toBe('P1')
  })
  it('24 小时内过期 → P1', () => {
    expect(priorityBandOf({ ...base, expires_at: '2026-09-07T20:00:00.000Z' }, 'low', NOW)).toBe(
      'P1',
    )
  })
  it('普通队列 → P2；只进日报 → P3', () => {
    expect(priorityBandOf(base, 'low', NOW)).toBe('P2')
    expect(priorityBandOf({ priority: 'digest' }, 'low', NOW)).toBe('P3')
  })

  it('排序：档位 → 期限 → 创建时间 → id', () => {
    const mk = (over: Partial<DeckCard>): DeckCard => ({ ...projectCard(item(), ctx), ...over })
    const cards: DeckCard[] = [
      mk({ id: 'c', priority_band: 'P2' }),
      mk({ id: 'a', priority_band: 'P0' }),
      mk({ id: 'b', priority_band: 'P1' }),
    ]
    expect(sortCards(cards).map((c) => c.id)).toEqual(['a', 'b', 'c'])

    const sameBand: DeckCard[] = [
      mk({ id: 'y', expires_at: '2026-09-09T00:00:00.000Z' }),
      mk({ id: 'x', expires_at: '2026-09-08T00:00:00.000Z' }),
      mk({ id: 'z' }),
    ]
    expect(sortCards(sameBand).map((c) => c.id)).toEqual(['x', 'y', 'z'])

    const sameDeadline: DeckCard[] = [
      mk({ id: 'q', detail: { ...mk({}).detail, created_at: '2026-09-07T00:00:01.000Z' } }),
      mk({ id: 'p' }),
    ]
    expect(sortCards(sameDeadline).map((c) => c.id)).toEqual(['p', 'q'])

    const tie: DeckCard[] = [mk({ id: 'n' }), mk({ id: 'm' }), mk({ id: 'n' })]
    expect(sortCards(tie).map((c) => c.id)).toEqual(['m', 'n', 'n'])
  })
})

describe('矩阵表本身', () => {
  it('系统卡不受审批状态影响', () => {
    expect(actionsFor('system_alert', 'applied')).toEqual(['open', 'snooze'])
    expect(actionsFor('digest', 'expired')).toEqual(['open', 'snooze'])
  })
  it('37 §2.4：daily_plan / review 有专属动作与动词', () => {
    expect(actionsFor('daily_plan', 'pending')).toEqual(['approve', 'instruct', 'snooze', 'open'])
    expect(labelsFor('daily_plan', ['approve', 'instruct', 'snooze'])).toEqual({
      approve: '采纳',
      instruct: '我改几条',
      snooze: '稍后',
    })
    expect(actionsFor('review', 'pending')).toEqual(['approve', 'reject', 'snooze', 'open'])
    expect(labelsFor('review', ['approve', 'reject', 'open'])).toEqual({
      approve: '按建议排明天',
      reject: '我来排',
      open: '看完',
    })
    // 决定过就只剩「打开」，和别的卡一样
    expect(actionsFor('daily_plan', 'applied')).toEqual(['open'])
  })

  it('表里没有的 kind 走通用卡', () => {
    expect(actionsFor('join_mapping', 'pending')).toEqual(['approve', 'reject', 'open'])
    expect(labelsFor('join_mapping', ['approve', 'open'])).toEqual({
      approve: '批准',
      open: '打开',
    })
    expect(riskClassFor('join_mapping')).toBe('high')
    expect(riskClassFor('staged_change')).toBe('medium')
  })
  it('预计分钟：每种卡一个数，未知的按 2 分钟', () => {
    expect(minutesFor('policy_change')).toBe(4)
    expect(minutesFor('unknown_kind' as 'digest')).toBe(2)
    const cards = [projectCard(item(), ctx), projectCard(policyItem(), ctx)]
    expect(estimatedMinutes(cards)).toBe(6)
    expect(estimatedMinutes([])).toBe(0)
  })
})
