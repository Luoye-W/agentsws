/**
 * WP75（57 §1 / §6、04 §5）：投放那五道门。
 *
 * 04 §5 那条额度纪律拆成机器能判的五句话，这个文件逐句钉住：
 * **减少花钱可以自动（止损 L3）、额度内调整 L2、开花钱口子永远 L1、
 * 总闸满了新开口子直接拦、广告文案里不许有承诺。**
 */
import type { Mandate } from '@agentsws/contracts'
import { ADS_DEFAULT_CAPS } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { AD_COPY_FORBIDDEN, evaluateGuardrail, HARD_L1, Provenance } from '../src/index.js'

const now = '2026-09-17T09:00:00Z'
const campaign = { type: 'campaign', id: 'cmp_1' } as const
const ad = { type: 'ad', id: 'ad_1' } as const

/** 四条投放职责共用的那一份 caps（57 §6 的默认值）。 */
const adsMandate: Mandate = {
  caps: { ...ADS_DEFAULT_CAPS },
  per_change_limits: { max_items: 1, no_repeat_target_field: true },
  window: { max_count: 20, per: 'day' },
}

const prov = (ref: { type: string; id: string }, full = true) => {
  const p = new Provenance('run_1')
  p.see([ref as never], { full })
  return p
}
const facts = (over: Partial<Parameters<typeof evaluateGuardrail>[2]> = {}) => ({
  now,
  changeSet: [],
  windowCount: 0,
  provenance: prov(campaign),
  ...over,
})
const rules = (r: ReturnType<typeof evaluateGuardrail>): string[] => r.hits.map((h) => h.rule)

describe('WP75 · 预算与出价（57 §6：delta 20% / 15%）', () => {
  const budget = (before: number, after: number) => ({
    kind: 'budget_change' as const,
    target: campaign,
    before: { value: before },
    after: { value: after },
  })

  it('额度内提预算（+10%）自己走：一条 hit 都没有', () => {
    const r = evaluateGuardrail(budget(100, 110), adsMandate, facts(), 'stage')
    expect(r.verdict).toBe('allow')
  })

  it('提预算超 20% → 升 L1（require_review），而且报的是 57 §6 那个 cap 名', () => {
    const r = evaluateGuardrail(budget(100, 130), adsMandate, facts(), 'stage')
    expect(r.verdict).toBe('require_review')
    expect(rules(r)).toContain('max_budget_delta_pct')
  })

  it('**调低**预算幅度再大也不撞总闸（04 §5：减少花钱的动作从宽）', () => {
    const r = evaluateGuardrail(
      budget(500, 100),
      adsMandate,
      facts({ dailySpendTotal: 990 }),
      'stage',
    )
    // 幅度超了 20%，所以还是要人点一下；但总闸那一条不该响
    expect(rules(r)).toContain('max_budget_delta_pct')
    expect(rules(r)).not.toContain('max_daily_spend')
  })

  it('提上去的那一截会突破岗位级总闸 → 升 L1（不是 block：人点一下能过）', () => {
    const r = evaluateGuardrail(
      // 幅度只有 10%，delta 那条不响；响的只有总闸
      budget(100, 110),
      adsMandate,
      // 四个平台今天已经花了 995，再提上去 10 就过 1000 了
      facts({ dailySpendTotal: 995 }),
      'stage',
    )
    expect(r.verdict).toBe('require_review')
    expect(rules(r)).toContain('max_daily_spend')
    expect(r.hits.find((h) => h.rule === 'max_daily_spend')?.severity).toBe('review')
  })

  it('出价超 15% → 升 L1', () => {
    const r = evaluateGuardrail(
      { kind: 'bid_change', target: campaign, before: { value: 2 }, after: { value: 2.4 } },
      adsMandate,
      facts(),
      'stage',
    )
    expect(rules(r)).toContain('max_bid_delta_pct')
  })

  it('15 §2 那两个老 cap 名照样认（`max_budget_change_pct`）——契约只加不删', () => {
    const legacy: Mandate = { caps: { max_budget_change_pct: 20 } }
    const r = evaluateGuardrail(budget(100, 130), legacy, facts(), 'stage')
    expect(rules(r)).toContain('max_budget_change_pct')
  })
})

describe('WP75 · 新建 campaign（04 §5：开花钱口子永远 L1）', () => {
  const create = (daily_budget: number) => ({
    kind: 'create_campaign' as const,
    target: campaign,
    before: {},
    after: { name: '桌面收纳 · 九月', daily_budget },
  })

  it('`create_campaign` 在 HARD_L1 里 —— 报什么等级都按回人审', () => {
    expect(HARD_L1.has('create_campaign')).toBe(true)
    const r = evaluateGuardrail(create(100), adsMandate, facts({ dailySpendTotal: 0 }), 'stage')
    expect(r.verdict).toBe('require_review')
    expect(rules(r)).toContain('hard_ceiling')
  })

  it('总闸已经满了还要新开一个花钱口子 → **block**，不是让人点一下', () => {
    const r = evaluateGuardrail(create(200), adsMandate, facts({ dailySpendTotal: 980 }), 'stage')
    expect(r.verdict).toBe('block')
    const hit = r.hits.find((h) => h.rule === 'max_daily_spend')
    expect(hit?.severity).toBe('block')
    // 拦下来那句话要带着数：总闸多少、算出来多少
    expect(hit?.cap).toBe(1000)
    expect(hit?.actual).toBe(1180)
  })
})

