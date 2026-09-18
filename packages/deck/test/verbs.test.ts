/**
 * WP100：卡面文案的两张派发表（`verbs.ts`）。
 *
 * 钉三件事：
 * 1. **十一种各有主动词**——一种排版漏一格，那种卡就回到"批准 / 驳回"，
 *    而"批准"在变体卡上根本不是人要做的那个动作；
 * 2. **动作语义没换**：主次动词全是五动作矩阵里的那几个，没有第六个动作，
 *    也没有哪一种排版把 `open` 当成动词；
 * 3. **类别表只出键、不出中文**，而且查不到时**回退**（不编一个类别名）。
 */
import { describe, expect, it } from 'vitest'
import { DECK_LAYOUTS, LAYOUT_BY_CHANGE } from '../src/layout.js'
import {
  CATEGORY_BY_CHANGE,
  CATEGORY_BY_KIND,
  categoryKey,
  LAYOUT_VERBS,
  verbKey,
  verbRank,
} from '../src/verbs.js'

const ACTIONS = ['approve', 'reject', 'instruct', 'snooze'] as const

describe('十一种各有主动词', () => {
  it('每一种排版都登记了主动词，一个不漏', () => {
    const missing = DECK_LAYOUTS.filter((l) => LAYOUT_VERBS[l]?.primary === undefined)
    expect(missing, `这些排版还没给主动词：${missing.join(', ')}`).toEqual([])
    expect(Object.keys(LAYOUT_VERBS)).toHaveLength(11)
  })

  it('每一种的主动词在 i18n 里有自己的一句（键各不相同）', () => {
    const keys = DECK_LAYOUTS.map((l) => verbKey(l, LAYOUT_VERBS[l].primary))
    expect(new Set(keys).size).toBe(11)
    for (const k of keys) expect(k).toMatch(/^verb\.[a-z]+\.(approve|reject|instruct)$/)
  })

  it('主动词不在次动词里，次动词不重复', () => {
    for (const layout of DECK_LAYOUTS) {
      const { primary, secondary } = LAYOUT_VERBS[layout]
      expect(secondary).not.toContain(primary)
      expect(new Set(secondary).size).toBe(secondary.length)
    }
  })

  it('动作语义一个没换：主次动词都是五动作矩阵里的，且 open 永远不是动词', () => {
    for (const layout of DECK_LAYOUTS) {
      const { primary, secondary } = LAYOUT_VERBS[layout]
      for (const a of [primary, ...secondary]) expect(ACTIONS).toContain(a)
      expect(verbKey(layout, 'open')).toBeUndefined()
      // 「稍后」在哪张卡上都是同一句话，不按排版分
      expect(verbKey(layout, 'snooze')).toBeUndefined()
    }
  })

  it('画布上那十一行：主动词与次动词逐条对得上', () => {
    const table: Record<string, [string, string[]]> = {
      outbound: ['approve', ['instruct', 'reject']],
      change: ['approve', ['instruct', 'reject']],
      publish: ['approve', ['instruct', 'reject']],
      money: ['approve', ['instruct', 'reject']],
      choice: ['approve', ['reject']],
      variants: ['approve', ['reject']],
      aftermath: ['approve', ['reject']],
      person: ['approve', ['reject']],
      handoff: ['approve', ['instruct', 'reject']],
      takeover: ['approve', ['reject']],
      policy: ['approve', ['reject']],
    }
    for (const [layout, [primary, secondary]] of Object.entries(table)) {
      expect(LAYOUT_VERBS[layout as keyof typeof LAYOUT_VERBS].primary).toBe(primary)
      expect([...LAYOUT_VERBS[layout as keyof typeof LAYOUT_VERBS].secondary]).toEqual(secondary)
    }
  })

  it('排不上主次的动作收进 ···（`more`）', () => {
    expect(verbRank('outbound', 'approve')).toBe('primary')
    expect(verbRank('outbound', 'instruct')).toBe('secondary')
    expect(verbRank('choice', 'instruct')).toBe('more')
    expect(verbRank('policy', 'snooze')).toBe('more')
  })
})

describe('金钱卡与事后决定卡的主动词按 kind 再分一层', () => {
  it('批准的是什么：退款 / 补发 / 发码 / 合作各有各的键', () => {
    expect(verbKey('money', 'approve', 'refund')).toBe('verb.money.approve.refund')
    expect(verbKey('money', 'approve', 'reship')).toBe('verb.money.approve.reship')
    expect(verbKey('money', 'approve', 'kol_affiliate_code')).toBe(
      'verb.money.approve.discount_code',
    )
    expect(verbKey('money', 'approve', 'kol_collaboration')).toBe(
      'verb.money.approve.kol_collaboration',
    )
    expect(verbKey('aftermath', 'approve', 'pause_ad')).toBe('verb.aftermath.approve.pause_ad')
  })

  it('只分主动词那一格：次动词与没登记的 kind 都走通用那一句', () => {
    expect(verbKey('money', 'reject', 'refund')).toBe('verb.money.reject')
    expect(verbKey('money', 'approve', 'no_such_kind')).toBe('verb.money.approve')
    expect(verbKey('money', 'approve')).toBe('verb.money.approve')
  })
})

describe('头一行的类别写人话', () => {
  it('`staged_change` 从账本条目类型上认（"变更待批" → "改价"）', () => {
    expect(categoryKey('staged_change', 'price_change')).toBe('category.price_change')
    expect(categoryKey('staged_change', 'refund')).toBe('category.refund')
    expect(categoryKey('staged_change', 'community_membership')).toBe('category.join')
    expect(categoryKey('staged_change', 'design_variant')).toBe('category.variants')
  })

  it('别的卡从 kind 上认', () => {
    expect(categoryKey('outbound_draft')).toBe('category.reply')
    expect(categoryKey('dev_handoff_result')).toBe('category.takeover')
    expect(categoryKey('policy_change')).toBe('category.policy')
  })

  it('没登记就回退（`undefined`，渲染层退回原来的 `kind.<kind>` 写法）', () => {
    expect(categoryKey('staged_change')).toBeUndefined()
    expect(categoryKey('staged_change', 'no_such_change_kind')).toBeUndefined()
    expect(categoryKey('system_alert')).toBeUndefined()
  })

  it('两张表都只出 i18n 键的后缀，一个中文字都没有', () => {
    const values = [...Object.values(CATEGORY_BY_KIND), ...Object.values(CATEGORY_BY_CHANGE)]
    for (const v of values) expect(v).toMatch(/^[a-z_]+$/)
  })

  it('每一种排版走得到的路上，至少有一个 kind 有类别名（没有写了没人走的表）', () => {
    const covered = new Set(
      Object.keys(LAYOUT_BY_CHANGE).filter(
        (k) => CATEGORY_BY_CHANGE[k as keyof typeof CATEGORY_BY_CHANGE] !== undefined,
      ),
    )
    expect(covered.size).toBe(Object.keys(LAYOUT_BY_CHANGE).length)
  })
})
