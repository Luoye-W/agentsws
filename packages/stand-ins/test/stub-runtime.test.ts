import type { RunEvent } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { StandIns } from '../src/index.js'
import { createStandIns } from '../src/index.js'
import { makeRequest, runAndCollect } from './helpers.js'

async function readToken(s: StandIns, actions = ['shopify_admin.get_order']): Promise<string> {
  const t = await s.connect.issueToken({
    assignment_id: 'asg_1',
    kind: 'role-read',
    allowed_actions: actions,
    allowed_connections: ['conn_shopify_admin'],
  })
  return t.token
}

function orderOf(s: StandIns, id: string) {
  const o = s.connect.state.orders.find((x) => x.id === id)
  if (!o) throw new Error(`no order ${id}`)
  return o
}

async function scenario(overrides: Parameters<typeof makeRequest>[0] = {}, seed = 42) {
  const s = createStandIns({ seed })
  const token = await readToken(s)
  const req = makeRequest({ order: orderOf(s, 'ord_1001'), connect_token: token, ...overrides })
  const run = await runAndCollect(s.stubRuntime, req)
  return { s, req, ...run }
}

const types = (events: RunEvent[]) => events.map((e) => e.type)

describe('stub 运行时：契约与确定性', () => {
  it('name / capabilities / health', async () => {
    const s = createStandIns({ seed: 1 })
    expect(s.stubRuntime.name).toBe('stub')
    expect(s.stubRuntime.capabilities()).toEqual({
      tool_choice: true,
      streaming: false,
      followup: false,
      seedable: true,
    })
    expect(await s.stubRuntime.health()).toEqual({ ok: true })
  })

  it('同 seed 两次事件序列完全相同（26 §6 用例 1）', async () => {
    const a = await scenario({}, 42)
    const b = await scenario({}, 42)
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events))
    expect(b.result.usage).toEqual(a.result.usage)
    expect(b.result.provenance.seen).toEqual(a.result.provenance.seen)
  })

  it('context.injected 条数 = context 项数，逐项带 hash 与 bytes', async () => {
    const { req, events } = await scenario()
    const injected = events.filter((e) => e.type === 'context.injected')
    expect(injected).toHaveLength(req.context.length)
    expect(injected.map((e) => (e.type === 'context.injected' ? e.item_id : ''))).toEqual(
      req.context.map((c) => c.id),
    )
    for (const e of injected) {
      if (e.type !== 'context.injected') continue
      expect(e.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(e.bytes).toBeGreaterThan(0)
    }
  })

  it('prompt.assembled 的哈希与静态前缀哈希两次相同（17 §6 用例 2）', async () => {
    const a = await scenario()
    const b = await scenario()
    const pa = a.events.find((e) => e.type === 'prompt.assembled')
    const pb = b.events.find((e) => e.type === 'prompt.assembled')
    if (pa?.type !== 'prompt.assembled' || pb?.type !== 'prompt.assembled')
      throw new Error('缺事件')
    expect(pb.hash).toBe(pa.hash)
    expect(pb.static_prefix_hash).toBe(pa.static_prefix_hash)
    expect(pa.total_tokens).toBeGreaterThan(0)
  })

  it('persona 段顺序变化不改静态前缀（按 order 排序装配）', async () => {
    const s = createStandIns({ seed: 9 })
    const token = await readToken(s)
    const base = makeRequest({ order: orderOf(s, 'ord_1001'), connect_token: token })
    const shuffled = {
      ...base,
      persona: { sections: [...base.persona.sections].reverse() },
    }
    const a = await runAndCollect(s.stubRuntime, base)
    const b = await runAndCollect(s.stubRuntime, shuffled)
    const ha = a.events.find((e) => e.type === 'prompt.assembled')
    const hb = b.events.find((e) => e.type === 'prompt.assembled')
    if (ha?.type !== 'prompt.assembled' || hb?.type !== 'prompt.assembled')
      throw new Error('缺事件')
    expect(hb.static_prefix_hash).toBe(ha.static_prefix_hash)
  })
})

