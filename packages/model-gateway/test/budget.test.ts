import { describe, expect, it } from 'vitest'
import type { BudgetPolicy } from '../src/index.js'
import { createModelGateway } from '../src/index.js'
import { fixedClock, fixedProvider, meta, policy, recorder, userPrompt } from './helpers.js'

/** 1 输出 token = 1 基准货币，输入不计价；估算与结算都好算。 */
const outOnlyPrices = { 'stub/stub-v1': { in: 0, out: 1_000_000, cached: 0 } }
const ref = { provider: 'stub', model: 'stub-v1', region: 'cn' as const }
const msg = [userPrompt('where is my order')]

const build = (args: {
  provider: ReturnType<typeof fixedProvider>
  budget: BudgetPolicy
  env?: Record<string, string | undefined>
}) => {
  const rec = recorder()
  const gw = createModelGateway({
    providers: [args.provider],
    policy: policy({
      prices: outOnlyPrices,
      budget: args.budget,
      estimate: { expected_output_tokens: 6 },
    }),
    clock: fixedClock(),
    eventSink: rec.sink,
    env: args.env ?? {},
  })
  return { gw, rec }
}

describe('22 §5.4 工作区日预算耗尽 → 冻结', () => {
  it('实际花费越线 → 冻结事件、新调用被拒、budget() frozen=true', async () => {
    const { gw, rec } = build({
      provider: fixedProvider({ ref, output: 12 }),
      budget: { workspace_daily_base: 10 },
    })
    await expect(gw.complete({ messages: msg, meta: meta() })).resolves.toMatchObject({
      usage: { cost_base: 12 },
    })
    await expect(gw.complete({ messages: msg, meta: meta() })).rejects.toMatchObject({
      code: 'budget_exhausted',
      details: { scope: 'workspace_daily', frozen: true },
    })
    const frozen = rec.ofType('model.budget_frozen')
    expect(frozen).toHaveLength(1)
    expect(frozen[0]?.payload).toMatchObject({
      scope: 'workspace_daily',
      period: '2026-09-09',
      used_base: 12,
      cap_base: 10,
    })
    expect(await gw.budget({ workspace_id: 'ws_1' })).toEqual({
      used_base: 12,
      cap_base: 10,
      frozen: true,
    })
    expect(rec.ofType('model.usage')).toHaveLength(1)
  })

  it('分配日预算独立生效', async () => {
    const { gw, rec } = build({
      provider: fixedProvider({ ref, output: 8 }),
      budget: { workspace_daily_base: 1_000, assignment_daily_base_by_id: { asg_1: 8 } },
    })
    await gw.complete({ messages: msg, meta: meta() })
    await expect(gw.complete({ messages: msg, meta: meta() })).rejects.toMatchObject({
      code: 'budget_exhausted',
      details: { scope: 'assignment_daily' },
    })
    // 另一个 assignment 不受影响
    await expect(
      gw.complete({ messages: msg, meta: meta({ assignment_id: 'asg_2' }) }),
    ).resolves.toBeTruthy()
    expect(await gw.budget({ workspace_id: 'ws_1', assignment_id: 'asg_1' })).toEqual({
      used_base: 8,
      cap_base: 8,
      frozen: true,
    })
    expect(await gw.budget({ workspace_id: 'ws_1' })).toMatchObject({ frozen: false })
    expect(rec.ofType('model.budget_frozen')).toHaveLength(1)
  })

  it('月预算越线同样冻结', async () => {
    const { gw, rec } = build({
      provider: fixedProvider({ ref, output: 9 }),
      budget: { workspace_monthly_base: 9 },
    })
    await gw.complete({ messages: msg, meta: meta() })
    await expect(gw.complete({ messages: msg, meta: meta() })).rejects.toMatchObject({
      code: 'budget_exhausted',
    })
    expect(rec.ofType('model.budget_frozen')[0]?.payload).toMatchObject({
      scope: 'workspace_monthly',
      period: '2026-09',
    })
  })

  it('没配预算时 budget() 返回无上限、不冻结', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [fixedProvider({ ref, output: 3 })],
      policy: policy({ prices: outOnlyPrices }),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    await gw.complete({ messages: msg, meta: meta() })
    expect(await gw.budget({ workspace_id: 'ws_1' })).toEqual({
      used_base: 0,
      cap_base: Number.POSITIVE_INFINITY,
      frozen: false,
    })
  })
})

