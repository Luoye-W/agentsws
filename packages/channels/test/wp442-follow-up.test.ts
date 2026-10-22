/**
 * WP442（docs/108 §5.3）：回信跟进的纯函数——工作日（跨周末、跨时区）、对方说过的答复日、盯哪些、哪天提醒、
 * 没接模型时的催促草稿。
 */
import type { MessageRecord } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  addBusinessDays,
  businessDaysBetween,
  followUpCandidate,
  followUpDue,
  nextBusinessMorning,
  nudgeSubject,
  nudgeTemplate,
  promisedReplyAt,
} from '../src/index.js'

const ME = 'hello@shop.example'
const SH = 480 // 上海 +08:00
const LA = -420 // 洛杉矶夏令时 -07:00

const rec = (over: Partial<MessageRecord> = {}): MessageRecord => ({
  id: 'm1',
  workspace_id: 'ws_1',
  source: 'email',
  account: ME,
  folder: 'Sent',
  folder_kind: 'sent',
  thread_id: '<t1@x>',
  message_id: '<m1@x>',
  references: [],
  headers: {},
  from: { email: ME },
  to: [{ email: 'clara@buyer.example', name: 'Clara Jones' }],
  cc: [],
  bcc: [],
  subject: 'Sample order',
  snippet: '',
  text: 'Please find the quote attached.',
  has_remote_images: false,
  attachments: [],
  date: '2026-10-16T07:00:00.000Z',
  received_at: '2026-10-16T07:00:00.000Z',
  flags: { read: true, starred: false, answered: false, draft: false },
  labels: [],
  route: 'inbox',
  ...over,
})

const inbound = (over: Partial<MessageRecord> = {}): MessageRecord =>
  rec({
    id: 'in1',
    folder: 'INBOX',
    folder_kind: 'inbox',
    message_id: '<in1@x>',
    from: { email: 'clara@buyer.example', name: 'Clara Jones' },
    to: [{ email: ME }],
    date: '2026-10-15T07:00:00.000Z',
    ...over,
  })

describe('工作日（品牌时区，周六日不算）', () => {
  it('周五下午发的，3 个工作日是下周三同一钟点；周四发的是下周二', () => {
    // 2026-10-23 是周五：上海 15:00 = 07:00Z
    expect(addBusinessDays('2026-10-23T07:00:00.000Z', 3, SH)).toBe('2026-10-28T07:00:00.000Z')
    expect(addBusinessDays('2026-10-22T07:00:00.000Z', 3, SH)).toBe('2026-10-27T07:00:00.000Z')
  })

  it('周六发的从周一数起；0 天原样回', () => {
    expect(addBusinessDays('2026-10-24T02:00:00.000Z', 3, SH)).toBe('2026-10-28T02:00:00.000Z')
    expect(addBusinessDays('2026-10-24T02:00:00.000Z', 0, SH)).toBe('2026-10-24T02:00:00.000Z')
  })

  it('同一时刻，品牌时区不同，算出来不一样（上海是周六、洛杉矶还是周五）', () => {
    const at = '2026-10-24T01:00:00.000Z'
    // 上海：周六 09:00 → 周一、二、三 → 10-28 09:00 当地
    expect(addBusinessDays(at, 3, SH)).toBe('2026-10-28T01:00:00.000Z')
    // 洛杉矶：周五 18:00 → 周一、二、三 → 10-28 18:00 当地 = 10-29 01:00Z
    expect(addBusinessDays(at, 3, LA)).toBe('2026-10-29T01:00:00.000Z')
  })

  it('过了几个整工作日（跨周末不算周六日）', () => {
    const fri = '2026-10-23T07:00:00.000Z'
    expect(businessDaysBetween(fri, '2026-10-25T07:00:00.000Z', SH)).toBe(0) // 周日
    expect(businessDaysBetween(fri, '2026-10-26T07:00:00.000Z', SH)).toBe(1) // 周一同一钟点
    expect(businessDaysBetween(fri, '2026-10-28T06:59:00.000Z', SH)).toBe(2)
    expect(businessDaysBetween(fri, '2026-10-28T07:00:00.000Z', SH)).toBe(3)
  })

  it('某天之后的下一个工作日早上 9 点（周五 → 下周一）', () => {
    // 上海 10-26（周一）00:00 = 10-25T16:00Z → 周二 09:00 = 10-27T01:00Z
    expect(nextBusinessMorning('2026-10-25T16:00:00.000Z', SH)).toBe('2026-10-27T01:00:00.000Z')
    expect(nextBusinessMorning('2026-10-22T16:00:00.000Z', SH)).toBe('2026-10-26T01:00:00.000Z')
  })
})

