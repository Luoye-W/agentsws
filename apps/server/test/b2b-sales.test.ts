/**
 * WP182（docs/84 §3）：B2B 业务——询盘分级与首回卡、诈骗嫌疑红卡、WhatsApp 三道闸、六类事实卡预填、
 * 报价单 PDF 与发给客户（也出卡）、样品往前走与超期提醒、离职交接卡。
 *
 * 按服务进程的装配把 B2B 库、账本、`b2b-service`、`b2b-sales`、`b2b-mail` 接在一起（不联网、不连真邮箱：
 * 发信是替身，收件人明文只在替身加密库里）。
 */
import type {
  B2bAccount,
  B2bContact,
  B2bSample,
  Clock,
  EventEnvelope,
  MessageRecord,
  PersonId,
} from '@agentsws/contracts'
import { createTxn } from '@agentsws/txn'
import { createWork } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import { createB2bMail } from '../src/b2b-mail.js'
import { type B2bFactCardLite, b2bLetterheadOf, createB2bSales } from '../src/b2b-sales.js'
import { createB2bService } from '../src/b2b-service.js'
import { addressHash, createB2bStore } from '../src/b2b-store.js'
import type { DirectMailInput } from '../src/channels.js'

const WS = 'ws_b2b_sales'
const T0 = '2026-09-29T02:00:00.000Z'
const DAY = 86_400_000

const CONFIG = {
  actions: [
    {
      id: 'stage_b2b_quote',
      mandate: {
        caps: {
          max_amount_usd: 10000,
          min_margin_pct: 20,
          max_discount_pct: 5,
          max_payment_terms_days: 30,
        },
      },
      route_to: 'scope_manager',
    },
    {
      id: 'stage_b2b_sample',
      mandate: { caps: { sample_overdue_days: 3, feedback_overdue_days: 14 } },
    },
    { id: 'stage_b2b_reply', mandate: { caps: {} } },
    { id: 'stage_b2b_account_transfer', mandate: { caps: {} }, route_to: 'owner' },
  ],
  automation: {},
}

