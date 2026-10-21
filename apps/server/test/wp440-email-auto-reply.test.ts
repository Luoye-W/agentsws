/**
 * WP440（docs/108 M9，Luoye 10-21）：**邮件客服也按把握直接回**。
 *
 * 真的审批总线 + 执行器（`@agentsws/txn`，发信那一跳是替身）、真的客服判断层（三道自主门）、
 * 真的工作模型（事项时间线）；模型是 stub 剧本（`emailAnswerStubScript`）。钉住：
 * - 有出处的单问题 → 直接发（总线自动批、执行器施行一次），记录带出处；
 * - 多问题一句没出处 → 整封不发，卡标题后那一句是「把握不够」；
 * - 退款 → 不发、不问模型；
 * - 签名里有电话 → 不因此转人；
 * - 出站门拦下 → 退回成卡（L1、标题后写「出站门拦下」）；
 * - 「这封不该直接回」→ 同类下次不发（和聊天同一份学习记录）；
 * - Amazon 买家消息不直发；关掉开关 → 每封都不直发。
 */

import type { ApprovalItem, Clock, EventEnvelope } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { ChatLearnedHold } from '@agentsws/support-core'
import { emailAnswerStubScript } from '@agentsws/support-core'
import type { BackendResult } from '@agentsws/txn'
import { createTxn } from '@agentsws/txn'
import { createWork } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import type { EmailAutoReplyRequest } from '../src/channels.js'
import { createEmailAutoReply, type EmailAutoReplySetting } from '../src/email-auto-reply.js'
import { createSupportJudgment } from '../src/support-judgment.js'

const WS = 'ws_1'
const T0 = '2026-10-21T02:00:00.000Z'
const CONTACT = { type: 'contact', id: 'cus_dan' }
const KNOWLEDGE = [
  { fact_card_id: 'fc_warranty', statement: '充电类产品的保修期是 24 个月，从签收日算起。' },
  { fact_card_id: 'fc_charger', statement: '充电盒用 USB-C 接口充电，充满大约 2 小时。' },
]

function assemble(over: { setting?: EmailAutoReplySetting; deliver?: () => BackendResult } = {}) {
  let t = Date.parse(T0)
  const clock: Clock = {
    now: () => new Date(t).toISOString(),
    sleep: async () => undefined,
  }
  let seq = 0
  const tick = (): void => {
    t += 1000
  }
  const events: EventEnvelope[] = []
  const appendEvent = (e: unknown): void => void events.push(e as EventEnvelope)
  const sent: ApprovalItem[] = []
  const txn = createTxn({
    clock: { now: () => clock.now() },
    random: () => 0.42,
    eventSink: (e) => {
      events.push(e)
    },
    deliverOutbound: async (item) => {
      sent.push(item)
      return over.deliver?.() ?? { status: 'ok', execution_id: `ex_${item.id}` }
    },
  })
  const work = createWork({ workspace_id: WS, clock, random: () => 0.5 })
  const judgment = createSupportJudgment({ workspace_id: WS, clock, appendEvent })
  const holds: (ChatLearnedHold & { message_id: string })[] = []
  let modelCalls = 0
  const models = {
    async complete(req: { messages: { role: string; content: unknown }[] }) {
      modelCalls += 1
      return {
        text: emailAnswerStubScript(req.messages) ?? '',
        usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost_base: 0 },
        model: { provider: 'stub', model: 'stub' },
        static_prefix_hash: '',
      }
    },
  } as unknown as ModelGatewayApi
  const auto = createEmailAutoReply({
    workspace_id: WS,
    clock,
    appendEvent,
    approvals: txn.approvals,
    applyNow: (id) => txn.executor.applyApproval(id, { skip_cancel_window: true }),
    models,
    position: () => ({ person_id: 'p_owner', assignment_id: 'asg_1', role_id: 'dtc.support' }),
    searchKnowledge: async (text) =>
      KNOWLEDGE.filter((k) =>
        ['保修', '充电盒', '接口'].some((w) => text.includes(w) && k.statement.includes(w)),
      ),
    setting: () => over.setting ?? { on: true },
    learnedHolds: () => holds,
    learn: (h) => {
      holds.push(h)
    },
    judgeDraft: (input) =>
      judgment.judgeDraft({
        channel: 'email',
        thread_id: input.thread_id,
        inbound_text: input.inbound_text,
        reply_text: input.reply_text,
        generated_by: 'ai',
      }),
    work,
  })
  const ask = async (
    text: string,
    extra: Partial<EmailAutoReplyRequest> = {},
  ): Promise<Awaited<ReturnType<typeof auto.attempt>>> => {
    tick()
    seq += 1
    const thread_id = extra.thread_id ?? `<t-${seq}@mail.example>`
    const matter = work.createMatter({
      kind: 'conversation',
      title: '与 Dan 的往来',
      pinned: [{ type: 'thread', id: thread_id }, CONTACT],
    })
    return auto.attempt({
      matter,
      thread_id,
      account: 'hello@shop.example',
      text,
      subject: '售后咨询',
      from_display: 'Dan Lee',
      contact: CONTACT,
      inbound_action: 'auto_reply',
      ...extra,
    })
  }
  return {
    auto,
    ask,
    txn,
    work,
    events,
    sent,
    holds,
    modelCalls: () => modelCalls,
    items: () => txn.runtime.store.listApprovals({}),
  }
}

