/**
 * WP63（51 §2.1 / §2.2）：店铺管理与内容那几条门，跑在**真的三道门框架**里
 * （`ledger.stage` → `evaluateGuardrail` → 审批总线），不是单测一个纯函数。
 *
 * 这条文件要钉住的是五句话：
 *
 * 1. **额内自动、超额转人审**（15 §3.2）。改价 20%、库存 50 件、单码 30% 这三条额度
 *    不是"越了就禁止"，是"越了就掉一级"——L2 的自动批消失，卡进人的队列。
 * 2. **上下架 / 全站活动 / 主题发布永远人审**。哪怕报 L3（等于有人在设置里把它开到
 *    全自动），`hard_ceiling` 也会当场把它拉回来。这条是反证：想让 Agent 自己上架，
 *    这条路走不通。
 * 3. **结账 / 支付 / 税根本没有可 stage 的动作**（51 §3 N2）。不是"有动作但不给批"，
 *    是这几件事在写动作对照表里一条入口都没有——这条断言在
 *    `packages/connect-adapter/test/shopify-actions.test.ts`，与这里互为一半。
 * 4. **fail-closed**：数据不全（没读过全记录、没有 before 数量、目标不在范围里）
 *    一律 block，不是"当成 0 往下算"。
 * 5. **每条决策都留得下痕**：`effective_mandate_hash` 印在 guardrail 结果上，
 *    三道门的决策印 `GATE_RULESET_HASH`——"当时用的是哪一版规则"必须事后复核得了。
 */
import type { GateDecision, ObjectRef, ProvenanceState } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { runPrecheck } from '../src/index.js'
import { ASG, harness, outboundInput, RUN, refundStage, T0, WS } from './helpers.js'

/** 规则集哈希的形状：真值由 `@agentsws/support-core` 的 `GATE_RULESET_HASH` 给。 */
const RULESET_HASH = 'b'.repeat(64)

const PRODUCT: ObjectRef = { type: 'product', id: 'prod_1' }
const COLLECTION: ObjectRef = { type: 'collection', id: 'col_home' }
const STOCK: ObjectRef = { type: 'inventory_item', id: 'inv_1' }
const REVIEW: ObjectRef = { type: 'review', id: 'rev_9' }
const ARTICLE: ObjectRef = { type: 'article', id: 'art_3' }
const DISCOUNT: ObjectRef = { type: 'discount', id: 'dsc_1' }
const CAMPAIGN: ObjectRef = { type: 'campaign', id: 'cmp_1' }

/** 这次运行读过哪些对象；`full` 是"读了全记录"（15 §1 改前必读）。 */
const seenOf = (target: ObjectRef, full = false): ProvenanceState => ({
  run_id: RUN,
  seen: { [target.type]: [target.id] },
  read_full: full ? [`${target.type}:${target.id}`] : [],
  recorded_at: T0,
})

type Over = Parameters<typeof refundStage>[0]

/** 一条店铺侧的 stage 输入：把退款那份模板的订单味道全部换掉。 */
const storeStage = (over: Over & { target: ObjectRef }): ReturnType<typeof refundStage> =>
  refundStage({
    money: undefined,
    requester: undefined,
    target_owner: undefined,
    record_version: 'v1',
    created_by: { kind: 'agent', id: 'agent_store' },
    provenance: seenOf(over.target, true),
    approval: {
      title: '店铺改动',
      summary: '店铺改动',
      recipients: [{ person: 'p_li', via: 'scope_manager' }],
      proposer: { kind: 'agent', id: 'agent_store', assignment_id: ASG },
      separation_of_duties: true,
    },
    ...over,
  })

const priceStage = (price: number, level: 'L1' | 'L2' | 'L3' = 'L2') =>
  storeStage({
    kind: 'price_change',
    target: PRODUCT,
    field: 'price',
    before: { price: 129, title: 'USB-C 65W Charger' },
    after: { price },
    mandate: { caps: { max_price_delta_pct: 20 }, window: { max_count: 20, per: 'day' } },
    level,
  })

