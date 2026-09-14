/**
 * WP56 第 3 件：长上下文检索档（48 §4 #7）与知识的适用范围（48 §3 L2）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  createKnowledge,
  DEFAULT_CONTEXT_BUDGET_CHARS,
  decideTier,
  type Knowledge,
} from '../src/index.js'
import { activated, admin, cardInput, testClock, WS } from './fixtures.js'

const open: Knowledge[] = []
afterEach(() => {
  for (const k of open.splice(0)) k.close()
})
const make = (budgetChars?: number) => {
  const k = createKnowledge({
    clock: testClock(),
    workspace_id: WS,
    ...(budgetChars === undefined ? {} : { budgetChars }),
  })
  open.push(k)
  return k
}

const card = (n: number, over = {}) =>
  cardInput({
    subject: { type: 'fact_card', key: `policy.topic.${n}` },
    statement: `第 ${n} 条：德国站退货窗口 14 天`,
    structured: { n },
    ...over,
  })

describe('检索档的选择', () => {
  it('装得下走 context，装不下走 lexical；hybrid 是显式选的', () => {
    expect(decideTier({ mode: 'auto', kb_chars: 100, budget_chars: 16_000 })).toBe('context')
    expect(decideTier({ mode: 'auto', kb_chars: 20_000, budget_chars: 16_000 })).toBe('lexical')
    expect(decideTier({ mode: 'lexical', kb_chars: 10, budget_chars: 16_000 })).toBe('lexical')
    expect(decideTier({ mode: 'hybrid', kb_chars: 10, budget_chars: 16_000 })).toBe('hybrid')
  })

  it('缺省预算是 16000 字符', () => {
    expect(DEFAULT_CONTEXT_BUDGET_CHARS).toBe(16_000)
  })
})

describe('长上下文档', () => {
  it('小库：整库注入，问什么都在，不检索', async () => {
    const k = make()
    for (const n of [1, 2, 3]) await activated(k, card(n))
    const r = await k.retrieval.search({ text: '关税申报', actor: admin() })
    expect(r.tier).toBe('context')
    expect(r.hits).toHaveLength(3)
  })

  it('超预算就退回 lexical（词面不沾边的就搜不到了）', async () => {
    const k = make(40)
    for (const n of [1, 2, 3]) await activated(k, card(n))
    const r = await k.retrieval.search({ text: '关税申报', actor: admin() })
    expect(r.tier).toBe('lexical')
    expect(r.hits).toHaveLength(0)
  })

  it('过滤下推还在：context 档也只给这个人看得见的那些', async () => {
    const k = make()
    await activated(k, card(1))
    await activated(
      k,
      card(2, { domain: 'finance', sensitivity: 'confidential', statement: '成本价 12 美元' }),
    )
    const { aftersales } = await import('./fixtures.js')
    const r = await k.retrieval.search({ text: '随便什么', actor: aftersales() })
    expect(r.hits.every((h) => !h.statement_redacted.includes('成本价'))).toBe(true)
  })

  it('precheck 照旧不读正文、不计 usage（context 档不绕过这条）', async () => {
    const k = make()
    const c = await activated(k, card(1))
    const r = await k.retrieval.search({ text: '退货', actor: admin(), precheck: true })
    expect(r.hits).toHaveLength(0)
    expect(k.store.getUnchecked(c.id)?.usage.recalled).toBe(0)
  })

  it('装箱按溯源分层：stale 的最先被挤出预算', async () => {
    // 预算只够一条；一条 fresh 一条 stale → 留下 fresh 那条
    const k = make(200)
    const fresh = await activated(k, card(1))
    const stale = await activated(k, card(2))
    await k.store.patch(stale.id, { verification_state: 'stale' })
    const r = await k.retrieval.search({ text: '退货', actor: admin(), budget_chars: 1 })
    expect(r.hits[0]?.fact_card_id).toBe(fresh.id)
  })

  it('命中带着溯源四件套出来', async () => {
    const k = make()
    const c = await activated(
      k,
      card(1, {
        provenance: [
          { source: 'web', ref: 'https://shop.example/p', at: '2026-09-01T00:00:00.000Z' },
        ],
        last_verified_at: '2026-09-02T00:00:00.000Z',
      }),
    )
    const r = await k.retrieval.search({ text: '退货', actor: admin() })
    const hit = r.hits.find((h) => h.fact_card_id === c.id)
    expect(hit?.provenance_grade).toBe('cited')
    expect(hit?.verification).toBe('fresh')
    expect(hit?.last_verified_at).toBe('2026-09-02T00:00:00.000Z')
  })
})

describe('售前 / 售后是知识的适用范围', () => {
  it('只排除只属于另一头的；both 与没标的两头都进', async () => {
    const k = make()
    const both = await activated(k, card(1))
    const pre = await activated(k, card(2, { stage: 'presales' }))
    const post = await activated(k, card(3, { stage: 'postsales' }))
    const r = await k.retrieval.search({ text: '退货', actor: admin(), stage: 'postsales' })
    const ids = r.hits.map((h) => h.fact_card_id)
    expect(ids).toContain(both.id)
    expect(ids).toContain(post.id)
    expect(ids).not.toContain(pre.id)
  })

  it('不给 stage 就不按适用范围过滤（存量调用方行为不变）', async () => {
    const k = make()
    await activated(k, card(1, { stage: 'presales' }))
    await activated(k, card(2, { stage: 'postsales' }))
    expect((await k.retrieval.search({ text: '退货', actor: admin() })).hits).toHaveLength(2)
  })

  it('lexical 档同样按适用范围过滤（过滤下推，不是命中后再筛）', async () => {
    const k = make(1)
    await activated(k, card(1, { stage: 'presales' }))
    const post = await activated(k, card(2, { stage: 'postsales' }))
    const r = await k.retrieval.search({
      text: '退货',
      actor: admin(),
      stage: 'postsales',
      mode: 'lexical',
    })
    expect(r.hits.map((h) => h.fact_card_id)).toEqual([post.id])
  })
})
