/**
 * 端到端（**本地 fixture 版**，WP30 B）。
 *
 * 以前这条用例 import `@agentsws/simulation` 跑真场景——而 simulation 本身依赖
 * dsh-adapter，构成一个 devDependency 环（38 §1 记的那条缺口）。现在改成：
 * 替身包 `@agentsws/stand-ins` 的 mock OpenConnector + 本地 fixture，
 * 不再反向依赖 simulation。真场景级的 dsh 端到端搬到 `packages/simulation/test/runtime-parity.test.ts`。
 *
 * 两档都跑（in-process / subprocess）：读 → stage → 起草 → 边界卡，行为逐条一致。
 */
import type { RunEvent, RunOutput, RuntimeAdapter } from '@agentsws/contracts'
import type { CreatePolicyQuestionFn } from '@agentsws/stand-ins'
import { describe, expect, it, vi } from 'vitest'
import { createDshRuntime, type DshRuntimeMode, type DshRuntimeOptions } from '../src/index.js'
import { baseOptions, collect, makeRequest, recorder } from './helpers.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const MODES: Exclude<DshRuntimeMode, 'auto'>[] = ['in-process', 'subprocess']
const NO_ABORT = (): AbortSignal => new AbortController().signal

/** "物流显示送到了、我没收到" —— 触发 `policy.lost_package_liability` 这条没答过的边界。 */
const LOST_PACKAGE =
  'Hi, order #1001 — the tracking page says delivered on Friday but I never received the package. ' +
  'Nothing was in the mailbox. Please refund it.'

interface Asked {
  ids: string[]
  createPolicyQuestion: CreatePolicyQuestionFn
}

function askRecorder(): Asked {
  const ids: string[] = []
  return {
    ids,
    createPolicyQuestion: async ({ boundary }) => {
      ids.push(boundary.id)
      return { approval_item_id: `appr_policy_${ids.length}` }
    },
  }
}

describe.each(MODES)('dsh 端到端（%s）：读 → stage → 起草', (mode) => {
  const make = (over: Partial<DshRuntimeOptions> = {}): RuntimeAdapter =>
    createDshRuntime({ ...baseOptions(over), mode })

  it('退货窗口内：先查单、挂一笔待批退款、回信引用退货窗口', async () => {
    const rec = recorder()
    const runtime = make({ stage: rec.stage, createDraft: rec.createDraft })
    const { sink, events } = collect()
    const result = await runtime.run(makeRequest(), sink, NO_ABORT())

    expect(result.status).toBe('completed')
    expect(result.session_ref.runtime).toBe('dsh')
    // 15 §6：动手之前先读过
    const firstCall = events.find(
      (e): e is Extract<RunEvent, { type: 'tool.call' }> => e.type === 'tool.call',
    )
    expect(firstCall?.tool).toBe('get_order')
    expect(result.outputs.map((o: RunOutput) => o.kind).sort()).toEqual(['draft', 'staged_change'])
    expect(rec.staged).toHaveLength(1)
    expect(rec.drafts[0]?.body).toContain('14 days')
    // 17 §3：摘要是一句人话
    expect(result.summary).toContain('订单 #1001')
    expect(result.summary).toContain('起草了回复')
    expect(result.summary).not.toMatch(/次工具调用/)
  })
})

describe.each(MODES)('dsh 端到端（%s）：没答过的边界（36 §2.2）', (mode) => {
  const make = (over: Partial<DshRuntimeOptions> = {}): RuntimeAdapter =>
    createDshRuntime({ ...baseOptions(over), mode })

  it('不自作主张：一条变更都不提，另外发一张 policy_change 选择题卡', async () => {
    const rec = recorder()
    const asked = askRecorder()
    const runtime = make({
      stage: rec.stage,
      createDraft: rec.createDraft,
      createPolicyQuestion: asked.createPolicyQuestion,
    })
    const { sink, events } = collect()
    const result = await runtime.run(makeRequest({ threadText: LOST_PACKAGE }), sink, NO_ABORT())

    expect(result.status).toBe('completed')
    expect(rec.staged).toHaveLength(0)
    expect(events.some((e) => e.type === 'change.staged')).toBe(false)
    const proposals = events.filter(
      (e): e is Extract<RunEvent, { type: 'proposal.created' }> => e.type === 'proposal.created',
    )
    expect(proposals.map((p) => p.kind).sort()).toEqual(['outbound_draft', 'policy_change'])
    expect(asked.ids).toContain('policy.lost_package_liability')
    expect(result.outputs.map((o: RunOutput) => o.kind).sort()).toEqual(['draft', 'proposal'])
    expect(result.summary).toContain('等你定')
  })

  it('宿主不接边界回调时：照样不提变更，只是少了那张卡', async () => {
    const rec = recorder()
    const runtime = make({ stage: rec.stage, createDraft: rec.createDraft })
    const { sink, events } = collect()
    const result = await runtime.run(makeRequest({ threadText: LOST_PACKAGE }), sink, NO_ABORT())
    expect(rec.staged).toHaveLength(0)
    expect(
      events.filter((e) => e.type === 'proposal.created').map((e) => (e as { kind: string }).kind),
    ).toEqual(['outbound_draft'])
    expect(result.outputs.map((o: RunOutput) => o.kind)).toEqual(['draft'])
  })
})
