/**
 * WP172（docs/84 §5）：分拣产出 `b2b`，挪进这只邮箱的 `BtoBAgents`，交给 B2B 那一路。
 *
 * 按服务进程的装配把消息同步与 B2B 那一路接在同一只替身邮箱上（不联网、不连真邮箱）：
 *
 * - 客户询盘：挪进 BtoBAgents、落成询盘、开事项、起一次 Run，面板上看得见；
 * - 回我们发出去的开发信：线程对上 → 往来记录（不花模型）；
 * - 阿里国际站询盘通知：规则认出来 → 开「去后台回复」的待办，不起 Run；
 * - 没开 B2B 岗位 / 这只邮箱关了「收 B2B 信」：不挪、不开事项；
 * - 退订回信、硬退信：直接进抑制名单（连着联系人就记「开发序列停了」）；
 * - 判不准：进「待确认」，人点「这是 B2B」才交出去；
 * - 信里要改收款账户：红卡落老板、不起 Run；
 * - 多只邮箱各认各的 BtoBAgents（已有小写的就沿用）。
 */
import type { MailboxWriter, MailSource } from '@agentsws/channels'
import type { Clock, EventEnvelope, ModelGateway, RoleId } from '@agentsws/contracts'
import { MemoryHalt } from '@agentsws/kernel'
import { createTxn } from '@agentsws/txn'
import { createWork } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import { createB2bMail } from '../src/b2b-mail.js'
import { createB2bOutbound } from '../src/b2b-outbound.js'
import { b2bDeckFromStore } from '../src/b2b-service.js'
import { addressHash, createB2bStore } from '../src/b2b-store.js'
import type { MailAccount } from '../src/index.js'
import { createMessages } from '../src/messages.js'

const WS = 'ws_b2b'
const ME = 'sales@zhilian.example'
const T0 = '2026-09-28T02:00:00.000Z'
const clock: Clock = { now: () => T0, sleep: async () => undefined }
const ACTOR = { workspace_id: WS, person_id: 'p_he', assignment_id: 'asg_sales' }

const accountOf = (address: string, id: string): MailAccount => ({
  connection_id: id,
  address,
  imap: { host: 'localhost', port: 143, secure: false, user: address, connection_id: id },
  smtp: { host: 'localhost', port: 25, secure: false, user: address, connection_id: id },
})

interface Letter {
  from: string
  subject: string
  body: string
  headers?: string[]
  mid: string
}

const mime = (l: Letter, to = ME): string =>
  [
    `From: ${l.from}`,
    `To: ${to}`,
    `Subject: ${l.subject}`,
    `Message-ID: <${l.mid}@mail.example>`,
    'Date: Mon, 28 Sep 2026 01:00:00 +0000',
    ...(l.headers ?? []),
    'Content-Type: text/plain; charset=utf-8',
    '',
    l.body,
    '',
  ].join('\r\n')

/** 替身邮箱：文件夹 → 信。挪过去的信拿一个新 UID。 */
class Mailbox {
  readonly folders = new Map<string, { uid: number; source: string }[]>([['INBOX', []]])
  private next = 100
  constructor(extra: string[] = []) {
    for (const f of extra) this.folders.set(f, [])
  }
  deliver(uid: number, source: string): void {
    this.folders.get('INBOX')?.push({ uid, source })
  }
  where(mid: string): string | undefined {
    for (const [folder, rows] of this.folders)
      if (rows.some((r) => r.source.includes(`<${mid}@`))) return folder
    return undefined
  }
  source(folder: string): MailSource {
    return {
      fetchSince: async (since) =>
        (this.folders.get(folder) ?? [])
          .filter((r) => r.uid > since)
          .map((r) => ({ uid: r.uid, mailbox: folder, source: r.source })),
      health: async () => ({ ok: true }),
    }
  }
  writer(): MailboxWriter {
    return {
      setFlags: () => true,
      move: (folder, uid, to) => {
        const rows = this.folders.get(folder) ?? []
        const at = rows.findIndex((r) => r.uid === uid)
        const row = rows[at]
        if (row === undefined) return false
        rows.splice(at, 1)
        const dest = this.folders.get(to) ?? []
        this.folders.set(to, dest)
        this.next += 1
        dest.push({ ...row, uid: this.next })
        return true
      },
      listFolders: () => [...this.folders.keys()],
    }
  }
}