describe('WP75 · 暂停（04 §5：止损是保护性动作，L3）', () => {
  const pause = (after: Record<string, unknown>) => ({
    kind: 'pause_ad' as const,
    target: campaign,
    before: { status: 'active' },
    after,
  })

  it('真的止损（ROAS 0.6 < 1，花了 400 > 日预算 1000 的 30%）→ 一条 hit 都没有', () => {
    const r = evaluateGuardrail(
      pause({ reason: 'stop_loss', roas: 0.6, spend: 400, daily_budget: 1000 }),
      adsMandate,
      facts(),
      'stage',
    )
    expect(r.verdict).toBe('allow')
  })

  it('写着止损但判据不成立（ROAS 2.1）→ 转人审，**不是** block', () => {
    const r = evaluateGuardrail(
      pause({ reason: 'stop_loss', roas: 2.1, spend: 400, daily_budget: 1000 }),
      adsMandate,
      facts(),
      'stage',
    )
    expect(r.verdict).toBe('require_review')
    expect(rules(r)).toContain('stop_loss_conditions_unmet')
  })

  it('写着止损但两格没给全 → 转人审（"不知道"不算"越了线"）', () => {
    const r = evaluateGuardrail(pause({ reason: 'stop_loss' }), adsMandate, facts(), 'stage')
    expect(rules(r)).toContain('stop_loss_conditions_unmet')
  })

  it('花得还不够多（100 < 300）也不算止损：两条判据是「且」不是「或」', () => {
    const r = evaluateGuardrail(
      pause({ reason: 'stop_loss', roas: 0.2, spend: 100, daily_budget: 1000 }),
      adsMandate,
      facts(),
      'stage',
    )
    expect(rules(r)).toContain('stop_loss_conditions_unmet')
  })

  it('普通暂停（`campaign_ended`）自己走，不被止损那道门碰', () => {
    const r = evaluateGuardrail(pause({ reason: 'campaign_ended' }), adsMandate, facts(), 'stage')
    expect(r.verdict).toBe('allow')
  })

  it('理由写不出来 → block（不然每条暂停都会写着"止损"）', () => {
    const r = evaluateGuardrail(pause({}), adsMandate, facts(), 'stage')
    expect(r.verdict).toBe('block')
    expect(rules(r)).toContain('ad_pause_reason_required')
  })
})

describe('WP75 · 换素材（57 §1：文案过承诺扫描）', () => {
  const swap = (after: Record<string, unknown>) => ({
    kind: 'creative_swap' as const,
    target: ad,
    before: { primary_text: '桌面收纳，三档可调。' },
    after,
  })
  const adFacts = (over: Partial<Parameters<typeof evaluateGuardrail>[2]> = {}) =>
    facts({ provenance: prov(ad), ...over })

  it('干净的新文案自己走', () => {
    const r = evaluateGuardrail(
      swap({ primary_text: '桌面收纳，三档可调，线材一次收齐。' }),
      adsMandate,
      adFacts(),
      'stage',
    )
    expect(r.verdict).toBe('allow')
  })

  it('效果保证 → block（不给"人点一下就发出去"的路径）', () => {
    const r = evaluateGuardrail(
      swap({ primary_text: '投了就保证出单，无效退款。' }),
      adsMandate,
      adFacts(),
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(rules(r)).toContain('ad_copy_commitment')
  })

  it('极限词（广告法第九条）→ block', () => {
    const r = evaluateGuardrail(
      swap({ headline: '全网最低价，今天下单立省' }),
      adsMandate,
      adFacts(),
      'stage',
    )
    expect(r.verdict).toBe('block')
  })

  it('没人批准过的促销 → block（促销要走 `promotion`，那条永远人审）', () => {
    const r = evaluateGuardrail(
      swap({ body: '买一送一，仅此一天' }),
      adsMandate,
      adFacts(),
      'stage',
    )
    expect(r.verdict).toBe('block')
  })

  it('换素材顺手换受众 → 受保护字段，block', () => {
    const r = evaluateGuardrail(
      {
        kind: 'creative_swap',
        target: ad,
        before: { primary_text: '旧文案', audience: '25-34 男' },
        after: { primary_text: '新文案', audience: '18-24 女' },
      },
      adsMandate,
      adFacts(),
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(rules(r)).toContain('protected_field')
  })

  it('没把这条广告读全就改 → block（`before` 就是那段正文）', () => {
    const r = evaluateGuardrail(
      swap({ primary_text: '新文案' }),
      adsMandate,
      facts({ provenance: prov(ad, false) }),
      'stage',
    )
    expect(rules(r)).toContain('requires_record_read')
  })

  it('一天改到第 21 条 → 转人审（`max_changes_per_day` 20）', () => {
    const r = evaluateGuardrail(
      swap({ primary_text: '新文案' }),
      adsMandate,
      adFacts({ windowCount: 20 }),
      'stage',
    )
    expect(rules(r)).toContain('max_changes_per_day')
  })

  it('禁语表大小写不敏感', () => {
    const r = evaluateGuardrail(
      swap({ primary_text: 'Guaranteed Results, or your money back' }),
      adsMandate,
      adFacts(),
      'stage',
    )
    expect(r.verdict).toBe('block')
  })

  it('禁语表只可加行：三类都在', () => {
    expect(AD_COPY_FORBIDDEN).toContain('保证出单')
    expect(AD_COPY_FORBIDDEN).toContain('全网最低')
    expect(AD_COPY_FORBIDDEN).toContain('买一送一')
  })
})
