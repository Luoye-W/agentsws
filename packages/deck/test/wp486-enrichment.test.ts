/**
 * WP486（Luoye 10-23 真机）：本人在个人模式下点自己岗位那张「昨天学到的」卡的详情，
 * 末尾一句「还有 1 条记录你无权查看，已隐去」——那一条其实是卡挂着的技能（宿主不给技能起展示名），
 * 根本不是权限问题。**起不了名字 ≠ 无权**：只有宿主明说「不让看」（`null`）才记进那句话。
 */
import { describe, expect, it } from 'vitest'
import type { ProjectContext } from '../src/index.js'
import { projectCard } from '../src/index.js'
import { item, NOW } from './fixtures.js'

const ctx: ProjectContext = { now: NOW, position_id: 'asg_1' }

describe('WP486 enrichment：起不了名字 ≠ 无权查看', () => {
  it('label 回 undefined（起不了名字）：不出芯片，也不记「无权」', () => {
    const card = projectCard(item(), { ...ctx, label: () => undefined })
    expect(card.entity_chips).toEqual([])
    expect(card.detail.enrichment.dropped_refs).toBe(0)
  })

  it('没装 label 的宿主（本地数据源）：同样不记「无权」', () => {
    const card = projectCard(
      item({ subject: { object: { type: 'skill', id: 'reddit-ops' } } }),
      ctx,
    )
    expect(card.detail.enrichment.dropped_refs).toBe(0)
  })

  it('label 回 null（宿主明说不让看，如同事模式里别人的私有记录）：才记进那句话', () => {
    const card = projectCard(item(), {
      ...ctx,
      label: (ref) =>
        ref.id === 'cus_anna' ? 'Anna Meyer' : ref.id === 'ord_1001' ? null : undefined,
    })
    expect(card.entity_chips.map((c) => c.id)).toEqual(['cus_anna'])
    expect(card.detail.enrichment.dropped_refs).toBe(1)
    // 不让看的那条也不进客户标签之类的旁路
    expect(card.customer_label).toBe('Anna Meyer')
  })
})
