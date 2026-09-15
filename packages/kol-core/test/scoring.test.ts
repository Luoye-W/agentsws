import { describe, expect, it } from 'vitest'
import { rankCreators, type ScorableAccount, scoreCreator } from '../src/index.js'

const now = '2026-09-15T00:00:00Z'
const daysAgo = (n: number): string => new Date(Date.parse(now) - n * 86_400_000).toISOString()

const account = (over: Partial<ScorableAccount> = {}): ScorableAccount => ({
  channel: 'youtube',
  followers: 48_000,
  engagement_rate: 0.05,
  category: '数码',
  language: 'de',
  region: 'DE',
  observed_at: daysAgo(2),
  ...over,
})

describe('打分（48 §5.2）：每一项都可解释', () => {
  it('五项齐了，每一项都有名字、权重与一句人话', () => {
    const s = scoreCreator(account(), { now, category: '数码', language: 'de', region: 'DE' })
    expect(s.factors.map((f) => f.id)).toEqual([
      'followers',
      'engagement',
      'category',
      'locale',
      'activity',
    ])
    for (const f of s.factors) {
      expect(f.label.length, f.id).toBeGreaterThan(0)
      // 这一格空着，整个模块就白写了
      expect(f.why.length, f.id).toBeGreaterThan(0)
      expect(f.weight, f.id).toBeGreaterThan(0)
    }
    // 权重归一：覆盖时不用凑够 1
    expect(s.factors.reduce((a, f) => a + f.weight, 0)).toBeCloseTo(1, 5)
    expect(s.total).toBeGreaterThan(90)
  })

  it('每一句"为什么"里都有那个数，不是一句套话', () => {
    const s = scoreCreator(account({ followers: 48_000, engagement_rate: 0.05 }), {
      now,
      category: '家居',
    })
    expect(s.factors.find((f) => f.id === 'followers')?.why).toContain('48,000')
    expect(s.factors.find((f) => f.id === 'engagement')?.why).toContain('5.0%')
    expect(s.factors.find((f) => f.id === 'category')?.why).toContain('家居')
    expect(s.factors.find((f) => f.id === 'activity')?.why).toContain('2 天')
  })

  it('刷粉护栏：粉丝很多互动率低得离谱 → 互动率 0 分 + blocked，而且 blocked 与低分分得开', () => {
    const fake = scoreCreator(account({ followers: 800_000, engagement_rate: 0.001 }), { now })
    expect(fake.factors.find((f) => f.id === 'engagement')?.score).toBe(0)
    expect(fake.blocked).toContain('刷')
    // 总分照算：面板上要能同时说"他多少分"和"这个数不可信"
    expect(fake.total).toBeGreaterThan(0)

    const merelyWeak = scoreCreator(account({ followers: 40_000, engagement_rate: 0.02 }), { now })
    expect(merelyWeak.blocked).toBeUndefined()
  })

  it('不知道粉丝数给中间分并说清楚，不给 0（那会把没采到数的人永远压在最下面）', () => {
    const { followers: _drop, ...noFollowers } = account()
    const s = scoreCreator(noFollowers, { now })
    expect(s.factors.find((f) => f.id === 'followers')?.score).toBe(50)
    expect(s.factors.find((f) => f.id === 'followers')?.why).toContain('没采到')
  })

  it('数据太旧就直说：90 天前看到的数，活跃度见底', () => {
    const stale = scoreCreator(account({ observed_at: daysAgo(200) }), { now })
    const f = stale.factors.find((x) => x.id === 'activity')
    expect(f?.score).toBe(0)
    expect(f?.why).toContain('太旧')
  })

  it('语言按 BCP-47 前缀比：想要 zh 时 zh-Hans 算命中', () => {
    const s = scoreCreator(account({ language: 'zh-Hans', region: 'CN' }), {
      now,
      language: 'zh',
      region: 'cn',
    })
    expect(s.factors.find((f) => f.id === 'locale')?.score).toBe(100)
  })

  it('各渠道互动率基准不同：同样 5% 在 X 上是高分，在 TikTok 上不是', () => {
    const onX = scoreCreator(account({ channel: 'x', engagement_rate: 0.05 }), { now })
    const onTikTok = scoreCreator(account({ channel: 'tiktok', engagement_rate: 0.05 }), { now })
    const ex = onX.factors.find((f) => f.id === 'engagement')?.score ?? 0
    const et = onTikTok.factors.find((f) => f.id === 'engagement')?.score ?? 0
    expect(ex).toBeGreaterThan(et)
  })

  it('权重可覆盖：小众品类找小号时把粉丝带压轻', () => {
    const small = account({ followers: 3_000 })
    const normal = scoreCreator(small, { now })
    const tuned = scoreCreator(small, { now, weights: { followers: 0.01 } })
    expect(tuned.total).toBeGreaterThan(normal.total)
  })

  it('排序：刷粉的排在后面而不是被剔掉（悄悄拿掉会让人以为我们没搜到他）', () => {
    const ranked = rankCreators(
      [
        account({ followers: 800_000, engagement_rate: 0.0005, category: '数码' }),
        account({ followers: 20_000, engagement_rate: 0.01, category: '家居' }),
        account({ followers: 60_000, engagement_rate: 0.08, category: '数码' }),
      ],
      { now, category: '数码' },
    )
    expect(ranked).toHaveLength(3)
    expect(ranked[0]?.score.blocked).toBeUndefined()
    expect(ranked.at(-1)?.score.blocked).toBeDefined()
  })
})
