/**
 * WP212（docs/88 §3）：类型判断、发件人规则教过类型后不再调模型、「没人接 / 只是通知 / 已交出去」的派生。
 */
import type {
  Clock,
  MessagePositionOption,
  MessageRecord,
  MessageTriage,
  SenderRule,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  aggregateThreads,
  claimOfThread,
  kindOfLegacy,
  MemoryMessageStore,
  SqliteMessageStore,
  suggestFor,
  type TriageContext,
  type TriageInput,
  type TriageModel,
  triageMessage,
} from '../src/index.js'

const T0 = '2026-09-30T02:00:00.000Z'
const clock: Clock = { now: () => T0, sleep: async () => undefined }
const ME = 'hello@shop.example'

const input = (over: Partial<TriageInput> = {}): TriageInput => ({
  from_email: 'tom@buyer.example',
  subject: 'Where is my order',
  text: 'Ordered 3 weeks ago, still nothing. I want my money back.',
  thread_id: '<t1@x>',
  references: [],
  headers: {},
  has_attachments: false,
  ...over,
})

const ctx = (over: Partial<TriageContext> = {}): TriageContext => ({
  support_enabled: true,
  kol_enabled: true,
  isSupportThread: () => false,
  isKolThread: () => false,
  senderRules: [],
  model_halted: false,
  at: T0,
  ...over,
})

function countingModel(kind?: string): TriageModel & { calls: number } {
  const m = {
    calls: 0,
    async classify() {
      m.calls += 1
      return {
        route: 'inbox' as const,
        labels: [],
        needs_reply: true,
        priority: 'normal' as const,
        summary: '想周四采访你 20 分钟',
        confidence: 0.91,
        ...(kind === undefined ? {} : { kind }),
      }
    },
  }
  return m
}

describe('类型（docs/88 §3）', () => {
  it('规则层先给：自动信按标签定类型，不花模型', async () => {
    const model = countingModel()
    const out = await triageMessage(
      input({
        from_email: 'noreply@shipfast.example',
        subject: 'Your order has shipped',
        text: 'Tracking number 123',
      }),
      ctx(),
      model,
    )
    expect(model.calls).toBe(0)
    expect(out.kind).toBe('logistics')
    expect(out.kind_by).toBe('rule')
  })

  it('线程归并给路由对应的类型', async () => {
    const out = await triageMessage(
      input({ in_reply_to: '<t0@x>', references: ['<t0@x>'] }),
      ctx({ isSupportThread: () => true }),
    )
    expect(out.route).toBe('support')
    expect(out.kind).toBe('customer_question')
  })

  it('模型给了认得的类型就用，把握照它', async () => {
    const out = await triageMessage(input(), ctx(), countingModel('media'))
    expect(out.kind).toBe('media')
    expect(out.kind_by).toBe('model')
    expect(out.kind_confidence).toBe(0.91)
  })

  it('模型给了不认得的类型：按路由与标签推，推不出是「个人与其他」', async () => {
    const out = await triageMessage(input(), ctx(), countingModel('nonsense'))
    expect(out.kind).toBe('personal_other')
  })

  it('没有模型：词面像售后就写售后，把握写低', async () => {
    const out = await triageMessage(input({ text: 'I want a refund, it arrived broken' }), ctx())
    expect(out.kind).toBe('after_sales')
    expect(out.kind_confidence).toBeLessThan(0.6)
  })

  it('发件人规则教过类型 → 下一封直接按规则、不再调模型', async () => {
    const rule: SenderRule = {
      id: 'r1',
      sender: 'clara@review.example',
      labels: [],
      by: 'p_me',
      created_at: T0,
      kind: 'media',
      position: 'pr',
    }
    const model = countingModel('personal_other')
    const out = await triageMessage(
      input({ from_email: 'clara@review.example', subject: 'Interview request' }),
      ctx({ senderRules: [rule] }),
      model,
    )
    expect(model.calls).toBe(0)
    expect(out.kind).toBe('media')
    expect(out.kind_by).toBe('sender_rule')
    expect(out.suggested_position).toBe('pr')
    expect(out.needs_reply).toBe(true)
    expect(out.route).toBe('inbox')
  })

  it('老记录没有类型：按标签对照表回填', () => {
    expect(kindOfLegacy(undefined, ['billing'], 'inbox').kind).toBe('billing_system')
    expect(kindOfLegacy(undefined, ['orders'], 'inbox').kind).toBe('logistics')
    expect(kindOfLegacy(undefined, ['newsletters'], 'inbox').kind).toBe('marketing')
    expect(kindOfLegacy(undefined, [], 'support').kind).toBe('customer_question')
    expect(kindOfLegacy(undefined, [], 'inbox').kind).toBe('personal_other')
  })
})

