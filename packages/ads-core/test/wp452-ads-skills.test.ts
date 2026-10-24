/**
 * WP452（docs/109 §5.2 #12–16）：投放第二批技能的纯函数。
 *
 * 钉住：体检十家共用一张数据表、三态、没证据未知、订阅来的清单按品牌覆盖（坏表回落）；
 * 样本量 / 时长与手算一致；保本 ROAS 和 `economics.ts` 一个数；落地页对不上的分得清谁改；素材疲劳不单凭跑得久。
 */
import { registerContentTableProvider } from '@agentsws/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type AdsReportRow,
  AUDIT_CHECKLIST_TABLE,
  adsReportRows,
  auditChecklist,
  breakEvenRoas,
  breakEvenTargets,
  checkLanding,
  creativeFatigue,
  designExperiment,
  experimentDays,
  extractAdClaims,
  fatigueThresholdsOf,
  normInv,
  parseAdsExport,
  readExperiment,
  runAdsAudit,
  sampleSizePerArm,
} from '../src/index.js'

const row = (
  day: string,
  m: AdsReportRow['metrics'],
  extra: Partial<AdsReportRow> = {},
): AdsReportRow => ({
  level: 'campaign',
  day,
  campaign: 'Spring',
  campaign_id: 'c1',
  status: 'enabled',
  metrics: m,
  ...extra,
})

describe('账户体检：十家一张表、三态', () => {
  let undo: (() => void) | undefined
  afterEach(() => {
    undo?.()
    undo = undefined
  })

  it('表里十家都有自己的后台项，外加十家共用的六项报表项', () => {
    for (const p of [
      'meta',
      'google',
      'tiktok',
      'x',
      'microsoft',
      'pinterest',
      'reddit',
      'linkedin',
      'snapchat',
      'apple',
    ] as const) {
      const list = auditChecklist(p)
      expect(list.filter((c) => c.evidence.kind === 'export')).toHaveLength(6)
      expect(list.filter((c) => c.evidence.kind === 'backend').length).toBeGreaterThanOrEqual(4)
    }
    expect(AUDIT_CHECKLIST_TABLE.table).toBe('ads.audit_checklist')
  })

  it('Meta 样本：报表能判的给过 / 不过，后台项一律未知、写清去哪看', () => {
    const r = runAdsAudit({
      platform: 'meta',
      today: '2026-10-20',
      latest: { currency: 'USD', until: '2026-10-19' },
      rows: [
        row('2026-10-19', { cost: 120, conversions: 4, conversion_value: 360 }),
        row(
          '2026-10-19',
          { cost: 80, conversions: 0, conversion_value: 0 },
          { campaign: 'Retarget', campaign_id: 'c2' },
        ),
      ],
    })
    const by = Object.fromEntries(r.items.map((i) => [i.id, i]))
    expect(by.fresh_data?.verdict).toBe('pass')
    expect(by.currency_stated?.verdict).toBe('pass')
    expect(by.timezone_stated?.verdict).toBe('fail')
    expect(by.zero_conversion_spenders?.verdict).toBe('fail')
    expect(by.zero_conversion_spenders?.note).toContain('Retarget')
    expect(by.pixel_capi?.verdict).toBe('unknown')
    expect(by.pixel_capi?.note).toContain('事件管理工具')
    expect(r.verdicts).toEqual({ pass: 4, fail: 2, unknown: 6 })
  })

  it('Microsoft 样本：没有报表时报表项也是未知（不猜）', () => {
    const r = runAdsAudit({ platform: 'microsoft', today: '2026-10-20', rows: [] })
    expect(r.items.every((i) => i.verdict === 'unknown')).toBe(true)
    expect(r.verdicts?.pass).toBe(0)
  })

  it('订阅来的正式清单按品牌覆盖；要出处没出处的不下结论；坏表回落基础版', () => {
    const official = [
      ...AUDIT_CHECKLIST_TABLE.rows.filter((r) => r.platform !== 'google'),
      {
        id: 'google.fresh_strict',
        platform: 'google' as const,
        check: 'fresh_strict',
        title: { zh: '数是新的（官方口径）', en: 'Fresh (official)' },
        evidence: { kind: 'export' as const, rule: 'fresh_data' as const },
        needs_source: true,
      },
      {
        id: 'google.fresh_cited',
        platform: 'google' as const,
        check: 'fresh_cited',
        title: { zh: '数是新的（带出处）', en: 'Fresh (cited)' },
        evidence: { kind: 'export' as const, rule: 'fresh_data' as const },
        needs_source: true,
        source: { title: '官方帮助', url: 'https://example.com/help', checked_on: '2026-10-20' },
      },
    ]
    undo = registerContentTableProvider((table, brand) =>
      table === 'ads.audit_checklist' && brand === 'ws_a' ? official : undefined,
    )
    const r = runAdsAudit({
      platform: 'google',
      brand: 'ws_a',
      today: '2026-10-20',
      rows: [row('2026-10-19', { cost: 10, conversions: 1 })],
    })
    const by = Object.fromEntries(r.items.map((i) => [i.id, i]))
    expect(by.fresh_strict?.verdict).toBe('unknown')
    expect(by.fresh_cited?.verdict).toBe('pass')
    expect(by.fresh_cited?.note).toContain('核于 2026-10-20')
    expect(by.conversion_actions).toBeUndefined()
    // 别的品牌照旧是基础版
    expect(
      auditChecklist('google', { brand: 'ws_b' }).some((c) => c.id === 'conversion_actions'),
    ).toBe(true)
    undo()
    undo = registerContentTableProvider(() => [{ id: 'bad', platform: 'google' }] as never)
    expect(auditChecklist('google').some((c) => c.id === 'conversion_actions')).toBe(true)
  })
})

