/**
 * WP404：客服垂直包的文字内容走读取口——每行有 id、按品牌可覆盖、没登记覆盖源时原样。
 */
import { registerContentTableProvider } from '@agentsws/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DIGITAL_TABLES,
  digitalPack,
  GOODS_TABLES,
  getVerticalPack,
  goodsPack,
  type PersonaRow,
} from '../src/index.js'

let undo: (() => void) | undefined
afterEach(() => {
  undo?.()
  undo = undefined
})

describe('WP404 客服垂直包内容表', () => {
  it('每张表每行都有 id、不重名；digital 的「同现状」行都能在 goods 里按 id 找到', () => {
    for (const tables of [GOODS_TABLES, DIGITAL_TABLES])
      for (const t of [tables.persona, tables.rules, tables.intents]) {
        const ids = t.rows.map((r) => r.id)
        expect(new Set(ids).size).toBe(ids.length)
      }
    const goodsIds = new Set(GOODS_TABLES.rules.rows.map((r) => r.id))
    const same = DIGITAL_TABLES.rules.rows.filter((r) => r.same_as === 'goods')
    expect(same.length).toBeGreaterThan(0)
    for (const r of same) expect(goodsIds.has(r.id)).toBe(true)
  })

  it('没登记覆盖源：给了品牌也是原来那个常量包', () => {
    expect(getVerticalPack('goods', { brand: 'b1' })).toBe(goodsPack)
    expect(getVerticalPack('digital', { brand: 'b1' })).toBe(digitalPack)
  })

  it('登记了覆盖源：只换这个品牌的文字那几格，结构不动；别的品牌照旧', () => {
    undo = registerContentTableProvider((table, brand) => {
      if (table !== 'support.goods.persona' || brand !== 'b1') return undefined
      return GOODS_TABLES.persona.rows.map(
        (r): PersonaRow => (r.id === 'chatAgent' ? { ...r, text: '你是这家店的客服。' } : r),
      )
    })
    const pack = getVerticalPack('goods', { brand: 'b1' })
    expect(pack.persona.chatAgent).toBe('你是这家店的客服。')
    expect(pack.persona.emailAgent).toBe(goodsPack.persona.emailAgent)
    expect(pack.chatRules).toEqual(goodsPack.chatRules)
    expect(pack.intents).toEqual(goodsPack.intents)
    expect(pack.chatPlan).toEqual(goodsPack.chatPlan)
    expect(pack.l3Denylist).toBe(goodsPack.l3Denylist)
    expect(Object.keys(pack)).toEqual(Object.keys(goodsPack))
    expect(getVerticalPack('goods', { brand: 'b2' }).persona).toEqual(goodsPack.persona)
    expect(getVerticalPack('goods').persona.chatAgent).toBe(goodsPack.persona.chatAgent)
  })

  it('覆盖了 goods 的一条规则：digital 里「同现状」引用它的那一行跟着变', () => {
    const target = DIGITAL_TABLES.rules.rows.find((r) => r.same_as === 'goods' && r.set === 'chat')
    if (target === undefined) throw new Error('digital 应有同现状的聊天规则')
    undo = registerContentTableProvider((table) =>
      table === 'support.goods.rules'
        ? GOODS_TABLES.rules.rows.map((r) =>
            r.id === target.id ? { ...r, text: `${target.id.slice(5)}. 新写法` } : r,
          )
        : undefined,
    )
    const pack = getVerticalPack('digital', { brand: 'b1' })
    expect(pack.chatRules.numbered).toContain(`${target.id.slice(5)}. 新写法`)
    expect(pack.chatRules.numbered).toHaveLength(digitalPack.chatRules.numbered.length)
  })
})
