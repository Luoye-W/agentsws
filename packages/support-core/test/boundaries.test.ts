import { describe, expect, it } from 'vitest'
import type { SupportPolicy } from '../src/index.js'
import {
  answerBoundary,
  answeredBoundariesBlock,
  boundaryTriggered,
  classifyText,
  detectAnsweredBoundaries,
  findBoundary,
  findBoundaryOption,
  findUnansweredBoundaries,
  findUnansweredBoundary,
  isAnswered,
  MAX_CUSTOM_ANSWER_CHARS,
  policyNumber,
  policyValue,
  returnWindowPolicy,
  SUPPORT_BOUNDARIES,
  validateBoundaryAnswer,
} from '../src/index.js'

const AT = '2026-09-07T01:00:00.000Z'
const ANSWER_CTX = { by: 'p_wang', at: AT }

describe('业务边界注册表（KefuAgent GOODS_POLICY_BOUNDARIES + 中台新增）', () => {
  it('至少 12 条，id 唯一，选项 id 在条内唯一', () => {
    expect(SUPPORT_BOUNDARIES.length).toBeGreaterThanOrEqual(12)
    const ids = SUPPORT_BOUNDARIES.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const b of SUPPORT_BOUNDARIES) {
      expect(b.id.startsWith('policy.')).toBe(true)
      expect(b.question.length).toBeGreaterThan(0)
      expect(b.options.length).toBeGreaterThanOrEqual(2)
      const optionIds = b.options.map((o) => o.id)
      expect(new Set(optionIds).size).toBe(optionIds.length)
    }
  })

  it('KefuAgent 那 10 条的 key 与选项 id 逐条对齐（已答行以 id 关联，不可改名）', () => {
    const expected: Record<string, string[]> = {
      'policy.refund_window': ['days_7', 'days_14', 'days_30', 'days_60'],
      'policy.return_shipping_payer': ['merchant_label', 'customer', 'by_reason'],
      'policy.replacement_first': ['replace_first', 'refund_only', 'customer_choice'],
      'policy.compensation_cap': ['usd_5', 'usd_15', 'usd_30', 'pct_30'],
      'policy.cancel_change_window': ['before_ship', 'never', 'platform_rules'],
      'policy.logistics_anomaly_days': ['days_7', 'days_10', 'days_15', 'days_20'],
      'policy.customs_duty_payer': ['merchant_ddp', 'customer', 'by_region'],
      'policy.warranty_period': ['m6', 'm12', 'm24', 'none'],
      'policy.presale_discount': ['none', 'pct_5', 'manual'],
      'policy.vip_threshold': ['usd_200', 'usd_500', 'none'],
    }
    for (const [id, options] of Object.entries(expected)) {
      const boundary = findBoundary(id)
      expect(boundary, id).toBeDefined()
      expect(boundary?.options.map((o) => o.id)).toEqual(options)
    }
  })

  it('declared 的两条永不触发', () => {
    for (const id of ['policy.presale_discount', 'policy.vip_threshold']) {
      const boundary = findBoundary(id)
      if (boundary === undefined) throw new Error(id)
      expect(boundary.wiring).toBe('declared')
      expect(boundaryTriggered(boundary, 'pre_sales')).toBe(false)
    }
  })

  it('触发是 OR：意图、风险词、变更种类任一命中', () => {
    const window = findBoundary('policy.refund_window')
    if (window === undefined) throw new Error('缺 policy.refund_window')
    expect(boundaryTriggered(window, 'returns_refunds')).toBe(true)
    expect(boundaryTriggered(window, 'warranty')).toBe(false)
    expect(boundaryTriggered(window, 'warranty', ['refund'])).toBe(true)
    const c = classifyText({ text: 'my item is broken, I want a replace' }, { now: AT })
    const replacement = findBoundary('policy.replacement_first')
    if (replacement === undefined) throw new Error('缺 policy.replacement_first')
    expect(boundaryTriggered(replacement, c)).toBe(true)
  })

  it('findUnansweredBoundary 只给第一条——一次只问一个问题', () => {
    const all = findUnansweredBoundaries('returns_refunds', [])
    expect(all.length).toBeGreaterThan(1)
    expect(findUnansweredBoundary('returns_refunds', [])?.id).toBe(all[0]?.id)
    const answered = all.map((b) => ({ boundary_id: b.id }))
    expect(findUnansweredBoundary('returns_refunds', answered)).toBeUndefined()
    expect(isAnswered('policy.refund_window', answered)).toBe(true)
    expect(isAnswered('policy.nope', answered)).toBe(false)
  })

  it('自定义注册表也走同一套查找', () => {
    const custom = [SUPPORT_BOUNDARIES[0] as (typeof SUPPORT_BOUNDARIES)[number]]
    expect(findBoundary('policy.refund_window', custom)?.id).toBe('policy.refund_window')
    expect(findBoundary('policy.warranty_period', custom)).toBeUndefined()
    expect(findUnansweredBoundaries('returns_refunds', [], { registry: custom })).toHaveLength(1)
  })
})