describe('实验设计：样本量与时长和手算一致', () => {
  it('z 值', () => {
    expect(normInv(0.975)).toBeCloseTo(1.959964, 5)
    expect(normInv(0.8)).toBeCloseTo(0.841621, 5)
  })

  it('点击率 2%、想看出提升 20%、α 0.05、把握 0.8 → 每版 21109 次展示', () => {
    // 手算：p1 = 0.02，p2 = 0.024，p̄ = 0.022
    // 1.959964 × √(2 × 0.022 × 0.978) = 1.959964 × 0.207442 = 0.406579
    // 0.841621 × √(0.02 × 0.98 + 0.024 × 0.976) = 0.841621 × 0.207422 = 0.174571
    // (0.406579 + 0.174571)² ÷ 0.004² = 0.337735 ÷ 0.000016 = 21108.4 → 21109
    expect(sampleSizePerArm({ baseline_rate: 0.02, mde_rel_pct: 20 })).toBe(21109)
  })

  it('每天 6000 次展示、两版 → 21109 × 2 ÷ 6000 = 7.04 → 8 天；量大时也至少 7 天', () => {
    expect(experimentDays({ per_arm: 21109, arms: 2, daily_units: 6000 })).toBe(8)
    expect(experimentDays({ per_arm: 100, arms: 2, daily_units: 6000 })).toBe(7)
  })

  it('缺基准、缺每天的量就列进 missing，不拿默认值顶上', () => {
    const plan = designExperiment({
      hypothesis: '标题带价格点击率更高',
      change: '只换标题',
      metric: 'ctr',
    })
    expect(plan.per_arm).toBe(0)
    expect(plan.missing.join('|')).toContain('基准点击率')
    expect(plan.missing.join('|')).toContain('最小提升')
    expect(plan.missing.join('|')).toContain('每天能进实验的展示数')
  })

  it('齐了：出样本量、天数、护栏与什么算赢', () => {
    const plan = designExperiment({
      hypothesis: '标题带价格点击率更高',
      change: '只换标题',
      metric: 'ctr',
      baseline_rate: 0.02,
      mde_rel_pct: 20,
      daily_units: 6000,
      guardrails: [{ metric: 'CPA', higher_is_better: false, max_worse_pct: 10 }],
    })
    expect(plan).toMatchObject({ per_arm: 21109, total: 42218, days: 8, missing: [] })
    expect(plan.win_rule).toContain('21109')
    expect(plan.win_rule).toContain('CPA变差不超过 10%')
  })
})

