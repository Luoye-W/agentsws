/**
 * WP390（docs/105 §4 / §5）：工坊服务本机那一半的纯逻辑——意向匹配（自营排第一）、岗位页最多三项、
 * 卡点 → 服务、起价、推荐卡与五种卡面的认法。
 */
import { describe, expect, it } from 'vitest'
import {
  isServiceOrderCardPayload,
  matchServices,
  SERVICE_POSITION_LIMIT,
  type ServiceView,
  serviceCardSnapshot,
  serviceForBlocker,
  serviceIntentScore,
  serviceOfferOf,
  serviceStartCredits,
  servicesForPosition,
} from '../src/index.js'

const base = {
  summary_zh: '一句话',
  summary_en: 'One line',
  promise: { accept_hours: 24 },
  revisions: 1,
  auto_accept_hours: 72,
  questions: [],
  deliverables: ['receipt' as const],
  landing: 'resume_step' as const,
  available: true,
}

const SITE: ServiceView = {
  ...base,
  id: 'workshop.site_build',
  kind: 'custom',
  label_zh: '工坊建站',
  label_en: 'Workshop site build',
  pricing_mode: 'quote',
  from_credits: 800,
  intents: ['想找人建站', '网站想改版', '找外包做网站'],
  positions: ['site', 'site_ops'],
  blockers: ['setup:site.store', '品牌没有独立站'],
  provider_label: 'workshop_team',
  landing: 'theme',
}

const PARTNER_SITE: ServiceView = {
  ...SITE,
  id: 'partner.site_build',
  label_zh: '合作建站',
  label_en: 'Partner site build',
  provider_label: 'partner_team',
}

const ENGAGE: ServiceView = {
  ...base,
  id: 'fake.engage',
  kind: 'standard',
  label_zh: '社媒互动',
  label_en: 'Social engagement',
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
      target_fields: [],
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
  intents: ['帖子要点赞', '帖子没人互动'],
  positions: ['social'],
  blockers: ['connect:google'],
  provider_label: 'partner_team',
}

describe('WP390 意向匹配', () => {
  it('说法整句包含 = 1；字 / 相邻两字覆盖过半算命中', () => {
    expect(serviceIntentScore('想找人建站', '我想找人建站，预算两万')).toBe(1)
    expect(serviceIntentScore('找外包做网站', '我想找个专业点的外包帮我做网站')).toBeGreaterThan(
      0.5,
    )
    expect(serviceIntentScore('帖子要点赞', '今天天气不错')).toBeLessThan(0.5)
  })

  it('自营排第一，其次当前岗位，没上架的不出', () => {
    const off = { ...ENGAGE, id: 'off', available: false, intents: ['想找人建站'] }
    const got = matchServices([PARTNER_SITE, SITE, ENGAGE, off], '想找人建站', 'site')
    expect(got.map((m) => m.service.id)).toEqual(['workshop.site_build', 'partner.site_build'])
    expect(got[0]?.position_hit).toBe(true)
    expect(matchServices([SITE], '今天天气不错')).toEqual([])
  })

  it('岗位页最多三项、自营在前', () => {
    const many = [1, 2, 3, 4].map((i) => ({ ...PARTNER_SITE, id: `p${i}` }))
    const got = servicesForPosition([...many, SITE], 'site')
    expect(got).toHaveLength(SERVICE_POSITION_LIMIT)
    expect(got[0]?.id).toBe('workshop.site_build')
    expect(servicesForPosition([SITE], 'social')).toEqual([])
  })

  it('卡点：机器键对上，或人话名字试匹配', () => {
    expect(serviceForBlocker([ENGAGE, SITE], { key: 'setup:site.store' })?.id).toBe(
      'workshop.site_build',
    )
    expect(serviceForBlocker([ENGAGE, SITE], { key: 'connect:google' })?.id).toBe('fake.engage')
    expect(serviceForBlocker([SITE], { key: 'setup:x', name: '品牌还没有独立站' })?.id).toBe(
      'workshop.site_build',
    )
    expect(serviceForBlocker([SITE], { key: 'connect:ga4', name: 'GA4' })).toBeUndefined()
  })
})

describe('WP390 起价与推荐卡', () => {
  it('一口价 / 起价参考 / 价目单最便宜那一项按最少数量', () => {
    expect(serviceStartCredits(SITE)).toBe(800)
    expect(serviceStartCredits({ ...SITE, pricing_mode: 'fixed', price_credits: 300 })).toBe(300)
    expect(serviceStartCredits(ENGAGE)).toBe(5)
  })

  it('推荐卡只带名字、起价、说法（不带合作方名字、不带风险）', () => {
    const offer = serviceOfferOf(PARTNER_SITE)
    expect(offer).toEqual({
      service_id: 'partner.site_build',
      kind: 'custom',
      label_zh: '合作建站',
      label_en: 'Partner site build',
      pricing_mode: 'quote',
      from_credits: 800,
      provider_label: 'partner_team',
    })
  })

  it('卡面认法：五种 form + 带服务快照', () => {
    const service = serviceCardSnapshot(ENGAGE)
    expect(
      isServiceOrderCardPayload({ form: 'service_menu', service, lines: [], idempotency_key: 'k' }),
    ).toBe(true)
    expect(isServiceOrderCardPayload({ form: 'service_menu' })).toBe(false)
    expect(isServiceOrderCardPayload({ form: 'setup_request', service })).toBe(false)
    expect(service).not.toHaveProperty('intents')
  })
})
