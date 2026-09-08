import { afterEach, describe, expect, it } from 'vitest'
import {
  createKnowledge,
  type Embedder,
  type GrantedActor,
  type Knowledge,
  type KnowledgeEvent,
} from '../src/index.js'
import { activated, admin, aftersales, cardInput, testClock, WS } from './fixtures.js'

const open: Knowledge[] = []
afterEach(() => {
  for (const k of open.splice(0)) k.close()
})
const make = (extra: Partial<Parameters<typeof createKnowledge>[0]> = {}) => {
  const k = createKnowledge({ clock: testClock(), workspace_id: WS, ...extra })
  open.push(k)
  return k
}

/** 玩具 embedding：只数三个字，够验证 RRF 把纯词面搜不到的卡也召回。 */
const toyEmbed: Embedder = (text) => [
  (text.match(/退/g) ?? []).length,
  (text.match(/德/g) ?? []).length,
  (text.match(/价/g) ?? []).length,
]

describe('Retrieval 过滤与排序', () => {
  it('domains / layers / scope 过滤都在候选集里生效', async () => {
    const k = make()
    await activated(k, cardInput())
    await activated(
      k,
      cardInput({
        layer: 'phrasing',
        subject: { type: 'fact_card', key: 'phrasing.return.de' },
        statement: '退货话术：先共情再给退货流程',
        structured: { tone: 'warm' },
        scope: [{ kind: 'store', id: 'shop_fr' }],
      }),
    )

    const all = await k.retrieval.search({ text: '退货', actor: admin() })
    expect(all.hits).toHaveLength(2)

    const factOnly = await k.retrieval.search({
      text: '退货',
      actor: admin(),
      layers: ['fact'],
    })
    expect(factOnly.hits).toHaveLength(1)
    expect(factOnly.hits[0]?.layer).toBe('fact')

    const deOnly = await k.retrieval.search({
      text: '退货',
      actor: admin(),
      scope: [{ kind: 'store', id: 'shop_de' }],
    })
    expect(deOnly.hits).toHaveLength(1)

    const noDomain = await k.retrieval.search({
      text: '退货',
      actor: admin(),
      domains: ['finance'],
    })
    expect(noDomain.hits).toHaveLength(0)
  })

  it('range: assigned —— 卡片 scope 与 actor ranges 无交集则不可见', async () => {
    const k = make()
    await activated(
      k,
      cardInput({
        domain: 'order',
        scope: [{ kind: 'store', id: 'shop_fr' }],
        subject: { type: 'fact_card', key: 'order.cutoff.fr' },
        statement: '法国站订单截单时间是 16 点',
        structured: { cutoff_hour: 16 },
      }),
    )
    expect((await k.retrieval.search({ text: '截单', actor: aftersales() })).hits).toHaveLength(0)

    const frStaff: GrantedActor = {
      ...aftersales(),
      person_id: 'per_fr',
      ranges: [{ kind: 'store', id: 'shop_fr' }],
    }
    expect((await k.retrieval.search({ text: '截单', actor: frStaff })).hits).toHaveLength(1)
  })

  it('没有任何 read scope → 一律零命中', async () => {
    const k = make()
    await activated(k, cardInput())
    const mute: GrantedActor = { ...aftersales(), grants: [] }
    const r = await k.retrieval.search({ text: '退货', actor: mute })
    expect(r.hits).toHaveLength(0)
    expect(r.relevant).toBe(false)
  })

  it('只有 stage 权限（无 read）不算可见', async () => {
    const k = make()
    await activated(k, cardInput())
    const stageOnly: GrantedActor = {
      ...aftersales(),
      grants: [
        { domain: 'knowledge', ops: ['stage'], range: 'workspace', max_sensitivity: 'restricted' },
      ],
    }
    expect((await k.retrieval.search({ text: '退货', actor: stageOnly })).hits).toHaveLength(0)
  })

  it('proposed / retired 的卡不进检索', async () => {
    const k = make()
    const card = await k.store.propose(cardInput())
    expect((await k.retrieval.search({ text: '退货', actor: admin() })).hits).toHaveLength(0)
    await k.store.activate(card.id, card.owner)
    expect((await k.retrieval.search({ text: '退货', actor: admin() })).hits).toHaveLength(1)
    await k.store.retire(card.id, card.owner)
    expect((await k.retrieval.search({ text: '退货', actor: admin() })).hits).toHaveLength(0)
  })

  it('k 限制返回条数，分数按相关度降序', async () => {
    const k = make()
    for (const n of [1, 2, 3])
      await activated(
        k,
        cardInput({
          subject: { type: 'fact_card', key: `policy.return_window.de.${n}` },
          statement: `德国站退货窗口说明第 ${n} 版`,
          structured: { version: n },
        }),
      )
    const r = await k.retrieval.search({ text: '退货', actor: admin(), k: 2 })
    expect(r.hits).toHaveLength(2)
    expect(r.hits[0]?.score).toBeGreaterThanOrEqual(r.hits[1]?.score ?? 0)
  })

  it('空查询：不 relevant，不报 missing', async () => {
    const k = make()
    await activated(k, cardInput())
    const r = await k.retrieval.search({ text: '   ', actor: admin() })
    expect(r).toEqual({ hits: [], relevant: false, matched: [], missing: [] })
  })

  it('statement_redacted 会遮掉秘密形态的片段', async () => {
    const k = make()
    await activated(
      k,
      cardInput({
        subject: { type: 'fact_card', key: 'policy.contact.de' },
        statement: '德国站退货联系邮箱 retoure@example.de',
        structured: { channel: 'email' },
      }),
    )
    const r = await k.retrieval.search({ text: '退货', actor: admin() })
    expect(r.hits[0]?.statement_redacted).toContain('[redacted]')
    expect(r.hits[0]?.statement_redacted).not.toContain('retoure@example.de')
  })

  it('provenance_summary 概述出处条数', async () => {
    const k = make()
    await activated(
      k,
      cardInput({
        provenance: [
          {
            source: 'document',
            ref: 'policy-de.md',
            locator: 'p2',
            at: '2026-09-09T09:00:00.000Z',
          },
          { source: 'meeting', ref: '2026-08 复盘', at: '2026-09-09T09:00:00.000Z' },
        ],
      }),
    )
    const r = await k.retrieval.search({ text: '退货', actor: admin() })
    expect(r.hits[0]?.provenance_summary).toBe('document policy-de.md p2 等 2 处')
  })
})

