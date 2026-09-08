import { afterEach, describe, expect, it } from 'vitest'
import { type Knowledge, KnowledgeError } from '../src/index.js'
import {
  activated,
  admin,
  aftersales,
  cardInput,
  finance,
  memoryFact,
  T0,
  testClock,
  WS,
  withKnowledge,
} from './fixtures.js'

/** 19 §7 一致性用例，逐条对照。 */
const open: Knowledge[] = []
const make = async (...args: Parameters<typeof withKnowledge>) => {
  const k = await withKnowledge(...args)
  open.push(k)
  return k
}
afterEach(() => {
  for (const k of open.splice(0)) k.close()
})

const costCard = () =>
  cardInput({
    domain: 'finance',
    sensitivity: 'confidential',
    subject: { type: 'product', id: 'sku_a1', key: 'sku_a1.成本价' },
    statement: '产品 A1 的成本价是 42 元，毛利率 61%',
    structured: { cost_price: 42 },
  })

describe('19 §7 用例 1：过滤下推 —— 无权数据域零命中，而不是命中后脱敏', () => {
  it('售后客服检索"成本价"→ 零命中；同一条查询财务能命中', async () => {
    const k = await make()
    await activated(k, costCard())

    const asHit = await k.retrieval.search({ text: '成本价', actor: aftersales() })
    expect(asHit.hits).toHaveLength(0)
    expect(asHit.relevant).toBe(false)
    expect(asHit.matched).toEqual([])
    expect(asHit.missing).toContain('成本价')

    const cfo = await k.retrieval.search({ text: '成本价', actor: finance() })
    expect(cfo.hits).toHaveLength(1)
    expect(cfo.hits[0]?.statement_redacted).toContain('成本价')
  })

  it('候选集在 SQL 里就被砍掉：无权者不会让卡片的 usage.recalled 增加', async () => {
    const k = await make()
    const card = await activated(k, costCard())
    await k.retrieval.search({ text: '成本价', actor: aftersales() })
    const seen = await k.store.get(card.id, finance())
    expect(seen?.usage.recalled).toBe(0)
  })

  it('敏感度高于 max_sensitivity 的卡同样不进候选集', async () => {
    const k = await make()
    await activated(
      k,
      cardInput({
        sensitivity: 'restricted',
        subject: { type: 'fact_card', key: 'policy.payout.de' },
        statement: '德国站打款账户与额度',
        structured: { payout_cap: 100000 },
      }),
    )
    const r = await k.retrieval.search({ text: '打款', actor: aftersales() })
    expect(r.hits).toHaveLength(0)
  })
})

describe('19 §7 用例 2：同 subject 两条矛盾事实 → 双值并存 + 冲突标记，无覆盖', () => {
  it('propose 不覆盖旧卡，双向写 conflicts', async () => {
    const k = await make()
    const first = await activated(k, cardInput())
    const second = await k.store.propose(
      cardInput({ statement: '德国站退货窗口 30 天', structured: { return_window_days: 30 } }),
    )

    expect(second.conflicts?.[0]?.with).toBe(first.id)
    expect(second.conflicts?.[0]?.note).toContain('return_window_days')
    const reloaded = await k.store.get(first.id, aftersales())
    expect(reloaded?.statement).toBe('德国站退货窗口 14 天')
    expect(reloaded?.conflicts?.[0]?.with).toBe(second.id)

    const all = await k.store.list({ workspace_id: WS }, aftersales())
    expect(all.map((c) => c.statement).sort()).toEqual([
      '德国站退货窗口 14 天',
      '德国站退货窗口 30 天',
    ])
    expect((await k.store.health(WS)).conflicts).toBe(1) // 只有 first 是 active
  })

  it('结构化值相同则不算冲突', async () => {
    const k = await make()
    await activated(k, cardInput())
    const same = await k.store.propose(cardInput({ statement: '德国站退货窗口为 14 天（复述）' }))
    expect(same.conflicts).toBeUndefined()
  })
})