describe('答案校验与沉淀', () => {
  it('校验：不认识的边界 / 选项 / 空自述 / 超长自述', () => {
    expect(validateBoundaryAnswer('policy.nope', { kind: 'decline' })).toEqual({
      ok: false,
      code: 'unknown_boundary',
    })
    expect(
      validateBoundaryAnswer('policy.refund_window', { kind: 'option', option_id: 'days_99' }),
    ).toEqual({ ok: false, code: 'unknown_option' })
    expect(validateBoundaryAnswer('policy.refund_window', { kind: 'custom', text: '  ' })).toEqual({
      ok: false,
      code: 'invalid_answer',
    })
    expect(
      validateBoundaryAnswer('policy.refund_window', {
        kind: 'custom',
        text: 'x'.repeat(MAX_CUSTOM_ANSWER_CHARS + 1),
      }),
    ).toEqual({ ok: false, code: 'invalid_answer' })
    expect(validateBoundaryAnswer('policy.refund_window', { kind: 'decline' })).toEqual({
      ok: true,
    })
    expect(
      validateBoundaryAnswer('policy.refund_window', { kind: 'option', option_id: 'days_14' }),
    ).toEqual({ ok: true })
  })

  it('选项答案沉淀成策略，value 是答题那一刻的快照', () => {
    const policy = answerBoundary(
      'policy.refund_window',
      { kind: 'option', option_id: 'days_30' },
      { ...ANSWER_CTX, approval_item_id: 'ai_1' },
    )
    expect(policy).toEqual({
      boundary_id: 'policy.refund_window',
      option_id: 'days_30',
      value: { days: 30 },
      statement: '退款/退货窗口：30 天',
      answered_by: 'p_wang',
      answered_at: AT,
      source: 'approval',
      approval_item_id: 'ai_1',
    })
    // 快照：改返回的对象不会回写注册表
    if (policy !== undefined) policy.value.days = 999
    expect(
      findBoundaryOption(
        findBoundary('policy.refund_window') ?? (SUPPORT_BOUNDARIES[0] as never),
        'days_30',
      )?.value,
    ).toEqual({ days: 30 })
  })

  it('自述答案与 decline', () => {
    const custom = answerBoundary(
      'policy.customs_duty_payer',
      { kind: 'custom', text: '  欧盟包税，其他地区客户自理  ' },
      { ...ANSWER_CTX, source: 'import' },
    )
    expect(custom?.value).toEqual({ text: '欧盟包税，其他地区客户自理' })
    expect(custom?.option_id).toBeUndefined()
    expect(custom?.source).toBe('import')
    expect(answerBoundary('policy.refund_window', { kind: 'decline' }, ANSWER_CTX)).toBeUndefined()
    expect(answerBoundary('policy.nope', { kind: 'decline' }, ANSWER_CTX)).toBeUndefined()
    expect(
      answerBoundary('policy.refund_window', { kind: 'custom', text: '' }, ANSWER_CTX),
    ).toBeUndefined()
  })

  it('policyValue / policyNumber', () => {
    const policies: SupportPolicy[] = [
      {
        boundary_id: 'policy.refund_window',
        value: { days: 30, note: 'x' },
        statement: '退款/退货窗口：30 天',
        answered_by: 'p_wang',
        answered_at: AT,
        source: 'approval',
      },
    ]
    expect(policyValue(policies, 'policy.refund_window', 'note')).toBe('x')
    expect(policyNumber(policies, 'policy.refund_window', 'days')).toBe(30)
    expect(policyNumber(policies, 'policy.refund_window', 'note')).toBeUndefined()
    expect(policyValue(policies, 'policy.nope', 'days')).toBeUndefined()
  })

  it('已确认边界的 prompt 块：空数组不出标题', () => {
    expect(answeredBoundariesBlock([])).toBeUndefined()
    const a = answerBoundary(
      'policy.refund_window',
      { kind: 'option', option_id: 'days_14' },
      ANSWER_CTX,
    )
    const b = answerBoundary(
      'policy.return_shipping_payer',
      { kind: 'option', option_id: 'customer' },
      ANSWER_CTX,
    )
    if (a === undefined || b === undefined) throw new Error('答案缺失')
    const block = answeredBoundariesBlock([b, a])
    expect(block).toContain('商户已确认的业务边界')
    // 注册表顺序，不是传进来的顺序
    expect(block?.indexOf('退款/退货窗口')).toBeLessThan(block?.indexOf('退货运费承担方') ?? 0)
    expect(block).toContain('- 退款/退货窗口：14 天')
    // statement 里没有全角冒号时整句就是答案
    const odd: SupportPolicy = { ...a, statement: '十四天' }
    expect(answeredBoundariesBlock([odd])).toContain('- 退款/退货窗口：十四天')
    const empty: SupportPolicy = { ...a, statement: '' }
    expect(answeredBoundariesBlock([empty])).toBeUndefined()
  })
})

