/**
 * WP389（docs/105 §7）：工坊服务的契约——状态、转移表、价目单 / 需求单校验、分段拆钱（只加不删）。
 */
import { describe, expect, it } from 'vitest'
import {
  allocationBucketOf,
  CLOUD_SCOPES,
  DEFAULT_CLOUD_SCOPES,
  emptyMemberUsageBlocks,
  normalizeServiceLines,
  normalizeServiceRequirements,
  PRICING_BLOCKS,
  pricingBlockOf,
  SERVICE_LEDGER_CAPABILITIES,
  SERVICE_ORDER_CLOUD_PATHS,
  SERVICE_ORDER_SCOPE,
  SERVICE_ORDER_STATUSES,
  SERVICE_ORDER_TERMINAL_STATUSES,
  SERVICE_ORDER_TRANSITIONS,
  type ServiceView,
  serviceMilestoneCredits,
  serviceMilestonesOk,
  serviceOrderActions,
  serviceOrderTransition,
} from '../src/index.js'

const STANDARD: ServiceView = {
  id: 'fake.engage',
  kind: 'standard',
  label_zh: '互动服务（测试）',
  label_en: 'Engagement (test)',
  summary_zh: '按件',
  summary_en: 'Per unit',
  pricing_mode: 'per_unit',
  menu: [
    {
      id: 'like',
      label_zh: '点赞',
      label_en: 'Likes',
      unit_zh: '个',
      unit_en: 'each',
      credits_per_unit: 0.5,
      min_quantity: 10,
      max_quantity: 500,
      target_fields: [
        { name: 'post_url', type: 'string', required: true, max: 300, label_zh: '帖子链接' },
      ],
    },
    {
      id: 'comment',
      label_zh: '评论',
      label_en: 'Comments',
      unit_zh: '条',
      unit_en: 'each',
      credits_per_unit: 8,
      min_quantity: 1,
      max_quantity: 50,
      target_fields: [],
    },
  ],
  promise: { accept_hours: 24, deliver_hours: 24 },
  revisions: 0,
  auto_accept_hours: 24,
  questions: [],
  deliverables: ['link'],
  landing: 'resume_step',
  positions: ['social'],
  intents: ['想要更多互动'],
  provider_label: 'partner_team',
  available: true,
}

const { menu: _menu, ...BASE } = STANDARD

const CUSTOM: ServiceView = {
  ...BASE,
  id: 'fake.site',
  kind: 'custom',
  pricing_mode: 'quote',
  from_credits: 800,
  milestones: [
    { id: 'brief', label_zh: '需求确认', label_en: 'Brief', share_percent: 20 },
    { id: 'design', label_zh: '设计稿', label_en: 'Design', share_percent: 40 },
    { id: 'launch', label_zh: '上线', label_en: 'Launch', share_percent: 40 },
  ],
  questions: [
    { id: 'what', label_zh: '卖什么', label_en: 'What you sell', required: true },
    { id: 'pages', label_zh: '要几页', label_en: 'Pages', options: ['3', '5', '10'] },
  ],
}