function assemble(
  opts: { holders?: { person: string; role: string }[]; facts?: B2bFactCardLite[] } = {},
) {
  let now = T0
  const clock: Clock = { now: () => now, sleep: async () => undefined }
  const events: EventEnvelope[] = []
  const appendEvent = (e: unknown): void => void events.push(e as EventEnvelope)
  const store = createB2bStore({ workspace_id: WS, now: () => now })
  const work = createWork({ workspace_id: WS, clock, random: () => 0.5 })
  const secrets = new Map<string, Record<string, string>>()
  const sent: DirectMailInput[] = []
  const whatsapp: { to: string; text: string }[] = []
  const facts: B2bFactCardLite[] = [...(opts.facts ?? [])]
  const holders = opts.holders ?? [
    { person: 'p_he', role: 'b2b.sales' },
    { person: 'p_he', role: 'b2b.outbound' },
  ]
  let sales: ReturnType<typeof createB2bSales> | undefined
  let service: ReturnType<typeof createB2bService> | undefined
  const txn = createTxn({
    clock,
    random: () => 0.42,
    eventSink: (e) => void events.push(e as EventEnvelope),
    readRecord: () => ({}),
    policy: { cancel_window_sec: 0 },
    backendApply: async (change) => {
      const applied = service?.apply(change)
      if (applied !== undefined) {
        if (applied.status === 'ok') await sales?.afterApplied(change)
        return applied
      }
      return (await sales?.apply(change)) ?? { status: 'ok', execution_id: 'exec_other' }
    },
    deliverOutbound: () => ({ status: 'ok', execution_id: 'exec_1' }),
  })
  service = createB2bService({
    workspace_id: WS,
    store,
    clock,
    random: () => 0.37,
    approvals: txn.approvals,
    ledger: txn.ledger,
    effectiveConfig: () => CONFIG as never,
    appendEvent,
    secrets: { put: (id, f) => void secrets.set(id, f) },
    owner: async () => 'p_zhou',
  })
  const holderRows = () =>
    holders.map((h) => ({
      person_id: h.person as PersonId,
      assignment_id: `asg_${h.person}_${h.role}`,
      role_id: h.role,
    }))
  sales = createB2bSales({
    workspace_id: WS,
    store,
    clock,
    random: () => 0.61,
    ledger: txn.ledger,
    approvals: txn.approvals,
    effectiveConfig: () => CONFIG as never,
    appendEvent,
    service,
    holders: holderRows,
    owner: async () => 'p_zhou',
    personName: async (id) => ({ p_he: 'He Jia', p_wu: 'Wu Min', p_zhou: 'Zhou' })[id],
    secrets: { get: (id) => secrets.get(id), put: (id, f) => void secrets.set(id, f) },
    messageOf: async (id) =>
      id === 'msg_inq'
        ? {
            from: 'anna@volthaus.example',
            rfc_message_id: '<inq@volthaus.example>',
            references: [],
            account: 'sales@zhilian.example',
          }
        : undefined,
    factCards: async () => facts,
    proposeFact: async (t) => {
      const id = `kc_${facts.length + 1}`
      facts.push({
        id,
        status: 'proposed',
        key: t.key,
        statement: t.statement,
        structured: t.structured as never,
        locator: t.locator,
      })
      return id
    },
    industry: () => ({
      industry: '消费电子 / 3C',
      sub_industry: '充电与电源产品',
      products: [],
      playbooks: [],
      certifications: ['CE', 'FCC', 'RoHS', 'UKCA', 'PSE'],
      website: 'https://zhilian.example',
    }),
    inquirySkill: () => '## b2b-inquiry（测试用正文）',
    companyName: () => 'Shenzhen Zhilian Tech',
    companyAddress: () => 'Bldg 5, Demo Park, Shenzhen',
    letterhead: () => ({ color: '#0F766E', font_family: 'Inter' }),
    sendMail: async (input) => {
      sent.push(input)
      return {
        ok: true,
        outbox_id: `ob_${sent.length}`,
        message_id: `<sent-${sent.length}@zhilian.example>`,
        account: 'sales@zhilian.example',
      }
    },
    sendWhatsApp: async (input) => {
      whatsapp.push(input)
      return { ok: true, external_id: 'wamid.1' }
    },
    work,
  })
  const mail = createB2bMail({
    workspace_id: WS,
    store,
    clock,
    appendEvent,
    holders: holderRows,
    owner: async () => 'p_zhou',
    approvals: txn.approvals,
    work,
    sales,
    startRun: () => {
      throw new Error('询盘不该再起 Run')
    },
  })
  const decide = async (id: string, who: string, action: 'approve' | 'reject' = 'approve') => {
    const card = await txn.approvals.get(id)
    const token = card?.deliveries.find((d) => d.to === who)?.decision_token ?? ''
    const item = await txn.approvals.decide(id, who as PersonId, {
      action,
      decision_token: token,
      via: 'workstation',
    })
    if (action === 'approve') return txn.executor.applyApproval(id)
    return item
  }
  const actor = {
    workspace_id: WS,
    person_id: 'p_he',
    assignment_id: 'asg_p_he_b2b.sales',
    role_id: 'b2b.sales',
  } as never
  return {
    store,
    txn,
    work,
    sales,
    service,
    mail,
    events,
    secrets,
    sent,
    whatsapp,
    facts,
    decide,
    actor,
    advance: (ms: number) => {
      now = new Date(Date.parse(now) + ms).toISOString()
    },
    ofType: (t: string) => events.filter((e) => e.type === t),
  }
}

const record = (patch: Partial<MessageRecord>): MessageRecord =>
  ({
    id: 'msg_inq',
    workspace_id: WS,
    source: 'email',
    account: 'sales@zhilian.example',
    folder: 'INBOX',
    folder_kind: 'inbox',
    thread_id: 'thr_inq',
    message_id: '<inq@volthaus.example>',
    references: [],
    headers: {},
    from: { email: 'anna@volthaus.example', name: 'Anna Keller' },
    to: [],
    cc: [],
    bcc: [],
    subject: 'GaN 65W for the UK',
    snippet: '',
    text: 'We are a distributor in the UK. We need 3,000 pcs of 65W USB-C PD chargers with UKCA. What is the MOQ and lead time?',
    has_remote_images: false,
    attachments: [],
    date: T0,
    ...patch,
  }) as MessageRecord

const TRIAGE = { route: 'b2b', by: 'model', confidence: 0.9, labels: [] } as never