describe('Retrieval 向量融合与引用', () => {
  it('传了 embed 就做 RRF：词面搜不到也能召回', async () => {
    const lexical = make()
    await activated(lexical, cardInput({ statement: '德国站退货窗口 14 天' }))
    expect((await lexical.retrieval.search({ text: '退款', actor: admin() })).hits).toHaveLength(0)

    const hybrid = make({ embed: toyEmbed })
    await activated(hybrid, cardInput({ statement: '德国站退货窗口 14 天' }))
    const r = await hybrid.retrieval.search({ text: '退款', actor: admin() })
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]?.score).toBeGreaterThan(0)
  })

  it('向量路同样受可见性约束（过滤下推不被绕开）', async () => {
    const k = make({ embed: toyEmbed })
    await activated(
      k,
      cardInput({
        domain: 'finance',
        sensitivity: 'confidential',
        subject: { type: 'product', id: 'sku_a1', key: 'sku_a1.成本价' },
        statement: '产品 A1 的成本价是 42 元',
        structured: { cost_price: 42 },
      }),
    )
    expect((await k.retrieval.search({ text: '成本价', actor: aftersales() })).hits).toHaveLength(0)
    expect((await k.retrieval.search({ text: '成本价', actor: admin() })).hits).toHaveLength(1)
  })

  it('cite 记 usage.cited；不存在的 id 静默返回', async () => {
    const k = make()
    const card = await activated(k, cardInput())
    await k.retrieval.cite(card.id, 'run_9')
    expect((await k.store.get(card.id, admin()))?.usage.cited).toBe(1)
    await expect(k.retrieval.cite('fact_missing', 'run_9')).resolves.toBeUndefined()
  })

  it('命中会记 last_recalled_at 并发 knowledge.card.recalled 事件', async () => {
    const events: KnowledgeEvent[] = []
    const k = make({ emit: (e) => events.push(e) })
    const card = await activated(k, cardInput())
    await k.retrieval.search({ text: '退货', actor: admin() })
    await k.retrieval.cite(card.id, 'run_1')

    const back = await k.store.get(card.id, admin())
    expect(back?.usage.last_recalled_at).toBe('2026-09-09T09:00:00.000Z')
    expect(events.map((e) => e.type)).toEqual([
      'knowledge.card.proposed',
      'knowledge.card.activated',
      'knowledge.card.recalled',
      'knowledge.card.cited',
    ])
  })
})