/**
 * 结论压成一句话：guardrail 怎么判的、命中了哪几条、卡最后自动批了没有。
 *
 * 为什么 `verdict` 与 `auto` 要分开看：guardrail 判 `allow` 只等于"这一步没越额度"，
 * 真正会不会自动批还要过 31 §3.4 那一刀——**v1 只有 low 风险的变更可以超过 L1**。
 * 改价与库存是 medium，所以它们即使额内也仍然落在人的队列里；这不是 WP63 的门松了，
 * 是平台层刻意的保守，见本文件末尾那条断言。
 */
async function verdictOf(
  h: ReturnType<typeof harness>,
  input: ReturnType<typeof refundStage>,
): Promise<{
  ok: boolean
  verdict?: 'allow' | 'require_review' | 'block'
  auto: boolean
  rules: string[]
  message?: string
}> {
  const out = await h.txn.ledger.stage(input)
  if (!out.ok)
    return {
      ok: false,
      auto: false,
      rules: out.guardrail?.hits.map((x) => x.rule) ?? [],
      ...(out.guardrail === undefined ? {} : { verdict: out.guardrail.verdict }),
      message: out.message,
    }
  return {
    ok: true,
    verdict: out.change.guardrail.verdict,
    auto: out.change.status === 'auto_approved',
    rules: out.change.guardrail.hits.map((x) => x.rule),
  }
}

// ── 改价：额内 L2 自动、超额升 L1 ──────────────────────────────────────

describe('51 §2.1 改价：额内 L2 自动，超 20% 升 L1', () => {
  it('129 → 119（降 7.8%）→ 一条 hit 都没有，guardrail 判 allow', async () => {
    const h = harness()
    const v = await verdictOf(h, priceStage(119))
    expect(v.ok).toBe(true)
    expect(v.rules).toEqual([])
    expect(v.verdict).toBe('allow')
  })

  it('129 → 99（降 23%）→ 命中 max_price_delta_pct，自动批消失，卡进人的队列', async () => {
    const h = harness()
    const out = await h.txn.ledger.stage(priceStage(99))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const hit = out.change.guardrail.hits.find((x) => x.rule === 'max_price_delta_pct')
    expect(hit?.severity).toBe('review')
    expect(hit?.cap).toBe(20)
    expect(hit?.actual).toBe(23)
    // 超额不是禁止，是转人审：卡建出来了，只是没人点头之前不施行
    expect(out.change.status).toBe('staged')
    expect(out.approval.state).toBe('pending')
    // 15 §3：这次判决用的是哪一份额度，印在结果上
    expect(out.change.guardrail.effective_mandate_hash).toMatch(/^m:[0-9a-f]{8,}$/)
  })

  it('报 L3 也一样：额度超了就是超了，等级报多高都救不回来', async () => {
    const h = harness()
    const v = await verdictOf(h, priceStage(99, 'L3'))
    expect(v.rules).toContain('max_price_delta_pct')
    expect(v.verdict).toBe('require_review')
    expect(v.auto).toBe(false)
  })
})

// ── 上下架 / 全站活动 / 主题发布：永远人审 ────────────────────────────

