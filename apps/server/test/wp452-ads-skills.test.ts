/**
 * WP452（docs/109 §5.2 #12–16、§6.3）：投放第二批技能在服务端——体检十家一套、保本线、落地页一致性
 * （对不上的开事项）、实验设计与读结果（「保留 / 停 / 再测」卡、选了写回）、素材疲劳那一轮。
 *
 * 全是替身：落地页抓取、开事项、实验记忆、出卡都是假的；没碰任何真实广告后台、没调任何付费接口。
 */

import { fatigueThresholdsOf } from '@agentsws/ads-core'
import type { AdsExperimentReadoutPayload, ApprovalItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createAdsStore } from '../src/ads.js'
import { exportDeckData } from '../src/ads-data/export-view.js'
import { createAdsDataService } from '../src/ads-data/service.js'
import { ADS_SKILL_STATE } from '../src/ads-data/skill-tools.js'
import {
  adsSkillDeckData,
  experimentReadoutCard,
  experimentResultText,
  fatigueRound,
} from '../src/ads-data/skill-wiring.js'
import { type AdsDataRow, createAdsDataStore } from '../src/ads-data/store.js'
import { createAdsDataToolExecutor } from '../src/ads-data/tools.js'

const WS = 'ws_ads452'
const TODAY = '2026-10-20'

function make() {
  const ads = createAdsStore({ workspace_id: WS as never })
  const store = createAdsDataStore({})
  let n = 0
  const svc = createAdsDataService({
    workspace_id: WS,
    store,
    ads,
    now: () => `${TODAY}T04:00:00.000Z`,
    newId: (p) => `${p}_${++n}`,
    tzOffsetMinutes: () => 0,
    wanted: () => ['meta'],
  })
  return { svc, ads, store }
}

const metaRow = (day: string, ad: string, m: AdsDataRow['metrics']): AdsDataRow => ({
  platform: 'meta',
  account: 'act_1',
  day,
  key: `ad|${ad}`,
  import_id: 'imp_1',
  level: 'ad',
  campaign: 'Spring',
  campaign_id: 'c1',
  ad,
  ad_id: ad,
  status: 'enabled',
  metrics: m,
})

function seedMeta(h: ReturnType<typeof make>): void {
  const rows: AdsDataRow[] = []
  const days = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19']
  const clicks = [60, 62, 58, 50, 44, 38]
  const freq = [1.4, 1.5, 1.6, 1.9, 2.2, 2.5]
  days.forEach((day, i) => {
    rows.push(
      metaRow(day, 'Lamp A', {
        impressions: 2000,
        clicks: clicks[i] as number,
        frequency: freq[i] as number,
        cost: 30,
        conversions: 1,
        conversion_value: 60,
      }),
    )
  })
  h.store.replace({
    import: {
      id: 'imp_1',
      platform: 'meta',
      account: 'act_1',
      source: 'manual',
      name: 'meta.csv',
      level: 'ad',
      rows: rows.length,
      days,
      at: `${TODAY}T01:00:00Z`,
      notes: [],
      currency: 'USD',
    },
    rows,
  })
}

const req = (role_id: string) =>
  ({
    id: 'run_1',
    workspace_id: WS,
    actor: { person_id: 'p_1', assignment_id: 'as_1', role_id },
    work_item: { id: 'mt_1' },
  }) as never

function tools(h: ReturnType<typeof make>, over: Record<string, unknown> = {}) {
  const opened: { role_id: string; title: string; text: string }[] = []
  const cards: AdsExperimentReadoutPayload[] = []
  const experiments = new Map<string, unknown>()
  const exec = createAdsDataToolExecutor({
    service: () => h.svc,
    ads: () => h.ads,
    port: () => undefined,
    caps: () => ({}),
    hasApp: () => false,
    skills: {
      brand: () => WS,
      grossMargin: () => 40,
      landingPage: async () => ({
        raw: 'Desk Fixture Lamp $34.99. Free shipping over $50. Warm light.',
        rendered: 'Desk Fixture Lamp $34.99. Free shipping over $50. Sale 20% off',
      }),
      openMatter: async (input) => {
        opened.push(input)
        return { matter_id: `mt_${opened.length + 1}` }
      },
      experiments: {
        add: async (_r, input) => {
          const e = { id: `adexp_${experiments.size + 1}`, round: 1, at: TODAY, ...input }
          experiments.set(e.id, e)
          return e as never
        },
        get: (_r, id) => experiments.get(id) as never,
      },
      readoutCard: async (_r, payload) => {
        cards.push(payload)
        return { id: `ap_${cards.length}` }
      },
      now: () => `${TODAY}T04:00:00.000Z`,
      ...over,
    },
  })
  const call = async (name: string, role: string, input: Record<string, unknown> = {}) =>
    (await exec({ name, input, request: req(role) })) as {
      status: string
      reason?: string
      data: Record<string, unknown>
    }
  return { call, opened, cards }
}