describe('19 §7 用例 3：MemoryFact 写过滤', () => {
  it('邮箱 / 16 位卡号 / IBAN 全部被拒并给出原因', async () => {
    const k = await make()
    const r = await k.memory.write([
      memoryFact({ key: 'contact_email', value: '联系邮箱 kunde@example.de' }),
      memoryFact({ key: 'card', value: '卡号 4111111111111111' }),
      memoryFact({ key: 'iban', value: '账户 DE89370400440532013000' }),
    ])
    expect(r.accepted).toHaveLength(0)
    expect(r.rejected.map((x) => x.reason)).toEqual([
      expect.stringContaining('email_like'),
      expect.stringContaining('card_number_like'),
      expect.stringContaining('iban_like'),
    ])
    expect(await k.memory.recall({ type: 'customer', id: 'cus_1' })).toHaveLength(0)
  })

  it('≥9 位连续数字也拒', async () => {
    const k = await make()
    const r = await k.memory.write([memoryFact({ key: 'tracking', value: '单号 1234567890' })])
    expect(r.rejected[0]?.reason).toContain('long_digit_run')
  })
})

describe('19 §7 用例 4：precheck 不改 usage 计数', () => {
  it('precheck 只回 relevant / matched / missing', async () => {
    const k = await make()
    const card = await activated(k, cardInput())

    const pre = await k.retrieval.search({ text: '退货', actor: aftersales(), precheck: true })
    expect(pre.hits).toEqual([])
    expect(pre.relevant).toBe(true)
    expect(pre.matched).toEqual(['退货'])
    expect((await k.store.get(card.id, aftersales()))?.usage.recalled).toBe(0)

    const full = await k.retrieval.search({ text: '退货', actor: aftersales() })
    expect(full.hits).toHaveLength(1)
    expect((await k.store.get(card.id, aftersales()))?.usage.recalled).toBe(1)
  })

  it('precheck 报告缺什么', async () => {
    const k = await make()
    await activated(k, cardInput())
    const pre = await k.retrieval.search({
      text: '退货 关税',
      actor: aftersales(),
      precheck: true,
    })
    expect(pre.matched).toEqual(['退货'])
    expect(pre.missing).toEqual(['关税'])
  })
})

describe('19 §7 用例 5：90 天未召回 → health.silent', () => {
  it('注入时钟快进 91 天后计入沉默条目', async () => {
    const clock = testClock()
    const k = await make(clock)
    await activated(k, cardInput())
    expect((await k.store.health(WS)).silent).toBe(0)

    clock.advanceDays(91)
    expect((await k.store.health(WS)).silent).toBe(1)
  })

  it('期间被召回过就不算沉默', async () => {
    const clock = testClock()
    const k = await make(clock)
    await activated(k, cardInput())
    clock.advanceDays(30)
    await k.retrieval.search({ text: '退货', actor: aftersales() })
    clock.advanceDays(61)
    expect((await k.store.health(WS)).silent).toBe(0)
  })
})

describe('19 §7 用例 6：policy 层只有 owner 能决', () => {
  const policy = () =>
    cardInput({
      layer: 'policy',
      domain: 'policy',
      owner: 'per_owner',
      subject: { type: 'fact_card', key: 'policy.discount_floor.de' },
      statement: '德国站折扣底线 15%',
      structured: { discount_floor: 0.15 },
    })

  it('非 owner activate → forbidden', async () => {
    const k = await make()
    const card = await k.store.propose(policy())
    await expect(k.store.activate(card.id, 'per_someone_else')).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect((await k.store.get(card.id, admin()))?.status).toBe('proposed')
  })

  it('非 owner retire 同样 forbidden；owner 可以', async () => {
    const k = await make()
    const card = await k.store.propose(policy())
    await expect(k.store.retire(card.id, 'per_someone_else')).rejects.toBeInstanceOf(KnowledgeError)
    expect((await k.store.activate(card.id, 'per_owner')).status).toBe('active')
    expect((await k.store.retire(card.id, 'per_owner')).status).toBe('retired')
  })

  it('fact 层不受此限（审批路由归 WP4）', async () => {
    const k = await make()
    const card = await k.store.propose(cardInput())
    expect((await k.store.activate(card.id, 'per_someone_else')).status).toBe('active')
  })
})

