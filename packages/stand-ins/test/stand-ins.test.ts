import { describe, expect, it } from 'vitest'
import {
  createStandIns,
  DEFAULT_START,
  defaultState,
  ObservationLog,
  SyntheticClock,
  summarizeInput,
} from '../src/index.js'
import { makeRequest, orderOf, runAndCollect } from './helpers.js'

describe('createStandIns 装配', () => {
  it('一次拿到全部替身，共享同一个合成时钟', () => {
    const s = createStandIns()
    expect(s.seed).toBe(42)
    expect(s.clock.now()).toBe(DEFAULT_START)
    expect(s.connect.state.orders).toHaveLength(3)
    expect(s.stubRuntime.name).toBe('stub')
    expect(s.replayRuntime.name).toBe('replay')
    expect(s.devStub.name).toBe('dev-stub')
    expect(s.deliveries.workstation.channel).toBe('workstation')
    expect(s.registry.size).toBe(0)
    expect(s.observations).toBeInstanceOf(ObservationLog)
    expect(s.actors.list()).toEqual([])

    s.clock.advance(1000)
    expect(s.connect.state.orders[0]?.id).toBe('ord_1001')
  })

  it('自定义 seed / start / state / actors / 审批总线', () => {
    const clock = new SyntheticClock('2026-01-01T00:00:00.000Z')
    const state = defaultState('2026-01-01T00:00:00.000Z')
    state.orders = state.orders.slice(0, 1)
    const s = createStandIns({
      seed: 7,
      clock,
      state,
      workspace_id: 'ws_other',
      actors: [
        { person_id: 'p_wang', workspace_id: 'ws_other', policy: { kind: 'always_approve' } },
      ],
      returnWindowDays: 30,
      signature: 'Ops Team',
    })
    expect(s.seed).toBe(7)
    expect(s.connect.state.orders).toHaveLength(1)
    expect(s.actors.list()).toHaveLength(1)
  })

  it('默认 stage / 起草出口把产物记在内存里', async () => {
    const s = createStandIns({ seed: 42 })
    const token = await s.connect.issueToken({
      assignment_id: 'asg_1',
      kind: 'role-read',
      allowed_actions: ['shopify_admin.get_order'],
      allowed_connections: ['conn_shopify_admin'],
    })
    const req = makeRequest({
      order: orderOf(s, 'ord_1001'),
      connect_token: token.token,
    })
    await runAndCollect(s.stubRuntime, req)
    expect(s.staged.map((x) => x.change_id)).toEqual(['chg_stub_1'])
    expect(s.drafts.map((x) => x.approval_item_id)).toEqual(['appr_stub_1'])
    expect(s.staged[0]?.at).toBe(DEFAULT_START)
    // 出站观察：stub 的一次 get_order 落进了同一份日志
    expect(s.observations.all().map((o) => o.action_id)).toEqual(['shopify_admin.get_order'])
  })

  it('可注入自己的 stage / createDraft / executeTool', async () => {
    const calls: string[] = []
    const s = createStandIns({
      seed: 42,
      executeTool: async ({ name }) => {
        calls.push(name)
        return { status: 'ok', data: { id: 'ord_1001', financial_status: 'paid' } }
      },
      stage: async () => {
        calls.push('stage')
        return { change_id: 'chg_real_1' }
      },
      createDraft: async () => {
        calls.push('draft')
        return { approval_item_id: 'ai_real_1' }
      },
    })
    const req = makeRequest({ order: orderOf(s, 'ord_1001') })
    const { result } = await runAndCollect(s.stubRuntime, req)
    expect(calls).toEqual(['get_order', 'stage', 'draft'])
    expect(result.outputs).toEqual([
      { kind: 'staged_change', change_id: 'chg_real_1' },
      { kind: 'draft', approval_item_id: 'ai_real_1' },
    ])
    expect(s.staged).toEqual([])
  })

  it('stage / createDraft 返回 undefined 时不产出对应产物', async () => {
    const s = createStandIns({
      seed: 42,
      stage: async () => undefined,
      createDraft: async () => undefined,
      executeTool: async () => ({ status: 'ok', data: { id: 'ord_1001', line_items: [] } }),
    })
    const req = makeRequest({ order: orderOf(s, 'ord_1001'), mustStage: true })
    const { events, result } = await runAndCollect(s.stubRuntime, req)
    expect(events.map((e) => e.type)).not.toContain('change.staged')
    expect(events.map((e) => e.type)).not.toContain('proposal.created')
    expect(result.outputs).toEqual([])
    expect(result.no_stage).toBe(true)
  })
})