describe('对方说过什么时候答复（分拣时抽）', () => {
  // 2026-10-21 周三，上海 10:00
  const ref = '2026-10-21T02:00:00.000Z'
  const day = (iso: string | undefined) => iso

  it('英文：next Monday I’ll confirm → 下周一（当地 00:00）', () => {
    expect(day(promisedReplyAt("Thanks! Next Monday I'll confirm the order.", ref, SH))).toBe(
      '2026-10-25T16:00:00.000Z',
    )
    expect(promisedReplyAt('I will get back to you by Friday.', ref, SH)).toBe(
      '2026-10-22T16:00:00.000Z',
    )
  })

  it('中文：下周一给你答复 / 月底前确认 / 下周给你答复（光说下周 = 下周五）/ 后天回复', () => {
    expect(promisedReplyAt('收到，我们下周一给你答复。', ref, SH)).toBe('2026-10-25T16:00:00.000Z')
    expect(promisedReplyAt('价格这边月底前确认', ref, SH)).toBe('2026-10-30T16:00:00.000Z')
    expect(promisedReplyAt('老板出差了，下周给你答复', ref, SH)).toBe('2026-10-29T16:00:00.000Z')
    expect(promisedReplyAt('我后天回复你', ref, SH)).toBe('2026-10-22T16:00:00.000Z')
  })

  it('没有许诺词的日期不算；引用的旧信不算；过去的不算', () => {
    expect(promisedReplyAt('Our sale ends Friday.', ref, SH)).toBeUndefined()
    expect(promisedReplyAt('促销周五结束', ref, SH)).toBeUndefined()
    expect(
      promisedReplyAt('Sounds good.\n\nOn Mon, Clara wrote:\n> I will confirm on Friday', ref, SH),
    ).toBeUndefined()
    expect(promisedReplyAt('I confirmed it on Oct 3.', ref, SH)).toBeUndefined()
  })

  it('一句里几个日期取最晚的', () => {
    expect(promisedReplyAt("I'll check it on Monday and confirm by Oct 30.", ref, SH)).toBe(
      '2026-10-29T16:00:00.000Z',
    )
    expect(promisedReplyAt('明天先看样品，10月28日前给你确认。', ref, SH)).toBe(
      '2026-10-27T16:00:00.000Z',
    )
  })
})

describe('哪天提醒', () => {
  const fri = '2026-10-23T07:00:00.000Z'
  it('默认 3 个工作日；催过一次之后翻倍（6 个工作日，从催的那一封算）', () => {
    expect(followUpDue({ anchor_at: fri, nudges: 0, business_days: 3, tz: SH })).toEqual({
      due_at: '2026-10-28T07:00:00.000Z',
      basis: 'default',
    })
    const nudged = '2026-10-28T08:00:00.000Z' // 周三
    expect(
      followUpDue({ anchor_at: fri, nudged_at: nudged, nudges: 1, business_days: 3, tz: SH }),
    ).toEqual({ due_at: '2026-11-05T08:00:00.000Z', basis: 'default' })
  })

  it('对方说过下周一答复：到那周二早上才提醒（不再按 3 天）', () => {
    const wed = '2026-10-21T02:00:00.000Z'
    expect(
      followUpDue({
        anchor_at: wed,
        nudges: 0,
        business_days: 3,
        promised_reply_at: '2026-10-25T16:00:00.000Z',
        tz: SH,
      }),
    ).toEqual({ due_at: '2026-10-27T01:00:00.000Z', basis: 'promised' })
  })

  it('答复日比我们最后一封还早 = 失约过了，按默认；再等等优先', () => {
    expect(
      followUpDue({
        anchor_at: fri,
        nudges: 0,
        business_days: 3,
        promised_reply_at: '2026-10-20T16:00:00.000Z',
        tz: SH,
      }).basis,
    ).toBe('default')
    expect(
      followUpDue({
        anchor_at: fri,
        nudges: 0,
        business_days: 3,
        wait_until: '2026-11-02T07:00:00.000Z',
        tz: SH,
      }),
    ).toEqual({ due_at: '2026-11-02T07:00:00.000Z', basis: 'waited' })
  })
})