describe('读结果：保留 / 停 / 再测', () => {
  const plan = {
    per_arm: 20000,
    alpha: 0.05,
    mde_rel_pct: 20,
    metric: 'ctr' as const,
    guardrails: [{ metric: 'CPA', higher_is_better: false, max_worse_pct: 10 }],
  }
  it('没跑够 → 再测', () => {
    const r = readExperiment({
      plan,
      arms: [
        { id: 'base', units: 5000, successes: 100 },
        { id: 'v1', units: 5000, successes: 160 },
      ],
    })
    expect(r.verdict).toBe('retest')
    expect(r.reached).toBe(false)
  })
  it('显著变好 → 保留；护栏破了 → 停', () => {
    const arms = [
      { id: 'base', units: 21000, successes: 420, guardrails: { CPA: 20 } },
      { id: 'v1', units: 21000, successes: 520, guardrails: { CPA: 21 } },
    ]
    const r = readExperiment({ plan, arms })
    expect(r.verdict).toBe('keep')
    expect(r.comparisons[0]?.significant).toBe(true)
    expect(r.comparisons[0]?.lift_pct).toBe(23.81)
    const g = readExperiment({
      plan,
      arms: [arms[0] as never, { ...(arms[1] as object), guardrails: { CPA: 23 } } as never],
    })
    expect(g.verdict).toBe('stop')
    expect(g.guardrail_breaches[0]).toMatchObject({ metric: 'CPA', worse_pct: 15 })
  })
  it('跑满了没分出高下：上限够不着最小提升 → 停；够得着 → 再测', () => {
    const flat = readExperiment({
      plan,
      arms: [
        { id: 'base', units: 200000, successes: 4000 },
        { id: 'v1', units: 200000, successes: 4010 },
      ],
    })
    expect(flat.verdict).toBe('stop')
    const wide = readExperiment({
      plan: { ...plan, per_arm: 1000 },
      arms: [
        { id: 'base', units: 1000, successes: 20 },
        { id: 'v1', units: 1000, successes: 24 },
      ],
    })
    expect(wide.verdict).toBe('retest')
  })
})

describe('盈亏平衡与目标', () => {
  it('只给毛利率时和 economics.ts 的盈亏线一个数', () => {
    for (const m of [40, 25, 33]) {
      const r = breakEvenTargets({ aov: 100, gross_margin_pct: m })
      expect(r.break_even_roas).toBe(breakEvenRoas(m))
    }
  })
  it('运费、手续费、退货一起算；目标利润出目标 CPA / ROAS', () => {
    // 100 × (1 − 10%) − 40 − 8 − (3% × 100 + 0.3) = 90 − 40 − 8 − 3.3 = 38.7
    const r = breakEvenTargets({
      aov: 100,
      cogs: 40,
      shipping: 8,
      payment_fee_pct: 3,
      payment_fee_fixed: 0.3,
      return_rate_pct: 10,
      target_profit_pct: 10,
    })
    expect(r).toMatchObject({
      contribution: 38.7,
      break_even_cpa: 38.7,
      break_even_roas: 2.58,
      target_cpa: 28.7,
      target_roas: 3.48,
      missing: [],
    })
  })
  it('缺的照实列出来；缺客单价 / 毛利就算不了', () => {
    expect(breakEvenTargets({ gross_margin_pct: 40 }).computable).toBe(false)
    const r = breakEvenTargets({ aov: 50, gross_margin_pct: 40 })
    expect(r.missing).toEqual(['shipping', 'payment_fee_pct', 'return_rate_pct'])
  })
})

