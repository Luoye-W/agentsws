import { describe, expect, it } from 'vitest'
import type { Evidence, ScenarioReport } from '../src/index.js'
import { parseScenario, runScenario } from '../src/index.js'
import { pack } from './helpers.js'

const HEAD = `
id: t/runner
version: 1
dataset: { pack: dtc-3c-3p, seed: 42 }
actors:
  p_wang: { approve: { policy: always_approve, latency: 10m..20m } }
stand_ins: { provider: mock_open_connector, model: stub, clock: virtual, delivery: inbox }
clock: { start: '2026-09-07T09:00:00+08:00' }
`

async function run(
  events: string,
  expected = '',
): Promise<{ report: ScenarioReport; evidence: Evidence }> {
  const scenario = parseScenario(`${HEAD}events:\n${events}${expected}`, 't.yml')
  let evidence: Evidence | undefined
  const report = await runScenario(scenario, {
    pack: pack(),
    captureEvidence: (e) => {
      evidence = e
    },
  })
  if (evidence === undefined) throw new Error('没有证据')
  return { report, evidence }
}

const inbound = (from: string, thread: string, body: string, msg?: string): string =>
  `  - at: '+0m'\n    inbound.email: { from: ${from}, thread: ${thread}, subject: S, body: '${body}'${
    msg === undefined ? '' : `, message_id: ${msg}`
  } }\n`