describe('51 §2.1 上下架 / 全站活动 / 主题发布：永远人审', () => {
  const cases: {
    kind: 'publish_product' | 'unpublish_product' | 'promotion' | 'publish_theme'
    target: ObjectRef
    before: Record<string, unknown>
    after: Record<string, unknown>
  }[] = [
    {
      kind: 'publish_product',
      target: PRODUCT,
      before: { published: false, title: 'USB-C 65W Charger' },
      after: { published: true },
    },
    {
      kind: 'unpublish_product',
      target: PRODUCT,
      before: { published: true, title: 'USB-C 65W Charger' },
      after: { published: false },
    },
    {
      kind: 'promotion',
      target: CAMPAIGN,
      before: { price: 100 },
      after: { price: 90, percent: 10 },
    },
    {
      kind: 'publish_theme',
      target: { type: 'theme', id: 'thm_2' },
      before: { theme_id: 'thm_1' },
      after: { theme_id: 'thm_2' },
    },
  ]

  for (const c of cases) {
    it(`${c.kind}：报 L3 也被 hard_ceiling 拉回人审`, async () => {
      const h = harness()
      const out = await h.txn.ledger.stage(
        storeStage({
          kind: c.kind,
          target: c.target,
          before: c.before,
          after: c.after,
          mandate: { caps: {} },
          level: 'L3',
        }),
      )
      expect(out.ok, c.kind).toBe(true)
      if (!out.ok) return
      expect(
        out.change.guardrail.hits.map((x) => x.rule),
        c.kind,
      ).toContain('hard_ceiling')
      expect(out.change.guardrail.verdict, c.kind).toBe('require_review')
      expect(out.change.status, c.kind).toBe('staged')
    })
  }
})

// ── 库存：加减额内自动、直接设定永远人审、算出负数直接拦 ──────────────

