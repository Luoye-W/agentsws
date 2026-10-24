/**
 * WP452（docs/109 §5.2 #12–16）：投放右栏的几块——体检三态（老四家也有）、保本线、素材疲劳、广告与落地页。
 * 都是资料（右栏）；决定在中栏出卡。没算过 / 没核过就是空表。
 */
import { describe, expect, it } from 'vitest'
import {
  type AdsDeckData,
  blocksForRole,
  type QueryContext,
  runQuery,
  type TableResult,
} from '../src/index.js'
import { queryContext, SOURCES } from './fixtures.js'

const withAds = SOURCES.map((s) => (s.id === 'ads' ? { ...s, connected: true } : s))
const base: AdsDeckData = {
  spend_gate: { spent: 0, cap: 1000, remaining: 1000, by_platform: [], missing: [] },
  campaigns: [],
  pending: [],
  stop_losses: [],
  pixels: [],
  attribution: [],
}
const deck: AdsDeckData = {
  ...base,
  audits: [
    {
      platform: 'meta',
      items: [
        {
          id: 'fresh_data',
          title: { zh: '数是不是新的', en: '' },
          status: 'ok',
          note: '到 10-19',
          evidence: 'export',
          verdict: 'pass',
        },
        {
          id: 'timezone_stated',
          title: { zh: '报表写了时区', en: '' },
          status: 'look',
          note: '没写',
          evidence: 'export',
          verdict: 'fail',
        },
        {
          id: 'pixel_capi',
          title: { zh: '像素', en: '' },
          status: 'unknown',
          note: '去看',
          evidence: 'backend',
          verdict: 'unknown',
        },
      ],
    },
  ],
  break_even_calc: {
    input: { aov: 100, gross_margin_pct: 40 },
    contribution: 40,
    break_even_cpa: 40,
    break_even_roas: 2.5,
    missing: ['shipping', 'payment_fee_pct', 'return_rate_pct'],
    computable: true,
    formula: '每单剩 = 100 − 货本 60 = 40',
    margin_from: '毛利率事实卡',
  },
  fatigue: [
    {
      platform: 'meta',
      account: 'acc',
      campaign: 'Spring',
      ad: 'Lamp video A',
      signals: ['ctr_declining', 'frequency_rising'],
      evidence: ['点击率连降 3 天', '频次连涨 3 天'],
      suggestion: '换一版',
      design_request_id: 'dreq_1',
      day: '2026-10-20',
    },
    {
      platform: 'google',
      account: 'g',
      ad: 'RSA 1',
      signals: ['ctr_declining'],
      evidence: [],
      suggestion: 'x',
      day: '2026-10-20',
    },
  ],
  landing: [
    {
      platform: 'meta',
      url: 'https://shop.example/lamp',
      ad_label: 'Lamp',
      items: [
        {
          claim: { kind: 'price', text: '29.99', value: '29.99' },
          raw: 'absent',
          rendered: 'absent',
          verdict: 'mismatch',
          page_values: ['34.99'],
          fix: 'ad',
          note: '广告说价格「29.99」，页上写的是 34.99。',
        },
      ],
    },
  ],
}
const run = (name: string, role: string, ads: AdsDeckData = deck): TableResult => {
  const ctx: QueryContext = queryContext({ role_id: role, sources: withAds, ads })
  const r = runQuery(name, ctx, 'last_7d')
  if (r.status !== 'ok') throw new Error(`${name} not ok`)
  return r.data as TableResult
}

describe('WP452 投放右栏几块', () => {
  it('老四家也有体检、保本线、素材疲劳、广告与落地页', () => {
    const q = blocksForRole('ads.meta').map((b) => b.query)
    for (const name of [
      'ads.export_audit',
      'ads.break_even_calc',
      'ads.creative_fatigue',
      'ads.landing_checks',
    ])
      expect(q).toContain(name)
  })
  it('体检结果写成三态：过 / 不过 / 未知', () => {
    expect(run('ads.export_audit', 'ads.meta').rows.map((r) => r.status)).toEqual([
      '过',
      '不过',
      '未知',
    ])
  })
  it('保本线：给了的照写、没给的写「没给，没算」、毛利率写从哪来', () => {
    const rows = run('ads.break_even_calc', 'ads.meta').rows
    expect(rows).toContainEqual({ item: '毛利率', value: '40（毛利率事实卡）' })
    expect(rows).toContainEqual({ item: '运费', value: '没给，没算' })
    expect(rows).toContainEqual({ item: '保本 ROAS', value: '2.5' })
    expect(run('ads.break_even_calc', 'ads.meta', base).rows).toEqual([])
  })
  it('素材疲劳与落地页核对按职责的平台筛', () => {
    const f = run('ads.creative_fatigue', 'ads.meta').rows
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ signals: '点击率连降、频次在涨', request: '已下给设计岗' })
    expect(run('ads.creative_fatigue', 'ads.google').rows[0]?.request).toBe('没下')
    const l = run('ads.landing_checks', 'ads.meta').rows
    expect(l[0]).toMatchObject({ verdict: '页上写的不一样', fix: '改广告' })
    expect(run('ads.landing_checks', 'ads.google').rows).toEqual([])
  })
})
