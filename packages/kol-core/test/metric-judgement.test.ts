import { describe, expect, it } from 'vitest'
import {
  ENGAGEMENT_THRESHOLDS,
  engagementMedianFor,
  judgeEngagement,
  judgeReach,
  REACH_NORMAL_BAND,
  REACH_THRESHOLDS,
} from '../src/metric-judgement.js'

/*
 * 移植自 KOLAgents `src/influencer/__tests__/metric-judgement.test.ts` @ 88d74b2c。
 * 原测试对着 `services/quality-metrics.ts` 的同一张表核（那边连库）；工坊没有那个服务，
 * 这里把那张表的值抄成常量，断言不变。
 */
const INDUSTRY_ENGAGEMENT_BASELINE = {
  nano: 0.05,
  micro: 0.03,
  mid: 0.018,
  macro: 0.01,
  mega: 0.008,
} as const

/**
 * W-UI1 §3 — the one part of the redraw that could not be cut.
 *
 * The tests worth having here are the boundaries (an operator arguing about a
 * verdict is arguing about a cut point) and the ABSENCE of a verdict, which is
 * the case a card renders far more often than any of the three colours.
 */
describe('judgeEngagement', () => {
  it('names the bottom of the distribution below 0.7%', () => {
    const verdict = judgeEngagement(0.002)
    expect(verdict).toMatchObject({ key: 'low', level: 'bad', value: '0.2' })
  })

  it('treats the boundary itself as the KINDER verdict', () => {
    // 0.7% exactly is 「average」, not 「low」: the doc's bands are `< 0.7` and
    // `0.7–1.5`, and a creator on the line should not be accused.
    expect(judgeEngagement(ENGAGEMENT_THRESHOLDS.low)?.key).toBe('average')
    expect(judgeEngagement(ENGAGEMENT_THRESHOLDS.average)?.key).toBe('healthy')
  })

  it('calls anything above 1.5% healthy', () => {
    expect(judgeEngagement(0.024)).toMatchObject({
      key: 'healthy',
      level: 'good',
      value: '2.4',
    })
  })

  it('quotes the same median in every sentence', () => {
    for (const rate of [0.002, 0.01, 0.03]) {
      expect(judgeEngagement(rate)?.median).toBe('1.8')
    }
  })

  it('returns nothing when the rate is missing or nonsense', () => {
    for (const value of [null, undefined, 0, -1, Number.NaN]) {
      expect(judgeEngagement(value)).toBeNull()
    }
  })
})

describe('judgeReach', () => {
  it('flags feed-driven reach above 1.2×', () => {
    expect(judgeReach(2_400_000, 1_000_000)).toMatchObject({
      key: 'pushDriven',
      level: 'warn',
      ratio: '2.4',
    })
  })

  it('flags a channel whose followers stopped watching', () => {
    expect(judgeReach(1_000, 100_000)).toMatchObject({
      key: 'declining',
      level: 'bad',
      percent: '1',
    })
  })

  it('says normal inside the band, at both edges', () => {
    expect(judgeReach(1_200, 10_000)?.key).toBe('normal')
    // The band the copy quotes is inclusive: 0.05 and 1.2 are both 「normal」,
    // because the doc's rules are `> 1.2` and `< 0.05`.
    expect(judgeReach(500, 10_000)?.key).toBe('normal')
    expect(judgeReach(12_000, 10_000)?.key).toBe('normal')
  })

  it('carries the quoted band into every reach sentence', () => {
    const verdict = judgeReach(1_200, 10_000)
    expect(verdict?.min).toBe('10')
    expect(verdict?.max).toBe('100')
  })

  it('returns nothing without both halves of the ratio', () => {
    expect(judgeReach(null, 10_000)).toBeNull()
    expect(judgeReach(1_000, null)).toBeNull()
    expect(judgeReach(1_000, 0)).toBeNull()
  })
})

describe('threshold provenance', () => {
  /**
   * The card's 1.8% is the mid-bucket industry constant the drawer's quality
   * score already uses. Not a measurement — see the PROVENANCE block in
   * `metric-judgement.ts` — but at least ONE number rather than two that
   * silently disagree, which is what a second literal here would create.
   */
  it('mirrors quality-metrics bucket table exactly (drift guard)', () => {
    // The card copies these values instead of importing them — that module
    // pulls in the DB and cannot enter a client bundle. This is the guard
    // that keeps the copy honest.
    const pairs: Array<[number, keyof typeof INDUSTRY_ENGAGEMENT_BASELINE]> = [
      [4_000, 'nano'],
      [50_000, 'micro'],
      [500_000, 'mid'],
      [5_000_000, 'macro'],
      [20_000_000, 'mega'],
    ]
    for (const [followers, bucket] of pairs) {
      expect(engagementMedianFor(followers)).toBe(INDUSTRY_ENGAGEMENT_BASELINE[bucket])
    }
  })

  it('measures each creator against their OWN bucket, not a flat median', () => {
    // The card and the drawer have to say the same thing about one creator:
    // the drawer scores against the creator's bucket, so the card does too.
    expect(engagementMedianFor(4_000)).toBe(INDUSTRY_ENGAGEMENT_BASELINE.nano)
    expect(engagementMedianFor(50_000)).toBe(INDUSTRY_ENGAGEMENT_BASELINE.micro)
    expect(engagementMedianFor(500_000)).toBe(INDUSTRY_ENGAGEMENT_BASELINE.mid)
    expect(engagementMedianFor(20_000_000)).toBe(INDUSTRY_ENGAGEMENT_BASELINE.mega)
    // Unknown size still gets told something.
    expect(engagementMedianFor(null)).toBe(INDUSTRY_ENGAGEMENT_BASELINE.mid)
  })

  it('quotes the bucket median a small creator is actually judged by', () => {
    // 2.5% is healthy for a mid-sized channel and unremarkable for a nano one;
    // the sentence has to quote the median it used, or the number is a lie.
    const nano = judgeEngagement(0.025, 4_000)
    expect(nano?.median).toBe('5.0')
    const mid = judgeEngagement(0.025, 500_000)
    expect(mid?.median).toBe('1.8')
  })

  it('keeps the bands ordered', () => {
    expect(ENGAGEMENT_THRESHOLDS.low).toBeLessThan(ENGAGEMENT_THRESHOLDS.average)
    expect(REACH_THRESHOLDS.declining).toBeLessThan(REACH_NORMAL_BAND.min)
    expect(REACH_NORMAL_BAND.max).toBeLessThan(REACH_THRESHOLDS.pushDriven)
  })
})