describe('51 §2.1 库存：adjust 看额度，set 永远人审', () => {
  const stock = (after: Record<string, unknown>, cap = 50) =>
    storeStage({
      kind: 'inventory_adjust',
      target: STOCK,
      before: { quantity: 120, sku: 'SKU-1' },
      after,
      mandate: { caps: { max_inventory_adjust: cap }, window: { max_count: 30, per: 'day' } },
      level: 'L2',
    })

  it('收货 +30（≤ 50）→ 没有 hit，guardrail 判 allow', async () => {
    const h = harness()
    const v = await verdictOf(h, stock({ mode: 'adjust', delta: 30 }))
    expect(v.rules).toEqual([])
    expect(v.verdict).toBe('allow')
  })

  it('报损 −80（> 50）→ 命中 max_inventory_adjust，转人审', async () => {
    const h = harness()
    const v = await verdictOf(h, stock({ mode: 'adjust', delta: -80 }))
    expect(v.rules).toContain('max_inventory_adjust')
    expect(v.verdict).toBe('require_review')
  })

  it('盘点直接设成 100（幅度只有 20，比上面那条小）→ 照样人审：看的是 mode 不是数字', async () => {
    const h = harness()
    const v = await verdictOf(h, stock({ mode: 'set', quantity: 100 }))
    expect(v.rules).toContain('inventory_set_needs_review')
    expect(v.verdict).toBe('require_review')
  })

  it('fail-closed：加减之后是负数 → block，一条变更都不进账本', async () => {
    const h = harness()
    const out = await h.txn.ledger.stage(stock({ mode: 'adjust', delta: -200 }, 500))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.guardrail?.hits.find((x) => x.rule === 'inventory_negative')?.severity).toBe('block')
    expect(await h.txn.ledger.list({ workspace_id: WS })).toHaveLength(0)
  })

  it('fail-closed：不知道现在有多少 → block，不当成 0 往下算', async () => {
    const h = harness()
    const out = await h.txn.ledger.stage(
      storeStage({
        kind: 'inventory_adjust',
        target: STOCK,
        before: { sku: 'SKU-1' },
        after: { mode: 'adjust', delta: 10 },
        mandate: { caps: { max_inventory_adjust: 50 } },
        level: 'L2',
      }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.guardrail?.hits.map((x) => x.rule)).toContain('inventory_before_ungrounded')
  })

  it('换一个仓 = 把数写到别的货上了：受保护字段 block', async () => {
    const h = harness()
    const out = await h.txn.ledger.stage(
      storeStage({
        kind: 'inventory_adjust',
        target: STOCK,
        before: { quantity: 120, location_id: 'loc_1' },
        after: { mode: 'adjust', delta: 10, location_id: 'loc_2' },
        mandate: { caps: { max_inventory_adjust: 50 } },
        level: 'L2',
      }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.guardrail?.hits.map((x) => x.rule)).toContain('protected_field')
  })
})

// ── 促销与折扣 ────────────────────────────────────────────────────────

describe('51 §2.1 促销与折扣：单码看力度与限量', () => {
  const code = (after: Record<string, unknown>) =>
    storeStage({
      kind: 'discount_code',
      target: DISCOUNT,
      before: {},
      after,
      mandate: {
        caps: { max_promo_discount_pct: 30, max_promo_uses: 500 },
        window: { max_count: 10, per: 'day' },
      },
      level: 'L2',
    })

  it('八折限量 200 → 额内且限量，L2 自动', async () => {
    const h = harness()
    const v = await verdictOf(h, code({ percent: 20, usage_limit: 200 }))
    expect(v.rules).toEqual([])
    expect(v.auto).toBe(true)
  })

  it('五折 → 超 30%，转人审', async () => {
    const h = harness()
    const v = await verdictOf(h, code({ percent: 50, usage_limit: 200 }))
    expect(v.rules).toContain('max_promo_discount_pct')
    expect(v.verdict).toBe('require_review')
    expect(v.auto).toBe(false)
  })

  it('无上限码（没有 usage_limit）→ 永远人审，哪怕力度只有 5%', async () => {
    const h = harness()
    const v = await verdictOf(h, code({ percent: 5 }))
    expect(v.rules).toContain('max_promo_uses')
    expect(v.verdict).toBe('require_review')
    expect(v.auto).toBe(false)
  })

  it('客服的安抚发码不受营销那组额度牵连：两组 cap 各判各的', async () => {
    const h = harness()
    // 客服那条职责配的是 `max_presales_discount_pct`，没有 `max_promo_uses`——
    // 于是"没写限量"这一条根本不问（否则每一张安抚码都要人点一下）
    const v = await verdictOf(
      h,
      storeStage({
        kind: 'discount_code',
        target: DISCOUNT,
        before: {},
        after: { percent: 10 },
        mandate: { caps: { max_presales_discount_pct: 15 } },
        level: 'L2',
      }),
    )
    expect(v.rules).toEqual([])
    expect(v.auto).toBe(true)
  })
})

// ── 集合 ──────────────────────────────────────────────────────────────

describe('51 §2.1 集合：改货架之前必须真读过它', () => {
  const collection = (over: Partial<{ products: string[]; full: boolean }> = {}) =>
    storeStage({
      kind: 'collection_edit',
      target: COLLECTION,
      before: { title: '首页精选', product_count: 12 },
      after: { products: over.products ?? ['prod_1', 'prod_2'] },
      mandate: { caps: { max_collection_products: 20 } },
      level: 'L2',
      provenance: seenOf(COLLECTION, over.full ?? true),
    })

  // 集合是 low 风险，所以它是少数**真的会自动批**的店铺动作之一（31 §3.4）
  it('读过全记录、只动两件 → L2 自动批', async () => {
    const h = harness()
    const v = await verdictOf(h, collection())
    expect(v.rules).toEqual([])
    expect(v.auto).toBe(true)
  })

  it('fail-closed：只看了摘要就改 → block（15 §1 改前必读）', async () => {
    const h = harness()
    const out = await h.txn.ledger.stage(collection({ full: false }))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.guardrail?.hits.map((x) => x.rule)).toContain('requires_record_read')
  })

  it('一次动 25 件 → 那不是调整货架是重排集合，转人审', async () => {
    const h = harness()
    const v = await verdictOf(
      h,
      collection({ products: Array.from({ length: 25 }, (_, i) => `prod_${i}`) }),
    )
    expect(v.rules).toContain('max_collection_products')
    expect(v.auto).toBe(false)
  })
})

// ── 评价 ──────────────────────────────────────────────────────────────

