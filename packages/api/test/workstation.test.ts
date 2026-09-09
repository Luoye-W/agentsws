/** 36 §5 工作台面的一致性用例：首页三区、岗位三 Tab、积木管线、数字块设置、卡片决定。 */
import type { DeckCard, PositionTiles, StatTile } from '@agentsws/deck'
import { describe, expect, it } from 'vitest'
import type { Harness } from './helpers.js'
import { approvalItem, harness } from './helpers.js'

interface Envelope<T> {
  data: T
  trace_id: string
}
interface ErrorEnvelope {
  code: string
  message: string
  details?: { reason?: string }
}

const json = async <T>(res: Response): Promise<T> => ((await res.json()) as Envelope<T>).data
const err = async (res: Response): Promise<ErrorEnvelope> => (await res.json()) as ErrorEnvelope

interface Home {
  queue: DeckCard[]
  alerts: DeckCard[]
  tiles: PositionTiles[]
  digest?: DeckCard
  estimated_minutes: number
  range: string
}

/** 一张选择题卡（policy_change 的问句形态）。 */
function seedQuestion(h: Harness): void {
  h.approvals.seed(
    approvalItem({
      id: 'ap_question',
      kind: 'policy_change',
      workspace_id: h.workspace_id,
      title: '超窗一周的退货，怎么办？',
      payload: {
        target: 'workspace_policy',
        before: { grace_days: 0 },
        after: { grace_days: 7 },
        options: [
          { id: 'grace_7', label: '宽限 7 天' },
          { id: 'refuse', label: '不退' },
        ],
      },
      routing: {
        recipients: [{ person: h.person_id, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: {
          after_hours: 24,
          business_hours: true,
          chain: ['scope_manager', 'owner'],
          escalated_at: [],
        },
        separation_of_duties: false,
      },
      deliveries: [
        {
          channel: 'workstation',
          to: h.person_id,
          sent_at: '2026-09-07T09:00:00.000Z',
          view: 'full',
          decision_token: 'tok_q',
          status: 'sent',
        },
      ],
    }),
  )
}

describe('GET /v1/home（36 §3 首页三区）', () => {
  it('队列 + 告警 + 每岗位一条数据条 + 摘要 + 预计 X 分钟', async () => {
    const h = await harness()
    h.workstation.alertsOn = true
    const home = await json<Home>(await h.get('/v1/home'))
    expect(home.queue.map((c) => c.id)).toEqual([h.item.id])
    expect(home.alerts.map((c) => c.kind)).toEqual(['system_alert'])
    expect(home.digest?.kind).toBe('digest')
    expect(home.tiles).toHaveLength(1)
    expect(home.tiles[0]?.role_name).toBe('独立站售后客服')
    expect(home.estimated_minutes).toBeGreaterThan(0)
    expect(home.range).toBe('yesterday')
  })

  it('首页只有数字块——没有表、没有图（36 §5.2）', async () => {
    const h = await harness()
    const home = await json<Home>(await h.get('/v1/home'))
    const body = JSON.stringify(home.tiles)
    expect(body).not.toContain('"columns"')
    expect(body).not.toContain('"series"')
    for (const t of home.tiles[0]?.tiles ?? []) {
      expect(['ok', 'not_connected']).toContain(t.status)
    }
  })

  it('售后岗位的默认四块：待回复 / 24h 回复率 / 退款申请 / 满意度', async () => {
    const h = await harness()
    const home = await json<Home>(await h.get('/v1/home'))
    const tiles = home.tiles[0]?.tiles ?? []
    expect(tiles.map((t: StatTile) => t.id)).toEqual([
      'pending_replies',
      'reply_rate_24h',
      'refund_requests',
      'csat',
    ])
    // 满意度没有数据源 → 「去连接」，不是编一个 0
    expect(tiles[3]?.status).toBe('not_connected')
    expect(tiles[3]?.value).toBeUndefined()
  })

  it('range 只认两个值', async () => {
    const h = await harness()
    expect((await h.get('/v1/home?range=last_7d')).status).toBe(200)
    const bad = await h.get('/v1/home?range=last_year')
    expect(bad.status).toBe(400)
    expect((await err(bad)).code).toBe('invalid_input')
  })

  it('没装配工作台面 → not_implemented（501）', async () => {
    const h = await harness()
    delete (h.deps as { workstation?: unknown }).workstation
    const res = await h.get('/v1/home')
    expect(res.status).toBe(501)
    expect((await err(res)).code).toBe('not_implemented')
  })
})

describe('GET /v1/positions（岗位 = Assignment）', () => {
  it('返回本人的岗位、数字块库与上限', async () => {
    const h = await harness()
    const data = await json<{
      positions: { position_id: string; role_id: string }[]
      tile_library: { id: string }[]
      max_tiles: number
    }>(await h.get('/v1/positions'))
    expect(data.positions[0]?.position_id).toBe(h.assignment.id)
    expect(data.max_tiles).toBe(6)
    expect(data.tile_library.length).toBeGreaterThan(6)
  })

  it('岗位 id 必须与 X-Assignment 一致（31 §3.1）', async () => {
    const h = await harness()
    const res = await h.get('/v1/positions/asg_other/cards')
    expect(res.status).toBe(403)
  })

  it('X-Assignment 指向的岗位不在清单里 → 404', async () => {
    const h = await harness()
    const res = await h.get(`/v1/positions/${h.weakAssignment.id}/cards`, {
      assignment: h.weakAssignment.id,
    })
    expect(res.status).toBe(404)
  })
})

describe('岗位三 Tab', () => {
  it('卡片 Tab 只出这个岗位的队列，动词由服务端给', async () => {
    const h = await harness()
    const data = await json<{ cards: DeckCard[] }>(
      await h.get(`/v1/positions/${h.assignment.id}/cards`),
    )
    expect(data.cards).toHaveLength(1)
    expect(data.cards[0]?.action_labels?.approve).toBe('发送')
    expect(data.cards[0]?.available_actions).toContain('instruct')
  })

  it('面板 Tab 按数据源分块，未连接的不给完整报告链接', async () => {
    const h = await harness()
    const data = await json<{
      sections: { source: string; connected: boolean; report_url?: string; blocks: unknown[] }[]
    }>(await h.get(`/v1/positions/${h.assignment.id}/view`))
    // 售后客服的面板只有店铺后台（它的职责里没有 analytics 域）
    expect(data.sections.map((s) => s.source)).toEqual(['shop'])
    expect(data.sections[0]?.report_url).toBe('https://admin.shopify.com')
    expect(data.sections[0]?.connected).toBe(true)
  })

  it('记录 Tab 是时间线', async () => {
    const h = await harness()
    const data = await json<{ status: string; payload: { rows: { id: string }[] } }>(
      await h.get(`/v1/positions/${h.assignment.id}/records`),
    )
    expect(data.status).toBe('ok')
    expect(data.payload.rows[0]?.id).toBe(h.item.id)
  })
})

describe('GET /v1/blocks/:id/data（29 §2 渲染管线）', () => {
  it('接了的数据源出 payload，且过组件的 payload_schema', async () => {
    const h = await harness()
    const data = await json<{ status: string; payload: { columns: unknown[] } }>(
      await h.get('/v1/blocks/shop.recent_orders/data?range=last_7d'),
    )
    expect(data.status).toBe('ok')
    expect(data.payload.columns).toHaveLength(4)
  })

  it('没接的数据源回 not_connected，不回空图', async () => {
    const h = await harness()
    const data = await json<{ status: string; payload?: unknown }>(
      await h.get('/v1/blocks/ga4.active_users/data'),
    )
    expect(data.status).toBe('not_connected')
    expect(data.payload).toBeUndefined()
  })

  it('未注册的积木 id → 拒（29 §7 用例 1）', async () => {
    const h = await harness()
    const res = await h.get('/v1/blocks/evil.block/data')
    expect(res.status).toBe(400)
    expect((await err(res)).details?.reason).toBe('UNKNOWN_COMPONENT')
  })

  it('对这个数据源没有读权限 → 403（29 §2 先查权限再跑查询）', async () => {
    const h = await harness()
    // asg_weak 只有 approval.read，没有 order.read
    const res = await h.get('/v1/blocks/shop.recent_orders/data', {
      assignment: h.weakAssignment.id,
    })
    expect(res.status).toBe(403)
  })
})

describe('PUT /v1/me/home-tiles（36 §3 换 / 增减数字块）', () => {
  it('换一组块并记住时间范围', async () => {
    const h = await harness()
    const data = await json<{ position: { tile_ids: string[]; range: string }; tiles: StatTile[] }>(
      await h.put('/v1/me/home-tiles', {
        position_id: h.assignment.id,
        tile_ids: ['sales_total', 'orders_count'],
        range: 'last_7d',
      }),
    )
    expect(data.position.tile_ids).toEqual(['sales_total', 'orders_count'])
    expect(data.position.range).toBe('last_7d')
    expect(data.tiles[0]?.value).toBe(218)
  })

  it('上限 6', async () => {
    const h = await harness()
    const res = await h.put('/v1/me/home-tiles', {
      position_id: h.assignment.id,
      tile_ids: new Array(7).fill('sales_total'),
    })
    expect(res.status).toBe(400)
  })

  it('库里没有的块 → 400', async () => {
    const h = await harness()
    const res = await h.put('/v1/me/home-tiles', {
      position_id: h.assignment.id,
      tile_ids: ['made_up_tile'],
    })
    expect(res.status).toBe(400)
    expect((await err(res)).details?.reason).toBe('UNKNOWN_TILE')
  })

  it('只能改本次绑定的那个岗位', async () => {
    const h = await harness()
    const res = await h.put('/v1/me/home-tiles', { position_id: 'asg_other', tile_ids: [] })
    expect(res.status).toBe(403)
  })
})

describe('POST /v1/approvals/:id/decide 的卡片扩展（36 §2.1）', () => {
  it('选择题卡裸 approve → OPTION_REQUIRED / invalid_input', async () => {
    const h = await harness()
    seedQuestion(h)
    const res = await h.post('/v1/approvals/ap_question/decide', { action: 'approve' })
    expect(res.status).toBe(400)
    const body = await err(res)
    expect(body.code).toBe('invalid_input')
    expect(body.details?.reason).toBe('OPTION_REQUIRED')
    expect(h.approvals.log).toEqual([])
  })

  it('选对了 → 走到审批总线，动作是 approve_edited', async () => {
    const h = await harness()
    seedQuestion(h)
    const res = await h.post('/v1/approvals/ap_question/decide', {
      action: 'approve',
      selected_option_id: 'grace_7',
    })
    expect(res.status).toBe(200)
    expect(h.approvals.log).toEqual(['decide:ap_question:per_me'.replace('per_me', h.person_id)])
  })

  it('卡上没有的选项 → 400', async () => {
    const h = await harness()
    seedQuestion(h)
    const res = await h.post('/v1/approvals/ap_question/decide', {
      action: 'approve',
      selected_option_id: 'nope',
    })
    expect(res.status).toBe(400)
    expect((await err(res)).details?.reason).toBe('UNKNOWN_OPTION')
  })

  it('instruct 必须带作用域；带了就落成 reject + 指导，并回带 scope', async () => {
    const h = await harness()
    const bare = await h.post(`/v1/approvals/${h.item.id}/decide`, { action: 'instruct' })
    expect(bare.status).toBe(400)
    expect((await err(bare)).details?.reason).toBe('SCOPE_REQUIRED')

    const withScope = await h.post(`/v1/approvals/${h.item.id}/decide`, {
      action: 'instruct',
      instruction: { scope: 'similar_cases', text: '别提补偿' },
    })
    expect(withScope.status).toBe(200)
    const data = await json<{ instruction_scope: string }>(withScope)
    expect(data.instruction_scope).toBe('similar_cases')
  })

  it('similar_cases → 建 skill_lesson（overlay 提案）；global_rule → 建 policy_change', async () => {
    const lesson = await harness()
    const a = await lesson.post(`/v1/approvals/${lesson.item.id}/decide`, {
      action: 'instruct',
      instruction: { scope: 'similar_cases', text: '类似的信一律先问尺码' },
    })
    expect(a.status).toBe(200)
    const first = await json<{ instruction_proposal?: { kind: string; approval_item_id: string } }>(
      a,
    )
    expect(first.instruction_proposal?.kind).toBe('skill_lesson')

    const rule = await harness()
    const b = await rule.post(`/v1/approvals/${rule.item.id}/decide`, {
      action: 'instruct',
      instruction: { scope: 'global_rule', text: '以后一律不给运费补偿' },
    })
    const second = await json<{ instruction_proposal?: { kind: string } }>(b)
    expect(second.instruction_proposal?.kind).toBe('policy_change')

    // single_reply 维持现状：只是 reject + 指导，不建新卡
    const plain = await harness()
    const c = await plain.post(`/v1/approvals/${plain.item.id}/decide`, {
      action: 'instruct',
      instruction: { scope: 'single_reply', text: '这封改一下措辞' },
    })
    expect(await json<{ instruction_proposal?: unknown }>(c)).not.toHaveProperty(
      'instruction_proposal',
    )
  })

  it('作用域不在三个之内 → 400（zod 挡住）', async () => {
    const h = await harness()
    const res = await h.post(`/v1/approvals/${h.item.id}/decide`, {
      action: 'instruct',
      instruction: { scope: 'whatever', text: 'x' },
    })
    expect(res.status).toBe(400)
  })

  it('reject 必须写原因（14 §4）', async () => {
    const h = await harness()
    const bare = await h.post(`/v1/approvals/${h.item.id}/decide`, { action: 'reject' })
    expect(bare.status).toBe(400)
    expect((await err(bare)).details?.reason).toBe('REASON_REQUIRED')
    expect(
      (await h.post(`/v1/approvals/${h.item.id}/decide`, { action: 'reject', reason: '太长' }))
        .status,
    ).toBe(200)
  })

  it('snooze → defer', async () => {
    const h = await harness()
    const res = await h.post(`/v1/approvals/${h.item.id}/decide`, { action: 'snooze' })
    expect(res.status).toBe(200)
  })

  it('乐观并发：version 不一致 → 409', async () => {
    const h = await harness()
    const res = await h.post(`/v1/approvals/${h.item.id}/decide`, { action: 'approve', version: 9 })
    expect(res.status).toBe(409)
    expect((await err(res)).details?.reason).toBe('VERSION_MISMATCH')
  })

  it('14 的原生动作（defer / withdraw / redirect）照旧不经卡片投影', async () => {
    const h = await harness()
    const res = await h.post(`/v1/approvals/${h.item.id}/decide`, {
      action: 'defer',
      defer_until: '2026-09-08T00:00:00.000Z',
    })
    expect(res.status).toBe(200)
  })
})

describe('OpenAPI', () => {
  it('工作台的六条路由都在 /v1 之下且进了文档', async () => {
    const h = await harness()
    const paths = h.gateway.paths().map((r) => r.path)
    for (const p of [
      '/v1/home',
      '/v1/positions',
      '/v1/positions/:id/cards',
      '/v1/positions/:id/view',
      '/v1/positions/:id/records',
      '/v1/blocks/:id/data',
      '/v1/me/home-tiles',
    ]) {
      expect(paths).toContain(p)
    }
    expect(Object.keys(h.gateway.openapi.paths)).toContain('/v1/blocks/{id}/data')
    expect(
      h.gateway.specs.every((s) => s.path.startsWith('/v1') || s.path === '/openapi.json'),
    ).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 37 §1：筛选、合并、enrichment、今日战报
// ─────────────────────────────────────────────────────────────────────────

interface DeckPage {
  queue?: DeckCard[]
  cards?: DeckCard[]
  filters: Record<string, string>
  counts: { total: number; customer_waiting: number; nobody_waiting: number; matched: number }
  pinned_p0: DeckCard[]
  battle_report?: {
    date: string
    ai_handled: number
    handled: number
    auto_sent: number
    intercepted: number
  }
}

/** 同族同型同渠道的三张草稿卡，用来验合并。 */
function seedFamily(h: Harness): void {
  for (const n of [1, 2, 3]) {
    h.approvals.seed(
      approvalItem({
        id: `ap_fam_${n}`,
        workspace_id: h.workspace_id,
        dedupe_key: `draft:thr_${n}`,
        title: `草稿 ${n}`,
        payload: { channel: 'email', body: { text: `draft ${n}` } },
        routing: {
          recipients: [{ person: h.person_id, via: 'role_holder' }],
          rule: 'role_holder',
          escalation: {
            after_hours: 24,
            business_hours: true,
            chain: ['scope_manager', 'owner'],
            escalated_at: [],
          },
          separation_of_duties: false,
        },
        deliveries: [
          {
            channel: 'workstation',
            to: h.person_id,
            sent_at: '2026-09-07T09:00:00.000Z',
            view: 'full',
            decision_token: `tok_fam_${n}`,
            status: 'sent',
          },
        ],
      }),
    )
  }
}

describe('37 §1 筛选：岗位 / 等待 / 卡型 / 来源', () => {
  it('卡型筛选只留那一种，计数按张数', async () => {
    const h = await harness()
    seedQuestion(h)
    const all = await json<DeckPage>(await h.get('/v1/home'))
    expect((all.queue ?? []).length).toBeGreaterThan(1)
    const only = await json<DeckPage>(await h.get('/v1/home?kind=policy_change'))
    expect((only.queue ?? []).map((c) => c.kind)).toEqual(['policy_change'])
    expect(only.counts.total).toBe(all.counts.total)
    expect(only.counts.matched).toBe(1)
    expect(only.filters.kind).toBe('policy_change')
  })

  it('来源与岗位筛选；岗位对不上就一张不剩', async () => {
    const h = await harness()
    const conv = await json<DeckPage>(await h.get('/v1/home?source=conversation'))
    expect((conv.queue ?? []).length).toBeGreaterThan(0)
    const nobody = await json<DeckPage>(await h.get('/v1/home?source=todo'))
    expect(nobody.queue).toEqual([])
    const wrong = await json<DeckPage>(await h.get('/v1/home?position_id=asg_nope'))
    expect(wrong.queue).toEqual([])
  })

  it('等待态筛选；坏值回 400 而不是悄悄退成全部', async () => {
    const h = await harness()
    expect((await h.get('/v1/home?waiting=nobody_waiting')).status).toBe(200)
    const bad = await h.get('/v1/home?waiting=lol')
    expect(bad.status).toBe(400)
    expect((await err(bad)).code).toBe('invalid_input')
    const badSource = await h.get('/v1/home?source=nope')
    expect(badSource.status).toBe(400)
  })

  it('P0 永不被筛掉：被筛掉时回到 pinned_p0', async () => {
    const h = await harness()
    h.approvals.seed(
      approvalItem({
        id: 'ap_p0',
        workspace_id: h.workspace_id,
        priority: 'immediate',
        title: '客户在等',
        routing: {
          recipients: [{ person: h.person_id, via: 'role_holder' }],
          rule: 'role_holder',
          escalation: {
            after_hours: 1,
            business_hours: true,
            chain: ['owner'],
            escalated_at: [],
          },
          separation_of_duties: false,
        },
        deliveries: [
          {
            channel: 'workstation',
            to: h.person_id,
            sent_at: '2026-09-07T09:00:00.000Z',
            view: 'full',
            decision_token: 'tok_p0',
            status: 'sent',
          },
        ],
      }),
    )
    const page = await json<DeckPage>(await h.get('/v1/home?kind=knowledge_update'))
    expect((page.queue ?? []).map((c) => c.id)).not.toContain('ap_p0')
    expect(page.pinned_p0.map((c) => c.id)).toContain('ap_p0')
  })

  it('岗位页用同一套筛选，但 position_id 永远被钉成本次 Assignment（31 §3.1）', async () => {
    const h = await harness()
    const page = await json<DeckPage>(
      await h.get(`/v1/positions/${h.assignment.id}/cards?position_id=asg_other&source=system`),
    )
    expect(page.filters.position_id).toBe(h.assignment.id)
    expect(page.cards).toEqual([])
    const conv = await json<DeckPage>(
      await h.get(`/v1/positions/${h.assignment.id}/cards?source=conversation`),
    )
    expect((conv.cards ?? []).length).toBeGreaterThan(0)
  })
})

describe('37 §1 合并：同族同型同渠道折成一张', () => {
  it('三张同族草稿 → 一张，merge_count = 3，成员各带各的 version', async () => {
    const h = await harness()
    seedFamily(h)
    const page = await json<DeckPage>(await h.get('/v1/home?kind=outbound_draft'))
    const merged = (page.queue ?? []).find((c) => c.merge_count > 1)
    expect(merged?.merge_count).toBe(3)
    expect(merged?.merged).toHaveLength(3)
    // 计数仍按张数：合并不改总数
    expect(page.counts.matched).toBeGreaterThanOrEqual(3)
  })
})

describe('29 §2 enrichment：ObjectRef → 展示名，查不到就丢并留 note', () => {
  it('查得到的进实体芯片；查不到的丢掉并记数；证据芯片里一个裸 id 都没有', async () => {
    const h = await harness()
    h.approvals.seed(
      approvalItem({
        id: 'ap_rich',
        workspace_id: h.workspace_id,
        payload: { channel: 'email', to: { type: 'customer', id: 'cus_anna' } },
        evidence: {
          run_id: 'run_demo_42',
          source_events: [],
          provenance: {
            seen: [
              { type: 'customer', id: 'cus_anna' },
              { type: 'order', id: 'ord_1001' },
              { type: 'fact_card', id: 'fact_775c' },
            ],
          },
          precheck: { provenance: 'ok' },
          citations: [{ fact_card_id: 'fact_775c', quote: '14 days' }],
        },
        routing: {
          recipients: [{ person: h.person_id, via: 'role_holder' }],
          rule: 'role_holder',
          escalation: {
            after_hours: 24,
            business_hours: true,
            chain: ['owner'],
            escalated_at: [],
          },
          separation_of_duties: false,
        },
        deliveries: [
          {
            channel: 'workstation',
            to: h.person_id,
            sent_at: '2026-09-07T09:00:00.000Z',
            view: 'full',
            decision_token: 'tok_rich',
            status: 'sent',
          },
        ],
      }),
    )
    const page = await json<DeckPage>(await h.get('/v1/home'))
    const card = (page.queue ?? []).flatMap((c) => (c.id === 'ap_rich' ? [c] : []))[0]
    expect(card).toBeDefined()
    // 只有 cus_anna 有展示名（MemoryWorkstation.label）；订单 / 事实卡 / thread 全丢掉
    expect(card?.entity_chips).toEqual([{ type: 'customer', id: 'cus_anna', label: 'Anna Meyer' }])
    expect(card?.detail.enrichment.dropped_refs).toBeGreaterThan(0)
    expect(JSON.stringify(card?.evidence_chips)).not.toMatch(/fact_|cus_|run_|ord_/)
    // run id 只进详情
    expect(card?.detail.run_id).toBe('run_demo_42')
    expect(card?.customer_label).toBe('Anna Meyer')
  })
})

describe('37 §1 今日战报（GET /v1/home 的 battle_report）', () => {
  it('四格从事件日志算，日界线按工作区时区', async () => {
    const h = await harness()
    const at = h.clock.now()
    for (const [type, actor] of [
      ['approval.created', { kind: 'agent', id: 'agent_1', run_id: 'run_ask' }],
      ['run.completed', { kind: 'agent', id: 'agent_1', run_id: 'run_ask' }],
      ['run.completed', { kind: 'agent', id: 'agent_1', run_id: 'run_ok' }],
      ['approval.decided', { kind: 'person', id: h.person_id }],
      ['approval.auto_approved', { kind: 'system', id: 'mandate' }],
    ] as const) {
      h.eventLog.append({
        schema_version: 1,
        workspace_id: h.workspace_id,
        type,
        at,
        actor: { ...actor },
        correlation: { trace_id: 'tr_x', ...('run_id' in actor ? { run_id: actor.run_id } : {}) },
        payload: {},
      })
    }
    const page = await json<DeckPage>(await h.get('/v1/home'))
    expect(page.battle_report).toEqual({
      date: page.battle_report?.date ?? '',
      ai_handled: 1,
      handled: 1,
      auto_sent: 1,
      intercepted: 1,
    })
  })

  it('没有事件时四格是四个零，不是缺字段', async () => {
    const h = await harness()
    const page = await json<DeckPage>(await h.get('/v1/home'))
    expect(page.battle_report?.ai_handled).toBe(0)
    expect(page.battle_report?.intercepted).toBe(0)
  })
})
