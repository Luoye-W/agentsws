/**
 * 47 J2 知识层与操作层的边界，在进入管道上的那一道拦。
 *
 * 三组断言：
 * 1. 判据本身（表驱动，中英都认，政策里的天数不许误伤成状态）；
 * 2. `propose` 真的降级：层变成 `historical_case`、打上"当时"、记着本来是哪一层；
 * 3. 误伤能人工改回来（`restoreLayer`），改回去之后"当时"一并清掉。
 */
import { describe, expect, it } from 'vitest'
import {
  detectStateWords,
  downgradeOf,
  downgradeReason,
  hasStateWords,
  STATE_WORD_RULES,
} from '../src/index.js'
import { cardInput, T0, testClock, withKnowledge } from './fixtures.js'

/** 该拦的：这些句子说的都是"现在 / 当时是什么样"，不是"规矩是什么"。 */
const STATE: readonly [string, string][] = [
  ['订单 #1001 已退款', 'order_id'],
  ['Order #1001 has been refunded', 'order_id'],
  ['ord_1001 还没发货', 'order_id'],
  ['这一单已经发货了，预计周五送达', 'fulfillment'],
  ['The package was delivered on Friday', 'fulfillment'],
  ['fulfillment_status 现在是 unfulfilled', 'fulfillment'],
  ['USB-C 充电器库存还有 3 件', 'inventory'],
  ['12 units in stock at the Berlin warehouse', 'inventory'],
  ['给客户退了 129 美元', 'money'],
  ['We refunded $129 to the customer', 'money'],
  ['退款于 2026-09-04 到账', 'payment'],
]

/** 不该拦的：这些是政策与话术——知识层本来就该存它们。 */
const KNOWLEDGE: readonly string[] = [
  '德国站退货窗口 14 天',
  'Customers may return items within 14 days of delivery.',
  '退货运费由谁出，看是不是质量问题',
  '回信开头先道歉，再说清楚下一步',
  '促销期间不叠加其他优惠券',
  'Refunds are processed within 5 business days.',
]

describe('47 J2 状态词判据', () => {
  // 标题用序号不用原文：`$129` 里的 `$` 会被 vitest 当成插值占位，标题里会变成 undefined
  it.each(STATE)('拦得下第 %# 句状态', (text, category) => {
    const hits = detectStateWords(text)
    expect(hits.length, text).toBeGreaterThan(0)
    expect(hits.map((h) => h.category)).toContain(category)
    expect(hasStateWords(text)).toBe(true)
  })

  it.each(KNOWLEDGE)('放过「%s」', (text) => {
    expect(detectStateWords(text), text).toEqual([])
  })

  it('每条判据都说得出自己在抓什么（界面上那句"为什么降级"）', () => {
    for (const rule of STATE_WORD_RULES) {
      expect(rule.what.length).toBeGreaterThan(0)
      expect(rule.category.length).toBeGreaterThan(0)
    }
    expect(downgradeReason(detectStateWords('订单 #1001 已退款'))).toContain('操作层')
  })

  it('话术层不降：模板里的金额是占位不是状态', () => {
    expect(downgradeOf('phrasing', '我们已经给您退了 $129')).toBeUndefined()
    expect(downgradeOf('fact', '我们已经给您退了 $129')).toBeDefined()
  })

  it('已经是历史案例的不再降一次', () => {
    expect(downgradeOf('historical_case', '订单 #1001 已退款')).toBeUndefined()
  })

  it('结构化字段里的状态也算', () => {
    expect(downgradeOf('fact', '这一单的情况', { order: '#1001' })).toBeDefined()
  })
})

describe('47 J2 进入管道：带状态的句子降成历史案例', () => {
  it('层降到 historical_case，记着本来是哪一层，打上"当时"', async () => {
    const k = await withKnowledge()
    const card = await k.store.propose(
      cardInput({
        layer: 'fact',
        statement: '订单 #1001 已退款 $129',
        structured: undefined,
        provenance: [{ source: 'email', ref: 'thr_1001', at: '2026-03-01T00:00:00.000Z' }],
      }),
    )
    expect(card.layer).toBe('historical_case')
    expect(card.downgraded_from).toBe('fact')
    // "当时"取出处最早的那个时间，不是入库时间
    expect(card.as_of).toBe('2026-03-01T00:00:00.000Z')
    k.close()
  })

  it('政策照旧是政策（14 天不是状态）', async () => {
    const k = await withKnowledge()
    const card = await k.store.propose(cardInput({ layer: 'policy', owner: 'per_owner' }))
    expect(card.layer).toBe('policy')
    expect(card.downgraded_from).toBeUndefined()
    expect(card.as_of).toBeUndefined()
    k.close()
  })

  it('降级之后落库、读回来都还是历史案例', async () => {
    const k = await withKnowledge()
    const card = await k.store.propose(
      cardInput({ statement: 'Order #1001 has been refunded', structured: undefined }),
    )
    const active = await k.store.activate(card.id, card.owner)
    expect(active.layer).toBe('historical_case')
    const list = await k.store.list(
      { workspace_id: card.workspace_id, layer: 'historical_case' },
      {
        person_id: 'per_owner',
        assignment_id: 'asg_owner',
        role_id: 'common.owner',
        workspace_id: card.workspace_id,
        grants: [
          { domain: 'knowledge', ops: ['read'], range: 'workspace', max_sensitivity: 'restricted' },
        ],
        ranges: [{ kind: 'store', id: 'shop_de' }],
      },
    )
    expect(list.map((c) => c.id)).toContain(card.id)
    k.close()
  })

  it('没有出处时间时用入库时间当"当时"', async () => {
    const clock = testClock()
    const k = await withKnowledge(clock)
    const card = await k.store.propose(
      cardInput({
        statement: '库存还有 3 件',
        structured: undefined,
        provenance: [{ source: 'human', ref: 'per_wang', at: 'not-a-date' }],
      }),
    )
    expect(card.as_of).toBe(T0)
    k.close()
  })
})

describe('47 J2 误伤可以人工改回来', () => {
  it('restoreLayer 把层还原，并清掉"当时"', async () => {
    const k = await withKnowledge()
    const card = await k.store.propose(
      cardInput({ layer: 'policy', statement: '超过 $500 的退款要经主管', structured: undefined }),
    )
    expect(card.layer).toBe('historical_case')

    const back = await k.store.restoreLayer(card.id, 'per_owner')
    expect(back.layer).toBe('policy')
    expect(back.as_of).toBeUndefined()
    expect(back.downgraded_from).toBeUndefined()
    k.close()
  })

  it('本来就没降过的卡，没有"改回去"可言', async () => {
    const k = await withKnowledge()
    const card = await k.store.propose(cardInput())
    await expect(k.store.restoreLayer(card.id, 'per_owner')).rejects.toThrow(/不是自动降级/)
    k.close()
  })
})
