import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEAM_PRICING,
  teamChannelUsable,
  teamPricingProblem,
  teamTierOf,
} from '../src/team-link.js'

describe('WP444 团队通道人数档', () => {
  it('按人数落档：3 / 5 / 8 / 10 人，超过 10 人每人 +12', () => {
    expect(teamTierOf(DEFAULT_TEAM_PRICING, 1)).toEqual({
      members: 3,
      credits: 45,
      extra_members: 0,
    })
    expect(teamTierOf(DEFAULT_TEAM_PRICING, 3).credits).toBe(45)
    expect(teamTierOf(DEFAULT_TEAM_PRICING, 4).credits).toBe(68)
    expect(teamTierOf(DEFAULT_TEAM_PRICING, 8).credits).toBe(98)
    expect(teamTierOf(DEFAULT_TEAM_PRICING, 9).credits).toBe(120)
    expect(teamTierOf(DEFAULT_TEAM_PRICING, 10).credits).toBe(120)
    expect(teamTierOf(DEFAULT_TEAM_PRICING, 13)).toEqual({
      members: 10,
      credits: 156,
      extra_members: 3,
    })
    expect(teamTierOf(DEFAULT_TEAM_PRICING, 0).members).toBe(3)
  })

  it('后台改的档位先核一遍', () => {
    expect(teamPricingProblem(DEFAULT_TEAM_PRICING)).toBeUndefined()
    expect(teamPricingProblem({ tiers: [], extra_per_member: 1 })).toBeDefined()
    expect(
      teamPricingProblem({
        tiers: [
          { members: 5, credits: 1 },
          { members: 3, credits: 1 },
        ],
        extra_per_member: 1,
      }),
    ).toBeDefined()
    expect(
      teamPricingProblem({ tiers: [{ members: 3, credits: -1 }], extra_per_member: 1 }),
    ).toBeDefined()
  })

  it('宽限里照常能用，宽限过了 / 没开通不能用', () => {
    expect(teamChannelUsable('trial')).toBe(true)
    expect(teamChannelUsable('grace')).toBe(true)
    expect(teamChannelUsable('cancelling')).toBe(true)
    expect(teamChannelUsable('suspended')).toBe(false)
    expect(teamChannelUsable('none')).toBe(false)
  })
})

describe('WP444 团队通道的月费归「其它」', () => {
  it('team.channel.monthly → other', async () => {
    const { allocationBucketOf } = await import('../src/cloud-allocation.js')
    expect(allocationBucketOf('team.channel.monthly')).toBe('other')
  })
})