describe('WP389 工坊服务契约', () => {
  it('十二个状态、四个终态；令牌动作集 services 进默认', () => {
    expect(SERVICE_ORDER_STATUSES).toHaveLength(12)
    expect([...SERVICE_ORDER_TERMINAL_STATUSES]).toEqual([
      'completed',
      'refunded',
      'cancelled',
      'expired',
    ])
    expect(SERVICE_ORDER_SCOPE).toBe('services')
    expect(CLOUD_SCOPES).toContain('services')
    expect(DEFAULT_CLOUD_SCOPES).toContain('services')
    expect(SERVICE_ORDER_CLOUD_PATHS.orders).toBe('/v1/services/orders')
  })

  it('转移表：终态出不去；每条转移的目标都是合法状态', () => {
    for (const t of SERVICE_ORDER_TRANSITIONS) {
      expect(SERVICE_ORDER_TERMINAL_STATUSES).not.toContain(t.from)
      for (const to of t.to) expect(SERVICE_ORDER_STATUSES).toContain(to)
    }
    expect(serviceOrderTransition('paid', 'take', 'operator')?.to).toEqual(['in_progress'])
    // 用户不能自己接单；系统不能替用户验收以外的事
    expect(serviceOrderTransition('paid', 'take', 'user')).toBeUndefined()
    expect(serviceOrderTransition('in_progress', 'cancel', 'user')).toBeUndefined()
    expect(serviceOrderTransition('completed', 'dispute', 'user')).toBeUndefined()
    expect(serviceOrderActions('delivered', 'user').sort()).toEqual(['accept', 'dispute', 'revise'])
    expect(serviceOrderActions('quoted', 'user').sort()).toEqual(['accept_quote', 'cancel'])
  })

  it('价目单：勾两项各填数量，合计当场算好；对象按白名单规范化', () => {
    const out = normalizeServiceLines(STANDARD, [
      { item_id: 'like', quantity: 50, target: { post_url: ' https://x.test/p/1 ', junk: 1 } },
      { item_id: 'comment', quantity: 10 },
    ])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.total_credits).toBe(105)
    expect(out.lines[0]?.target).toEqual({ post_url: 'https://x.test/p/1' })
    expect(out.lines[1]?.target).toBeUndefined()
  })

  it('价目单：缺对象、数量出界、勾两次、空单都说人话', () => {
    const bad = (raw: unknown) => {
      const r = normalizeServiceLines(STANDARD, raw)
      return r.ok ? '' : r.message
    }
    expect(bad([{ item_id: 'like', quantity: 50 }])).toContain('帖子链接')
    expect(bad([{ item_id: 'like', quantity: 5, target: { post_url: 'u' } }])).toContain('10–500')
    expect(
      bad([
        { item_id: 'comment', quantity: 1 },
        { item_id: 'comment', quantity: 2 },
      ]),
    ).toContain('勾了两次')
    expect(bad([])).toContain('至少勾一项')
    expect(bad([{ item_id: 'nope', quantity: 1 }])).toContain('没有这一项')
    expect(normalizeServiceLines(CUSTOM, [{ item_id: 'x', quantity: 1 }]).ok).toBe(false)
  })

  it('需求单：必答的要答、选项题只认选项、多答的丢掉', () => {
    expect(normalizeServiceRequirements(CUSTOM, []).ok).toBe(false)
    const ok = normalizeServiceRequirements(CUSTOM, [
      { question_id: 'what', answer: ' 电动自行车 ' },
      { question_id: 'extra', answer: 'x' },
    ])
    expect(ok).toEqual({ ok: true, requirements: [{ question_id: 'what', answer: '电动自行车' }] })
    const bad = normalizeServiceRequirements(CUSTOM, [
      { question_id: 'what', answer: 'x' },
      { question_id: 'pages', answer: '7' },
    ])
    expect(bad.ok).toBe(false)
  })

  it('分段：占比加起来 100 才合法；拆钱零头进最后一段', () => {
    expect(serviceMilestonesOk(CUSTOM.milestones ?? [])).toBe(true)
    expect(
      serviceMilestonesOk([{ id: 'a', label_zh: 'a', label_en: 'a', share_percent: 50 }]),
    ).toBe(false)
    const parts = serviceMilestoneCredits(1000.01, CUSTOM.milestones ?? [])
    expect(parts).toEqual([200.002, 400.004, 400.004])
    expect(parts.reduce((s, n) => s + n, 0)).toBeCloseTo(1000.01, 6)
    expect(serviceMilestoneCredits(1001, CUSTOM.milestones ?? [])).toEqual([200.2, 400.4, 400.4])
  })

  it('积分新一块「工坊服务」：三行归它，额度归「其它」', () => {
    expect(PRICING_BLOCKS).toContain('workshop_service')
    for (const cap of Object.values(SERVICE_LEDGER_CAPABILITIES)) {
      expect(pricingBlockOf({ capability: cap })).toBe('workshop_service')
      expect(allocationBucketOf(cap)).toBe('other')
    }
    expect(emptyMemberUsageBlocks().workshop_service).toEqual({ credits: 0, calls: 0 })
  })
})