describe('广告与落地页说法一致性', () => {
  const ad = ['Desk Fixture Lamp — now $29.99, 20% off', 'Free shipping on orders over $50']
  it('抽出价格、折扣、包邮；「满 $50」是门槛不是价格', () => {
    const claims = extractAdClaims({ texts: ad, selling_points: ['Dimmable warm light'] })
    expect(claims.map((c) => `${c.kind}:${c.value}`)).toEqual([
      'price:29.99',
      'discount:20%',
      'free_shipping:free_shipping',
      'selling_point:Dimmable warm light',
    ])
  })
  it('页上价格不一样 → 改广告；只靠 JS 的折扣 → 改页面；没写的卖点 → 改页面', () => {
    const claims = extractAdClaims({ texts: ad, selling_points: ['Dimmable warm light'] })
    const items = checkLanding({
      claims,
      raw: 'Desk Fixture Lamp $34.99 Free shipping over $50. Warm light.',
      rendered: 'Desk Fixture Lamp $34.99 Free shipping over $50. Sale 20% off',
    })
    const by = Object.fromEntries(items.map((i) => [i.claim.kind, i]))
    expect(by.price).toMatchObject({
      verdict: 'mismatch',
      fix: 'ad',
      page_values: ['34.99', '50.00'],
    })
    expect(by.discount).toMatchObject({ verdict: 'js_only', fix: 'page' })
    expect(by.free_shipping?.verdict).toBe('ok')
    expect(by.selling_point).toMatchObject({ verdict: 'missing', fix: 'page' })
  })
  it('页抓不到 → 全部未知', () => {
    const items = checkLanding({ claims: extractAdClaims({ texts: ad }) })
    expect(items.every((i) => i.verdict === 'unknown' && i.fix === undefined)).toBe(true)
  })
})

describe('素材疲劳', () => {
  const adRow = (
    day: string,
    impressions: number,
    clicks: number,
    frequency?: number,
  ): AdsReportRow => ({
    level: 'ad',
    day,
    campaign: 'Spring',
    ad: 'Lamp video A',
    ad_id: 'a1',
    status: 'enabled',
    metrics: { impressions, clicks, ...(frequency === undefined ? {} : { frequency }) },
  })
  it('点击率连降 + 频次连涨 → 有建议；跑得久只当佐证', () => {
    const rows = [
      adRow('2026-10-10', 2000, 60, 1.4),
      adRow('2026-10-11', 2000, 62, 1.6),
      adRow('2026-10-12', 2000, 50, 1.9),
      adRow('2026-10-13', 2000, 44, 2.2),
      adRow('2026-10-14', 2000, 38, 2.5),
    ]
    const out = creativeFatigue({ rows, platform: 'meta', account: 'acc', today: '2026-10-15' })
    expect(out).toHaveLength(1)
    expect(out[0]?.signals).toEqual(['ctr_declining', 'frequency_rising'])
    const long = creativeFatigue({
      rows,
      platform: 'meta',
      account: 'acc',
      today: '2026-10-15',
      thresholds: { long_running_days: 5 },
    })
    expect(long[0]?.signals).toContain('long_running')
  })
  it('只是跑得久、点击率平稳 → 不算疲劳；展示太少的天不算', () => {
    const flat = Array.from({ length: 30 }, (_, i) =>
      adRow(`2026-09-${String(i + 1).padStart(2, '0')}`, 2000, 60),
    )
    expect(
      creativeFatigue({ rows: flat, platform: 'meta', account: 'a', today: '2026-10-01' }),
    ).toEqual([])
    const thin = [
      adRow('2026-10-10', 100, 9),
      adRow('2026-10-11', 100, 6),
      adRow('2026-10-12', 100, 3),
      adRow('2026-10-13', 100, 1),
    ]
    expect(
      creativeFatigue({ rows: thin, platform: 'meta', account: 'a', today: '2026-10-14' }),
    ).toEqual([])
  })
  it('门槛从职责 thresholds 读（没写用起步值）', () => {
    expect(fatigueThresholdsOf({ fatigue_ctr_drop_days: 4 }).ctr_drop_days).toBe(4)
    expect(fatigueThresholdsOf(undefined).ctr_drop_pct).toBe(20)
  })
  it('导出表的「Frequency」列认得出', () => {
    const parsed = parseAdsExport(
      'Ad name,Campaign name,Day,Impressions,Link clicks,Frequency,Amount spent\nLamp,Spring,2026-10-14,2000,38,2.5,30\n',
      { platform: 'meta' },
    )
    expect(adsReportRows(parsed)[0]?.metrics.frequency).toBe(2.5)
  })
})
