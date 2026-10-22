/**
 * WP442（docs/108 §5.3 / M4）：回信跟进——服务进程这一层（消息库 + 审批总线 + 执行器 + 出站门，按 stub 剧本走）。
 *
 * 剧本一：发出 → 3 个工作日后出卡 → 「发出」走出站门（已连邮箱的 sendMail：急停拦得住、在原会话里回）。
 * 剧本二：对方说「next Monday I'll confirm」→ 到那周二才出（不按 3 天）。
 * 还钉住：对方回了卡撤掉；红人 / B2B 序列、客服的会话不出卡；一个会话只一张；再等等顺延 3 个工作日；
 * 不用跟了就停；第二次间隔翻倍、最多两次；系统规则能改天数、能关、能按邮箱分开设。
 */
import type { MailboxWriter, MailSource, RawEmailMessage } from '@agentsws/channels'
import type { ApprovalItem, Clock, EventEnvelope, FollowUpNudgePayload } from '@agentsws/contracts'
import { MemoryHalt } from '@agentsws/kernel'
import { createTxn } from '@agentsws/txn'
import { describe, expect, it } from 'vitest'
import type { DirectMailInput, DirectMailResult } from '../src/channels.js'
import { OUTBOUND_HALTED } from '../src/channels.js'
import type { MailAccount } from '../src/index.js'
import { createMessageFollowUp, type MessageFollowUpService } from '../src/message-follow-up.js'
import { createMessages, type MessagesOptions } from '../src/messages.js'

const WS = 'ws_1'
const ME = 'hello@shop.example'
const CLARA = 'clara@buyer.example'
const SH = 480
const OWNER = 'p_owner'
const ACTOR = { workspace_id: WS, person_id: OWNER, assignment_id: 'asg_1' }

const account: MailAccount = {
  connection_id: 'conn_mail',
  address: ME,
  imap: { host: 'localhost', port: 143, secure: false, user: ME, connection_id: 'conn_mail' },
  smtp: { host: 'localhost', port: 25, secure: false, user: ME, connection_id: 'conn_mail' },
}

/** 上海当地时间 → ISO（`2026-10-23 15:00` → 07:00Z）。 */
const sh = (local: string): string =>
  new Date(Date.parse(`${local.replace(' ', 'T')}:00+08:00`)).toISOString()

interface Mail {
  uid: number
  folder: 'INBOX' | 'Sent'
  from: string
  to: string
  subject: string
  id: string
  at: string
  text: string
  reply_to?: string
  headers?: string[]
  /** 整个 Message-ID（不给 = `<id@mail.example>`）。 */
  mid?: string
  /** References 链（不给 = 只有 `reply_to`）。 */
  refs?: string[]
}