describe('19 §7 用例 7：引用后草稿被改 → 比例过线 → health.stale', () => {
  it('drafts_edited_after_cite / cited ≥ 0.5', async () => {
    const k = await make()
    const card = await activated(k, cardInput())
    await k.retrieval.cite(card.id, 'run_1')
    await k.retrieval.cite(card.id, 'run_2')
    expect((await k.store.health(WS)).stale).toBe(0)

    await k.store.markDraftEdited(card.id)
    expect((await k.store.health(WS)).stale).toBe(1)
    expect((await k.store.get(card.id, aftersales()))?.usage).toMatchObject({
      cited: 2,
      drafts_edited_after_cite: 1,
    })
  })

  it('valid.until 过期也算 stale', async () => {
    const clock = testClock()
    const k = await make(clock)
    await activated(k, cardInput({ valid: { from: T0, until: '2026-09-20T00:00:00.000Z' } }))
    expect((await k.store.health(WS)).stale).toBe(0)
    clock.advanceDays(20)
    expect((await k.store.health(WS)).stale).toBe(1)
  })
})

describe('19 §7 用例 8：导出 markdown 再导入 → id 与出处不变', () => {
  it('往返后整卡等值', async () => {
    const source = await make()
    const a = await activated(source, cardInput())
    const b = await activated(
      source,
      cardInput({
        layer: 'policy',
        domain: 'policy',
        subject: { type: 'fact_card', key: 'policy.discount_floor.de' },
        statement: '德国站折扣底线 15% --> 不得再低',
        structured: { discount_floor: 0.15 },
        provenance: [
          {
            source: 'meeting',
            ref: '2026-08 定价会',
            locator: '00:12:30',
            quote: '底线 15%',
            at: T0,
          },
        ],
      }),
    )
    const files = await source.store.exportMarkdown(WS)
    expect(files).toHaveLength(2)
    expect(files[0]?.path.endsWith('.md')).toBe(true)
    expect(files.map((f) => f.content).join('\n')).toContain('## 出处')

    const target = await make()
    const imported = await target.store.importMarkdown(files)
    expect(imported.map((c) => c.id).sort()).toEqual([a.id, b.id].sort())

    for (const original of [a, b]) {
      const back = await target.store.get(original.id, admin())
      expect(back).toEqual(original)
      expect(back?.provenance).toEqual(original.provenance)
    }
    // 导入后照样能被检索到（索引重建）
    const r = await target.retrieval.search({ text: '退货', actor: aftersales() })
    expect(r.hits[0]?.fact_card_id).toBe(a.id)
  })
})

describe('中文检索（13 §2 的 FTS5 中文缺口）', () => {
  it('"德国站退货 14 天" 能被 "退货 德国" 命中', async () => {
    const k = await make()
    const card = await activated(
      k,
      cardInput({ statement: '德国站退货 14 天内可无理由退回，运费由买家承担' }),
    )
    const r = await k.retrieval.search({ text: '退货 德国', actor: aftersales() })
    expect(r.hits.map((h) => h.fact_card_id)).toEqual([card.id])
    expect(r.matched.sort()).toEqual(['德国', '退货'])
  })

  it('词序无关、跨词命中；不相干的中文词不命中', async () => {
    const k = await make()
    await activated(k, cardInput({ statement: '德国站退货 14 天内可无理由退回' }))
    expect(
      (await k.retrieval.search({ text: '无理由退回', actor: aftersales() })).hits,
    ).toHaveLength(1)
    expect((await k.retrieval.search({ text: '关税申报', actor: aftersales() })).hits).toHaveLength(
      0,
    )
  })
})