describe('体检：十家一套、三态', () => {
  it('Meta（插件那一路的表）与 LinkedIn（只读）都出体检；三态计数', async () => {
    const h = make()
    seedMeta(h)
    const { call } = tools(h)
    const meta = await call('run_ads_audit', 'ads.meta')
    expect(meta.status).toBe('ok')
    expect(meta.data.verdicts).toMatchObject({
      pass: expect.any(Number),
      unknown: expect.any(Number),
    })
    const items = meta.data.items as { id: string; verdict: string }[]
    expect(items.find((i) => i.id === 'pixel_capi')?.verdict).toBe('unknown')
    expect(items.find((i) => i.id === 'currency_stated')?.verdict).toBe('pass')
    const li = await call('run_ads_audit', 'ads.linkedin')
    expect((li.data.items as { verdict: string }[]).every((i) => i.verdict === 'unknown')).toBe(
      true,
    )
    // 右栏那一块十家都有；Apple 认「卖的是什么」没 App → 一句话
    const deck = exportDeckData(h.svc, { has_app: false, brand: WS })
    expect(deck.audits.map((a) => a.platform)).toContain('meta')
    expect(deck.audits.find((a) => a.platform === 'apple')?.app_only).toBeDefined()
  })
  it('只读平台没有实验工具；老四家有', async () => {
    const { call } = tools(make())
    expect((await call('design_ads_experiment', 'ads.pinterest')).status).toBe('blocked')
    expect((await call('calc_break_even', 'ads.pinterest', { aov: 50 })).status).toBe('ok')
  })
})

describe('保本线', () => {
  it('毛利率没给读事实卡；缺的照实列；结论进右栏', async () => {
    const h = make()
    const { call } = tools(h)
    const out = await call('calc_break_even', 'ads.meta', { aov: 100 })
    expect(out.data).toMatchObject({ break_even_roas: 2.5, margin_from: '毛利率事实卡' })
    expect(out.data.ask).toEqual(['运费', '支付手续费', '退货率'])
    expect(adsSkillDeckData(h.svc).break_even_calc?.break_even_roas).toBe(2.5)
  })
})

describe('广告与落地页', () => {
  it('价格对不上 → 给自己开一件改广告；只靠 JS 的折扣 → 给网站运营开一件；7 天内同一份不重开', async () => {
    const h = make()
    const { call, opened } = tools(h)
    const input = {
      url: 'https://shop.example/lamp',
      ad_label: 'Lamp',
      texts: ['Desk Fixture Lamp — now $29.99, 20% off', 'Free shipping on orders over $50'],
    }
    const out = await call('check_ad_landing', 'ads.meta', input)
    expect(out.data.counts).toMatchObject({ to_fix: 2 })
    expect(opened.map((o) => o.role_id).sort()).toEqual(['ads.meta', 'dtc.store'])
    expect(opened.find((o) => o.role_id === 'dtc.store')?.text).toContain('只有开 JS 才看得到')
    expect(opened.find((o) => o.role_id === 'ads.meta')?.text).toContain('34.99')
    await call('check_ad_landing', 'ads.meta', input)
    expect(opened).toHaveLength(2)
    expect(adsSkillDeckData(h.svc).landing?.[0]?.platform).toBe('meta')
  })
  it('页抓不到：全部未知、不开事项', async () => {
    const h = make()
    const { call, opened } = tools(h, { landingPage: async () => ({ note: '落地页没抓到。' }) })
    const out = await call('check_ad_landing', 'ads.meta', {
      url: 'https://shop.example/x',
      texts: ['$19.99 today'],
    })
    expect(out.data.counts).toMatchObject({ unknown: 1, to_fix: 0 })
    expect(opened).toHaveLength(0)
  })
})

