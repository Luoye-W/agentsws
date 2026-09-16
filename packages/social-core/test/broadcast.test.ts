import { describe, expect, it } from 'vitest'
import { BROADCAST_RULES, buildAudience, checkBroadcast } from '../src/index.js'

const now = '2026-09-16T02:00:00.000Z'

describe('56 §3 群发：受众、抑制名单、频率（WP72）', () => {
  it('名单上的人一个都不在受众里；剔掉的那些原样带出来给人认', () => {
    const a = buildAudience({
      members: ['A+promo@x.com', 'b@x.com', 'c@x.com'],
      suppression_list: ['a@x.com'],
      now,
    })
    // 归一化的规则在 `@agentsws/core` 的 suppression.ts（全仓同一份）：
    // 大小写、加号别名都归到 a@x.com
    expect(a.recipients).toEqual(['b@x.com', 'c@x.com'])
    expect(a.suppressed).toEqual(['A+promo@x.com'])
    expect(a.suppression_checked).toBe(true)
    expect(a.note).toContain('剔了 1 个')
  })

  it('七天内收过的也剔掉；**没记过就不判**（把没有的数据当成很久没收到，等于把闸门打开）', () => {
    const last = new Map([
      ['b@x.com', '2026-09-14T02:00:00.000Z'],
      ['c@x.com', '2026-08-01T02:00:00.000Z'],
    ])
    const a = buildAudience({
      members: ['b@x.com', 'c@x.com', 'never@x.com'],
      suppression_list: [],
      now,
      last_sent_at: last,
    })
    expect(a.too_soon).toEqual(['b@x.com'])
    expect(a.recipients).toEqual(['c@x.com', 'never@x.com'])
  })

  it('一个人都不剩的时候明说，别提交', () => {
    const a = buildAudience({ members: ['a@x.com'], suppression_list: ['a@x.com'], now })
    const check = checkBroadcast({
      channel: 'discord',
      account_id: 'sa_dc',
      body: '公告',
      audience: a.recipients,
      suppressed: a.suppressed,
      audience_size: a.recipients.length,
      suppression_checked: true,
    })
    expect(check.ok).toBe(false)
    expect(check.problems.join('')).toContain('一个人都不剩')
  })

  it('一周一条：第二条要人点头', () => {
    const check = checkBroadcast(
      {
        channel: 'telegram_group',
        account_id: 'sa_tg',
        body: '本周上新',
        audience: ['u1'],
        suppressed: [],
        audience_size: 1,
        suppression_checked: true,
      },
      { sent_this_week: 1 },
    )
    expect(check.ok).toBe(false)
    expect(check.problems.join('')).toContain(`上限 ${BROADCAST_RULES.max_per_week}`)
  })

  it('WhatsApp：没模板 id / 没 opt-in 一律不许提交（封的是这个品牌的号）', () => {
    const base = {
      channel: 'whatsapp' as const,
      account_id: 'sa_wa',
      body: '订单更新',
      audience: ['+4915112345678'],
      suppressed: [],
      audience_size: 1,
      suppression_checked: true as const,
    }
    const none = checkBroadcast(base)
    expect(none.ok).toBe(false)
    expect(none.problems.join('')).toContain('模板')
    expect(none.problems.join('')).toContain('opt-in')

    const both = checkBroadcast({ ...base, template_id: 'order_update_v3', opt_in_verified: true })
    expect(both.ok).toBe(true)
  })

  it('WhatsApp 一天 100 条模板消息：超了说清楚分几天发', () => {
    const many = Array.from({ length: 101 }, (_, i) => `+49151${String(i).padStart(7, '0')}`)
    const check = checkBroadcast({
      channel: 'whatsapp',
      account_id: 'sa_wa',
      body: '订单更新',
      audience: many,
      suppressed: [],
      audience_size: many.length,
      suppression_checked: true,
      template_id: 'order_update_v3',
      opt_in_verified: true,
    })
    expect(check.ok).toBe(false)
    expect(check.problems.join('')).toContain('分几天发')
  })

  it('别的渠道不受 WhatsApp 那两条管', () => {
    const check = checkBroadcast({
      channel: 'discord',
      account_id: 'sa_dc',
      body: '公告',
      audience: ['u1', 'u2'],
      suppressed: [],
      audience_size: 2,
      suppression_checked: true,
    })
    expect(check.ok).toBe(true)
  })
})