const FACTS: B2bFactCardLite[] = [
  {
    id: 'kc_moq',
    status: 'active',
    key: 'b2b:pricing_moq',
    statement: 'GaN 65W MOQ 500 件每款',
    structured: { reply_en: 'The MOQ for the GaN 65W is 500 pcs per model.' },
  },
  {
    id: 'kc_lead',
    status: 'active',
    key: 'b2b:delivery',
    statement: '常规交期定金后 15-20 天',
    structured: { reply_en: 'Standard lead time is 15-20 days after deposit.' },
  },
  // 提议中的（人没点生效）：起草一个字都不许引
  {
    id: 'kc_cert',
    status: 'proposed',
    key: 'b2b:certifications',
    statement: '认证清单（预填，待核）：CE、UKCA',
    structured: { reply_en: 'Our chargers are certified to UKCA.' },
  },
]

describe('WP182 询盘接客服那条管线：分级 → 首回卡 / 红卡', () => {
  it('真买家：首回只引生效的事实卡、出一张 b2b_reply 卡（碰承诺另报一条）、不起 Run', async () => {
    const h = assemble({ facts: FACTS })
    const out = await h.mail.intake(record({}), TRIAGE, 'triage')
    expect(out.accepted).toBe(true)
    const [inq] = h.store.inquiries()
    expect(inq).toMatchObject({ grade: 'buyer', owner_person_id: 'p_he', reply_by: 'template' })
    const card = await h.txn.approvals.get(inq?.reply_approval_id ?? '')
    const payload = card?.payload as {
      kind: string
      after: Record<string, unknown>
      guardrail_notes: string[]
    }
    expect(payload.kind).toBe('b2b_reply')
    expect(payload.guardrail_notes).toContain('b2b_commitment')
    expect(payload.after.cited_facts).toEqual(['kc_moq', 'kc_lead'])
    expect(String(payload.after.body)).toContain('500 pcs')
    expect(String(payload.after.body)).not.toContain('UKCA.')
    expect(card?.summary).toMatch(/^真买家/)
    expect(card?.summary).toContain('价格与 MOQ')
    expect(card?.routing.recipients[0]).toMatchObject({ person: 'p_he', via: 'role_holder' })
    // 卡里没有收件人明文
    expect(JSON.stringify(card)).not.toContain('anna@volthaus.example')
    // 事项时间线上一句人话
    const matter = h.work.listMatters({ kind: 'conversation' })[0]
    expect(matter).toBeDefined()
    expect(h.ofType('b2b.inquiry_recorded')[0]?.payload).toMatchObject({
      grade: 'buyer',
      reply_staged: true,
      run_started: false,
    })
  })

  it('批了首回卡 → 回在原线程里（In-Reply-To）、收件人发的那一刻才从消息库取、询盘标已回', async () => {
    const h = assemble({ facts: FACTS })
    await h.mail.intake(record({}), TRIAGE, 'triage')
    const [inq] = h.store.inquiries()
    await h.decide(inq?.reply_approval_id ?? '', 'p_he')
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({
      to: ['anna@volthaus.example'],
      in_reply_to: '<inq@volthaus.example>',
    })
    expect(h.store.inquiries()[0]?.status).toBe('replied')
    expect(h.store.outboundMatch(['<sent-1@zhilian.example>'])?.kind).toBe('reply')
  })

  it('诈骗嫌疑：不起草，红卡落老板、业务员同收', async () => {
    const h = assemble({ facts: FACTS })
    await h.mail.intake(
      record({
        id: 'msg_scam',
        thread_id: 'thr_scam',
        from: { email: 'purchase.walmart@gmail.com' },
        subject: 'Walmart vendor RFQ',
        text: 'Please click the link below and login to view the purchase order. Walmart purchasing.',
      }),
      TRIAGE,
      'triage',
    )
    const [inq] = h.store.inquiries()
    expect(inq?.grade).toBe('scam')
    expect(inq?.reply_approval_id).toBeUndefined()
    const red = await h.txn.approvals.get(inq?.fraud_alert_id ?? '')
    expect(red?.kind).toBe('b2b_fraud_alert')
    expect((red?.payload as { reason?: string } | undefined)?.reason).toBe('scam_suspect')
    expect(red?.routing.recipients.map((r) => r.person)).toEqual(['p_zhou', 'p_he'])
  })

  it('WhatsApp 同一条路：窗口里出卡、批了发；过了 24 小时 → 三道闸拦下、不出卡', async () => {
    const h = assemble({ facts: FACTS })
    const ok = await h.sales.intakeWhatsApp({
      from_phone: '+44 7700 900123',
      from_name: 'Tom',
      text: 'Hi, MOQ for GaN 65W? We need 1000 pcs with UKCA.',
      message_id: 'wamid.in.1',
      received_at: T0,
    })
    expect(ok.reply_approval_id).toBeDefined()
    const inq = h.store.inquiry(ok.inquiry_id ?? '')
    expect(inq).toMatchObject({ channel: 'whatsapp', from_masked: '+********0123' })
    expect(JSON.stringify(inq)).not.toContain('7700900123')
    await h.decide(ok.reply_approval_id ?? '', 'p_he')
    expect(h.whatsapp[0]?.to).toBe('447700900123')
    const late = await h.sales.intakeWhatsApp({
      from_phone: '+44 7700 900999',
      text: 'MOQ for GaN 65W, 1000 pcs?',
      message_id: 'wamid.in.2',
      received_at: new Date(Date.parse(T0) - 2 * DAY).toISOString(),
    })
    expect(late.reply_approval_id).toBeUndefined()
    expect(h.ofType('b2b.inquiry_reply_blocked')[0]?.payload).toMatchObject({})
    expect(JSON.stringify(h.ofType('guardrail.hit'))).toContain('whatsapp_window_closed')
  })
})