/** 模型桩：走到模型这一层的信一律判成 `route`，把握 `confidence`。 */
const modelSaying = (route: string, confidence: number): ModelGateway =>
  ({
    async complete() {
      return {
        text: JSON.stringify({
          route,
          labels: [],
          needs_reply: true,
          priority: 'normal',
          summary: '询价',
          confidence,
        }),
        usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost_base: 0 },
        model: { provider: 'stub', model: 'stub' },
        static_prefix_hash: '',
      }
    },
  }) as unknown as ModelGateway

function assemble(over: {
  boxes: { address: string; box: Mailbox }[]
  roles?: RoleId[]
  route?: string
  confidence?: number
  /** WP173：接上开发信序列（回信分类、停序列）。 */
  outbound?: boolean
}) {
  const events: EventEnvelope[] = []
  const appendEvent = (e: unknown): void => void events.push(e as EventEnvelope)
  const work = createWork({ workspace_id: WS, clock, random: () => 0.5 })
  const store = createB2bStore({ workspace_id: WS, now: () => T0 })
  const txn = createTxn({
    clock: { now: () => T0 },
    random: () => 0.42,
    readRecord: () => ({}),
    eventSink: (e) => void events.push(e as EventEnvelope),
  })
  const runs: string[] = []
  const roles = over.roles ?? ['b2b.sales', 'b2b.outbound']
  const outbound =
    over.outbound === true
      ? createB2bOutbound({
          workspace_id: WS,
          store,
          clock,
          random: () => 0.3,
          timeZone: () => '+08:00',
          ledger: txn.ledger,
          approvals: txn.approvals,
          effectiveConfig: () => ({ actions: [], automation: {} }) as never,
          appendEvent,
          mailboxes: () => [ME],
          primaryDomains: () => ['zhilian.example'],
          companyName: () => 'Zhilian',
          outboundHolder: () => undefined,
        })
      : undefined
  const b2b = createB2bMail({
    ...(outbound === undefined ? {} : { outbound }),
    workspace_id: WS,
    store,
    clock,
    appendEvent,
    holders: () =>
      roles
        .filter((r) => r.startsWith('b2b.'))
        .map((r) => ({ person_id: 'p_he', assignment_id: `asg_${r}`, role_id: r })),
    owner: async () => 'p_zhou',
    approvals: txn.approvals,
    work,
    startRun: ({ matter }) => {
      runs.push(matter.id)
      return { run_id: `run_${runs.length}` }
    },
  })
  const accounts = over.boxes.map((b, i) => accountOf(b.address, `conn_${i}`))
  const boxOf = (a: MailAccount): Mailbox =>
    over.boxes.find((b) => b.address === a.address)?.box as Mailbox
  const messages = createMessages({
    clock,
    workspace_id: WS,
    appendEvent,
    halt: new MemoryHalt({}),
    accounts: () => accounts,
    credentials: { password: () => 'pw' },
    work,
    position: () => ({ person_id: 'p_he', assignment_id: 'asg_b2b.sales', role_id: 'b2b.sales' }),
    activeRoles: () => roles,
    models: modelSaying(over.route ?? 'b2b', over.confidence ?? 0.9),
    makeSource: (a, folder) => boxOf(a).source(folder),
    makeWriter: (a) => boxOf(a).writer(),
    listFolders: async (a) => [...boxOf(a).folders.keys()],
    b2b,
  })
  const ofType = (type: string) => events.filter((e) => e.type === type)
  const matters = () => work.listMatters({ kind: 'conversation' })
  return { messages, store, work, txn, runs, events, ofType, matters }
}

const INQUIRY: Letter = {
  from: 'buyer@volthaus.example',
  subject: 'Quotation for 65W GaN chargers',
  body: 'Hi, please send your price list and MOQ for 65W GaN chargers, FOB Shenzhen. We are a distributor in Germany.',
  mid: 'inq-1',
}