describe('默认工具执行器（connectToolExecutor）', () => {
  it('未知工具名 → tool.result{error}，不当成 blocked', async () => {
    const s = createStandIns({ seed: 42 })
    const req = makeRequest({
      order: orderOf(s, 'ord_1001'),
      allow: ['does_not_exist'],
      grounding: [
        {
          name: 'x',
          intent_terms: ['refund'],
          cue_terms: [],
          tool: 'does_not_exist',
          prefetch: false,
        },
      ],
    })
    const { events } = await runAndCollect(s.stubRuntime, req)
    const res = events.find((e) => e.type === 'tool.result')
    if (res?.type !== 'tool.result') throw new Error('缺 tool.result')
    expect(res.status).toBe('error')
    expect(res.reason).toContain('未知 Action')
  })

  it('token 无效 → tool.result{error}；订单已由 ContextItem 进 provenance，仍可 stage', async () => {
    const s = createStandIns({ seed: 42 })
    const req = makeRequest({ order: orderOf(s, 'ord_1001'), connect_token: 'tok_bogus' })
    const { events, result } = await runAndCollect(s.stubRuntime, req)
    const res = events.find((e) => e.type === 'tool.result')
    if (res?.type !== 'tool.result') throw new Error('缺 tool.result')
    expect(res.status).toBe('error')
    expect(res.reason).toContain('connect token 无效')
    // 15 §6：provenance 证明"本次运行读过"，注入的 order ContextItem 就算读过
    expect(result.provenance.seen.order).toContain('ord_1001')
    expect(result.outputs.map((o) => o.kind)).toEqual(['staged_change', 'draft'])
  })
})

describe('假编码执行器 dev-stub（17 §4）', () => {
  it('dev_task → 固定的 dev_result（PR url / theme id）', async () => {
    const s = createStandIns({ seed: 42 })
    const req = makeRequest({ kind: 'dev_task' })
    const { events, result } = await runAndCollect(s.devStub, req)
    expect(events.map((e) => e.type)).toEqual([
      'run.started',
      'progress',
      'progress',
      'progress',
      'progress',
      'run.completed',
    ])
    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual([{ kind: 'dev_result', dev_task_id: 'wi_1' }])
    expect(s.devStub.resultOf('run_1')).toEqual({
      dev_task_id: 'wi_1',
      pr_url: 'https://github.com/agentsws/stand-in-repo/pull/1',
      theme_id: 'theme_stand_in_1',
      branch: 'agent/dev-task',
      commit: '0'.repeat(40),
      checks: 'passed',
    })
    expect(result.summary).toContain('pull/1')
    expect(s.devStub.capabilities().seedable).toBe(true)
    expect(await s.devStub.health()).toEqual({ ok: true })
    expect(s.devStub.resultOf('run_other')).toBeUndefined()
  })

  it('非 dev_task → run.failed', async () => {
    const s = createStandIns({ seed: 42 })
    const { events, result } = await runAndCollect(s.devStub, makeRequest({ kind: 'work_item' }))
    expect(events.map((e) => e.type)).toEqual(['run.started', 'run.failed'])
    expect(result.status).toBe('failed')
    expect(result.summary).toContain("dev-stub 只接受 kind='dev_task'")
  })

  it('中断 → run.cancelled；可覆盖固定返回值', async () => {
    const s = createStandIns({ seed: 42 })
    const ctrl = new AbortController()
    ctrl.abort()
    const { result } = await runAndCollect(
      s.devStub,
      makeRequest({ kind: 'dev_task' }),
      ctrl.signal,
    )
    expect(result.status).toBe('cancelled')

    const { createDevStubRuntime } = await import('../src/index.js')
    const custom = createDevStubRuntime({
      clock: s.clock,
      result: { pr_url: 'https://example.com/pr/9', theme_id: 'theme_9' },
    })
    const out = await runAndCollect(custom, makeRequest({ kind: 'dev_task', id: 'run_9' }))
    expect(custom.resultOf('run_9')?.pr_url).toBe('https://example.com/pr/9')
    expect(out.result.summary).toContain('theme_9')
  })
})

describe('出站观察工具函数', () => {
  it('summarizeInput 处理标量 / 数组 / 空值', () => {
    expect(summarizeInput(undefined)).toEqual({})
    expect(summarizeInput(null)).toEqual({})
    expect(summarizeInput('abc')).toEqual({ value: 'abc' })
    expect(summarizeInput([1, 2, 3])).toEqual({ value: '[array:3]' })
    expect(summarizeInput({ a: null, b: undefined, c: true, d: 1 })).toEqual({
      a: 'null',
      b: 'undefined',
      c: 'true',
      d: '1',
    })
  })

  it('defaultState 的窗口内 / 外订单相对起点生成', () => {
    const state = defaultState('2026-09-07T00:00:00.000Z')
    expect(state.orders.find((o) => o.id === 'ord_1001')?.delivered_at).toBe(
      '2026-09-04T00:00:00.000Z',
    )
    expect(state.orders.find((o) => o.id === 'ord_1003')?.delivered_at).toBeUndefined()
    expect(() => defaultState('nope')).toThrow(RangeError)
  })
})
