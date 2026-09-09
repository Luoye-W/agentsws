import { adoptionLowerBound } from '@agentsws/roles'
import { describe, expect, it } from 'vitest'
import type { PooledLesson } from '../src/index.js'
import { PROMOTION_CRITERIA, promotionCriteria, weeklyPromotions } from '../src/index.js'

const NOW = '2026-10-01T06:00:00.000Z'
const OLD = '2026-09-01T06:00:00.000Z'

function lesson(over: Partial<PooledLesson> & { id: string }): PooledLesson {
  return {
    workspace_id: 'ws_1',
    assignment_id: 'asg_1',
    run_id: 'run_1',
    applies_to: { skill: 'customer-care', section_id: 'sec_1' },
    kind: 'rule',
    signal: 'reject',
    strength: 'strong',
    text: '退货窗口从送达日算',
    confidence: 0.95,
    semantic_key: 'customer-care::sec_1::rule::k1',
    evidence: [{ quote: '退货窗口从送达日算', at: OLD }],
    hits: 3,
    status: 'accepted',
    created_at: OLD,
    updated_at: OLD,
    runs: ['run_1'],
    assignments: ['asg_1'],
    ...over,
  }
}

const FROM = { tier: 'personal' as const, owner: 'p_wang' }

describe('07 §1 判据用 Wilson 单侧 95% 下界（不重写统计）', () => {
  it('与 roles 的 adoptionLowerBound 是同一把尺子', () => {
    const c = promotionCriteria({ accepted: 8, samples: 10, contributors: 2, now: NOW })
    expect(c.lower_bound).toBeCloseTo(adoptionLowerBound(8, 10), 4)
    // 卡片 payload 不能出现十几位连续数字（会被密钥 / 卡号扫描拦下）
    expect(String(c.lower_bound).replace('0.', '').length).toBeLessThanOrEqual(4)
  })

  it('少数几次全采纳不够：n 小的时候下界过不了 0.9', () => {
    const c = promotionCriteria({
      accepted: 5,
      samples: 5,
      contributors: 2,
      oldest_at: OLD,
      now: NOW,
    })
    expect(c.passed).toBe(false)
    expect(c.missing.some((m) => m.includes('采纳率下界'))).toBe(true)
  })

  it('样本够多且全采纳 → 四条判据都过', () => {
    const c = promotionCriteria({
      accepted: 60,
      samples: 60,
      contributors: 3,
      oldest_at: OLD,
      now: NOW,
    })
    expect(c.lower_bound).toBeGreaterThanOrEqual(PROMOTION_CRITERIA.min_lower_bound)
    expect(c.passed).toBe(true)
    expect(c.missing).toEqual([])
  })

  it('缺时间就是 0 天，少于 14 天不过', () => {
    const c = promotionCriteria({ accepted: 60, samples: 60, contributors: 3, now: NOW })
    expect(c.age_days).toBe(0)
    expect(c.missing).toContain('存在时间 < 14 天')
    expect(
      promotionCriteria({ accepted: 0, samples: 0, contributors: 0, now: NOW }).missing,
    ).toEqual([
      expect.stringContaining('采纳率下界'),
      '采用次数 < 5',
      '贡献者 < 2',
      '存在时间 < 14 天',
    ])
  })
})