describe('51 §2.1 评价：回复看评分，邀评看合规词表', () => {
  const reply = (rating: number, full = true) =>
    storeStage({
      kind: 'review_reply',
      target: REVIEW,
      before: { rating, body: 'Cable stopped working after a week.' },
      after: { body: 'Sorry about that — here is what we can do.' },
      mandate: { caps: { review_reply_min_rating: 3 }, window: { max_count: 30, per: 'day' } },
      level: 'L2',
      provenance: seenOf(REVIEW, full),
    })

  it('四星好评的回复 → L2 自动', async () => {
    const h = harness()
    const v = await verdictOf(h, reply(4))
    expect(v.rules).toEqual([])
    expect(v.auto).toBe(true)
  })

  it('两星差评 → 命中 review_reply_min_rating，不自动（差评转客服 `dtc.support`）', async () => {
    const h = harness()
    const v = await verdictOf(h, reply(2))
    expect(v.rules).toContain('review_reply_min_rating')
    expect(v.verdict).toBe('require_review')
    expect(v.auto).toBe(false)
  })

  it('fail-closed：没读过那条评价就回 → block', async () => {
    const h = harness()
    const out = await h.txn.ledger.stage(reply(4, false))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.guardrail?.hits.map((x) => x.rule)).toContain('requires_record_read')
  })

  const invite = (body: string) =>
    storeStage({
      kind: 'review_invite',
      target: REVIEW,
      before: {},
      after: { body },
      mandate: {
        caps: { max_review_invites_per_day: 50 },
        window: { max_count: 50, per: 'day' },
      },
      level: 'L2',
    })

  it('干净的邀评 → L2 自动', async () => {
    const h = harness()
    const v = await verdictOf(h, invite('How is your charger? A short review would help us a lot.'))
    expect(v.rules).toEqual([])
    expect(v.auto).toBe(true)
  })

  it('「五星好评返现」→ block，不给"人点一下就发"的路径', async () => {
    const h = harness()
    const out = await h.txn.ledger.stage(invite('留五星好评返现 $5，谢谢支持！'))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.guardrail?.hits.find((x) => x.rule === 'review_invite_compliance')?.severity).toBe(
      'block',
    )
    expect(await h.txn.ledger.list({ workspace_id: WS })).toHaveLength(0)
  })

  it('英文的同一句话也拦：Leave a 5-star review and get a gift card', async () => {
    const h = harness()
    const out = await h.txn.ledger.stage(invite('Leave a 5-star review and get a gift card!'))
    expect(out.ok).toBe(false)
  })
})

// ── 内容与博客（51 §2.2）──────────────────────────────────────────────

describe('51 §2.2 博客：草稿 L2、发布 L1、每天两篇', () => {
  const post = (published: boolean) =>
    storeStage({
      kind: 'publish_post',
      target: ARTICLE,
      before: { title: '如何挑一根快充线', published: false },
      after: { title: '如何挑一根快充线', published },
      mandate: { caps: { max_posts_per_day: 2 }, window: { max_count: 20, per: 'day' } },
      level: 'L2',
      role_id: 'dtc.content',
    })

  it('草稿 → 没有 hit，guardrail 判 allow（躺在后台的东西不惊动人）', async () => {
    const h = harness()
    const v = await verdictOf(h, post(false))
    expect(v.rules).toEqual([])
    expect(v.verdict).toBe('allow')
  })

  it('发布 → 命中 publish_post_needs_review，转人审', async () => {
    const h = harness()
    const v = await verdictOf(h, post(true))
    expect(v.rules).toContain('publish_post_needs_review')
    expect(v.verdict).toBe('require_review')
    expect(v.auto).toBe(false)
  })

  it('博客不进 HARD_L1：它是按 published 分档的，不是一刀切', async () => {
    const h = harness()
    const v = await verdictOf(h, post(false))
    expect(v.rules).not.toContain('hard_ceiling')
  })
})

