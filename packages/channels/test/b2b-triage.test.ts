/**
 * WP172（docs/84 §5）：分拣开始产出 `b2b`。
 *
 * 钉住五件事：
 *
 * 1. 判成 B2B 的顺序：线程对上我们发出去的 B2B 信 → 发件人在 B2B 库里 → 平台询盘通知 → 模型；
 * 2. **没开 B2B 岗位（或这只邮箱不收 B2B 信）一封都不产出 `b2b`**（WP161 / WP163 的老规矩）；
 * 3. 模型把握不够 → 不挪，挂 `suggested_route: 'b2b'` 进「待确认」；
 * 4. 退订回复与退信认得出来（群发页脚里的 unsubscribe 不算、软退信不拉黑）；
 * 5. 去哪一路（`intakeOf`）与「待确认」筛子都认 `b2b`。
 */
import type { MessageRecord, MessageTriage } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  allowedRoutes,
  bounceOf,
  intakeOf,
  looksLikeB2bInquiry,
  pendingRouteOf,
  platformInquiryOf,
  type TriageContext,
  type TriageInput,
  type TriageModel,
  triageMessage,
  unsubscribeReplyOf,
} from '../src/index.js'

const T0 = '2026-09-28T02:00:00.000Z'

const input = (over: Partial<TriageInput> = {}): TriageInput => ({
  from_email: 'buyer@volthaus.example',
  subject: 'Hello',
  text: 'Hi there',
  thread_id: '<m1@volthaus.example>',
  references: [],
  headers: {},
  has_attachments: false,
  ...over,
})

const ctx = (over: Partial<TriageContext> = {}): TriageContext => ({
  support_enabled: true,
  kol_enabled: false,
  b2b_enabled: true,
  isSupportThread: () => false,
  isKolThread: () => false,
  isB2bThread: () => false,
  isB2bSender: () => false,
  senderRules: [],
  model_halted: false,
  at: T0,
  ...over,
})

const model = (route: MessageTriage['route'], confidence: number): TriageModel => ({
  classify: async () => ({
    route,
    labels: [],
    needs_reply: true,
    priority: 'normal',
    summary: '询价',
    confidence,
  }),
})

describe('WP172 分拣产出 b2b：顺序', () => {
  it('① 回我们发出去的开发信（线程对上）→ b2b，一个 token 都不花', async () => {
    let calls = 0
    const spy: TriageModel = {
      classify: async () => {
        calls += 1
        return {
          route: 'inbox',
          labels: [],
          needs_reply: false,
          priority: 'low',
          summary: '',
          confidence: 1,
        }
      },
    }
    const v = await triageMessage(
      input({ in_reply_to: '<out-1@us.example>', references: ['<out-1@us.example>'] }),
      ctx({ isB2bThread: (_id, refs) => refs.includes('<out-1@us.example>') }),
      spy,
    )
    expect(v.route).toBe('b2b')
    expect(v.by).toBe('rule')
    expect(calls).toBe(0)
  })

  it('② 发件人在 B2B 库里 → b2b（和客服抢的时候按库里算）', async () => {
    const v = await triageMessage(
      input({ subject: 'Refund for damaged units', text: 'We need a refund for 20 broken units.' }),
      ctx({ isB2bSender: (e) => e === 'buyer@volthaus.example' }),
      model('support', 0.95),
    )
    expect(v.route).toBe('b2b')
    expect(v.reasons[0]).toContain('B2B 客户')
  })

  it('③ 阿里国际站的询盘通知（noreply 发的）→ b2b，在"自动信头"之前认', async () => {
    const v = await triageMessage(
      input({
        from_email: 'noreply@notice.alibaba.com',
        subject: 'You have a new inquiry from a buyer',
        text: 'A buyer sent you an inquiry about 65W GaN chargers. Reply on Alibaba.com.',
        headers: { 'list-unsubscribe': '<mailto:x@alibaba.com>' },
      }),
      ctx(),
    )
    expect(v.route).toBe('b2b')
    expect(v.labels).toContain('platform')
    expect(v.reasons[0]).toContain('alibaba')
  })

  it('同一个平台域名的营销订阅不是询盘：落回自动信头那一层', async () => {
    const v = await triageMessage(
      input({
        from_email: 'news@alibaba.com',
        subject: 'Super September deals',
        text: 'Save big this season.',
        headers: { 'list-unsubscribe': '<mailto:x@alibaba.com>' },
      }),
      ctx(),
    )
    expect(v.route).toBe('inbox')
    expect(platformInquiryOf(input({ from_email: 'a@evilalibaba.com', subject: 'inquiry' }))).toBe(
      undefined,
    )
  })

  it('④ 模型判 b2b 且有把握 → b2b；把握不够 → 不挪，进「待确认」', async () => {
    const sure = await triageMessage(input(), ctx(), model('b2b', 0.9))
    expect(sure.route).toBe('b2b')
    const shy = await triageMessage(input(), ctx(), model('b2b', 0.4))
    expect(shy.route).toBe('inbox')
    expect(shy.suggested_route).toBe('b2b')
    expect(intakeOf({ triage: shy, folder_kind: 'inbox' })).toBe('pending')
  })
})