describe('24 §6.5 三人接受相似修改 → 一条晋升提议，证据含三人', () => {
  const cluster = (): PooledLesson[] => [
    lesson({ id: 'l1', assignment_id: 'asg_1', assignments: ['asg_1'], hits: 25 }),
    lesson({ id: 'l2', assignment_id: 'asg_2', assignments: ['asg_2'], hits: 25 }),
    lesson({ id: 'l3', assignment_id: 'asg_3', assignments: ['asg_3'], hits: 25 }),
  ]

  it('出卡且 contributors 是三个人', () => {
    const { cards, blocked } = weeklyPromotions({
      workspace_id: 'ws_1',
      lessons: cluster(),
      now: NOW,
      from: FROM,
    })
    expect(blocked).toEqual([])
    expect(cards).toHaveLength(1)
    expect(cards[0]?.contributors.sort()).toEqual(['asg_1', 'asg_2', 'asg_3'])
    expect(cards[0]?.to_tier).toBe('department')
    expect(cards[0]?.section_ids).toEqual(['sec_1'])
    expect(cards[0]?.evidence.lessons).toEqual(['l1', 'l2', 'l3'])
  })

  it('只有一个人 → 不出卡（安静跳过，不是"被拦"）', () => {
    const { cards, blocked } = weeklyPromotions({
      workspace_id: 'ws_1',
      lessons: [lesson({ id: 'l1', hits: 60 })],
      now: NOW,
      from: FROM,
    })
    expect(cards).toEqual([])
    expect(blocked).toEqual([])
  })

  it('采纳率下界不过 → blocked: criteria', () => {
    const { cards, blocked } = weeklyPromotions({
      workspace_id: 'ws_1',
      lessons: [
        lesson({ id: 'l1', assignment_id: 'asg_1', assignments: ['asg_1'], hits: 2 }),
        lesson({ id: 'l2', assignment_id: 'asg_2', assignments: ['asg_2'], hits: 2 }),
      ],
      now: NOW,
      from: FROM,
    })
    expect(cards).toEqual([])
    expect(blocked[0]?.reason).toBe('criteria')
    expect(blocked[0]?.criteria?.passed).toBe(false)
  })

  it('不强制判据时照样出卡（手动触发用）', () => {
    const { cards } = weeklyPromotions({
      workspace_id: 'ws_1',
      lessons: [
        lesson({ id: 'l1', assignment_id: 'asg_1', assignments: ['asg_1'], hits: 2 }),
        lesson({ id: 'l2', assignment_id: 'asg_2', assignments: ['asg_2'], hits: 2 }),
      ],
      now: NOW,
      from: FROM,
      enforce_criteria: false,
      to_tier: 'company',
    })
    expect(cards).toHaveLength(1)
    expect(cards[0]?.to_tier).toBe('company')
    expect(cards[0]?.summary).toContain('公司')
  })

  it('被忽略 / 驳回的同键 lesson 进样本，采纳率不会永远是 1', () => {
    const { blocked } = weeklyPromotions({
      workspace_id: 'ws_1',
      lessons: [
        lesson({ id: 'l1', assignment_id: 'asg_1', assignments: ['asg_1'], hits: 30 }),
        lesson({ id: 'l2', assignment_id: 'asg_2', assignments: ['asg_2'], hits: 30 }),
        lesson({
          id: 'l3',
          assignment_id: 'asg_3',
          assignments: ['asg_3'],
          hits: 60,
          status: 'refuted',
        }),
      ],
      now: NOW,
      from: FROM,
    })
    expect(blocked[0]?.criteria?.samples).toBe(120)
    expect(blocked[0]?.criteria?.accepted).toBe(60)
    expect(blocked[0]?.reason).toBe('criteria')
  })
})

describe('24 §6.6 eval 红 → 预检 blocked；24 §3 策略层不进', () => {
  const two = (): PooledLesson[] => [
    lesson({ id: 'l1', assignment_id: 'asg_1', assignments: ['asg_1'], hits: 40 }),
    lesson({ id: 'l2', assignment_id: 'asg_2', assignments: ['asg_2'], hits: 40 }),
  ]

  it('eval 红 → blocked，带失败用例名', () => {
    const { cards, blocked } = weeklyPromotions({
      workspace_id: 'ws_1',
      lessons: two(),
      now: NOW,
      from: FROM,
      evalResult: { status: 'red', failed: ['refund-window'] },
    })
    expect(cards).toEqual([])
    expect(blocked[0]?.reason).toBe('eval_red')
    expect(blocked[0]?.detail).toContain('refund-window')
  })

  it('eval 红但没给失败用例名也说得清', () => {
    const { blocked } = weeklyPromotions({
      workspace_id: 'ws_1',
      lessons: two(),
      now: NOW,
      from: FROM,
      evalResult: { status: 'red' },
    })
    expect(blocked[0]?.detail).toContain('blocked')
  })

  it('eval 绿不挡', () => {
    const { cards } = weeklyPromotions({
      workspace_id: 'ws_1',
      lessons: two(),
      now: NOW,
      from: FROM,
      evalResult: { status: 'green' },
      enforce_criteria: false,
    })
    expect(cards).toHaveLength(1)
  })

  it('策略层技能 → blocked: policy_layer', () => {
    const { cards, blocked } = weeklyPromotions({
      workspace_id: 'ws_1',
      lessons: two(),
      now: NOW,
      from: FROM,
      policySkills: ['customer-care'],
    })
    expect(cards).toEqual([])
    expect(blocked[0]?.reason).toBe('policy_layer')
  })

  it('跨工作区不串；没有 accepted 就没有卡', () => {
    expect(
      weeklyPromotions({ workspace_id: 'ws_other', lessons: two(), now: NOW, from: FROM }).cards,
    ).toEqual([])
    expect(
      weeklyPromotions({
        workspace_id: 'ws_1',
        lessons: two().map((l) => ({ ...l, status: 'pooled' as const })),
        now: NOW,
        from: FROM,
      }).cards,
    ).toEqual([])
  })

  it('没写段的 lesson 也能晋升（section_ids 为空）', () => {
    const { cards } = weeklyPromotions({
      workspace_id: 'ws_1',
      lessons: two().map((l) => ({ ...l, applies_to: { skill: 'customer-care' } })),
      now: NOW,
      from: FROM,
      enforce_criteria: false,
    })
    expect(cards[0]?.section_ids).toEqual([])
  })
})