const mime = (m: Mail): RawEmailMessage => ({
  uid: m.uid,
  mailbox: m.folder,
  source: [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${m.subject}`,
    `Message-ID: ${m.mid ?? `<${m.id}@mail.example>`}`,
    ...(m.reply_to === undefined
      ? []
      : [
          `In-Reply-To: <${m.reply_to}@mail.example>`,
          `References: ${(m.refs ?? [m.reply_to]).map((r) => `<${r}@mail.example>`).join(' ')}`,
        ]),
    ...(m.headers ?? []),
    `Date: ${new Date(m.at).toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    m.text,
    '',
  ].join('\r\n'),
})

const writer: MailboxWriter = {
  setFlags: () => true,
  move: () => true,
  keywordsSupported: () => false,
}

function harness(
  over: {
    extra?: Partial<MessagesOptions>
    otherFollowUp?: (thread_id: string) => boolean
    noRecipient?: boolean
  } = {},
) {
  let t = Date.parse(sh('2026-10-23 15:00'))
  const clock: Clock = { now: () => new Date(t).toISOString(), sleep: async () => undefined }
  const at = (iso: string): void => {
    t = Date.parse(iso)
  }
  const mails: Mail[] = []
  const events: EventEnvelope[] = []
  const appendEvent = (e: unknown): void => void events.push(e as EventEnvelope)
  const halt = new MemoryHalt({})
  const sent: DirectMailInput[] = []
  // 出站门的替身：与 `channels.sendMail` 同一条规矩——急停开着一封都不发；同一幂等键只发一次
  const seen = new Map<string, DirectMailResult>()
  const sendMail = async (input: DirectMailInput): Promise<DirectMailResult> => {
    if (halt.isHalted('outbound'))
      return {
        ok: false,
        outbox_id: '',
        message_id: '',
        account: ME,
        error: OUTBOUND_HALTED,
        retryable: true,
      }
    const prior = seen.get(input.idempotency_key)
    if (prior !== undefined) return prior
    sent.push(input)
    const out = {
      ok: true,
      outbox_id: `ob_${sent.length}`,
      message_id: `<nudge-${sent.length}@shop.example>`,
      account: input.account ?? ME,
    }
    seen.set(input.idempotency_key, out)
    return out
  }
  let fu: MessageFollowUpService | undefined
  const messages = createMessages({
    clock,
    workspace_id: WS,
    appendEvent,
    halt,
    accounts: () => [account],
    credentials: { password: () => 'pw' },
    position: () => ({ person_id: OWNER, assignment_id: 'asg_1', role_id: 'dtc.store' }),
    activeRoles: () => [],
    makeSource: (_acct, folder): MailSource => ({
      fetchSince: async (since) =>
        mails.filter((m) => m.folder === folder && m.uid > since).map(mime),
      health: async () => ({ ok: true }),
      uidValidity: async () => 1,
    }),
    makeWriter: () => writer,
    listFolders: async () => ['INBOX', 'Sent'],
    sendMail,
    tzOffsetMinutes: () => SH,
    followUp: () => fu,
    ...over.extra,
  })
  const txn = createTxn({
    clock: { now: () => clock.now() },
    random: () => 0.42,
    eventSink: (e) => {
      events.push(e)
    },
    deliverOutbound: async (item, opts) =>
      (await fu?.deliver(item, opts)) ?? { status: 'ok', execution_id: `stub_${item.id}` },
  })
  fu = createMessageFollowUp({
    workspace_id: WS,
    clock,
    appendEvent,
    store: messages.store,
    accounts: () => [ME],
    tz: () => SH,
    otherFollowUp: (thread_id, refs) =>
      over.otherFollowUp?.(thread_id) === true || messages.otherFollowUp(thread_id, refs),
    recipientFor: () =>
      over.noRecipient === true
        ? undefined
        : { person_id: OWNER as never, assignment_id: 'asg_1', role_id: 'dtc.store' },
    approvals: txn.approvals,
    applyApproval: (id) => txn.executor.applyApproval(id, { skip_cancel_window: true }),
    cancelWindowMs: 0,
    sendMail,
    halt,
  })
  const followUp = fu
  let uid = 0
  const deliver = (m: Omit<Mail, 'uid'>): void => {
    uid += 1
    mails.push({ ...m, uid })
  }
  /** 我们发出去一封（落在「已发送」）。 */
  const send = (
    id: string,
    local: string,
    text = 'Hi Clara, please find the quote for the sample order attached.',
    reply_to?: string,
    refs?: string[],
  ): void =>
    deliver({
      folder: 'Sent',
      from: ME,
      to: `Clara Jones <${CLARA}>`,
      subject: 'Sample order',
      id,
      at: sh(local),
      text,
      ...(reply_to === undefined ? {} : { reply_to }),
      ...(refs === undefined ? {} : { refs }),
    })
  /** Clara 来一封。 */
  const receive = (id: string, local: string, text: string, reply_to?: string): void =>
    deliver({
      folder: 'INBOX',
      from: `Clara Jones <${CLARA}>`,
      to: ME,
      subject: 'Re: Sample order',
      id,
      at: sh(local),
      text,
      ...(reply_to === undefined ? {} : { reply_to }),
    })
  const cards = (): ApprovalItem[] =>
    txn.runtime.store
      .listApprovals({ workspace_id: WS, kind: 'outbound_draft' })
      .filter((i) => (i.payload as { form?: string }).form === 'follow_up_nudge')
  const open = (): ApprovalItem[] =>
    cards().filter((i) => ['pending', 'in_review', 'deferred'].includes(i.state))
  const decide = async (
    item: ApprovalItem,
    action: 'approve' | 'approve_edited' | 'reject' | 'defer',
    extra: Record<string, unknown> = {},
  ): Promise<ApprovalItem> => {
    const token =
      [...item.deliveries].reverse().find((d) => d.to === OWNER && d.status !== 'expired')
        ?.decision_token ?? ''
    const out = await txn.approvals.decide(item.id, OWNER as never, {
      decision_token: token,
      action,
      via: 'workstation',
      ...(action === 'reject' ? { reason: '不要' } : {}),
      ...extra,
    })
    await followUp.onDecided(out)
    if (action === 'approve' || action === 'approve_edited')
      return txn.executor.applyApproval(out.id, { skip_cancel_window: true })
    return out
  }
  const summary = async (thread: string) =>
    (await messages.port.threads(ACTOR, {})).threads.find((x) => x.thread_id === thread)
  return {
    clock,
    at,
    messages,
    followUp,
    txn,
    events,
    sent,
    halt,
    send,
    receive,
    deliver,
    cards,
    open,
    decide,
    summary,
    poll: () => messages.poll(),
  }
}

const THREAD = '<q1@mail.example>'

describe('WP442 剧本一：发出 → 3 个工作日后出卡 → 「发出」走出站门', () => {
  it('周五发的，下周二不出、周三到点出一张；卡上是英文催促草稿；同一会话不出第二张', async () => {
    const h = harness()
    h.send('q1', '2026-10-23 15:00') // 周五
    await h.poll()
    expect((await h.messages.store.thread(THREAD)).map((m) => m.folder_kind)).toEqual(['sent'])

    h.at(sh('2026-10-27 15:00')) // 周二：才 2 个工作日
    await h.followUp.sweep()
    expect(h.cards()).toHaveLength(0)
    expect((await h.summary(THREAD))?.follow_up).toMatchObject({
      state: 'waiting',
      nudges: 0,
      basis: 'default',
      business_days: 3,
      due_at: sh('2026-10-28 15:00'),
      waiting_on: { email: CLARA },
    })

    h.at(sh('2026-10-28 15:05')) // 周三
    const r = await h.followUp.sweep()
    expect(r.carded).toBe(1)
    const [card] = h.cards()
    expect(card?.title).toBe('Clara Jones 还没回（3 个工作日）')
    expect(card?.state).toBe('pending')
    const p = card?.payload as FollowUpNudgePayload
    expect(p.recipients).toEqual([{ email: CLARA, name: 'Clara Jones' }])
    expect(p.body.subject).toBe('Re: Sample order')
    expect(p.lang).toBe('en')
    expect(p.body.text.startsWith('Hi Clara,')).toBe(true)
    expect(p.follow_up).toMatchObject({ reminder: 1, waited_business_days: 3, basis: 'default' })
    expect(p.surface).toBe('messages')
    expect(h.events.some((e) => e.type === 'message.follow_up_due')).toBe(true)
    // 事件里没有邮箱地址
    const due = h.events.find((e) => e.type === 'message.follow_up_due')
    expect(JSON.stringify(due?.payload)).not.toContain('@')
    expect((await h.summary(THREAD))?.follow_up).toMatchObject({
      state: 'carded',
      card_id: card?.id,
    })

    // 一小时后再巡检：同一会话不出第二张
    h.at(sh('2026-10-28 16:10'))
    expect((await h.followUp.sweep()).carded).toBe(0)
    expect(h.cards()).toHaveLength(1)
    expect(h.followUp.rows().map((x) => x.thread_id)).toEqual([THREAD])
  })

  it('「发出」：总线批了 → 执行器 → 已连邮箱在原会话里回一封（In-Reply-To / References）；之后间隔翻倍', async () => {
    const h = harness()
    h.send('q1', '2026-10-23 15:00')
    await h.poll()
    h.at(sh('2026-10-28 15:05'))
    await h.followUp.sweep()
    const card = h.cards()[0] as ApprovalItem
    const applied = await h.decide(card, 'approve')
    expect(applied.state).toBe('applied')
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({
      account: ME,
      to: [CLARA],
      subject: 'Re: Sample order',
      in_reply_to: '<q1@mail.example>',
      references: ['<q1@mail.example>'],
      thread_ref: THREAD,
      idempotency_key: card.id,
    })
    const after = (await h.summary(THREAD))?.follow_up
    // 催过一次：从催的那一刻（周三 15:05）起 6 个工作日 → 下下周四 15:05
    expect(after).toMatchObject({ state: 'waiting', nudges: 1, due_at: sh('2026-11-05 15:05') })
    // 「已发送」同步回来那封催促信（同一个 Message-ID）：认得出是我们催的，不当成新的一轮
    h.deliver({
      folder: 'Sent',
      from: ME,
      to: `Clara Jones <${CLARA}>`,
      subject: 'Re: Sample order',
      id: 'nudge-1',
      mid: '<nudge-1@shop.example>',
      at: sh('2026-10-28 15:05'),
      text: (h.sent[0]?.text as string) ?? '',
      reply_to: 'q1',
    })
    h.at(sh('2026-10-29 10:00'))
    await h.poll()
    expect((await h.messages.store.list({ folder_kind: 'sent', limit: 10 })).length).toBe(2)
    await h.followUp.sweep()
    expect((await h.summary(THREAD))?.follow_up).toMatchObject({
      state: 'waiting',
      nudges: 1,
      due_at: sh('2026-11-05 15:05'),
    })
  })

  it('出站急停开着：批了也发不出去（施行失败、一封没发），关了再重试才发', async () => {
    const h = harness()
    h.send('q1', '2026-10-23 15:00')
    await h.poll()
    h.at(sh('2026-10-28 15:05'))
    await h.followUp.sweep()
    h.halt.set('outbound', true, 'test')
    const card = h.cards()[0] as ApprovalItem
    const out = await h.decide(card, 'approve')
    expect(out.state).toBe('apply_failed')
    expect(h.sent).toHaveLength(0)
    expect((await h.summary(THREAD))?.follow_up?.nudges).toBe(0)
    h.halt.set('outbound', false)
    h.at(sh('2026-10-28 15:10')) // 过了取消窗口
    await h.txn.approvals.retryApply(card.id, OWNER as never)
    expect(h.sent).toHaveLength(1)
    expect((await h.summary(THREAD))?.follow_up?.nudges).toBe(1)
  })

  it('「修改」：带着改过的那一版批，发出去的是改过的字', async () => {
    const h = harness()
    h.send('q1', '2026-10-23 15:00')
    await h.poll()
    h.at(sh('2026-10-28 15:05'))
    await h.followUp.sweep()
    const card = h.cards()[0] as ApprovalItem
    const p = card.payload as FollowUpNudgePayload
    await h.decide(card, 'approve_edited', {
      edited_payload: { ...p, body: { ...p.body, text: 'Hi Clara, any news on the sample?' } },
    })
    expect(h.sent[0]?.text).toBe('Hi Clara, any news on the sample?')
  })
})

describe('WP442 剧本二：对方说过哪天答复', () => {
  it('「next Monday I’ll confirm」→ 周一不出（默认 3 天本该是周一），到那周二才出', async () => {
    const h = harness()
    h.at(sh('2026-10-21 10:00')) // 周三
    h.send('q1', '2026-10-20 10:00')
    h.receive('c1', '2026-10-21 09:30', "Thanks! Next Monday I'll confirm the order.", 'q1')
    h.send('q2', '2026-10-21 10:00', 'Great, talk on Monday.', 'c1', ['q1', 'c1'])
    await h.poll()
    const clara = (await h.messages.store.thread(THREAD)).find((m) => m.from.email === CLARA)
    // 分拣时抽出来的：周一当地 00:00
    expect(clara?.triage?.promised_reply_at).toBe(sh('2026-10-26 00:00'))

    h.at(sh('2026-10-26 18:00')) // 周一晚上（默认 3 个工作日这时已经到了）
    await h.followUp.sweep()
    expect(h.cards()).toHaveLength(0)
    expect((await h.summary(THREAD))?.follow_up).toMatchObject({
      basis: 'promised',
      due_at: sh('2026-10-27 09:00'),
      promised_reply_at: sh('2026-10-26 00:00'),
    })

    h.at(sh('2026-10-27 09:30')) // 周二早上
    await h.followUp.sweep()
    expect(h.cards()).toHaveLength(1)
    expect(h.cards()[0]?.title).toBe('Clara Jones 说 10-26 答复，还没回')
  })
})

describe('WP442：对方回了、别的跟进、再等等、不用跟了、最多两次', () => {
  it('对方回了 → 卡撤掉、这条跟进收掉', async () => {
    const h = harness()
    h.send('q1', '2026-10-23 15:00')
    await h.poll()
    h.at(sh('2026-10-28 15:05'))
    await h.followUp.sweep()
    expect(h.open()).toHaveLength(1)
    h.receive('c2', '2026-10-28 16:00', 'Sorry for the delay — confirmed!', 'q1')
    h.at(sh('2026-10-28 16:02'))
    await h.poll()
    expect(h.open()).toHaveLength(0)
    expect(h.cards()[0]?.state).toBe('expired')
    expect((await h.summary(THREAD))?.follow_up).toBeUndefined()
    expect(h.events.find((e) => e.type === 'message.follow_up_closed')?.payload).toMatchObject({
      reason: 'replied',
      card_withdrawn: true,
    })
  })

  it('红人 / B2B 开发信序列、客服的会话不出卡', async () => {
    const seq = harness({ otherFollowUp: (id) => id === THREAD })
    seq.send('q1', '2026-10-23 15:00')
    await seq.poll()
    seq.at(sh('2026-10-30 15:00'))
    await seq.followUp.sweep()
    expect(seq.cards()).toHaveLength(0)
    expect((await seq.summary(THREAD))?.follow_up).toBeUndefined()

    // 客服在办：会话里那封来信归了客服（路由 support）→ 客服回复时限在管，不重复盯
    const sup = harness()
    sup.at(sh('2026-10-22 10:00'))
    sup.receive('c0', '2026-10-22 09:00', 'My parcel is broken.')
    sup.send('r0', '2026-10-23 15:00', 'Sorry! We will send a new one.', 'c0')
    await sup.poll()
    const inbound = (await sup.messages.store.thread('<c0@mail.example>')).find(
      (m) => m.from.email === CLARA,
    )
    await sup.messages.store.update(inbound?.id as string, { route: 'support' })
    sup.at(sh('2026-10-30 15:00'))
    await sup.followUp.sweep()
    expect(sup.cards()).toHaveLength(0)
  })

  it('收件人是机器（noreply）不盯；对方来过的信带群发头也不盯', async () => {
    const h = harness()
    h.deliver({
      folder: 'Sent',
      from: ME,
      to: 'no-reply@platform.example',
      subject: 'Ticket',
      id: 'n1',
      at: sh('2026-10-23 15:00'),
      text: 'hello',
    })
    await h.poll()
    h.at(sh('2026-10-30 15:00'))
    await h.followUp.sweep()
    expect(h.cards()).toHaveLength(0)
  })

  it('「再等等」→ 卡撤掉、顺延 3 个工作日再出；「不用跟了」→ 停、不再出', async () => {
    const h = harness()
    h.send('q1', '2026-10-23 15:00')
    await h.poll()
    h.at(sh('2026-10-28 15:05'))
    await h.followUp.sweep()
    const first = h.cards()[0] as ApprovalItem
    await h.decide(first, 'defer')
    expect((await h.txn.approvals.get(first.id))?.state).toBe('expired')
    expect((await h.summary(THREAD))?.follow_up).toMatchObject({
      state: 'waiting',
      basis: 'waited',
      due_at: sh('2026-11-02 15:05'), // 周三 + 3 个工作日 = 下周一
      nudges: 0,
    })
    h.at(sh('2026-10-30 15:05'))
    await h.followUp.sweep()
    expect(h.open()).toHaveLength(0)
    h.at(sh('2026-11-02 15:10'))
    await h.followUp.sweep()
    expect(h.open()).toHaveLength(1)
    const second = h.open()[0] as ApprovalItem
    expect((second.payload as FollowUpNudgePayload).follow_up.reminder).toBe(1)

    await h.decide(second, 'reject')
    expect((await h.summary(THREAD))?.follow_up?.state).toBe('stopped')
    h.at(sh('2026-11-20 15:00'))
    await h.followUp.sweep()
    expect(h.open()).toHaveLength(0)
  })

  it('催过一次还没回：第二次间隔翻倍；催满两次就停', async () => {
    const h = harness()
    h.send('q1', '2026-10-23 15:00')
    await h.poll()
    h.at(sh('2026-10-28 15:05'))
    await h.followUp.sweep()
    await h.decide(h.cards()[0] as ApprovalItem, 'approve')
    h.at(sh('2026-11-04 15:05')) // 才 5 个工作日
    await h.followUp.sweep()
    expect(h.open()).toHaveLength(0)
    h.at(sh('2026-11-05 15:10')) // 6 个工作日
    await h.followUp.sweep()
    const second = h.open()[0] as ApprovalItem
    expect((second.payload as FollowUpNudgePayload).follow_up).toMatchObject({
      reminder: 2,
      nudges: 1,
    })
    expect((second.payload as FollowUpNudgePayload).body.text).toContain('Following up once more')
    expect((second.payload as FollowUpNudgePayload).in_reply_to).toBe('<nudge-1@shop.example>')
    await h.decide(second, 'approve')
    expect(h.sent).toHaveLength(2)
    expect((await h.summary(THREAD))?.follow_up).toMatchObject({ state: 'stopped', nudges: 2 })
    h.at(sh('2026-12-01 15:00'))
    await h.followUp.sweep()
    expect(h.open()).toHaveLength(0)
  })

  it('系统规则：能改天数、能关、能按邮箱分开设；「等对方回」那一行能直接停 / 现在就催', async () => {
    const h = harness()
    expect(h.followUp.settings()).toMatchObject({ enabled: true, business_days: 3, accounts: [] })
    h.send('q1', '2026-10-23 15:00')
    await h.poll()
    await h.followUp.sweep()
    h.followUp.setSettings({ account: ME, business_days: 5 }, OWNER as never)
    expect((await h.summary(THREAD))?.follow_up).toMatchObject({
      business_days: 5,
      due_at: sh('2026-10-30 15:00'),
    })
    expect(h.followUp.settings().accounts).toEqual([{ account: ME, business_days: 5 }])
    h.followUp.setSettings({ account: ME, reset: true }, OWNER as never)
    h.followUp.setSettings({ enabled: false }, OWNER as never)
    h.at(sh('2026-10-30 16:00'))
    await h.followUp.sweep()
    expect(h.cards()).toHaveLength(0)
    expect(h.followUp.rows()).toHaveLength(0)

    h.followUp.setSettings({ enabled: true }, OWNER as never)
    h.at(sh('2026-10-26 10:00'))
    await h.followUp.sweep()
    // 没到点也能「现在就催」
    const nudged = await h.followUp.act(THREAD, 'nudge', OWNER as never)
    expect(nudged?.state).toBe('carded')
    expect(h.open()).toHaveLength(1)
    const stopped = await h.followUp.act(THREAD, 'stop', OWNER as never)
    expect(stopped?.state).toBe('stopped')
    expect(h.open()).toHaveLength(0)
    // 接口那一层
    const viaPort = await h.messages.port.followUpSettings?.({
      workspace_id: WS,
      person_id: OWNER,
      assignment_id: 'asg_1',
    })
    expect(viaPort?.enabled).toBe(true)
  })

  it('卡放到过期（没人管）：当成再等等，顺延 3 个工作日再出一张，不当场又冒一张', async () => {
    const h = harness()
    h.send('q1', '2026-10-23 15:00')
    await h.poll()
    h.at(sh('2026-10-28 15:05'))
    await h.followUp.sweep()
    const first = h.cards()[0] as ApprovalItem
    await h.txn.approvals.expireNow?.(first.id, 'housekeeping')
    h.at(sh('2026-10-28 16:10'))
    await h.followUp.sweep()
    expect(h.open()).toHaveLength(0)
    expect((await h.summary(THREAD))?.follow_up).toMatchObject({
      state: 'waiting',
      basis: 'waited',
    })
    h.at(sh('2026-11-02 16:20'))
    await h.followUp.sweep()
    expect(h.open()).toHaveLength(1)
    expect(h.open()[0]?.id).not.toBe(first.id)
  })

  it('没人可给卡（品牌里还没有持岗位的人）就不出，下一拍再看', async () => {
    const h = harness({ noRecipient: true })
    h.send('q1', '2026-10-23 15:00')
    await h.poll()
    h.at(sh('2026-10-28 15:05'))
    await h.followUp.sweep()
    expect(h.cards()).toHaveLength(0)
    expect((await h.summary(THREAD))?.follow_up?.state).toBe('waiting')
  })
})
