/**
 * WP133：`runTurn()` 的摘要不再用 `session.eventAt()` 回扫会话日志，改成边收 `session/event` 边折。
 *
 * 为什么不是派工单写的 `session.read()`：0.1.7-rc.1 的 `Session` 上**没有** `read()`
 * （`dsh-session/lib/types/index.d.ts` 的 `Session` 类只有 `eventAt` / `snapshotEvents` /
 * `ownEvents` 三个同步读，全标 `@deprecated`；上游 master 的 `packages/core/session/src/index.ts`
 * 也没有）。官方 Agent Note 2026-09-09 给的迁移方向是两条：普通逻辑"读投影或处理送到手的当前事件"，
 * 只有按需展示的历史内容才走"显式的异步分页"。我们这一处是前一种。
 *
 * 两组：
 * 1. `TurnSummary` 本身的折法（纯函数，合成事件）；
 * 2. 真跑一轮：新折法的结果与**旧折法**（在测试里照原样用 `eventAt()` 回扫同一段 seq）逐字段相同。
 *    上游政策允许测试文件继续用这三个同步读（Agent Note「Repository test files … may call these
 *    three readers」），所以旧折法留在这里当对照组，生产代码里一处都不剩。
 */
import { Provenance } from '@agentsws/core'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { TurnSummary } from '../src/harness.js'
import type { DshHarness } from '../src/index.js'
import { createHarness } from '../src/index.js'
import { baseOptions, collect, makeRequest, type RequestOverrides } from './helpers.js'

const ev = (type: string, data: unknown) => ({ type, data }) as unknown as SessionEvent

const said = (...blocks: { type: string; text?: string }[]) =>
  ev('assistant/message', { message: { content: blocks } })

describe('TurnSummary 的折法', () => {
  it('什么都没收到：空文本、原因 unknown', () => {
    expect(new TurnSummary().result()).toEqual({ text: '', reason: 'unknown' })
  })

  it('最后一条文字非空的 assistant/message 胜出；只有工具调用的那条不覆盖', () => {
    const t = new TurnSummary()
    t.observe(said({ type: 'text', text: '先查一下订单。' }))
    t.observe(said({ type: 'text', text: '可以退，' }, { type: 'text', text: '已提交审批。' }))
    t.observe(said({ type: 'tool-call' }))
    t.observe(ev('turn/end', { reason: { kind: 'completed' } }))
    expect(t.result()).toEqual({ text: '可以退，已提交审批。', reason: 'completed' })
  })

  it('非文字块不拼进去；别的事件类型一律不看', () => {
    const t = new TurnSummary()
    t.observe(said({ type: 'reasoning', text: '想一想' }, { type: 'text', text: '好的' }))
    t.observe(ev('tool/result', { message: { content: [{ type: 'text', text: '工具输出' }] } }))
    t.observe(ev('turn/start', {}))
    expect(t.result()).toEqual({ text: '好的', reason: 'unknown' })
  })
})

/** WP133 之前 `harness.ts` 的 `summarizeTurn()`，原样搬来当对照组（测试文件里允许用 `eventAt`）。 */
function legacySummarize(session: Session, firstSeq: number): { text: string; reason: string } {
  let text = ''
  let reason = 'unknown'
  const length = Number(session.seq)
  for (let seq = firstSeq; seq < length; seq += 1) {
    const event = session.eventAt(seq as never) as SessionEvent | undefined
    if (event === undefined) continue
    if (event.type === 'assistant/message') {
      const joined = (
        event.data as { message: { content: readonly { type: string; text?: string }[] } }
      ).message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') {
      reason = (event.data as { reason: { kind: string } }).reason.kind
    }
  }
  return { text, reason }
}

const open: DshHarness[] = []
afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose()
})

async function build(o: RequestOverrides): Promise<DshHarness> {
  const req = makeRequest(o)
  const { sink } = collect()
  const harness = await createHarness({
    request: req,
    sink,
    provenance: new Provenance(req.id),
    options: baseOptions(),
    buildStageIntent: (args) => ({
      request: req,
      kind: 'refund',
      target: { type: 'order', id: 'ord_1001' },
      before: 0,
      after: args.amount,
      money: { amount: args.amount, currency: 'USD' },
      notes: ['turn summary test'],
    }),
    buildDraftPayload: (args) => ({
      request: req,
      channel: 'email',
      to: ['anna@example.com'],
      subject: args.subject,
      body: args.body,
      child_change_ids: [],
      citations: [],
    }),
    model: 'stub-v1',
    meta: {
      workspace_id: req.workspace_id,
      assignment_id: req.actor.assignment_id,
      role_id: req.actor.role_id,
      run_id: req.id,
      purpose: 'run',
    },
  })
  open.push(harness)
  return harness
}

describe('真跑一轮：新折法与旧的 eventAt 回扫逐字段相同', () => {
  const cases: [string, RequestOverrides][] = [
    ['退款请求（会调工具、会起草）', {}],
    ['没有订单上下文', { withOrderContext: false, id: 'run_0002' }],
    [
      '一句普通问候',
      { threadText: 'Hi, just saying thanks for the fast shipping!', id: 'run_0003' },
    ],
  ]
  for (const [name, o] of cases) {
    it(name, async () => {
      const harness = await build(o)
      const firstSeq = Number(harness.session.seq)
      const got = await harness.runTurn('Handle this conversation.')
      const want = legacySummarize(harness.session, firstSeq)
      expect(got).toEqual(want)
      // 对照组本身不是空转：这一轮确实有事件、确实结束了
      expect(Number(harness.session.seq)).toBeGreaterThan(firstSeq)
      expect(want.reason).not.toBe('unknown')
      expect(want.text.length).toBeGreaterThan(0)
    }, 60_000)
  }

  it('两轮接着跑：第二轮的摘要只看第二轮的事件', async () => {
    const harness = await build({ id: 'run_0004' })
    await harness.runTurn('Handle this conversation.')
    const firstSeq = Number(harness.session.seq)
    const got = await harness.runTurn('Anything else?')
    expect(got).toEqual(legacySummarize(harness.session, firstSeq))
  }, 60_000)
})
