/**
 * WP395（docs/106 §13）：Amazon 运营岗位 + 亚马逊店铺运营职责的骨架。
 *
 * 钉住的几件事：
 * 1. 别名 `amz.market-intel` 读进来就是 `amz.store`（docs/104 C2 / docs/106 A1）；
 * 2. 一条职责七块：七组意图词，不拆成七条职责；
 * 3. 一期只读：数据域只有 read（审批那条另有 approve），动作只有「向设计岗下需求单」；
 * 4. 岗位里 `amz.support` 列着、默认不勾（A3），而且它的岗位 persona 仍是客服岗那一份。
 */
import { describe, expect, it } from 'vitest'
import {
  bundledPositionOfRole,
  loadBundledPosition,
  loadBundledRole,
  resolveRoleId,
} from '../src/index.js'

describe('亚马逊店铺运营 amz.store', () => {
  const role = loadBundledRole('amz.store')

  it('旧 id amz.market-intel 读进来是 amz.store', () => {
    expect(resolveRoleId('amz.market-intel')).toBe('amz.store')
    expect(loadBundledRole('amz.market-intel').id).toBe('amz.store')
  })

  it('七块落成七组意图词（不拆职责）', () => {
    expect((role.grounding ?? []).map((g) => g.name)).toEqual([
      'account_health',
      'listing_keywords',
      'inventory_inbound',
      'pricing_promo',
      'reviews_returns',
      'profit_settlement',
      'new_launch',
    ])
  })

  it('一期只读：没有 stage / write 的数据域，动作只有向设计岗下需求单（L3）', () => {
    for (const s of role.scopes) {
      const ops = s.domain === 'approval' ? ['read', 'approve'] : ['read']
      expect(s.ops, s.domain).toEqual(ops)
    }
    expect(role.scopes.map((s) => s.domain).sort()).toEqual(
      ['approval', 'knowledge', 'order', 'product', 'skill'].sort(),
    )
    expect(role.actions.map((a) => a.id)).toEqual(['request_design'])
    expect(role.automation.request_design?.ceiling).toBe('L3')
  })

  it('连接 amazon_sp 可选；技能 unit-economics 打头、WP397 的 Amazon 技能全部按需；网页工具两样都挂', () => {
    expect(role.connectors).toEqual([
      expect.objectContaining({ kind: 'amazon_sp', required: false }),
    ])
    expect(role.skills[0]?.name).toBe('unit-economics')
    // WP397：其余都是 amazon-*（官方 amazon-sp-* 与改写 / 自写），一律按需加载
    for (const s of role.skills.slice(1)) expect(s.name.startsWith('amazon-'), s.name).toBe(true)
    for (const s of role.skills) expect(s.load, s.name).toBe('on_demand')
    expect(role.web_tools).toEqual(['web_search', 'web_fetch'])
  })

  it('快捷问题不超过 6 条；persona 写了广告的分界', () => {
    expect((role.quick_prompts ?? []).length).toBeLessThanOrEqual(6)
    const zh = typeof role.persona === 'object' ? role.persona.zh : (role.persona ?? '')
    expect(zh).toContain('有 Amazon 广告职责时归你')
    expect(zh).toContain('转投放')
  })
})

describe('Amazon 运营岗位 amazon-ops', () => {
  const position = loadBundledPosition('amazon-ops')

  it('amz.store 默认勾，amz.support 列着、默认不勾；有图标', () => {
    expect(position.roles).toEqual([
      { role: 'amz.store', default: true },
      { role: 'amz.support', default: false },
    ])
    expect(position.icon).toBe('amazon-ops')
  })

  it('amz.store 的岗位是它；amz.support 的岗位仍是客服（默认勾的那一个）', () => {
    expect(bundledPositionOfRole('amz.store')?.id).toBe('amazon-ops')
    expect(bundledPositionOfRole('amz.market-intel')?.id).toBe('amazon-ops')
    expect(bundledPositionOfRole('amz.support')?.id).toBe('customer-care')
  })
})
