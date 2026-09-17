/**
 * WP78（60 §1 / §2）：公共关系那三条 ChangeKind 的门。
 *
 * 三件事在这里钉死，别处都改不动它们：
 *
 * 1. `community_post` 在 `HARD_L1` 里（在别人的地盘上发东西**永远人审**），
 *    而且版规与冷却是 **block** 不是转人审；
 * 2. `press_release` 里的每个数字都要有出处，引语必须带 `provided_by`；
 * 3. `mention_triage` 只判形状（类与情绪各是封闭集合里的一个）。
 */
import type { Mandate } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  evaluateGuardrail,
  extractFigures,
  HARD_L1,
  KIND_RISK,
  Provenance,
  uncitedFigures,
} from '../src/index.js'

const now = '2026-09-17T09:00:00Z'

const release = { type: 'press_release', id: 'pr_1' } as const
const post = { type: 'external_post', id: 'ep_1' } as const
const mention = { type: 'mention', id: 'mn_1' } as const

const prov = (target: { type: string; id: string }) => {
  const p = new Provenance('run_1')
  p.see([target as never], { full: true })
  return p
}
const facts = (
  target: { type: string; id: string },
  over: Partial<Parameters<typeof evaluateGuardrail>[2]> = {},
) => ({ now, changeSet: [], windowCount: 0, provenance: prov(target), ...over })

const pressMandate: Mandate = { caps: { max_releases_per_week: 2 } }
const postMandate: Mandate = {
  caps: { max_external_posts_per_day: 2, cooldown_per_subreddit_hours: 72 },
}
const mentionMandate: Mandate = { caps: { max_alerts_per_day: 50 } }

const goodQuote = {
  speaker: '王岚，Nordvolt 创始人',
  text: '我们做这件事三年了。',
  provided_by: 'p_wang',
  provided_at: now,
}

const pressChange = (over: Record<string, unknown> = {}) => ({
  kind: 'press_release' as const,
  target: release,
  before: { status: 'draft' },
  after: {
    headline: 'Nordvolt 发布第二代户外电源',
    body: '新机型续航提升 18%，首批售出 3,200 台。',
    quotes: [goodQuote],
    facts_cited: [
      { figure: '18%', fact_card_id: 'fc_battery' },
      { figure: '3200', fact_card_id: 'fc_units' },
    ],
    ...over,
  },
})

const postChange = (over: Record<string, unknown> = {}) => ({
  kind: 'community_post' as const,
  target: post,
  before: {},
  after: {
    platform: 'reddit',
    venue: 'BuyItForLife',
    body: '分享一个我们做了三年的产品的拆解。',
    rules_checked: { ok: true, reasons: [], checked_at: now },
    commitment_checked: true,
    ...over,
  },
})