describe('WP172：判成 B2B 的信挪进 BtoBAgents、落成询盘', () => {
  it('客户询盘：挪进 BtoBAgents、落成询盘、开一条事项、起一次 Run、面板上看得见', async () => {
    const box = new Mailbox()
    box.deliver(1, mime(INQUIRY))
    const h = assemble({ boxes: [{ address: ME, box }] })
    await h.messages.poll()
    expect(box.where('inq-1')).toBe('BtoBAgents')
    const [inq] = h.store.inquiries()
    expect(inq).toMatchObject({
      kind: 'inquiry',
      basis: 'model',
      from_masked: 'b***@volthaus.example',
    })
    expect(inq?.commitments).toContain('起订量')
    expect(h.matters()).toHaveLength(1)
    expect(h.runs).toHaveLength(1)
    // 消息库里那封挂着那条事项、落在 BtoBAgents
    const row = (await h.messages.store.list({})).find(
      (m) => m.message_id === '<inq-1@mail.example>',
    )
    expect(row).toMatchObject({ route: 'b2b', folder: 'BtoBAgents', folder_kind: 'b2b' })
    expect(row?.linked?.id).toBe(h.matters()[0]?.id)
    // 面板「待回询盘」
    expect(b2bDeckFromStore(h.store, T0).inquiries[0]).toMatchObject({
      account: 'volthaus.example',
      subject: INQUIRY.subject,
      source: 'email',
    })
    // 事件里没有正文、没有完整地址
    const ev = h.ofType('b2b.inquiry_recorded')[0]
    expect(JSON.stringify(ev)).not.toContain('buyer@volthaus.example')
    expect(JSON.stringify(ev)).not.toContain('price list')
    // 再扫一遍不重复落、不重复起 Run
    await h.messages.poll()
    expect(h.store.inquiries()).toHaveLength(1)
    expect(h.runs).toHaveLength(1)
  })

  it('回我们发出去的开发信（线程对上）→ 往来记录；发件人在库里 → 也按 B2B 算（不花模型）', async () => {
    const box = new Mailbox()
    const h = assemble({ boxes: [{ address: ME, box }], route: 'support', confidence: 0.99 })
    h.store.noteOutbound(
      { message_id: '<out-1@zhilian.example>', kind: 'outreach', contact_id: 'ctc_1' },
      T0,
    )
    h.store.put('b2b_account', {
      id: 'acc_peak',
      name: 'Peak Gadgets',
      domain: 'peakgadgets.example',
    })
    box.deliver(
      1,
      mime({
        from: 'mia@peakgadgets.example',
        subject: 'Re: GaN chargers',
        body: 'Thanks, interested. Can we talk next week?',
        headers: ['In-Reply-To: <out-1@zhilian.example>', 'References: <out-1@zhilian.example>'],
        mid: 'rep-1',
      }),
    )
    box.deliver(
      2,
      mime({
        from: 'leo@peakgadgets.example',
        subject: 'Broken units in last shipment',
        body: 'Refund for 20 broken units please.',
        mid: 'rep-2',
      }),
    )
    await h.messages.poll()
    expect(box.where('rep-1')).toBe('BtoBAgents')
    expect(box.where('rep-2')).toBe('BtoBAgents')
    const all = h.store.inquiries()
    expect(all.map((i) => i.basis).sort()).toEqual(['known_sender', 'our_thread'])
    expect(all.every((i) => i.kind === 'correspondence')).toBe(true)
    expect(all.find((i) => i.basis === 'known_sender')?.account_id).toBe('acc_peak')
  })

  it('WP173：回开发信的——有意向落成询盘交给业务、停序列；不感兴趣只记往来、进名单、不开事项', async () => {
    const box = new Mailbox()
    const h = assemble({
      boxes: [{ address: ME, box }],
      route: 'support',
      confidence: 0.99,
      outbound: true,
    })
    for (const [n, contact] of [
      [1, 'ctc_mia'],
      [2, 'ctc_leo'],
    ] as const) {
      h.store.saveEnrollment({
        id: `enr_${n}`,
        workspace_id: WS,
        contact_id: contact,
        account_id: 'acc_peak',
        sender: ME,
        status: 'active',
        steps: [{ step: 'first', at: T0, message_id: `<out-${n}@zhilian.example>` }],
        next_step: 'follow_up',
        due_at: '2026-10-01T02:00:00.000Z',
        created_at: T0,
        updated_at: T0,
      })
      h.store.noteOutbound(
        {
          message_id: `<out-${n}@zhilian.example>`,
          kind: 'outreach',
          contact_id: contact,
          enrollment_id: `enr_${n}`,
          step: 'first',
        },
        T0,
      )
    }
    box.deliver(
      1,
      mime({
        from: 'mia@peakgadgets.example',
        subject: 'Re: GaN chargers for Peak Gadgets',
        body: 'Interesting. Please send your catalog and pricing.',
        headers: ['In-Reply-To: <out-1@zhilian.example>', 'References: <out-1@zhilian.example>'],
        mid: 'rep-1',
      }),
    )
    box.deliver(
      2,
      mime({
        from: 'leo@peakgadgets.example',
        subject: 'Re: GaN chargers for Peak Gadgets',
        body: 'No thanks, we already have a supplier.',
        headers: ['In-Reply-To: <out-2@zhilian.example>', 'References: <out-2@zhilian.example>'],
        mid: 'rep-2',
      }),
    )
    await h.messages.poll()
    const all = h.store.inquiries()
    const hot = all.find((i) => i.reply_class === 'asks_price')
    const cold = all.find((i) => i.reply_class === 'not_interested')
    expect(hot).toMatchObject({ kind: 'inquiry', status: 'new', basis: 'our_thread' })
    expect(cold).toMatchObject({ kind: 'correspondence', status: 'closed' })
    expect(hot?.matter_id).toBeDefined()
    expect(cold?.matter_id).toBeUndefined()
    expect(h.runs).toHaveLength(1)
    expect(h.store.enrollment('enr_1')?.status).toBe('handed_to_sales')
    expect(h.store.enrollment('enr_2')?.status).toBe('stopped')
    expect(h.store.isSuppressed('leo@peakgadgets.example')).toBe(true)
    expect(h.ofType('b2b.handed_to_sales')).toHaveLength(1)
  })

  it('阿里国际站询盘通知：规则认出来，开一条「去后台回复」的待办，不起 Run', async () => {
    const box = new Mailbox()
    box.deliver(
      1,
      mime({
        from: 'noreply@notice.alibaba.com',
        subject: 'You have a new inquiry from a buyer',
        body: 'A buyer sent you an inquiry about 20000mAh power banks. Reply on Alibaba.com.',
        headers: ['List-Unsubscribe: <mailto:x@alibaba.com>'],
        mid: 'ali-1',
      }),
    )
    const h = assemble({ boxes: [{ address: ME, box }] })
    await h.messages.poll()
    expect(box.where('ali-1')).toBe('BtoBAgents')
    expect(h.store.inquiries()[0]).toMatchObject({ basis: 'platform_notice', platform: 'alibaba' })
    expect(h.runs).toHaveLength(0)
    expect(h.work.listTodos({}).map((t) => t.title)).toEqual(['去 alibaba 后台回复这条询盘'])
    expect(b2bDeckFromStore(h.store, T0).marketplace_inquiries).toHaveLength(1)
  })

  it('没开 B2B 岗位：不挪、不落、不开事项（模型想判 b2b 也降回收件箱）', async () => {
    const box = new Mailbox()
    box.deliver(1, mime(INQUIRY))
    const h = assemble({ boxes: [{ address: ME, box }], roles: ['dtc.support'] })
    await h.messages.poll()
    expect(box.where('inq-1')).toBe('INBOX')
    expect(h.store.inquiries()).toHaveLength(0)
    expect(h.matters()).toHaveLength(0)
    expect(h.runs).toHaveLength(0)
  })

  it('这只邮箱关了「收 B2B 信」：它的信不挪；另一只照常（多邮箱各自处理，已有小写变体沿用）', async () => {
    const a = new Mailbox()
    const b = new Mailbox(['btobagents'])
    a.deliver(1, mime(INQUIRY))
    b.deliver(1, mime({ ...INQUIRY, mid: 'inq-2' }, 'hello@zhilian.example'))
    const h = assemble({
      boxes: [
        { address: ME, box: a },
        { address: 'hello@zhilian.example', box: b },
      ],
    })
    h.messages.switches.set(ME, { b2b: false }, 'p_he')
    expect(h.messages.switches.get(ME)).toMatchObject({ b2b: false, b2b_position: true })
    await h.messages.poll()
    expect(a.where('inq-1')).toBe('INBOX')
    expect(b.where('inq-2')).toBe('btobagents')
    expect(b.folders.has('BtoBAgents')).toBe(false)
    expect(h.store.inquiries()).toHaveLength(1)
  })

  it('影子模式：落询盘、开事项照旧，邮箱一下都不动', async () => {
    const box = new Mailbox()
    box.deliver(1, mime(INQUIRY))
    const h = assemble({ boxes: [{ address: ME, box }] })
    h.messages.switches.set(ME, { shadow_mode: true }, 'p_he')
    await h.messages.poll()
    expect(box.where('inq-1')).toBe('INBOX')
    expect(h.store.inquiries()).toHaveLength(1)
  })
})