describe('runner 的事件调度（26 §1 events）', () => {
  it('同一封信重复投递 → inbound.deduped，不重复起运行', async () => {
    const { evidence } = await run(
      `${inbound('anna@example.com', 'new', 'I want to return order #1001 and get a refund', 'm1')}` +
        `  - at: '+1m'\n    inbound.email: { from: anna@example.com, thread: $thread, subject: S, body: 'I want to return order #1001 and get a refund', message_id: m1 }\n`,
    )
    expect(evidence.events.filter((e) => e.type === 'inbound.received')).toHaveLength(1)
    expect(evidence.events.filter((e) => e.type === 'inbound.deduped')).toHaveLength(1)
    expect(evidence.runs).toHaveLength(1)
  })

  it('发件人不是已知客户 → 死信，不起运行', async () => {
    const { evidence } = await run(inbound('nobody@example.com', 'new', 'hello #1001'))
    expect(evidence.runs).toHaveLength(0)
    const dead = evidence.events.find((e) => e.type === 'inbound.dead_letter')
    expect(dead).toBeDefined()
    expect(((dead?.payload ?? {}) as { reason?: string }).reason).toBe('unresolved_sender')
  })

  it('$thread 引用了还不存在的线程 → 报错', async () => {
    await expect(run(inbound('anna@example.com', '$thread', 'x'))).rejects.toThrow(/\$thread/)
  })

  it('inject.fault 打到 mock connect 的 Action 上（15 §8.13）', async () => {
    const { evidence } = await run(
      `  - at: '+0m'\n    inject.fault: { action: shopify_admin.create_refund, code: 429, times: 5 }\n` +
        `  - at: '+1m'\n    inbound.email: { from: anna@example.com, thread: new, subject: S, body: 'I want to return order #1001 and get a refund' }\n` +
        `  - at: '+6h'\n    clock.advance: {}\n`,
    )
    expect(evidence.events.some((e) => e.type === 'simulation.fault_injected')).toBe(true)
    const refunds = evidence.observations.filter(
      (o) => o.action_id === 'shopify_admin.create_refund',
    )
    expect(refunds.length).toBeGreaterThan(0)
    expect(refunds.every((o) => o.status === 'error' && o.error_code === 'rate_limited')).toBe(true)
    // 重试用尽后 failed，账本留痕，回信不发（父子顺序）
    const change = evidence.changes[0]
    expect(change?.status).toBe('failed')
    expect(evidence.events.filter((e) => e.type === 'delivery.sent')).toHaveLength(0)
  })

  it('actor.decide 指到不存在的审批项 → 报错', async () => {
    await expect(
      run(
        inbound('anna@example.com', 'new', 'I want to return order #1001 and get a refund') +
          `  - at: '+1m'\n    actor.decide: { who: p_wang, item: apr_nope, action: approve }\n`,
      ),
    ).rejects.toThrow(/审批项不存在/)
  })

  it('actor.decide 由手上没有 token 的人做 → 报错', async () => {
    await expect(
      run(
        inbound('anna@example.com', 'new', 'I want to return order #1001 and get a refund') +
          `  - at: '+1m'\n    actor.decide: { who: p_chen, item: $last_outbound_draft, action: approve }\n`,
      ),
    ).rejects.toThrow(/decision_token/)
  })

  it('$last_staged_change 能被 actor.decide 解析到', async () => {
    const { evidence } = await run(
      inbound('anna@example.com', 'new', 'I want to return order #1001 and get a refund') +
        `  - at: '+1m'\n    actor.decide: { who: p_wang, item: $last_staged_change, action: approve }\n` +
        `  - at: '+2h'\n    clock.advance: {}\n`,
    )
    expect(evidence.changes[0]?.status).toBe('applied')
  })

  it('驳回的草稿不会被发出去', async () => {
    const { evidence } = await run(
      inbound('anna@example.com', 'new', 'I want to return order #1001 and get a refund') +
        `  - at: '+1m'\n    actor.decide: { who: p_wang, item: $last_outbound_draft, action: reject, reason: 措辞不对 }\n` +
        `  - at: '+3h'\n    clock.advance: {}\n`,
    )
    const draft = evidence.approvals.find((a) => a.kind === 'outbound_draft')
    expect(draft?.state).toBe('rejected')
    expect(evidence.events.filter((e) => e.type === 'delivery.sent')).toHaveLength(0)
    expect(evidence.changes[0]?.status).not.toBe('applied')
  })

  it('approve_edited 留下 edit_diff（学习信号），发出的是编辑后的版本', async () => {
    const { evidence } = await run(
      inbound('anna@example.com', 'new', 'I want to return order #1001 and get a refund') +
        `  - at: '+1m'\n    actor.decide: { who: p_wang, item: $last_outbound_draft, action: approve_edited }\n` +
        `  - at: '+3h'\n    clock.advance: {}\n`,
    )
    const draft = evidence.approvals.find((a) => a.kind === 'outbound_draft')
    expect(draft?.decision?.action).toBe('approve_edited')
    expect(draft?.decision?.edit_diff).toBeDefined()
    expect(draft?.state).toBe('applied')
    const decided = evidence.events.find((e) => e.type === 'approval.decided')
    expect(decided).toBeDefined()
    expect(((decided?.payload ?? {}) as { edited?: boolean }).edited).toBe(true)
  })

  it('合成人自己按策略与延迟决定（不写 actor.decide 也能跑完）', async () => {
    const { evidence } = await run(
      inbound('anna@example.com', 'new', 'I want to return order #1001 and get a refund') +
        `  - at: '+6h'\n    clock.advance: {}\n`,
    )
    expect(evidence.events.filter((e) => e.type === 'approval.decided').length).toBeGreaterThan(0)
    expect(evidence.emails).toHaveLength(1)
    // 延迟真的被采样（合成人不是当场决定）
    const decisions = evidence.events.filter((e) => e.type === 'approval.decided')
    const created = evidence.events.find((e) => e.type === 'approval.created')
    expect(Date.parse(decisions[0]?.at as string)).toBeGreaterThan(
      Date.parse(created?.at as string),
    )
  })

  it('事件时间倒流直接报错（合成时钟单调，25 §6.5）', async () => {
    const scenario = parseScenario(
      `${HEAD}events:\n  - at: '+2h'\n    clock.advance: {}\n  - at: '+1h'\n    clock.advance: {}\n`,
      't.yml',
    )
    await expect(runScenario(scenario, { pack: pack() })).rejects.toThrow(/倒流/)
  })

  it('body_ref 指到 pack 里没有的 fixture → 报错', async () => {
    const scenario = parseScenario(
      `${HEAD}events:\n  - at: '+0m'\n    inbound.email: { from: anna@example.com, thread: new, body_ref: fixtures/nope.txt }\n`,
      't.yml',
    )
    await expect(runScenario(scenario, { pack: pack() })).rejects.toThrow(/fixture/)
  })

  it('未知的合成人策略 → 报错', async () => {
    const scenario = parseScenario(
      `${HEAD.replace('always_approve', 'vibes')}events:\n  - at: '+0m'\n    clock.advance: {}\n`,
      't.yml',
    )
    await expect(runScenario(scenario, { pack: pack() })).rejects.toThrow(/合成人策略/)
  })

  it('reject_rules 策略：命中就驳回', async () => {
    const head = HEAD.replace(
      'p_wang: { approve: { policy: always_approve, latency: 10m..20m } }',
      "p_wang: { approve: { policy: reject, latency: 10m..20m, reject_rules: ['contains:1001'] } }",
    )
    const scenario = parseScenario(
      `${head}events:\n${inbound('anna@example.com', 'new', 'I want to return order #1001 and get a refund')}  - at: '+3h'\n    clock.advance: {}\n`,
      't.yml',
    )
    let evidence: Evidence | undefined
    await runScenario(scenario, {
      pack: pack(),
      captureEvidence: (e) => {
        evidence = e
      },
    })
    const decided = evidence?.events.filter((e) => e.type === 'approval.decided') ?? []
    expect(decided.length).toBeGreaterThan(0)
    expect(decided.every((e) => (e.payload as { rejected: boolean }).rejected)).toBe(true)
    expect(decided.length).toBeGreaterThanOrEqual(2)
    expect(evidence?.emails).toHaveLength(0)
  })
})