describe('WP172 没开 B2B 岗位：一封都不产出 b2b', () => {
  it('四条认法都不生效；模型选 b2b 也降回收件箱；允许的路里没有 b2b', async () => {
    const off = ctx({
      b2b_enabled: false,
      isB2bThread: () => true,
      isB2bSender: () => true,
    })
    const a = await triageMessage(
      input({ in_reply_to: '<out-1@us.example>', references: ['<out-1@us.example>'] }),
      off,
      model('b2b', 0.99),
    )
    expect(a.route).toBe('inbox')
    expect(a.suggested_route).toBeUndefined()
    const b = await triageMessage(
      input({ from_email: 'noreply@alibaba.com', subject: 'New inquiry', text: 'buyer inquiry' }),
      off,
    )
    expect(b.route).toBe('inbox')
    expect(allowedRoutes(off)).not.toContain('b2b')
    expect(allowedRoutes(ctx())).toContain('b2b')
    // 老调用方（不给 b2b_enabled）= 关
    const { b2b_enabled: _drop, ...legacy } = ctx()
    expect(allowedRoutes(legacy)).not.toContain('b2b')
  })

  it('没有模型时的兜底：像询盘 + B2B 开着 → 挂「像是 B2B？」；关着不挂', async () => {
    const inquiry = input({
      subject: 'Quotation for 5000 pcs',
      text: 'Please send your price list and MOQ for the 20000mAh power bank, FOB Shenzhen.',
    })
    const on = await triageMessage(inquiry, ctx())
    expect(on.route).toBe('inbox')
    expect(on.suggested_route).toBe('b2b')
    const off = await triageMessage(inquiry, ctx({ b2b_enabled: false }))
    expect(off.suggested_route).toBeUndefined()
    // 一个词不够：零售客户问一句 samples 不是询盘
    expect(looksLikeB2bInquiry({ subject: 'samples?', text: 'hi' })).toEqual([])
  })
})

describe('WP172 退订与退信', () => {
  it('人回的退订认得出；群发页脚里的 unsubscribe 不算；引用尾巴之后的不算', () => {
    expect(
      unsubscribeReplyOf(
        input({ subject: 'Re: GaN chargers', text: 'Please remove me from your list.' }),
      ),
    ).toBe('remove me')
    expect(unsubscribeReplyOf(input({ text: '请退订，谢谢' }))).toBe('退订')
    expect(
      unsubscribeReplyOf(
        input({
          text: 'Weekly deals… click to unsubscribe',
          headers: { 'list-unsubscribe': '<x>' },
        }),
      ),
    ).toBeUndefined()
    expect(
      unsubscribeReplyOf(input({ text: `${'Thanks for the catalog. '.repeat(30)} unsubscribe` })),
    ).toBeUndefined()
  })

  it('硬退信：mailer-daemon + 5.1.1 + Final-Recipient → 认出收件人；软退信不拉黑', () => {
    const hard = bounceOf(
      input({
        from_email: 'MAILER-DAEMON@mx.example',
        subject: 'Undelivered Mail Returned to Sender',
        text: 'Final-Recipient: rfc822; old.buyer@gone.example\nStatus: 5.1.1\nDiagnostic: user unknown',
      }),
    )
    expect(hard).toEqual({ hard: true, recipient: 'old.buyer@gone.example', status: '5.1.1' })
    const soft = bounceOf(
      input({
        from_email: 'postmaster@mx.example',
        subject: 'Delivery Status Notification (Delay)',
        text: '<busy@full.example>: mailbox full, Status: 4.2.2',
      }),
    )
    expect(soft?.hard).toBe(false)
    expect(soft?.recipient).toBe('busy@full.example')
    // X-Failed-Recipients 头优先
    const byHeader = bounceOf(
      input({
        from_email: 'mailer-daemon@googlemail.com',
        subject: 'Delivery Status Notification (Failure)',
        text: 'The email account that you tried to reach does not exist.',
        headers: { 'x-failed-recipients': 'nobody@nowhere.example' },
      }),
    )
    expect(byHeader).toEqual({ hard: true, recipient: 'nobody@nowhere.example' })
    expect(bounceOf(input({ subject: 'Re: quote', text: 'thanks' }))).toBeUndefined()
  })
})

describe('WP172「待确认」认 b2b', () => {
  it('suggested_route: b2b、还在收件箱、人没判过 → 待确认', () => {
    const row = {
      route: 'inbox',
      triage: {
        route: 'inbox',
        suggested_route: 'b2b',
        by: 'model',
        labels: [],
        needs_reply: true,
        priority: 'normal',
        summary: '',
        confidence: 0.4,
        reasons: [],
        at: T0,
      },
    } as unknown as MessageRecord
    expect(pendingRouteOf(row)).toBe('b2b')
    expect(
      intakeOf({ triage: { ...row.triage, route: 'b2b' } as MessageTriage, folder_kind: 'inbox' }),
    ).toBe('b2b')
  })
})
