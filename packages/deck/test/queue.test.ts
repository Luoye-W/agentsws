import { describe, expect, it } from 'vitest'
import type { DeckCard, ProjectContext } from '../src/index.js'
import {
  CONTENT_MODES,
  compareCards,
  contentVariantsOf,
  filterCards,
  foldCards,
  isCustomerWaiting,
  isMergeable,
  isNobodyWaiting,
  mergeKeyOf,
  pickContent,
  projectCard,
  sortCards,
  sourceOf,
  waitingOf,
} from '../src/index.js'
import { item, NOW, policyItem } from './fixtures.js'

const ctx: ProjectContext = { now: NOW, position_id: 'asg_1' }
const base = (): DeckCard => projectCard(item(), ctx)
const mk = (over: Partial<DeckCard>): DeckCard => ({ ...base(), ...over })

describe('排序：priority_band → expires_at (nulls last) → priority → created_at → id', () => {
  it('档位第一顺位', () => {
    const cards = [
      mk({ id: 'c', priority_band: 'P2' }),
      mk({ id: 'a', priority_band: 'P0' }),
      mk({ id: 'b', priority_band: 'P1' }),
    ]
    expect(sortCards(cards).map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('同档位按期限，没期限的排最后（nulls last）', () => {
    const cards = [
      mk({ id: 'none' }),
      mk({ id: 'late', expires_at: '2026-09-09T00:00:00.000Z' }),
      mk({ id: 'soon', expires_at: '2026-09-08T00:00:00.000Z' }),
    ]
    expect(sortCards(cards).map((c) => c.id)).toEqual(['soon', 'late', 'none'])
  })

  it('两张都没期限时不靠 NaN 决定顺序（Infinity - Infinity 的坑）', () => {
    const a = mk({ id: 'a' })
    const b = mk({ id: 'b' })
    expect(compareCards(a, b)).toBe(-1)
    expect(compareCards(b, a)).toBe(1)
    // 坏掉的 ISO 串也当没期限处理，不排到最前面
    const bad = mk({ id: 'z', expires_at: 'not-a-date' })
    expect(sortCards([bad, mk({ id: 'y', expires_at: '2026-09-08T00:00:00.000Z' })])[0]?.id).toBe(
      'y',
    )
  })

  it('期限相同时 priority 高的先（immediate > queue > digest）', () => {
    const cards = [
      mk({ id: 'q', priority: 'queue' }),
      mk({ id: 'd', priority: 'digest' }),
      mk({ id: 'i', priority: 'immediate' }),
    ]
    expect(sortCards(cards).map((c) => c.id)).toEqual(['i', 'q', 'd'])
  })

  it('再同就按创建时间，最后按 id 兜成全序', () => {
    const older = mk({
      id: 'q',
      detail: { ...base().detail, created_at: '2026-09-06T00:00:00.000Z' },
    })
    expect(sortCards([mk({ id: 'p' }), older]).map((c) => c.id)).toEqual(['q', 'p'])
    expect(sortCards([mk({ id: 'n' }), mk({ id: 'm' })]).map((c) => c.id)).toEqual(['m', 'n'])
    // 创建时间坏掉也不抖：退到 id
    const broken = mk({ id: 'a', detail: { ...base().detail, created_at: 'x' } })
    expect(sortCards([mk({ id: 'b' }), broken]).map((c) => c.id)).toEqual(['a', 'b'])
  })
})

describe('等待态', () => {
  it('P0 = 客户在等，P3 = 无人等待，中间两档两者都不是', () => {
    expect(isCustomerWaiting(mk({ priority_band: 'P0' }))).toBe(true)
    expect(isNobodyWaiting(mk({ priority_band: 'P3' }))).toBe(true)
    expect(waitingOf(mk({ priority_band: 'P0' }))).toBe('customer_waiting')
    expect(waitingOf(mk({ priority_band: 'P3' }))).toBe('nobody_waiting')
    expect(waitingOf(mk({ priority_band: 'P1' }))).toBeUndefined()
    expect(waitingOf(mk({ priority_band: 'P2' }))).toBeUndefined()
  })
})

describe('合并：dedupe family × kind × channel，P0 永不合并', () => {
  it('合并键取去重键的第一段', () => {
    expect(mergeKeyOf(mk({ dedupe_key: 'draft:thr_1:v2' }))).toBe('draft|outbound_draft|email')
    // 没有冒号就是整串
    expect(mergeKeyOf(mk({ dedupe_key: 'plain' }))).toBe('plain|outbound_draft|email')
    // 没渠道也有键，不会因为 undefined 把两张不同渠道的并到一起
    expect(mergeKeyOf(mk({ dedupe_key: 'a:b', channel: undefined }))).toBe('a|outbound_draft|none')
  })

  it('同族同型同渠道合成一张，merge_count 记张数，成员各带各的 version', () => {
    const folded = foldCards([
      mk({ id: 'a', dedupe_key: 'draft:1', version: 1 }),
      mk({ id: 'b', dedupe_key: 'draft:2', version: 4 }),
      mk({ id: 'c', dedupe_key: 'draft:3', version: 7 }),
    ])
    expect(folded).toHaveLength(1)
    expect(folded[0]?.merge_count).toBe(3)
    expect(folded[0]?.merged).toEqual([
      { id: 'a', version: 1 },
      { id: 'b', version: 4 },
      { id: 'c', version: 7 },
    ])
  })

  it('卡型或渠道不同就不合', () => {
    const folded = foldCards([
      mk({ id: 'a', dedupe_key: 'draft:1' }),
      mk({ id: 'b', dedupe_key: 'draft:2', kind: 'knowledge_update' }),
      mk({ id: 'c', dedupe_key: 'draft:3', channel: 'chat' }),
    ])
    expect(folded).toHaveLength(3)
    for (const c of folded) expect(c.merge_count).toBe(1)
  })

  it('P0 永不合并：三张同族 P0 还是三张，倒计时一个都不藏', () => {
    expect(isMergeable(mk({ priority_band: 'P0' }))).toBe(false)
    const folded = foldCards([
      mk({ id: 'a', dedupe_key: 'draft:1', priority_band: 'P0' }),
      mk({ id: 'b', dedupe_key: 'draft:2', priority_band: 'P0' }),
      mk({ id: 'c', dedupe_key: 'draft:3', priority_band: 'P0' }),
    ])
    expect(folded).toHaveLength(3)
    expect(folded.every((c) => c.merge_count === 1)).toBe(true)
  })

  it('合并不改原对象（代表卡是副本）', () => {
    const a = mk({ id: 'a', dedupe_key: 'draft:1' })
    foldCards([a, mk({ id: 'b', dedupe_key: 'draft:2' })])
    expect(a.merge_count).toBe(1)
    expect(a.merged).toBeUndefined()
  })
})

describe('筛选：不跳页、按张数计数、P0 永不被筛掉', () => {
  const deck = (): DeckCard[] => [
    mk({ id: 'p0', priority_band: 'P0', position_id: 'asg_2', source: 'conversation' }),
    mk({ id: 'a', priority_band: 'P2', position_id: 'asg_1', source: 'conversation' }),
    mk({ id: 'b', priority_band: 'P3', position_id: 'asg_2', source: 'system', kind: 'digest' }),
    mk({ id: 'c', priority_band: 'P2', position_id: 'asg_1', source: 'todo' }),
  ]

  it('空筛选 = 全给', () => {
    const r = filterCards(deck())
    expect(r.cards.map((c) => c.id)).toEqual(['p0', 'a', 'c', 'b'])
    expect(r.pinned_p0).toEqual([])
  })

  it('按岗位筛', () => {
    const r = filterCards(deck(), { position_id: 'asg_1' })
    expect(r.cards.map((c) => c.id)).toEqual(['a', 'c'])
  })

  it('按等待态筛', () => {
    expect(filterCards(deck(), { waiting: 'customer_waiting' }).cards.map((c) => c.id)).toEqual([
      'p0',
    ])
    expect(filterCards(deck(), { waiting: 'nobody_waiting' }).cards.map((c) => c.id)).toEqual(['b'])
  })

  it('按卡型与来源筛', () => {
    expect(filterCards(deck(), { kind: 'digest' }).cards.map((c) => c.id)).toEqual(['b'])
    expect(filterCards(deck(), { source: 'todo' }).cards.map((c) => c.id)).toEqual(['c'])
  })

  it('被筛掉的 P0 回到 pinned_p0，不会人间蒸发', () => {
    const r = filterCards(deck(), { position_id: 'asg_1' })
    expect(r.cards.some((c) => c.id === 'p0')).toBe(false)
    expect(r.pinned_p0.map((c) => c.id)).toEqual(['p0'])
  })

  it('计数按张数（合并前的总数），不是按组数', () => {
    const r = filterCards(deck(), { position_id: 'asg_1' })
    expect(r.counts).toEqual({ total: 4, customer_waiting: 1, nobody_waiting: 1, matched: 2 })
  })
})

describe('内容语言：一次一种，缺席就回退并说明', () => {
  it('三种模式都有名字', () => {
    expect(CONTENT_MODES).toEqual(['zh_summary', 'original', 'en'])
  })

  it('有就给，没有就回退中文摘要并立 fell_back', () => {
    const v = { zh_summary: '中文摘要', original: 'Hi Anna' }
    expect(pickContent(v, 'zh_summary')).toEqual({
      text: '中文摘要',
      mode: 'zh_summary',
      fell_back: false,
    })
    expect(pickContent(v, 'original')).toEqual({
      text: 'Hi Anna',
      mode: 'original',
      fell_back: false,
    })
    expect(pickContent(v, 'en')).toEqual({
      text: '中文摘要',
      mode: 'zh_summary',
      fell_back: true,
    })
    // 空白串等于没有
    expect(pickContent({ zh_summary: 'z', en: '  ' }, 'en').fell_back).toBe(true)
  })

  it('变体只从结构化字段取，不编', () => {
    expect(contentVariantsOf(item())).toEqual({ zh_summary: item().summary, original: 'Hi Anna' })
    expect(contentVariantsOf(item({ payload: { original: 'O', summary_en: 'E' } }))).toEqual({
      zh_summary: item().summary,
      original: 'O',
      en: 'E',
    })
    expect(contentVariantsOf(item({ payload: 'x' }))).toEqual({ zh_summary: item().summary })
    expect(contentVariantsOf(item({ payload: { source_text: 'S', en: 'EN' } })).original).toBe('S')
    expect(contentVariantsOf(item({ payload: { original_text: 'OT' } })).original).toBe('OT')
  })
})

describe('来源（37 §3 第四枚筛选 chip）', () => {
  it('对话 / 待办委托 / 系统三分', () => {
    expect(sourceOf(item(), 'outbound_draft')).toBe('conversation')
    expect(
      sourceOf(
        item({ subject: { object: { type: 'order', id: 'o1' }, conversation_id: 'cv_1' } }),
        'staged_change',
      ),
    ).toBe('conversation')
    expect(
      sourceOf(
        item({ subject: { object: { type: 'order', id: 'o1' }, work_item_id: 'mat_1' } }),
        'staged_change',
      ),
    ).toBe('todo')
    expect(sourceOf(item(), 'system_alert')).toBe('system')
    expect(sourceOf(item(), 'digest')).toBe('system')
    expect(sourceOf(policyItem(), 'policy_change')).toBe('system')
  })

  it('projectCard 把 subject.work_item_id 投成 matter_id（37 §2.2b 的指针）', () => {
    const card = projectCard(
      item({ subject: { object: { type: 'thread', id: 'thr_1' }, work_item_id: 'mat_7' } }),
      { ...ctx, label: (r) => (r.type === 'work_item' ? 'Anna 的退货' : undefined) },
    )
    expect(card.matter_id).toBe('mat_7')
    expect(card.matter_label).toBe('Anna 的退货')
    expect(projectCard(item(), ctx).matter_id).toBeUndefined()
  })
})