describe('盯哪些会话', () => {
  const now = '2026-10-21T02:00:00.000Z'
  const opts = { now, lookback_days: 14 }

  it('最后一封是我们发的、收件人是真人 → 盯；对方上一封说过的答复日带出来', () => {
    const out = followUpCandidate(
      [
        inbound({
          triage: {
            route: 'inbox',
            labels: [],
            needs_reply: true,
            priority: 'normal',
            summary: '',
            confidence: 0.9,
            by: 'model',
            reasons: [],
            at: now,
            kind: 'inquiry',
            promised_reply_at: '2026-10-25T16:00:00.000Z',
          },
        }),
        rec(),
      ],
      opts,
    )
    expect(out).toMatchObject({
      ok: true,
      account: ME,
      waiting_on: { email: 'clara@buyer.example' },
      promised_reply_at: '2026-10-25T16:00:00.000Z',
    })
  })

  it('对方回了 / 草稿不算我们发的 / 太老 / 只发给自己', () => {
    expect(followUpCandidate([rec(), inbound({ date: '2026-10-17T00:00:00.000Z' })], opts)).toEqual(
      {
        ok: false,
        reason: 'replied',
      },
    )
    expect(
      followUpCandidate(
        [
          inbound(),
          rec({ folder: 'Drafts', folder_kind: 'drafts', date: '2026-10-20T00:00:00.000Z' }),
        ],
        opts,
      ),
    ).toEqual({ ok: false, reason: 'replied' })
    expect(followUpCandidate([rec({ date: '2026-09-30T00:00:00.000Z' })], opts)).toEqual({
      ok: false,
      reason: 'stale',
    })
    expect(followUpCandidate([rec({ to: [{ email: ME }] })], opts)).toEqual({
      ok: false,
      reason: 'no_recipient',
    })
  })

  it('收件人是机器：noreply 地址、对方来过的信带群发头 / 判成通知类', () => {
    expect(followUpCandidate([rec({ to: [{ email: 'no-reply@shopify.com' }] })], opts)).toEqual({
      ok: false,
      reason: 'not_human',
    })
    expect(
      followUpCandidate(
        [inbound({ headers: { 'list-unsubscribe': '<mailto:u@x>' } }), rec()],
        opts,
      ),
    ).toEqual({ ok: false, reason: 'not_human' })
  })

  it('在别的跟进里：会话里有信归了客服 / 红人 / B2B，或宿主说是（序列、客服线程）', () => {
    expect(followUpCandidate([inbound({ route: 'support' }), rec()], opts)).toEqual({
      ok: false,
      reason: 'other_follow_up',
    })
    expect(followUpCandidate([inbound({ folder_kind: 'kol' }), rec()], opts)).toEqual({
      ok: false,
      reason: 'other_follow_up',
    })
    expect(followUpCandidate([rec()], { ...opts, otherFollowUp: true })).toEqual({
      ok: false,
      reason: 'other_follow_up',
    })
  })
})

describe('催促草稿（没接模型时）', () => {
  it('按对方语言、称呼只取名、第二次换一句；没有模板的语言退回英文', () => {
    const en = nudgeTemplate({
      lang: 'en',
      waiting_on: { email: 'c@x', name: 'Clara Jones' },
      subject: 'Re: Sample order',
      reminder: 1,
    })
    expect(en.startsWith('Hi Clara,')).toBe(true)
    expect(en).toContain('"Sample order"')
    const zh = nudgeTemplate({ lang: 'zh', subject: '样品报价', reminder: 2 })
    expect(zh.startsWith('你好，')).toBe(true)
    expect(zh).toContain('再跟进一下「样品报价」')
    expect(nudgeTemplate({ lang: 'ko', subject: 'x', reminder: 1 }).startsWith('Hi,')).toBe(true)
  })

  it('回信主题已经是 Re: 的不再加', () => {
    expect(nudgeSubject('Sample order')).toBe('Re: Sample order')
    expect(nudgeSubject('RE: Sample order')).toBe('RE: Sample order')
    expect(nudgeSubject('回复：样品')).toBe('回复：样品')
  })
})