describe('22 §3 / 31 §1 I2 并发预留与结算', () => {
  it('预算 10、两次并发各估 6：第二次在预留阶段被拒；第一次结算 3 后再调用成功', async () => {
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const { gw, rec } = build({
      provider: fixedProvider({ ref, output: 3, gate }),
      budget: { workspace_daily_base: 10 },
    })
    const first = gw.complete({ messages: msg, meta: meta() })
    await expect(
      gw.complete({ messages: msg, meta: meta({ run_id: 'run_2' }) }),
    ).rejects.toMatchObject({
      code: 'budget_exhausted',
      details: { frozen: false, estimate_base: 6, used_base: 6 },
    })
    // 预留阶段的拒绝不是冻结：不发冻结事件，工作区仍可用
    expect(rec.ofType('model.budget_frozen')).toHaveLength(0)
    open()
    await expect(first).resolves.toMatchObject({ usage: { cost_base: 3 } })
    expect(await gw.budget({ workspace_id: 'ws_1' })).toEqual({
      used_base: 3,
      cap_base: 10,
      frozen: false,
    })
    await expect(
      gw.complete({ messages: msg, meta: meta({ run_id: 'run_3' }) }),
    ).resolves.toBeTruthy()
    expect(rec.ofType('model.usage')).toHaveLength(2)
  })

  it('调用失败时整笔释放预留，不计花费', async () => {
    const { gw } = build({
      provider: fixedProvider({
        ref,
        fail: () => {
          throw new Error('boom')
        },
      }),
      budget: { workspace_daily_base: 10 },
    })
    await expect(gw.complete({ messages: msg, meta: meta() })).rejects.toMatchObject({
      code: 'unknown_outcome',
    })
    expect(await gw.budget({ workspace_id: 'ws_1' })).toMatchObject({ used_base: 0, frozen: false })
    await expect(gw.complete({ messages: msg, meta: meta() })).rejects.toMatchObject({
      code: 'unknown_outcome',
    })
  })
})

describe('22 §3 运行预算', () => {
  it('超运行 max_cost_base → budget_exhausted 且发 budget.exhausted 事件', async () => {
    const { gw, rec } = build({
      provider: fixedProvider({ ref, output: 3 }),
      budget: { workspace_daily_base: 1_000 },
    })
    await expect(
      gw.complete({ messages: msg, meta: meta(), max_cost_base: 4 }),
    ).rejects.toMatchObject({ code: 'budget_exhausted', details: { scope: 'run' } })
    expect(rec.ofType('budget.exhausted')[0]?.payload).toMatchObject({
      which: 'max_cost_base',
      cap: 4,
      run_id: 'run_1',
    })
  })

  it('运行预算按 run_id 累计', async () => {
    const { gw } = build({
      provider: fixedProvider({ ref, output: 3 }),
      budget: { workspace_daily_base: 1_000 },
    })
    await gw.complete({ messages: msg, meta: meta(), max_cost_base: 10 })
    await gw.complete({ messages: msg, meta: meta(), max_cost_base: 10 })
    await expect(
      gw.complete({ messages: msg, meta: meta(), max_cost_base: 10 }),
    ).rejects.toMatchObject({ code: 'budget_exhausted', details: { scope: 'run', used_base: 6 } })
    // 换一个 run 不受影响
    await expect(
      gw.complete({ messages: msg, meta: meta({ run_id: 'run_9' }), max_cost_base: 10 }),
    ).resolves.toBeTruthy()
  })
})