describe('实验：设计 → 读结果 → 卡 → 写回', () => {
  it('基准与每天的量从库里算；样本量规则算；记进实验记忆', async () => {
    const h = make()
    seedMeta(h)
    const { call } = tools(h)
    const out = await call('design_ads_experiment', 'ads.meta', {
      hypothesis: '标题带价格点击率更高',
      change: '只换标题',
      metric: 'ctr',
      mde_rel_pct: 20,
    })
    const plan = out.data.plan as {
      baseline_rate: number
      daily_units: number
      per_arm: number
      days: number
      baseline_from: string
    }
    expect(plan.baseline_rate).toBeCloseTo(312 / 12000, 6)
    expect(plan.daily_units).toBe(2000)
    expect(plan.baseline_from).toContain('近 30 天')
    expect(plan.per_arm).toBeGreaterThan(0)
    expect(out.data.experiment_id).toBe('adexp_1')
  })
  it('读结果出卡；建议排第一、带「建议」；选了写回结论', async () => {
    const h = make()
    seedMeta(h)
    const { call, cards } = tools(h)
    const d = await call('design_ads_experiment', 'ads.meta', {
      hypothesis: '标题带价格',
      change: '只换标题',
      metric: 'ctr',
      baseline_rate: 0.02,
      daily_units: 6000,
      mde_rel_pct: 20,
    })
    const r = await call('read_ads_experiment', 'ads.meta', {
      experiment_id: d.data.experiment_id,
      arms: [
        { id: 'base', units: 21200, successes: 424 },
        { id: 'v1', label: '带价格', units: 21200, successes: 530 },
      ],
    })
    expect(r.data.card_id).toBe('ap_1')
    const payload = cards[0] as AdsExperimentReadoutPayload
    expect(payload.recommended).toBe('keep')
    const card = experimentReadoutCard(req('ads.meta'), payload)
    expect(card.kind).toBe('ads_experiment_readout')
    expect(card.options?.[0]).toMatchObject({ id: 'keep' })
    expect(card.options?.[0]?.label).toContain('建议')
    expect(card.subject.matter_id).toBe('mt_1')
    const decided = {
      ...card,
      state: 'approved',
      decision: {
        action: 'approve',
        by: 'p_1',
        at: TODAY,
        via: 'workstation',
        selected_option_id: 'stop',
      },
    } as unknown as ApprovalItem
    const text = experimentResultText(decided)
    expect(text).toMatch(/^停。v1/)
    expect(text).toContain('建议是「保留」')
    expect(experimentResultText({ ...decided, state: 'rejected' } as ApprovalItem)).toBeUndefined()
  })
})

describe('素材疲劳那一轮', () => {
  it('点击率连降 + 频次连涨 → 建议 + 换素材单（同一轮最多下额度那么多张）；进右栏', async () => {
    const h = make()
    seedMeta(h)
    const need: string[] = []
    const out = await fatigueRound({
      platform: 'meta',
      rows: h.svc.rows({ since: '2026-09-20', until: TODAY, platform: 'meta', levels: ['ad'] }),
      today: TODAY,
      thresholds: fatigueThresholdsOf({}),
      autoRequest: true,
      maxRequests: 5,
      requestDesign: async (n) => {
        need.push(n.title)
        return 'dreq_1'
      },
      getState: (k) => h.svc.getState?.(k),
      setState: (k, v) => h.svc.setState?.(k, v),
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.signals).toEqual(['ctr_declining', 'frequency_rising'])
    expect(need).toEqual(['换素材：Lamp A（素材疲劳）'])
    expect(adsSkillDeckData(h.svc).fatigue?.[0]?.design_request_id).toBe('dreq_1')
    // 开关关掉：只给建议不下单
    const quiet = await fatigueRound({
      platform: 'meta',
      rows: h.svc.rows({ since: '2026-09-20', until: TODAY, platform: 'meta', levels: ['ad'] }),
      today: TODAY,
      thresholds: fatigueThresholdsOf({}),
      autoRequest: false,
      maxRequests: 5,
      requestDesign: async () => 'never',
      getState: (k) => h.svc.getState?.(k),
      setState: (k, v) => h.svc.setState?.(k, v),
    })
    expect(quiet[0]?.design_request_id).toBeUndefined()
    expect(h.svc.getState?.(ADS_SKILL_STATE.fatigue)).toHaveLength(1)
  })
})