describe('WP440：邮件客服有把握就直接回', () => {
  it('有出处的单问题 → 直接发（总线自动批 + 执行器施行一次），记录带出处', async () => {
    const h = assemble()
    const out = await h.ask('你好，请问充电类产品保修期多久？')
    expect(out.sent).toBe(true)
    if (!out.sent) return
    expect(out.note).toContain('出处')
    const item = h.items().find((i) => i.id === out.approval_item_id)
    expect(item?.state).toBe('applied')
    expect(item?.automation.level_at_creation).toBe('L2')
    expect(item?.automation.auto_approved).toBe(true)
    expect(item?.decision?.by).toBe('mandate')
    expect(h.sent).toHaveLength(1)
    const body = (item?.payload as { body: { text: string; subject: string } } | undefined)
      ?.body ?? { text: '', subject: '' }
    expect(body.text).toContain('24 个月')
    expect(body.text).not.toContain('[K1]')
    expect(body.text).not.toContain('把握')
    expect(body.text.startsWith('Dan，您好') || body.text.startsWith('您好')).toBe(true)
    expect(body.subject).toBe('Re: 售后咨询')
    // 记录带出处：时间线那一行、事件都有
    const mark = h.auto.of(out.approval_item_id)
    expect(mark?.sources.map((s) => s.label).join('')).toContain('保修期')
    expect(mark?.score).toBeGreaterThanOrEqual(0.7)
    const ev = h.events.find((e) => e.type === 'support.email_auto_replied')
    expect((ev?.payload as { source_ids?: string[] } | undefined)?.source_ids).toEqual([
      'fc_warranty',
    ])
    // 总线那一侧：置信度直答的结论进了执行上下文
    expect(
      h.txn.runtime.store.getContext(out.approval_item_id)?.confident_reply?.source_ids,
    ).toEqual(['fc_warranty'])
  })

  it('一封问了两件事、一件没出处 → 整封不发，标题后那一句是「把握不够」', async () => {
    const h = assemble()
    const out = await h.ask('充电类产品保修期多久？另外你们的客服电话营业到几点？', {
      thread_id: 't-multi',
    })
    expect(out.sent).toBe(false)
    if (out.sent) return
    expect(out.kind).toBe('low_confidence')
    expect(h.auto.heldNote('t-multi')).toBe('把握不够')
    expect(h.items()).toHaveLength(0)
    expect(h.sent).toHaveLength(0)
  })

  it('两件事都有出处 → 逐句都过，直接发', async () => {
    const h = assemble()
    const out = await h.ask('充电类产品保修期多久？充电盒用什么接口充电？')
    expect(out.sent).toBe(true)
  })

  it('退款 → 不发，也不问模型（一律转人）', async () => {
    const h = assemble()
    const out = await h.ask('订单 #1002 的耳机坏了，我要退款。', { thread_id: 't-refund' })
    expect(out.sent).toBe(false)
    if (out.sent) return
    expect(out.kind).toBe('money')
    expect(h.modelCalls()).toBe(0)
    expect(h.auto.heldNote('t-refund')).toBe('涉及钱或改单')
  })

  it('签名里有电话 → 不因此转人', async () => {
    const h = assemble()
    const out = await h.ask(
      '你好，请问充电类产品保修期多久？\n\n谢谢\n张伟\n手机：138 0013 8000\n上海市南京西路 100 号',
    )
    expect(out.sent).toBe(true)
  })

  it('出站门拦下 → 退回成卡（L1，标题后写「出站门拦下」），不再起 Run 重复出卡', async () => {
    const h = assemble({
      deliver: () => ({
        status: 'failed',
        error: { message: '没发出去：出站已急停', retryable: false },
      }),
    })
    const out = await h.ask('你好，请问充电类产品保修期多久？', { thread_id: 't-blocked' })
    expect(out.sent).toBe(false)
    if (out.sent) return
    expect(out.kind).toBe('outbound_blocked')
    expect(out.card_id).toBeDefined()
    const card = h.items().find((i) => i.id === out.card_id)
    expect(card?.state).toBe('pending')
    expect(card?.automation.level_at_creation).toBe('L1')
    expect(card?.title).toContain('（出站门拦下）')
    // 那一封（自动批的）照实记施行失败，没有第二次发
    expect(h.items().filter((i) => i.state === 'apply_failed')).toHaveLength(1)
  })

  it('「这封不该直接回」→ 记进同一份学习记录，同类下次不发', async () => {
    const h = assemble()
    const first = await h.ask('你好，请问充电类产品保修期多久？')
    expect(first.sent).toBe(true)
    if (!first.sent) return
    expect(h.auto.flag({ approval_item_id: first.approval_item_id, by: 'p_owner' })).toEqual({
      learned: true,
    })
    expect(h.holds).toHaveLength(1)
    expect(h.holds[0]?.source_ids).toEqual(['fc_warranty'])
    expect(h.auto.of(first.approval_item_id)?.flagged).toBe(true)
    expect(h.events.some((e) => e.type === 'support.email_auto_reply_flagged')).toBe(true)
    const again = await h.ask('请问充电产品的保修期是多久呀？', { thread_id: 't-again' })
    expect(again.sent).toBe(false)
    if (again.sent) return
    expect(again.kind).toBe('learned')
    expect(h.auto.heldNote('t-again')).toBe('同类你说过先给你看')
    // 不是直接回的那一封点不了
    expect(h.auto.flag({ approval_item_id: 'apr_nope', by: 'p_owner' })).toBeUndefined()
  })

  it('Amazon 买家消息不直发（可改的排除项）', async () => {
    const h = assemble()
    const out = await h.ask('你好，请问充电类产品保修期多久？', { sub_channel: 'amazon' })
    expect(out.sent).toBe(false)
    if (out.sent) return
    expect(out.kind).toBe('excluded_channel')
    expect(h.modelCalls()).toBe(0)
  })

  it('关掉开关 → 每封都不直发；影子模式也不直发', async () => {
    const off = assemble({ setting: { on: false } })
    const a = await off.ask('你好，请问充电类产品保修期多久？', { thread_id: 't-off' })
    expect(a.sent).toBe(false)
    expect(off.auto.heldNote('t-off')).toBe('直接回已关')
    const shadow = assemble({ setting: { on: true, shadow_mode: true } })
    expect((await shadow.ask('你好，请问充电类产品保修期多久？')).sent).toBe(false)
  })

  it('三道自主门没放行（判断层不是 auto_reply）/ 收件人待定 → 不直发', async () => {
    const h = assemble()
    const a = await h.ask('你好，请问充电类产品保修期多久？', { inbound_action: 'pending_review' })
    expect(a.sent).toBe(false)
    const b = await h.ask('你好，请问充电类产品保修期多久？', {
      contact: undefined as unknown as typeof CONTACT,
    })
    expect(b.sent).toBe(false)
    if (b.sent) return
    expect(b.kind).toBe('no_recipient')
    expect(h.modelCalls()).toBe(0)
  })

  it('「严格」档更保守：同一封，适中发、严格的门槛更高', async () => {
    const strict = assemble({ setting: { on: true, strictness: 'strict' } })
    const out = await strict.ask('你好，请问充电类产品保修期多久？')
    // stub 自评 90、逐句有出处、检索 ≥0.6：严格档也能过（0.86 ≥ 0.80）
    expect(out.sent).toBe(true)
  })
})