describe('WP172：退订与退信直接进抑制名单', () => {
  it('退订回信 → 发件人进名单，连着联系人就记「开发序列停了」；硬退信 → 退回的那个收件人进名单', async () => {
    const box = new Mailbox()
    const h = assemble({ boxes: [{ address: ME, box }] })
    h.store.indexContactEmail(addressHash('mia@peakgadgets.example'), 'ctc_mia')
    box.deliver(
      1,
      mime({
        from: 'mia@peakgadgets.example',
        subject: 'Re: GaN chargers',
        body: 'Please remove me from your mailing list.',
        mid: 'uns-1',
      }),
    )
    box.deliver(
      2,
      mime({
        from: 'MAILER-DAEMON@mx.example',
        subject: 'Undelivered Mail Returned to Sender',
        body: 'Final-Recipient: rfc822; old.buyer@gone.example\nStatus: 5.1.1\nuser unknown',
        mid: 'bnc-1',
      }),
    )
    box.deliver(
      3,
      mime({
        from: 'postmaster@mx.example',
        subject: 'Delivery Status Notification (Delay)',
        body: '<busy@full.example>: mailbox full, Status: 4.2.2',
        mid: 'bnc-2',
      }),
    )
    await h.messages.poll()
    expect(h.store.isSuppressed('mia@peakgadgets.example')).toBe(true)
    expect(h.store.isSuppressed('old.buyer@gone.example')).toBe(true)
    // 软退信不拉黑
    expect(h.store.isSuppressed('busy@full.example')).toBe(false)
    expect(
      h.store
        .suppressions()
        .map((s) => s.reason)
        .sort(),
    ).toEqual(['hard_bounce', 'unsubscribe'])
    expect(h.ofType('b2b.sequence_stopped')[0]?.payload).toMatchObject({
      contact_id: 'ctc_mia',
      reason: 'unsubscribe',
    })
    // 名单里不存明文
    expect(JSON.stringify(h.store.suppressions())).not.toContain('mia@peakgadgets.example')
  })
})