describe('从上下文探测已答边界', () => {
  it('结构化键优先，正文闭集次之', () => {
    const found = detectAnsweredBoundaries({
      structured: [{ refund_caps: { return_window_days: 14, currency: 'USD' } }],
      texts: ['德国站的退货窗口是签收后 14 天内。Warranty period is 12 months.'],
      at: AT,
    })
    const ids = found.map((p) => p.boundary_id)
    expect(ids).toContain('policy.refund_window')
    expect(ids).toContain('policy.warranty_period')
    expect(found.find((p) => p.boundary_id === 'policy.refund_window')?.value).toEqual({ days: 14 })
    // 没有任何一条闭集词提到丢件赔付 → 仍然是"没答过"
    expect(ids).not.toContain('policy.lost_package_liability')
  })

  it('空输入返回空；未知结构化键与对象值都跳过', () => {
    expect(detectAnsweredBoundaries({ at: AT })).toEqual([])
    expect(
      detectAnsweredBoundaries({
        structured: [
          { unknown_key: 1, return_window_days: { nested: 1 }, deep: [{ warranty_months: 24 }] },
        ],
        at: AT,
      }).map((p) => p.boundary_id),
    ).toEqual(['policy.warranty_period'])
  })

  it('运行时解析出的退货窗口直接算一条已答边界', () => {
    const p = returnWindowPolicy(21, AT, 'fc_1')
    expect(p.boundary_id).toBe('policy.refund_window')
    expect(p.value).toEqual({ days: 21, fact_card_id: 'fc_1' })
    expect(returnWindowPolicy(21, AT).value).toEqual({ days: 21 })
  })
})