describe('三个建议里的主按钮（docs/88 §3.2）', () => {
  const positions: MessagePositionOption[] = [
    { id: 'customer-care', name_zh: '客服', name_en: 'CC', open: true, route: 'support' },
    { id: 'pr', name_zh: '公共关系', name_en: 'PR', open: false },
  ]
  it('类型对得上一个开着的岗位 → 交给它', () => {
    expect(suggestFor({ kind: 'after_sales', needs_reply: true }, positions)).toEqual({
      action: 'hand',
      position: 'customer-care',
    })
  })
  it('对口岗位没开 → 不建议交（我自己回）', () => {
    expect(suggestFor({ kind: 'media', needs_reply: true }, positions)).toEqual({ action: 'self' })
  })
  it('账单与系统通知里要你动手的 → 我自己处理；营销 → 只是通知', () => {
    expect(suggestFor({ kind: 'billing_system', needs_reply: true }, positions).action).toBe('self')
    expect(suggestFor({ kind: 'marketing', needs_reply: true }, positions).action).toBe('notice')
  })
})

/* ── 没人接 / 只是通知 / 已交出去 ─────────────────────────────────────── */

let seq = 0
function mail(over: Partial<MessageRecord> & { triage?: MessageTriage } = {}): MessageRecord {
  seq += 1
  return {
    id: `m${seq}`,
    workspace_id: 'ws_1',
    source: 'email',
    account: ME,
    folder: 'INBOX',
    folder_kind: 'inbox',
    thread_id: `<th${seq}@x>`,
    references: [],
    headers: {},
    from: { email: 'someone@buyer.example' },
    to: [{ email: ME }],
    cc: [],
    bcc: [],
    subject: 's',
    snippet: 's',
    text: 's',
    has_remote_images: false,
    attachments: [],
    date: new Date(Date.parse('2026-09-30T00:00:00.000Z') + seq * 60_000).toISOString(),
    received_at: T0,
    flags: { read: false, starred: false, answered: false, draft: false },
    labels: [],
    route: 'inbox',
    ...over,
  }
}
const verdict = (over: Partial<MessageTriage> = {}): MessageTriage => ({
  route: 'inbox',
  labels: [],
  needs_reply: true,
  priority: 'normal',
  summary: '要退款',
  confidence: 0.5,
  by: 'model',
  reasons: [],
  at: T0,
  ...over,
})

describe('「要不要你」派生（docs/88 §3.1）', () => {
  it('要回、没人接 → 没人接；带摘要、类型与作用的那一封', () => {
    const m = mail({ triage: verdict({ kind: 'after_sales', kind_confidence: 0.52 }) })
    const c = claimOfThread([m])
    expect(c.claim).toBe('unclaimed')
    expect(c.claim_message_id).toBe(m.id)
    expect(c.kind).toBe('after_sales')
    expect(c.summary).toBe('要退款')
  })
  it('AI 判了不用回 → 只是通知（不算没人接）', () => {
    expect(claimOfThread([mail({ triage: verdict({ needs_reply: false }) })]).claim).toBe('notice')
  })
  it('归了岗位 / 人交给了岗位 → 已交出去，以后同一条会话的新来信也不再催', () => {
    const a = mail({ route: 'support', thread_id: '<same@x>' })
    const b = mail({ thread_id: '<same@x>', triage: verdict() })
    expect(claimOfThread([a, b])).toMatchObject({ claim: 'handed', handed_to: 'customer-care' })
    const c = mail({
      triage: verdict(),
      handled: { as: 'position', position_id: 'pr', by: 'p_me', at: T0 },
    })
    expect(claimOfThread([c])).toMatchObject({ claim: 'handed', handed_to: 'pr' })
  })
  it('回过了 / 标了通知 / 归档了 → 已交出去；对方又来一封 → 又没人接', () => {
    const asked = mail({ thread_id: '<t9@x>', triage: verdict() })
    const replied = mail({
      thread_id: '<t9@x>',
      folder: 'Sent',
      folder_kind: 'sent',
      from: { email: ME },
    })
    expect(claimOfThread([asked, replied]).claim).toBe('handed')
    const again = mail({ thread_id: '<t9@x>', triage: verdict() })
    expect(claimOfThread([asked, replied, again]).claim).toBe('unclaimed')
    expect(claimOfThread([mail({ triage: verdict(), folder_kind: 'archive' })]).claim).toBe(
      'handed',
    )
    const noticed = mail({
      triage: verdict(),
      handled: { as: 'notice', by: 'p_me', at: T0 },
    })
    expect(claimOfThread([noticed])).toMatchObject({ claim: 'handed', handed_to: 'notice' })
  })

  it('两个库同一份答案：claim=unclaimed 只列没人接的', async () => {
    for (const store of [new MemoryMessageStore(), new SqliteMessageStore({ clock })]) {
      const open = mail({ triage: verdict() })
      const notice = mail({ triage: verdict({ needs_reply: false }) })
      const handed = mail({ route: 'support', triage: verdict({ route: 'support' }) })
      for (const m of [open, notice, handed]) await store.put(m)
      const unclaimed = await store.threads({ claim: 'unclaimed' })
      expect(unclaimed.map((t) => t.thread_id)).toEqual([open.thread_id])
      const notices = await store.threads({ claim: 'notice' })
      expect(notices.map((t) => t.thread_id)).toEqual([notice.thread_id])
      // 「全部」照旧三条都在，而且每条都带归属
      const all = aggregateThreads([open, notice, handed])
      expect(all.map((t) => t.claim).sort()).toEqual(['handed', 'notice', 'unclaimed'])
      store.close?.()
    }
  })
})