describe('stub 运行时：退货窗口内的一次完整运行', () => {
  it('get_order → provenance → 一条 staged refund + 一条草稿', async () => {
    const { s, events, result } = await scenario()
    expect(types(events)).toEqual([
      'run.started',
      'context.injected',
      'context.injected',
      'context.injected',
      'prompt.assembled',
      'tool.call',
      'tool.result',
      'change.staged',
      'proposal.created',
      'run.completed',
    ])

    const call = events.find((e) => e.type === 'tool.call')
    if (call?.type !== 'tool.call') throw new Error('缺 tool.call')
    expect(call.tool).toBe('get_order')
    expect(call.input).toEqual({ order_id: 'ord_1001' })

    const res = events.find((e) => e.type === 'tool.result')
    if (res?.type !== 'tool.result') throw new Error('缺 tool.result')
    expect(res.status).toBe('ok')
    expect(res.provenance_added).toEqual([{ type: 'order', id: 'ord_1001' }])
    expect(result.provenance.seen.order).toContain('ord_1001')

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual([
      { kind: 'staged_change', change_id: 'chg_stub_1' },
      { kind: 'draft', approval_item_id: 'appr_stub_1' },
    ])
    expect(result.no_stage).toBeUndefined()

    expect(s.staged).toHaveLength(1)
    expect(s.staged[0]?.intent).toMatchObject({
      kind: 'refund',
      target: { type: 'order', id: 'ord_1001' },
      field: 'refunded_amount',
      before: 0,
      after: 129,
      money: { amount: 129, currency: 'USD' },
      requester: { channel: 'email', external_id: 'anna@example.com' },
    })

    expect(s.drafts).toHaveLength(1)
    const draft = s.drafts[0]?.payload
    expect(draft?.to).toEqual(['anna@example.com'])
    expect(draft?.child_change_ids).toEqual(['chg_stub_1'])
    expect(draft?.citations).toEqual([
      { fact_card_id: 'ctx_policy', quote: 'returns within 14 days of delivery' },
    ])
    expect(draft?.body).toContain('14 days')
    expect(draft?.body).toContain('#1001')
    expect(draft?.body).toContain('129 USD')
    expect(draft?.body).not.toContain('补偿')
    // 围栏纪律：模板不回显客户原文
    expect(draft?.body).not.toContain('too bulky')

    expect(result.usage.tool_calls).toBe(1)
    expect(result.session_ref.runtime).toBe('stub')
  })

  it('窗口外的订单只出草稿，不 stage', async () => {
    const s = createStandIns({ seed: 42 })
    const token = await readToken(s)
    const req = makeRequest({
      order: orderOf(s, 'ord_1002'),
      connect_token: token,
      threadBody: 'I want a refund for order #1002 please.',
    })
    const { events, result } = await runAndCollect(s.stubRuntime, req)
    expect(types(events)).not.toContain('change.staged')
    expect(result.outputs).toEqual([{ kind: 'draft', approval_item_id: 'appr_stub_1' }])
    expect(s.drafts[0]?.payload.body).toContain('outside the 14-day window')
  })

  it('policy 里的窗口天数被采纳（30 天 → 窗口内）', async () => {
    const s = createStandIns({ seed: 42 })
    const token = await readToken(s)
    const req = makeRequest({
      order: orderOf(s, 'ord_1002'),
      connect_token: token,
      policyText: 'Customers may return items within 45 days of delivery.',
    })
    const { result } = await runAndCollect(s.stubRuntime, req)
    expect(result.outputs.some((o) => o.kind === 'staged_change')).toBe(true)
    expect(s.drafts[0]?.payload.body).toContain('45 days')
  })

  it('没有变更请求的来信只出草稿，且 must_stage 不触发 no_stage', async () => {
    const s = createStandIns({ seed: 42 })
    const token = await readToken(s)
    const req = makeRequest({
      order: orderOf(s, 'ord_1001'),
      connect_token: token,
      threadBody: 'Just checking where my parcel is, thanks!',
      threadSubject: 'Where is my parcel?',
      mustStage: true,
      grounding: [
        {
          name: 'order_lookup',
          intent_terms: ['parcel', 'where'],
          cue_terms: [],
          tool: 'get_order',
          prefetch: false,
        },
      ],
    })
    const { result } = await runAndCollect(s.stubRuntime, req)
    expect(result.no_stage).toBeUndefined()
    expect(result.outputs.map((o) => o.kind)).toEqual(['draft'])
  })

  it('must_stage_if_change_requested 却没 stage → no_stage（15 §4.4）', async () => {
    const s = createStandIns({ seed: 42 })
    const token = await readToken(s)
    const req = makeRequest({
      order: orderOf(s, 'ord_1002'),
      connect_token: token,
      mustStage: true,
      outputs: ['draft'],
    })
    const { result } = await runAndCollect(s.stubRuntime, req)
    expect(result.no_stage).toBe(true)
  })
})