describe('WP172：「待确认」里的「这是 B2B」与红卡', () => {
  it('判不准 → 待确认、不挪不落；人点「这是 B2B」→ 落询盘、挪进 BtoBAgents、写事件', async () => {
    const box = new Mailbox()
    box.deliver(1, mime(INQUIRY))
    const h = assemble({ boxes: [{ address: ME, box }], confidence: 0.4 })
    await h.messages.poll()
    expect(box.where('inq-1')).toBe('INBOX')
    expect(h.store.inquiries()).toHaveLength(0)
    const pending = await h.messages.port.threads(ACTOR, { pending_route: true })
    expect(pending.threads[0]?.suggested_route).toBe('b2b')
    const id = pending.threads[0]?.pending_message_id as string
    const out = await h.messages.port.confirmRoute(ACTOR, id, { route: 'b2b' })
    expect(out.handed_off).toBe(true)
    expect(out.message).toMatchObject({ route: 'b2b', folder: 'BtoBAgents' })
    expect(h.store.inquiries()[0]).toMatchObject({ basis: 'user', kind: 'inquiry' })
    expect(h.ofType('messages.route_confirmed')[0]?.payload).toMatchObject({
      route: 'b2b',
      handed_off: true,
    })
    expect((await h.messages.port.threads(ACTOR, { pending_route: true })).threads).toHaveLength(0)
  })

  it('没开 B2B 岗位时点「这是 B2B」：交不出去、什么都不改', async () => {
    const box = new Mailbox()
    box.deliver(1, mime(INQUIRY))
    const h = assemble({
      boxes: [{ address: ME, box }],
      roles: ['dtc.support'],
      route: 'support',
      confidence: 0.3,
    })
    await h.messages.poll()
    const [row] = await h.messages.store.list({})
    const out = await h.messages.port.confirmRoute(ACTOR, row?.id as string, { route: 'b2b' })
    expect(out.handed_off).toBe(false)
    expect(box.where('inq-1')).toBe('INBOX')
  })

  it('信里要改收款账户：红卡落老板、不起 Run（信里的账户不采纳）', async () => {
    const box = new Mailbox()
    const h = assemble({ boxes: [{ address: ME, box }] })
    h.store.put('b2b_account', {
      id: 'acc_dp',
      name: 'Dubai Power LLC',
      domain: 'dubai-power.example',
    })
    box.deliver(
      1,
      mime({
        from: 'ap@dubai-power.example',
        subject: 'Re: PO-7702 balance payment',
        body: 'Dear partner, please note our bank details have changed due to an audit. Kindly remit the balance to the new account IBAN AE07 0331 2345 6789 0123 456 instead.',
        mid: 'fraud-1',
      }),
    )
    await h.messages.poll()
    const [inq] = h.store.inquiries()
    expect(inq?.fraud_alert_id).toBeDefined()
    expect(h.runs).toHaveLength(0)
    const card = await h.txn.approvals.get(inq?.fraud_alert_id as string)
    expect(card?.kind).toBe('b2b_fraud_alert')
    expect(card?.routing.recipients.map((r) => r.person)).toEqual(['p_zhou', 'p_he'])
    expect(JSON.stringify(card)).not.toContain('AE07 0331')
  })
})