// ── 范围与留痕 ────────────────────────────────────────────────────────

describe('44 G2 / 15 §3：新 kind 也走同一条范围门与同一份留痕', () => {
  it('库存 / 集合 / 评价的目标不在范围里 → 与改价同一条路 block', async () => {
    const asked: string[] = []
    const h = harness({
      targetInRange: ({ kind }) => {
        asked.push(kind)
        return { ok: false, reason: '这件货归户外线那条岗位管' }
      },
    })
    const inputs = [
      storeStage({
        kind: 'inventory_adjust',
        target: STOCK,
        before: { quantity: 10 },
        after: { mode: 'adjust', delta: 1 },
        mandate: { caps: {} },
        level: 'L2',
      }),
      storeStage({
        kind: 'collection_edit',
        target: COLLECTION,
        before: { title: 'x' },
        after: { products: ['prod_1'] },
        mandate: { caps: {} },
        level: 'L2',
      }),
      storeStage({
        kind: 'review_reply',
        target: REVIEW,
        before: { rating: 5 },
        after: { body: 'thanks' },
        mandate: { caps: {} },
        level: 'L2',
      }),
    ]
    for (const input of inputs) {
      const out = await h.txn.ledger.stage(input)
      expect(out.ok, input.kind).toBe(false)
      if (out.ok) continue
      expect(out.message).toContain('target_in_range')
    }
    expect(asked).toEqual(['inventory_adjust', 'collection_edit', 'review_reply'])
  })

  it('留痕两头都在：guardrail 印额度哈希，三道门印规则集哈希', async () => {
    const h = harness()
    const out = await h.txn.ledger.stage(priceStage(119))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    // guardrail 那一侧的锚：这次判决用的是哪一份额度
    expect(out.change.guardrail.effective_mandate_hash.length).toBeGreaterThan(8)

    // 门那一侧的锚：前置层把 `ruleset_hash` 原样转录进给人看的那句话里——
    // "当时用的是哪一版规则"必须事后复核得了，而不是只留一个 fail
    const gate: GateDecision = {
      gate: 'commitment_scan',
      status: 'gate_error',
      ruleset_hash: RULESET_HASH,
      reason: '规则集加载失败',
    }
    const pre = runPrecheck(outboundInput(), { gates: [gate] })
    // fail-closed：门自己出错 = 不自主，不是"出错就当通过"
    expect(pre.autonomous).toBe(false)
    expect(pre.precheck.commitment_scan).toBe('gate_error')
    expect((pre.precheck.notes ?? []).join(' ')).toContain(RULESET_HASH.slice(0, 12))
  })

  /**
   * 31 §3.4 的那一刀，写成断言免得下次有人以为"51 说了 L2 怎么还要人点"。
   *
   * 51 §2.1 那张表里的 L2 是**职责给的上限**；平台层另有一条更紧的规矩：
   * v1 只有 `low` 风险的变更可以超过 L1。于是改价（medium）额内也仍然进队列，
   * 集合（low）额内才真的自动批。要让改价自动，得先在 15 §2 里把它的风险级改掉——
   * 那是另一场讨论，不该由一条职责 yml 顺手做掉。
   */
  it('31 §3.4：额内不等于自动——medium 的改价进队列，low 的集合才自动批', async () => {
    const h = harness()
    const price = await verdictOf(h, priceStage(119))
    expect(price.verdict).toBe('allow')
    expect(price.auto).toBe(false)

    const h2 = harness()
    const collection = await verdictOf(
      h2,
      storeStage({
        kind: 'collection_edit',
        target: COLLECTION,
        before: { title: '首页精选' },
        after: { products: ['prod_1'] },
        mandate: { caps: { max_collection_products: 20 } },
        level: 'L2',
      }),
    )
    expect(collection.verdict).toBe('allow')
    expect(collection.auto).toBe(true)
  })
})