describe('stub 运行时：预算与门禁', () => {
  it('max_tool_calls=0 → budget.exhausted 且补齐未闭合调用（17 §6 用例 4）', async () => {
    const { events, result, s } = await scenario({ maxToolCalls: 0 })
    expect(types(events)).toEqual([
      'run.started',
      'context.injected',
      'context.injected',
      'context.injected',
      'prompt.assembled',
      'tool.call',
      'budget.exhausted',
      'tool.result',
      'run.completed',
    ])
    const call = events.find((e) => e.type === 'tool.call')
    const res = events.find((e) => e.type === 'tool.result')
    if (call?.type !== 'tool.call' || res?.type !== 'tool.result') throw new Error('缺事件')
    expect(res.call_id).toBe(call.call_id)
    expect(res).toMatchObject({ status: 'blocked', reason: 'budget_exhausted' })
    expect(result.status).toBe('budget_exhausted')
    expect(result.usage.tool_calls).toBe(0)
    // 未 stage 的产物被丢弃
    expect(result.outputs).toEqual([])
    expect(s.staged).toEqual([])
    expect(s.drafts).toEqual([])
  })

  it('max_tool_calls=1 → 最后一次调用前发 budget.warning', async () => {
    const { events } = await scenario({ maxToolCalls: 1 })
    expect(types(events)).toContain('budget.warning')
    expect(types(events)).not.toContain('budget.exhausted')
  })

  it('max_tokens 超了直接 budget.exhausted，不调工具', async () => {
    const { events, result } = await scenario({ maxTokens: 10 })
    expect(types(events)).toEqual([
      'run.started',
      'context.injected',
      'context.injected',
      'context.injected',
      'prompt.assembled',
      'budget.exhausted',
      'run.completed',
    ])
    expect(result.status).toBe('budget_exhausted')
  })

  it('不在 allowlist 的工具 → tool.result{blocked}，不到达工具（17 §6 用例 3）', async () => {
    const { events, s } = await scenario({ allow: ['search_policies'] })
    const res = events.find((e) => e.type === 'tool.result')
    if (res?.type !== 'tool.result') throw new Error('缺 tool.result')
    expect(res.status).toBe('blocked')
    expect(res.reason).toContain('not_in_allowlist')
    expect(s.observations.all()).toEqual([])
  })

  it('side_effect_policy=executor 下 write_external 被 block（16 §3）', async () => {
    const s = createStandIns({ seed: 42 })
    const token = await readToken(s, ['shopify_admin.get_order', 'shopify_admin.create_refund'])
    const req = makeRequest({
      order: orderOf(s, 'ord_1001'),
      connect_token: token,
      allow: ['create_refund'],
      grounding: [
        {
          name: 'refund',
          intent_terms: ['refund'],
          cue_terms: [],
          tool: 'create_refund',
          prefetch: false,
        },
      ],
    })
    const { events } = await runAndCollect(s.stubRuntime, req)
    const res = events.find((e) => e.type === 'tool.result')
    if (res?.type !== 'tool.result') throw new Error('缺 tool.result')
    expect(res.status).toBe('blocked')
    expect(res.reason).toContain('write_external_requires_executor')
    expect(s.connect.state.orders[0]?.refunded_amount).toBe(0)
  })

  it('工具执行报错 → tool.result{error}，不 stage（provenance 未命中）', async () => {
    const s = createStandIns({ seed: 42 })
    const token = await readToken(s)
    s.connect.inject({ action: 'get_order', code: 500, times: 1 })
    const req = makeRequest({ connect_token: token, allow: ['get_order'] })
    const { events, result } = await runAndCollect(s.stubRuntime, req)
    const res = events.find((e) => e.type === 'tool.result')
    if (res?.type !== 'tool.result') throw new Error('缺 tool.result')
    expect(res.status).toBe('error')
    expect(result.outputs.map((o) => o.kind)).toEqual(['draft'])
  })

  it('AbortSignal → run.cancelled', async () => {
    const s = createStandIns({ seed: 42 })
    const token = await readToken(s)
    const ctrl = new AbortController()
    ctrl.abort()
    const req = makeRequest({ order: orderOf(s, 'ord_1001'), connect_token: token })
    const { events, result } = await runAndCollect(s.stubRuntime, req, ctrl.signal)
    expect(types(events)).toEqual(['run.started', 'run.cancelled'])
    expect(result.status).toBe('cancelled')
  })
})

describe('stub 运行时：没有订单上下文时', () => {
  it('没有订单也没有 grounding 命中 → 不调工具，只出草稿', async () => {
    const s = createStandIns({ seed: 42 })
    const token = await readToken(s)
    const req = makeRequest({
      connect_token: token,
      threadBody: 'Do you ship to Norway?',
      grounding: [],
    })
    const { events, result } = await runAndCollect(s.stubRuntime, req)
    expect(types(events)).not.toContain('tool.call')
    expect(result.usage.tool_calls).toBe(0)
    expect(s.drafts[0]?.payload.body).toContain('Tell us the order number')
  })

  it('没有注入 executeTool → tool.result{error: no_tool_executor}', async () => {
    const s = createStandIns({ seed: 42 })
    const token = await readToken(s)
    const req = makeRequest({ order: orderOf(s, 'ord_1001'), connect_token: token })
    // 不注入 executeTool 的 stub：直接构造
    const { createStubRuntime } = await import('../src/index.js')
    const runtime = createStubRuntime({ clock: s.clock, seed: 1 })
    const { events } = await runAndCollect(runtime, req)
    const res = events.find((e) => e.type === 'tool.result')
    if (res?.type !== 'tool.result') throw new Error('缺 tool.result')
    expect(res.reason).toBe('no_tool_executor')
  })
})