describe('WP182 六类事实卡', () => {
  it('按官网行业预填：六类各提议一张（认证清单预填 3C 那几张证），已有的不重复提', async () => {
    const h = assemble()
    const first = await h.sales.port.setupFacts(h.actor)
    expect(first.proposed).toBe(6)
    expect(first.industry).toBe('消费电子 / 3C')
    const cert = first.categories.find((c) => c.category === 'certifications')
    expect(cert?.card).toMatchObject({ status: 'proposed', prefilled: true })
    expect(cert?.card?.statement).toMatch(/CE、FCC、RoHS、UKCA、PSE/)
    expect(first.ready).toBe(0)
    const again = await h.sales.port.setupFacts(h.actor)
    expect(again.proposed).toBe(0)
  })
})

const account = (id: string, owner: string, region: string, line: string): B2bAccount => ({
  id,
  workspace_id: WS as never,
  name: id.replace('acc_', '').toUpperCase(),
  region,
  country: region === 'EU' ? 'DE' : 'US',
  product_lines: [line],
  stage: 'quote',
  owner_person_id: owner as PersonId,
  source: { kind: 'manual', observed_at: T0 },
  created_at: T0,
  updated_at: T0,
})

const seedContact = (h: ReturnType<typeof assemble>, account_id: string, email: string): string => {
  const id = `ctc_${account_id}`
  const ref = `b2b.contact.${id}.email`
  h.secrets.set(ref, { value: email })
  h.store.put('b2b_contact', {
    id,
    workspace_id: WS,
    account_id,
    name: 'Anna Keller',
    email_ref: ref,
    email_masked: 'a***@volthaus.example',
    email_key_hash: addressHash(email),
    source: { kind: 'manual', observed_at: T0 },
    created_at: T0,
  } as B2bContact & Record<string, unknown>)
  return id
}

