/**
 * WP96：卡片十一种排版的派发表。
 *
 * 最要紧的一条是**这张表是全的**：`ApprovalKind` / `ChangeKind` 每加一个成员，
 * 必须同时给它一个排版，否则那张卡会静悄悄地掉进兜底的改动卡里。
 * `Record<ChangeKind, DeckLayout>` 在编译期挡一道，这里在运行期再挡一道——
 * 契约的联合类型直接从**源文件**读（那是真源），所以谁在 changes.ts 里加一行
 * 却忘了改这里，这个用例当场红。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DECK_LAYOUTS,
  DEFAULT_LAYOUT,
  isQueueCard,
  LAYOUT_BY_CHANGE,
  LAYOUT_BY_KIND,
  layoutFor,
  NOT_A_CARD,
} from '../src/layout.js'

/** 从契约源文件里把一个联合类型的成员抠出来（只认 `  | 'xxx'` 那种写法）。 */
function unionMembers(relative: string, typeName: string): string[] {
  const path = fileURLToPath(new URL(relative, import.meta.url))
  const src = readFileSync(path, 'utf8')
  const start = src.indexOf(`export type ${typeName} =`)
  expect(start, `${typeName} 没在 ${relative} 里找到`).toBeGreaterThanOrEqual(0)
  const rest = src.slice(start)
  // 联合结束于下一个顶格的 `export` / `/**`（不在 `  | ` 行上的东西）
  const end = rest.search(/\n(?:export |\/\*\*\n \* )/)
  const body = end === -1 ? rest : rest.slice(0, end)
  return [...body.matchAll(/^\s*\|\s*'([a-z_]+)'/gm)].map((m) => m[1] as string)
}

describe('十一种排版', () => {
  it('就是十一种，不多不少', () => {
    expect(DECK_LAYOUTS).toHaveLength(11)
    expect(new Set(DECK_LAYOUTS).size).toBe(11)
  })

  it('两张表里的值都是这十一种之一', () => {
    for (const v of Object.values(LAYOUT_BY_KIND)) expect(DECK_LAYOUTS).toContain(v)
    for (const v of Object.values(LAYOUT_BY_CHANGE)) expect(DECK_LAYOUTS).toContain(v)
  })

  it('十一种每一种都真的被用到（没有写了没人走的排版）', () => {
    const used = new Set([...Object.values(LAYOUT_BY_KIND), ...Object.values(LAYOUT_BY_CHANGE)])
    expect([...DECK_LAYOUTS].filter((l) => !used.has(l))).toEqual([])
  })
})

describe('每个已知 kind 都有 layout', () => {
  it('ApprovalKind 一个不漏', () => {
    const kinds = unionMembers('../../contracts/src/approval.ts', 'ApprovalKind')
    expect(kinds.length).toBeGreaterThan(15)
    const missing = kinds.filter((k) => k !== 'staged_change' && !(k in LAYOUT_BY_KIND))
    expect(missing, `这些 ApprovalKind 还没给排版：${missing.join(', ')}`).toEqual([])
  })

  it('DeckKind 的两个系统卡也有', () => {
    expect(LAYOUT_BY_KIND.system_alert).toBe('aftermath')
    expect(LAYOUT_BY_KIND.digest).toBe('aftermath')
  })

  it('ChangeKind 一个不漏', () => {
    const kinds = unionMembers('../../contracts/src/changes.ts', 'ChangeKind')
    expect(kinds.length).toBeGreaterThan(50)
    const missing = kinds.filter((k) => !(k in LAYOUT_BY_CHANGE))
    expect(missing, `这些 ChangeKind 还没给排版：${missing.join(', ')}`).toEqual([])
  })

  it('表里也没有契约上不存在的 kind（拼错的那种）', () => {
    const kinds = new Set(unionMembers('../../contracts/src/changes.ts', 'ChangeKind'))
    const extra = Object.keys(LAYOUT_BY_CHANGE).filter((k) => !kinds.has(k))
    expect(extra, `这些 key 在 ChangeKind 里不存在：${extra.join(', ')}`).toEqual([])
  })
})

describe('layoutFor', () => {
  it('非 staged_change 直接查表', () => {
    expect(layoutFor('outbound_draft')).toBe('outbound')
    expect(layoutFor('policy_change')).toBe('policy')
    expect(layoutFor('claim')).toBe('handoff')
    expect(layoutFor('membership')).toBe('person')
    expect(layoutFor('dev_handoff_result')).toBe('takeover')
    expect(layoutFor('ai_question')).toBe('choice')
  })

  it('staged_change 看账本条目类型', () => {
    expect(layoutFor('staged_change', 'price_change')).toBe('change')
    expect(layoutFor('staged_change', 'refund')).toBe('money')
    expect(layoutFor('staged_change', 'social_post')).toBe('publish')
    expect(layoutFor('staged_change', 'design_variant')).toBe('variants')
    expect(layoutFor('staged_change', 'pause_ad')).toBe('aftermath')
    expect(layoutFor('staged_change', 'community_membership')).toBe('person')
    expect(layoutFor('staged_change', 'mention_triage')).toBe('handoff')
    expect(layoutFor('staged_change', 'review_reply')).toBe('outbound')
  })

  it('没写 kind、或写了个不认识的，退到改动卡（双格对任何 diff 都成立）', () => {
    expect(layoutFor('staged_change')).toBe(DEFAULT_LAYOUT)
    expect(layoutFor('staged_change', 'no_such_kind')).toBe(DEFAULT_LAYOUT)
  })
})

describe('只有要人决定的才是卡', () => {
  it('日报 / 检查单 / 纯告警不进队列', () => {
    expect(isQueueCard('daily_report')).toBe(false)
    expect(isQueueCard('system_alert')).toBe(false)
    expect(isQueueCard('staged_change', 'launch_check')).toBe(false)
  })

  it('它们引出的决定照旧出卡', () => {
    // 恢复投放 ⑦ / 补货 ② / 回应舆情 ①
    expect(isQueueCard('staged_change', 'pause_ad')).toBe(true)
    expect(isQueueCard('staged_change', 'inventory_adjust')).toBe(true)
    expect(isQueueCard('outbound_draft')).toBe(true)
  })

  it('清单本身就四条，改它要同时改文档（WP154 加了搜索报告）', () => {
    expect([...NOT_A_CARD.kinds]).toEqual(['daily_report', 'system_alert', 'seo_report'])
    expect([...NOT_A_CARD.changeKinds]).toEqual(['launch_check'])
  })
})