describe('WP78 press_release（60 §2：数字只引事实卡、引语必须是人给的）', () => {
  it('数字都有出处 + 还是草稿 → allow', () => {
    const r = evaluateGuardrail(pressChange(), pressMandate, facts(release), 'stage')
    expect(r.verdict).toBe('allow')
  })

  it('正文里多了一个没出处的数字 → block，理由里带着那个数', () => {
    const r = evaluateGuardrail(
      pressChange({ body: '新机型续航提升 18%，首批售出 3,200 台，复购率 47%。' }),
      pressMandate,
      facts(release),
      'stage',
    )
    expect(r.verdict).toBe('block')
    const hit = r.hits.find((h) => h.rule === 'press_release_facts_required')
    expect(String(hit?.actual)).toContain('47%')
  })

  it('引语没有 provided_by（= 模型替创始人说的）→ block', () => {
    const r = evaluateGuardrail(
      pressChange({ quotes: [{ ...goodQuote, provided_by: '  ' }] }),
      pressMandate,
      facts(release),
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(r.hits.some((h) => h.rule === 'press_release_quote_needs_human')).toBe(true)
  })

  it('一条引语都没有是允许的——没有比编一条好', () => {
    const r = evaluateGuardrail(pressChange({ quotes: [] }), pressMandate, facts(release), 'stage')
    expect(r.verdict).toBe('allow')
  })

  it('要分发出去 → 升人审（草稿 L2 / 分发 L1）', () => {
    const r = evaluateGuardrail(
      pressChange({ distributed: true }),
      pressMandate,
      facts(release),
      'stage',
    )
    expect(r.verdict).toBe('require_review')
    expect(r.hits.some((h) => h.rule === 'press_release_distribute')).toBe(true)
  })

  it('一周两条是额度，超了转人审不拦', () => {
    const r = evaluateGuardrail(
      pressChange({ distributed: true }),
      pressMandate,
      facts(release, { windowCount: 2 }),
      'stage',
    )
    expect(r.verdict).toBe('require_review')
    expect(r.hits.some((h) => h.rule === 'max_releases_per_week')).toBe(true)
  })

  it('联系方式是受保护字段：Agent 提都不许提', () => {
    const change = {
      kind: 'press_release' as const,
      target: release,
      before: { contact: { name: '王岚', email: 'pr@nordvolt.example' } },
      after: {
        ...pressChange().after,
        contact: { name: '自动回复', email: 'noreply@nordvolt.example' },
      },
    }
    const r = evaluateGuardrail(change, pressMandate, facts(release), 'stage')
    expect(r.verdict).toBe('block')
    expect(r.hits.some((h) => h.rule === 'protected_field')).toBe(true)
  })

  it('数字抽取：年份与一位数放过，百分比与千分位算', () => {
    expect(extractFigures('2026 年 9 月，3 款新品，售出 3,200 台，增长 18%')).toEqual([
      '3,200',
      '18%',
    ])
    expect(uncitedFigures('售出 3,200 台', ['3200'])).toEqual([])
  })
})

describe('WP78 community_post（60 §1：别人的地盘，永远人审 + 版规 + 冷却）', () => {
  it('在硬顶里：版规过了也还是要人点', () => {
    expect(HARD_L1.has('community_post')).toBe(true)
    expect(KIND_RISK.community_post).toBe('high')
    const r = evaluateGuardrail(postChange(), postMandate, facts(post), 'stage')
    expect(r.verdict).toBe('require_review')
    expect(r.hits.some((h) => h.rule === 'hard_ceiling')).toBe(true)
  })

  it('版规禁自我推广 → block（不是转人审）', () => {
    const r = evaluateGuardrail(
      postChange({
        rules_checked: { ok: false, reasons: ['no_self_promotion'], checked_at: now },
      }),
      postMandate,
      facts(post),
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(r.hits.find((h) => h.rule === 'subreddit_rules')?.cap).toBe('no_self_promotion')
  })

  it('没查过版规就提上来 → block（没问过 ≠ 问过了没事）', () => {
    const after = { ...postChange().after } as Record<string, unknown>
    delete after.rules_checked
    const r = evaluateGuardrail(
      { kind: 'community_post' as const, target: post, before: {}, after },
      postMandate,
      facts(post),
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(r.hits.some((h) => h.rule === 'subreddit_rules_required')).toBe(true)
  })

  it('72 小时内在同一个版再发 → block', () => {
    const r = evaluateGuardrail(
      postChange({ hours_since_last_post: 12 }),
      postMandate,
      facts(post),
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(r.hits.find((h) => h.rule === 'cooldown_per_subreddit_hours')?.actual).toBe(12)
  })

  it('过了冷却就只剩人审那一道', () => {
    const r = evaluateGuardrail(
      postChange({ hours_since_last_post: 96 }),
      postMandate,
      facts(post),
      'stage',
    )
    expect(r.verdict).toBe('require_review')
  })

  it('承诺扫描没跑过 → block', () => {
    const r = evaluateGuardrail(
      postChange({ commitment_checked: false }),
      postMandate,
      facts(post),
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(r.hits.some((h) => h.rule === 'commitment_scan_required')).toBe(true)
  })

  it('换一个版是受保护字段', () => {
    const r = evaluateGuardrail(
      {
        kind: 'community_post' as const,
        target: post,
        before: { venue: 'BuyItForLife' },
        after: { ...postChange().after, venue: 'gadgets' },
      },
      postMandate,
      facts(post),
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(r.hits.some((h) => h.rule === 'protected_field')).toBe(true)
  })

  it('一天两条是额度，超了转人审', () => {
    const r = evaluateGuardrail(postChange(), postMandate, facts(post, { windowCount: 2 }), 'stage')
    expect(r.hits.some((h) => h.rule === 'max_external_posts_per_day')).toBe(true)
  })
})

describe('WP78 mention_triage（60 §1：只判形状）', () => {
  const change = (after: Record<string, unknown>) => ({
    kind: 'mention_triage' as const,
    target: mention,
    before: {},
    after,
  })

  it('类与情绪都在封闭集合里 → allow', () => {
    const r = evaluateGuardrail(
      change({ triage: 'reputation', sentiment: 'negative' }),
      mentionMandate,
      facts(mention),
      'stage',
    )
    expect(r.verdict).toBe('allow')
  })

  it('说不清是哪一类 → block', () => {
    const r = evaluateGuardrail(
      change({ triage: '疑似客户问题', sentiment: 'negative' }),
      mentionMandate,
      facts(mention),
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(r.hits.some((h) => h.rule === 'mention_triage_class_required')).toBe(true)
  })

  it('没有情绪档 → block', () => {
    const r = evaluateGuardrail(
      change({ triage: 'praise' }),
      mentionMandate,
      facts(mention),
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(r.hits.some((h) => h.rule === 'mention_sentiment_required')).toBe(true)
  })

  it('负面预警一天 50 条封顶，超了转人审', () => {
    const r = evaluateGuardrail(
      change({ triage: 'reputation', sentiment: 'negative' }),
      mentionMandate,
      facts(mention, { windowCount: 50 }),
      'stage',
    )
    expect(r.hits.some((h) => h.rule === 'max_alerts_per_day')).toBe(true)
  })
})