describe('WP182 报价：永远出卡、超授权转上级 / 老板、新建版本、报价单 PDF、发给客户也出卡', () => {
  it('超授权的 V2 落老板（没有上级）、面板读真落到的那一档；PDF 预览在批的那一版；批了才发，发的时候带 PDF', async () => {
    const h = assemble({ facts: FACTS })
    h.store.put('b2b_account', account('acc_volthaus', 'p_he', 'EU', 'GaN'))
    seedContact(h, 'acc_volthaus', 'anna@volthaus.example')
    const line = {
      sku: 'GaN65',
      description: 'GaN 65W charger, UKCA',
      qty: 3000,
      unit_price_usd: 6.2,
    }
    const v = (margin: number) => ({
      lines: [line],
      margin_pct: margin,
      discount_pct: 1,
      payment_terms_days: 30,
      incoterm: 'FOB' as const,
      incoterm_place: 'Shenzhen',
      valid_until: '2026-10-31T00:00:00.000Z',
      tiers: [
        { min_qty: 1000, unit_price_usd: 6.5 },
        { min_qty: 3000, unit_price_usd: 6.2 },
      ],
    })
    const port = h.service.port
    const d1 = await port.saveDraft(h.actor, 'b2b_quote', {
      record: { account_id: 'acc_volthaus', number: 'Q-20260929-01' },
      quote_version: v(18.5),
    })
    const s1 = await port.submitDraft(h.actor, 'b2b_quote', d1.draft.id)
    expect(s1).toMatchObject({ staged: true, approver: 'owner' })
    expect(s1.breaches).toEqual(
      expect.arrayContaining(['quote_amount_over_mandate', 'quote_margin_under_mandate']),
    )
    const view = await h.sales.port.view(h.actor)
    expect(view.quotes[0]?.pending).toMatchObject({ version: 1, approver: 'owner' })
    // 在批的那一版也能预览报价单
    const sheet = await h.sales.port.quoteSheet(h.actor, d1.draft.record_id)
    expect(sheet).toMatchObject({
      version: 1,
      incoterm_text: 'FOB Shenzhen, Incoterms® 2020',
      moq: 'The MOQ for the GaN 65W is 500 pcs per model.',
      issues: [],
    })
    const pdf = await h.sales.port.quotePdf(h.actor, d1.draft.record_id)
    expect(Buffer.from(pdf.bytes).subarray(0, 8).toString('latin1')).toBe('%PDF-1.4')
    expect(pdf.filename).toBe('Quotation-Q-20260929-01-V1.pdf')
    // 没批不能发
    await expect(h.sales.port.sendQuote(h.actor, d1.draft.record_id, {})).rejects.toThrow(/还在批/)
    await h.decide(s1.approval_item_id ?? '', 'p_zhou')
    expect(h.store.quoteVersions(d1.draft.record_id).map((x) => x.version)).toEqual([1])
    // 改价 = 新建一版（V2，授权内 → 业务员自己批）；旧版原样
    const d2 = await port.saveDraft(h.actor, 'b2b_quote', {
      record_id: d1.draft.record_id,
      record: {},
      quote_version: { ...v(22), lines: [{ ...line, qty: 1500 }] },
    })
    const s2 = await port.submitDraft(h.actor, 'b2b_quote', d2.draft.id)
    expect(s2).toMatchObject({ staged: true, approver: 'role_holder' })
    await h.decide(s2.approval_item_id ?? '', 'p_he')
    expect(h.store.quoteVersions(d1.draft.record_id).map((x) => x.version)).toEqual([1, 2])
    expect(h.store.quoteVersions(d1.draft.record_id)[0]?.lines[0]?.qty).toBe(3000)
    // 发给客户：也出卡，PDF 附在卡上；批了才发
    const send = await h.sales.port.sendQuote(h.actor, d1.draft.record_id, {})
    expect(send.staged).toBe(true)
    const card = await h.txn.approvals.get(send.approval_item_id ?? '')
    const after = (card?.payload as { after: Record<string, unknown> } | undefined)?.after ?? {}
    expect(after.attachments).toEqual([
      {
        kind: 'quote_pdf',
        quote_id: d1.draft.record_id,
        version: 2,
        filename: 'Quotation-Q-20260929-01-V2.pdf',
      },
    ])
    expect(String(after.body)).not.toMatch(/6\.2|USD/)
    expect(h.sent).toHaveLength(0)
    await h.decide(send.approval_item_id ?? '', 'p_he')
    expect(h.sent[0]?.to).toEqual(['anna@volthaus.example'])
    expect(h.sent[0]?.attachments?.[0]).toMatchObject({
      filename: 'Quotation-Q-20260929-01-V2.pdf',
      content_type: 'application/pdf',
    })
    expect(h.store.get<{ status: string }>('b2b_quote', d1.draft.record_id)?.status).toBe('sent')
  })
})

