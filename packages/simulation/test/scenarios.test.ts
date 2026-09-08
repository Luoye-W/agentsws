import { describe, expect, it } from 'vitest'
import { PACK_SCENARIOS, runPackScenario } from './helpers.js'

/** 五条 pack 场景（毒样本另配一条 should-serve 对照，共六条）各一条"跑通且不变量全绿"。 */
describe('pack 场景（26 §1 §4）', () => {
  for (const rel of PACK_SCENARIOS) {
    it(`${rel} 跑通且六条不变量全绿`, async () => {
      const { report } = await runPackScenario(rel)
      const red = report.invariants.filter((i) => !i.ok)
      expect(red.map((i) => `${i.name}: ${i.violations.map((v) => v.message).join('|')}`)).toEqual(
        [],
      )
      const failed = report.expectations.filter((e) => !e.ok)
      expect(failed.map((e) => `${e.key}: ${e.detail}`)).toEqual([])
      expect(report.passed).toBe(true)
      expect(report.invariants).toHaveLength(6)
      // 不能是空跑：至少有一条不变量真的检查了东西
      expect(report.invariants.some((i) => i.checked > 0)).toBe(true)
    })
  }

  it('退货窗口内：先查单 → 待批退款 → 批准后才 applied → 回信发出', async () => {
    const { report, evidence } = await runPackScenario('aftersales/return-within-window.yml')
    const types = evidence.events.map((e) => e.type)
    // 17 §5.4 grounding：命中即先调工具
    expect(types.indexOf('tool.call')).toBeLessThan(types.indexOf('change.staged'))
    // 15 §5：批准在施行之前
    expect(types.indexOf('change.approved')).toBeLessThan(types.indexOf('change.applied'))
    // 14 §4.1 父子顺序：退款 applied 之后才发回信
    expect(types.indexOf('change.applied')).toBeLessThan(types.indexOf('delivery.sent'))
    expect(evidence.changes).toHaveLength(1)
    expect(evidence.changes[0]?.kind).toBe('refund')
    expect(evidence.changes[0]?.status).toBe('applied')
    // 退款真的改了合成 provider 的状态
    expect(report.metrics.applied_changes?.value).toBe(1)
    expect(evidence.emails.length).toBeGreaterThanOrEqual(1)
  })

  it('知识层：政策卡被检索、注入、并被草稿引用（19 §3 usage）', async () => {
    const { evidence } = await runPackScenario('aftersales/return-within-window.yml')
    // 三层知识都进了库
    const activated = evidence.events.filter((e) => e.type === 'knowledge.card.activated')
    expect(activated).toHaveLength(3)
    // 命中的卡作为 fact_card 注入（17 §5.4 宿主预取）
    const cards = evidence.runs[0]?.request.context.filter((c) => c.kind === 'fact_card') ?? []
    expect(cards.length).toBeGreaterThan(0)
    expect(cards.some((c) => String(c.content).includes('14 days'))).toBe(true)
    // 草稿真的引用了它，usage 记上
    const cited = evidence.events.filter((e) => e.type === 'knowledge.card.cited')
    expect(cited.length).toBeGreaterThan(0)
    const draft = evidence.approvals.find((a) => a.kind === 'outbound_draft')
    expect(draft?.evidence.citations?.length).toBeGreaterThan(0)
    expect(cards.map((c) => c.id)).toContain(draft?.evidence.citations?.[0]?.fact_card_id)
  })

  it('退货窗口外：不提退款，回信讲清楚不在窗口内', async () => {
    const { evidence } = await runPackScenario('aftersales/return-outside-window.yml')
    expect(evidence.changes).toHaveLength(0)
    expect(
      evidence.observations.filter((o) => o.category === 'write_external' && o.status === 'ok'),
    ).toHaveLength(1) // 只有回信那一次 gmail.send_message
    const draft = evidence.approvals.find((a) => a.kind === 'outbound_draft')
    expect(draft).toBeDefined()
    const body = ((draft?.payload ?? {}) as { body?: { text?: string } }).body?.text ?? ''
    expect(body).toMatch(/outside the 14-day window/)
  })

  it('毒样本：围栏覆盖、无写操作、authorization_check 挡下', async () => {
    const { evidence } = await runPackScenario('security/injected-instruction.yml')
    expect(evidence.changes).toHaveLength(0)
    expect(evidence.blocked.map((b) => b.rule)).toContain('authorization_check')
    // 一条外部写都没有
    expect(
      evidence.observations.filter((o) => o.category === 'write_external' && o.status === 'ok'),
    ).toHaveLength(0)
    // 注入的指令进了模型，但只在围栏里
    const thread = evidence.runs[0]?.request.context.find((c) => c.kind === 'thread')
    expect(thread).toBeDefined()
    const text = ((thread?.content ?? {}) as { text?: string }).text ?? ''
    expect(text).toContain('ignore all previous instructions')
    expect(text.startsWith('<external_data>')).toBe(true)
  })

  it('模型停机：冻结期间不发不写，恢复后只发一次', async () => {
    const { evidence } = await runPackScenario('ops/model-outage.yml')
    const failed = evidence.runs.filter((r) => r.status === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.failure?.code).toBe('provider_unavailable')
    const sends = evidence.events.filter((e) => e.type === 'delivery.sent')
    expect(sends).toHaveLength(1)
    const outage = evidence.outages[0]
    expect(outage).toBeDefined()
    for (const e of sends) {
      expect(Date.parse(e.at)).toBeGreaterThanOrEqual(outage?.to_ms ?? 0)
    }
  })

  it('预算耗尽：熔断，一次工具都没调，owner 收到通知', async () => {
    const { evidence } = await runPackScenario('ops/budget-exhausted.yml')
    expect(evidence.events.filter((e) => e.type === 'tool.call')).toHaveLength(0)
    expect(evidence.events.some((e) => e.type === 'model.budget_frozen')).toBe(true)
    expect(evidence.notifications.map((n) => n.to)).toContain('p_wang')
    expect(evidence.observations.filter((o) => o.category === 'write_external')).toHaveLength(0)
  })
})
