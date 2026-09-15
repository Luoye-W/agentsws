import { describe, expect, it } from 'vitest'
import { briefGaps, planCampaign, roleIdOfChannel, type ScorableAccount } from '../src/index.js'

const now = '2026-09-15T00:00:00Z'
const acc = (over: Partial<ScorableAccount> & { channel: ScorableAccount['channel'] }) => ({
  followers: 50_000,
  engagement_rate: 0.05,
  category: '数码',
  observed_at: now,
  ...over,
})

describe('campaign 向导（48 §5.2）', () => {
  it('缺格时不给清单，而是说还缺哪几格', () => {
    const plan = planCampaign({ goal: '秋季新品' }, [], now)
    expect(plan.ready).toBe(false)
    expect(plan.gaps).toEqual(['budget', 'channels', 'headcount'])
    expect(plan.message).toContain('还差 3 件事')
    expect(plan.picks).toEqual([])
  })

  it('四格齐了就不缺', () => {
    expect(briefGaps({ goal: 'x', budget: 1, channels: ['youtube'], headcount: 1 })).toEqual([])
  })

  it('名额按渠道平分：选了三条渠道就是想三条都试试', () => {
    const pool = [
      acc({ channel: 'youtube', followers: 60_000 }),
      acc({ channel: 'youtube', followers: 55_000 }),
      acc({ channel: 'youtube', followers: 50_000 }),
      acc({ channel: 'instagram', followers: 40_000, engagement_rate: 0.01 }),
      acc({ channel: 'tiktok', followers: 30_000, engagement_rate: 0.01 }),
    ]
    const plan = planCampaign(
      {
        goal: '秋季新品',
        budget: 900,
        currency: 'USD',
        channels: ['youtube', 'instagram', 'tiktok'],
        headcount: 3,
      },
      pool,
      now,
    )
    expect(plan.ready).toBe(true)
    expect(plan.by_channel.map((g) => g.picks.length)).toEqual([1, 1, 1])
    expect(plan.picks).toHaveLength(3)
    expect(plan.budget_per_creator).toBe(300)
  })

  it('除不尽时靠前的渠道多一个', () => {
    const pool = [
      acc({ channel: 'youtube' }),
      acc({ channel: 'youtube' }),
      acc({ channel: 'instagram' }),
      acc({ channel: 'instagram' }),
    ]
    const plan = planCampaign(
      { goal: 'x', budget: 100, channels: ['youtube', 'instagram'], headcount: 3 },
      pool,
      now,
    )
    expect(plan.by_channel.map((g) => g.picks.length)).toEqual([2, 1])
  })

  it('每一条都带"该由哪条职责去动它"——跨渠道挑人，动作仍走各自职责（05 §4）', () => {
    const plan = planCampaign(
      { goal: 'x', budget: 100, channels: ['youtube', 'x'], headcount: 2 },
      [acc({ channel: 'youtube' }), acc({ channel: 'x', engagement_rate: 0.02 })],
      now,
    )
    expect(plan.by_channel.map((g) => g.role_id)).toEqual(['kol.youtube', 'kol.x'])
    expect(plan.picks.every((p) => p.role_id === roleIdOfChannel(p.channel))).toBe(true)
  })

  it('刷粉的不进清单：清单是"准备发信的人"，不是搜索结果', () => {
    const plan = planCampaign(
      { goal: 'x', budget: 100, channels: ['youtube'], headcount: 2 },
      [
        acc({ channel: 'youtube', followers: 900_000, engagement_rate: 0.0005 }),
        acc({ channel: 'youtube', followers: 60_000 }),
      ],
      now,
    )
    expect(plan.picks).toHaveLength(1)
    expect(plan.picks[0]?.score.blocked).toBeUndefined()
  })

  it('一个都没挑到时人均预算是 0，不是 NaN', () => {
    const plan = planCampaign(
      { goal: 'x', budget: 100, channels: ['facebook'], headcount: 2 },
      [acc({ channel: 'youtube' })],
      now,
    )
    expect(plan.budget_per_creator).toBe(0)
  })
})
