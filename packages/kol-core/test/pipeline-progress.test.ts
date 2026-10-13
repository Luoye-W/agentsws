/**
 * WP302（决策 406）：分段进度与紧急程度。规则照 KOLAgents（停满 7 天标黄、只盯要人推的几段、
 * 谢绝不画成走完），阶段换成工坊十段。
 */
import { describe, expect, it } from 'vitest'
import {
  COLLAB_GROUPS,
  collabStatus,
  dwellDays,
  groupOfTier,
  isStageStalled,
  PIPELINE_STALL_DAYS,
  stageSegments,
} from '../src/index.js'

const NOW = '2026-10-20T12:00:00.000Z'
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString()

describe('分段进度（改编自 KOLAgents pipeline-progress）', () => {
  it('停了几整天：向下取整；时刻在将来按 0；老数据退回最近一次动静', () => {
    expect(dwellDays(daysAgo(6.5), NOW)).toBe(6)
    expect(dwellDays(daysAgo(-1), NOW)).toBe(0)
    expect(dwellDays(undefined, NOW, daysAgo(3))).toBe(3)
    expect(dwellDays(undefined, NOW)).toBeNull()
  })

  it('只盯要人推的几段，停满 7 天才算卡住；还没开始的、交付中的、结案的不标', () => {
    expect(PIPELINE_STALL_DAYS).toBe(7)
    expect(isStageStalled('contacted', daysAgo(7), NOW)).toBe(true)
    expect(isStageStalled('contacted', daysAgo(6), NOW)).toBe(false)
    expect(isStageStalled('agreed', daysAgo(9), NOW)).toBe(true)
    for (const s of ['sourced', 'delivering', 'closed', 'declined'] as const)
      expect(isStageStalled(s, daysAgo(30), NOW), s).toBe(false)
  })

  it('一条合作的那几段：到过的 done、现在的 current（停久了标 stalled）、后面的 pending', () => {
    const segs = stageSegments('replied', { now: NOW, stageChangedAt: daysAgo(8) })
    expect(segs.map((s) => [s.stage, s.state])).toEqual([
      ['sourced', 'done'],
      ['contacted', 'done'],
      ['replied', 'current'],
      ['negotiating', 'pending'],
      ['agreed', 'pending'],
      ['delivering', 'pending'],
      ['delivered', 'pending'],
      ['closed', 'pending'],
    ])
    expect(segs.find((s) => s.state === 'current')?.stalled).toBe(true)
  })

  it('「已寄样」只在寄过样时出；谢绝的不画成走完；结案是终点', () => {
    expect(
      stageSegments('delivering', { now: NOW, withSample: true }).map((s) => s.stage),
    ).toContain('sample_sent')
    expect(stageSegments('delivering', { now: NOW }).map((s) => s.stage)).not.toContain(
      'sample_sent',
    )
    const declined = stageSegments('declined', { now: NOW, declinedFrom: 'replied' })
    expect(declined.map((s) => [s.stage, s.state])).toEqual([
      ['sourced', 'done'],
      ['contacted', 'done'],
      ['replied', 'done'],
      ['declined', 'terminal'],
    ])
    expect(stageSegments('closed', { now: NOW }).at(-1)?.state).toBe('terminal')
  })
})

describe('紧急程度（色阶移植自 KOLAgents status-tier）', () => {
  it('四组：要处理 / 等对方（蓝 + 黄）/ 进行中 / 其他', () => {
    expect(COLLAB_GROUPS).toEqual(['action', 'waiting', 'active', 'idle'])
    expect(groupOfTier('scheduled')).toBe('waiting')
  })

  it('有卡等批、交付逾期、交付等审、对方回了信没回应 → 要处理', () => {
    expect(collabStatus({ stage: 'contacted', now: NOW, pending_cards: 2 })).toEqual({
      tier: 'action',
      label: '有 2 张卡等你批',
    })
    expect(collabStatus({ stage: 'delivering', now: NOW, overdue_deliverables: 1 }).label).toBe(
      '交付逾期',
    )
    expect(collabStatus({ stage: 'delivering', now: NOW, pending_reviews: 1 }).label).toBe(
      '交付物等你审',
    )
    expect(
      collabStatus({
        stage: 'replied',
        now: NOW,
        last_exchange: { direction: 'in', at: daysAgo(1), reply_class: 'wants_quote' },
      }),
    ).toEqual({ tier: 'action', label: '要报价 · 待回应' })
  })

  it('发了信：跟进排上了是蓝；没排上就是黄「等回复 · 已 N 天（第 n 封）」', () => {
    expect(collabStatus({ stage: 'contacted', now: NOW, next_follow_up_at: daysAgo(-2) })).toEqual({
      tier: 'scheduled',
      label: '跟进已排上 · 2 天后',
    })
    expect(
      collabStatus({
        stage: 'contacted',
        now: NOW,
        outbound_count: 2,
        last_exchange: { direction: 'out', at: daysAgo(5) },
      }),
    ).toEqual({ tier: 'waiting', label: '等回复 · 已 5 天（第 2 封）' })
  })

  it('谈成之后是进行中；还没联系、结案、谢绝是其他', () => {
    expect(collabStatus({ stage: 'sample_sent', now: NOW })).toEqual({
      tier: 'active',
      label: '已寄样',
    })
    expect(collabStatus({ stage: 'sourced', now: NOW }).tier).toBe('idle')
    expect(collabStatus({ stage: 'declined', now: NOW }).label).toBe('谢绝了')
  })
})