describe('WP182 样品：一步一步走、已寄必须带单号、寄样通知出卡、超期提醒', () => {
  it('待寄 → 已寄（没单号被拦）→ 批了出寄样通知卡；超期不寄 / 没反馈各提醒一次', async () => {
    const h = assemble({ facts: FACTS })
    h.store.put('b2b_account', account('acc_volthaus', 'p_he', 'EU', 'GaN'))
    const contact_id = seedContact(h, 'acc_volthaus', 'anna@volthaus.example')
    const sample: B2bSample = {
      id: 'smp_1',
      workspace_id: WS as never,
      account_id: 'acc_volthaus',
      contact_id,
      items: [{ sku: 'GaN65', qty: 3 }],
      status: 'to_ship',
      ship_by: '2026-09-25T00:00:00.000Z',
      updated_at: T0,
    }
    h.store.put('b2b_sample', sample as never)
    h.store.put('b2b_sample', {
      ...sample,
      id: 'smp_2',
      status: 'delivered',
      ship_by: '2026-09-01T00:00:00.000Z',
      feedback_by: '2026-09-20T00:00:00.000Z',
    } as never)
    // 跳一步不行
    expect(
      (await h.sales.port.advanceSample(h.actor, 'smp_1', { status: 'delivered' })).message,
    ).toMatch(/一步一步/)
    // 没单号：guardrail 拦
    const bad = await h.sales.port.advanceSample(h.actor, 'smp_1', { status: 'shipped' })
    expect(bad.staged).toBe(false)
    const ok = await h.sales.port.advanceSample(h.actor, 'smp_1', {
      status: 'shipped',
      tracking_no: 'DHL-0001',
      carrier: 'DHL',
    })
    expect(ok.staged).toBe(true)
    await h.decide(ok.approval_item_id ?? '', 'p_he')
    expect(h.store.get<B2bSample>('b2b_sample', 'smp_1')?.status).toBe('shipped')
    const notice = (
      await h.txn.approvals.queue({ workspace_id: WS, person_id: 'p_he' as PersonId, lane: 'mine' })
    ).find((c) => c.title.startsWith('寄样通知'))
    expect(notice?.summary).toContain('DHL-0001')
    // 超期提醒：smp_2 签收后没反馈；同一个截止日只提醒一次
    const first = await h.sales.sweep()
    expect(first.reminders).toBe(1)
    expect((await h.sales.sweep()).reminders).toBe(0)
    const todos = h.work.listTodos({ workspace_id: WS as never })
    expect(todos.map((t) => t.title)).toEqual([expect.stringMatching(/没反馈/)])
    const view = await h.sales.port.view(h.actor)
    expect(view.samples.find((s) => s.id === 'smp_2')).toMatchObject({
      overdue: 'feedback_overdue',
    })
  })
})

describe('WP182 离职交接：按接手的人在管的地区 / 产品线分，出一张卡给老板批', () => {
  it('何佳离开 → 欧洲的给吴敏、其余给兜底；批了才改归属', async () => {
    const h = assemble({
      holders: [
        { person: 'p_wu', role: 'b2b.sales' },
        { person: 'p_li', role: 'b2b.sales' },
      ],
    })
    h.store.put('b2b_account', account('acc_volthaus', 'p_he', 'EU', 'GaN'))
    h.store.put('b2b_account', account('acc_harbor', 'p_he', 'NA', 'TWS'))
    h.store.put('b2b_account', account('acc_berlin', 'p_wu', 'EU', 'Cable'))
    const out = await h.sales.onMemberLeft('p_he' as PersonId, 'p_zhou' as PersonId)
    const card = await h.txn.approvals.get(out.approval_item_id ?? '')
    expect((card?.payload as { kind?: string } | undefined)?.kind).toBe('b2b_account_transfer')
    expect(card?.routing.recipients[0]).toMatchObject({ person: 'p_zhou', via: 'owner' })
    expect(card?.summary).toContain('VOLTHAUS')
    expect(card?.summary).toContain('Wu Min')
    expect(h.store.get<B2bAccount>('b2b_account', 'acc_volthaus')?.owner_person_id).toBe('p_he')
    await h.decide(out.approval_item_id ?? '', 'p_zhou')
    expect(h.store.get<B2bAccount>('b2b_account', 'acc_volthaus')?.owner_person_id).toBe('p_wu')
    // 北美那家没人在管 → 兜底（按 id 排第一个接手的人）
    expect(h.store.get<B2bAccount>('b2b_account', 'acc_harbor')?.owner_person_id).toBe('p_li')
    // 名下什么都没有的人离开：不出卡
    expect(await h.sales.onMemberLeft('p_nobody' as PersonId, 'p_zhou' as PersonId)).toEqual({})
  })
})

describe('WP182 报价单信头取品牌设计的色与字', () => {
  it('primary 那一格优先；没有就取第一个不是黑白灰的；字体取标题那一格', () => {
    expect(
      b2bLetterheadOf({
        colors: { ink: { value: '#111111' }, primary: { value: '#0F766E' } },
        typography: {
          body: { value: { fontFamily: 'Inter' } },
          heading: { value: { fontFamily: 'Playfair Display' } },
        },
      }),
    ).toEqual({ color: '#0f766e', font_family: 'Playfair Display' })
    expect(
      b2bLetterheadOf({ colors: { a: { value: '#ffffff' }, b: { value: '#e11d48' } } }),
    ).toEqual({ color: '#e11d48' })
    expect(b2bLetterheadOf(undefined)).toEqual({})
  })
})
