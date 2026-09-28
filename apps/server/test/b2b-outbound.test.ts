/**
 * WP173（docs/84 §2 / §11.1）：开发信序列的服务端。
 *
 * 钉住的事：
 *
 * 1. 第一次开 → 「发信域名」选择卡（单独域名在前、主域名带风险提示），**不问不设**；
 * 2. 选了 → 体检（DNS 替身 + 给自己发测试信）→ DKIM 等测试信收回来 → 过了才出卡；
 * 3. **首封批量一张卡**（L1），超了今天配额的排到明天；德奥没往来的默认不放进来、卡上写原因；
 * 4. 批了才发：页脚（公司地址 + 退订）、`List-Unsubscribe`、`noteOutbound`、下一封 +3 天；
 * 5. 公司地址没填 / SPF 没过：不出卡、原因写在序列上；
 * 6. 回信：有意向转业务、不感兴趣进名单、自动回复顺延；驳回的卡那一批停下；跟进到点出卡。
 */
import type {
  B2bAccount,
  B2bContact,
  EffectiveConfig,
  EventEnvelope,
  MessageRecord,
} from '@agentsws/contracts'
import { createTxn } from '@agentsws/txn'
import { describe, expect, it } from 'vitest'
import { createB2bOutbound } from '../src/b2b-outbound.js'
import { addressHash, createB2bStore } from '../src/b2b-store.js'
import type { DirectMailInput } from '../src/channels.js'

const T0 = '2026-09-28T02:00:00.000Z'
const WS = 'ws_b2b'
const LEO = {
  workspace_id: WS,
  person_id: 'p_leo',
  assignment_id: 'asg_outbound',
  role_id: 'b2b.outbound',
}
const SEPARATE = 'leo@trybrand.example'
const PRIMARY = 'hello@zhilian.example'

function seeded(seed = 7): () => number {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
}

const config = (cap = 2): EffectiveConfig =>
  ({
    actions: [
      {
        id: 'stage_b2b_outreach',
        mandate: {
          caps: { max_outreach_per_day: cap, max_outreach_per_day_warmed: 50, warmup_days: 14 },
          window: { max_count: 20, per: 'day' },
        },
        route_to: 'role_holder',
      },
    ],
    automation: {},
  }) as unknown as EffectiveConfig

interface Prospect {
  id: string
  company: string
  country: string
  email: string
  stage?: B2bAccount['stage']
}

const PROSPECTS: Prospect[] = [
  { id: 'volt', company: 'Volthaus', country: 'US', email: 'anna@volthaus.example' },
  { id: 'peak', company: 'Peak Gadgets', country: 'GB', email: 'mia@peak.example' },
  { id: 'nord', company: 'Nordlicht', country: 'DE', email: 'jan@nordlicht.example' },
  { id: 'maple', company: 'Maple Mobile', country: 'AU', email: 'sam@maple.example' },
]

function setup(
  opts: {
    cap?: number
    address?: string
    spf?: string[]
    model?: (prompt: string) => string
    /** WP176：DKIM 选择器那几条 TXT（`<sel>._domainkey.<域名>` → 记录）。 */
    dkimTxt?: Record<string, string[]>
    /** WP176：公司档案（给了就装配 companyAddress / saveCompanyAddress）。 */
    profile?: { address?: string; exists?: boolean }
    cooldownDays?: number
    /** WP176：云端检查地址（给了测试信就发到那里；`header` = 云端读到的信头）。 */
    cloud?: { header?: string }
  } = {},
) {
  let now = T0
  const clock = { now: () => now, sleep: async () => undefined }
  const events: EventEnvelope[] = []
  const secrets = new Map<string, Record<string, string>>()
  const sent: DirectMailInput[] = []
  const store = createB2bStore({ workspace_id: WS, now: clock.now })
  for (const p of PROSPECTS) {
    store.put('b2b_account', {
      id: `acc_${p.id}`,
      workspace_id: WS,
      name: p.company,
      country: p.country,
      product_lines: [],
      stage: p.stage ?? 'contacted',
      source: { kind: 'import', observed_at: T0 },
      created_at: T0,
      updated_at: T0,
    } satisfies B2bAccount)
    const ref = `b2b.contact.ctc_${p.id}.email`
    secrets.set(ref, { value: p.email })
    store.put('b2b_contact', {
      id: `ctc_${p.id}`,
      workspace_id: WS,
      account_id: `acc_${p.id}`,
      name: `${p.email.split('@')[0]} Lee`,
      email_ref: ref,
      email_key_hash: addressHash(p.email),
      source: { kind: 'website', url: `https://${p.email.split('@')[1]}/contact`, observed_at: T0 },
      created_at: T0,
    } as B2bContact & Record<string, unknown>)
  }
  if (opts.address !== undefined)
    store.saveOutboundSettings({ postal_address: opts.address, sender_name: 'Leo' })
  let outbound: ReturnType<typeof createB2bOutbound> | undefined
  const txn = createTxn({
    clock,
    random: seeded(),
    eventSink: (e) => events.push(e),
    readRecord: () => ({}),
    policy: { cancel_window_sec: 0 },
    backendApply: async (change) =>
      (await outbound?.apply(change)) ?? { status: 'ok', execution_id: 'exec_other' },
    deliverOutbound: () => ({ status: 'ok', execution_id: 'exec_1' }),
  })
  let n = 0
  const timers: (() => void)[] = []
  const profile = opts.profile
  outbound = createB2bOutbound({
    workspace_id: WS,
    store,
    clock,
    random: seeded(3),
    timeZone: () => '+08:00',
    ledger: txn.ledger,
    approvals: txn.approvals,
    effectiveConfig: () => config(opts.cap),
    appendEvent: (e) => events.push(e as EventEnvelope),
    secrets: { get: (id) => secrets.get(id) },
    mailboxes: () => [PRIMARY, SEPARATE],
    primaryDomains: () => ['zhilian.example'],
    companyName: () => 'Zhilian 3C Co., Ltd.',
    sendMail: async (input) => {
      sent.push(input)
      n += 1
      return {
        ok: true,
        outbox_id: `ob_${n}`,
        message_id: `<m${n}@trybrand.example>`,
        account: input.account ?? '',
      }
    },
    dns: {
      txt: async (name) =>
        name.includes('._domainkey.')
          ? (opts.dkimTxt?.[name] ?? [])
          : name.startsWith('_dmarc.')
            ? []
            : (opts.spf ?? ['v=spf1 include:_spf.mx.example ~all']),
    },
    later: (fn) => {
      timers.push(fn)
    },
    ...(opts.cloud === undefined
      ? {}
      : {
          cloudAuthCheck: {
            address: () => 'probe@check.example',
            result: async () => opts.cloud?.header,
          },
        }),
    ...(opts.cooldownDays === undefined ? {} : { declinedCooldownDays: () => opts.cooldownDays }),
    ...(profile === undefined
      ? {}
      : {
          companyAddress: () => profile.address,
          saveCompanyAddress: (address: string | undefined) => {
            if (profile.exists === false) return false
            if (address === undefined) delete profile.address
            else profile.address = address
            return true
          },
        }),
    outboundHolder: () => ({
      person_id: 'p_leo',
      assignment_id: 'asg_outbound',
      role_id: 'b2b.outbound',
    }),
    ...(opts.model === undefined
      ? {}
      : {
          drafter:
            () =>
            async ({ prompt }: { prompt: string }) => ({
              text: (opts.model as (p: string) => string)(prompt),
            }),
          coldEmailSkill: () => '## cold-email（测试用正文）',
        }),
  })
  const decide = async (id: string, input: { action: 'approve' | 'reject'; option?: string }) => {
    const card = await txn.approvals.get(id)
    const token = card?.deliveries.find((d) => d.to === 'p_leo')?.decision_token ?? ''
    // 选择题照工作台那一路：approve_edited + edited_payload.selected_option_id（deck/decide.ts）
    return txn.approvals.decide(id, 'p_leo', {
      action: input.option === undefined ? input.action : 'approve_edited',
      decision_token: token,
      via: 'workstation',
      ...(input.action === 'reject' ? { reason: '这一批先不发' } : {}),
      ...(input.option === undefined
        ? {}
        : { edited_payload: { ...(card?.payload as object), selected_option_id: input.option } }),
    })
  }
  const mail = (patch: Partial<MessageRecord>): MessageRecord =>
    ({
      id: `msg_${Math.floor(Math.random() * 1e9)}`,
      workspace_id: WS,
      source: 'imap',
      account: SEPARATE,
      folder: 'INBOX',
      folder_kind: 'inbox',
      thread_id: 't1',
      references: [],
      headers: {},
      from: { email: SEPARATE },
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      snippet: '',
      text: '',
      has_remote_images: false,
      attachments: [],
      date: now,
      received_at: now,
      flags: { seen: false, flagged: false, answered: false },
      labels: [],
      route: 'inbox',
      ...patch,
    }) as MessageRecord
  const port = outbound.port
  return {
    store,
    txn,
    events,
    sent,
    outbound,
    port,
    decide,
    mail,
    timers,
    setNow: (t: string) => {
      now = t
    },
  }
}

/** 选单独域名 → 体检 → 测试信收回来（DKIM 签的是自己的域名）。 */
async function chooseAndPass(h: ReturnType<typeof setup>, cardId: string) {
  const item = await h.decide(cardId, { action: 'approve', option: `separate:${SEPARATE}` })
  await h.outbound.onSenderChosen(item)
  const test = h.sent.find((m) => m.subject.includes('体检'))
  expect(test?.to).toEqual([SEPARATE])
  h.outbound.observe(
    h.mail({
      message_id: '<m1@trybrand.example>',
      headers: {
        'authentication-results': `mx.example; dkim=pass header.d=trybrand.example; spf=pass smtp.mailfrom=${SEPARATE}`,
      },
    }),
  )
  // advanceLater 是异步的：让它跑完
  await new Promise((r) => setTimeout(r, 20))
}

describe('开发信序列（服务端）', () => {
  it('第一次开 → 发信域名选择卡（不问不设）；德国潜在客户默认不放进来、写明原因', async () => {
    const h = setup({ address: '8 Keji Rd, Shenzhen, China' })
    const out = await h.port.start(LEO, { product: 'GaN chargers' })
    expect(out.status).toBe('queued')
    expect(out.queued_reason).toBe('sender_choice')
    expect(out.excluded).toEqual([
      expect.objectContaining({ contact_id: 'ctc_nord', reason: 'de_at' }),
    ])
    expect(out.excluded[0]?.label).toContain('两国法院常把未经同意的 B2B 冷邮件判为违法')
    const card = await h.txn.approvals.get(out.approval_item_id ?? '')
    expect(card?.kind).toBe('b2b_sender_choice')
    expect(card?.options?.map((o) => o.id)).toEqual([`separate:${SEPARATE}`, `primary:${PRIMARY}`])
    expect(card?.summary).toContain('强烈建议')
    // 没答之前：一个发信邮箱都没设，一封都没发
    expect(h.store.outboundSettings().sender_address).toBeUndefined()
    expect(h.sent).toHaveLength(0)
    const view = await h.port.view(LEO)
    expect(view.needs).toContain('sender_choice')
    expect(view.queued.sender_choice).toBe(3)
  })

  it('选单独域名 → 体检 → DKIM 等测试信 → 过了才出一张批量首封卡（超配额的排明天）', async () => {
    const h = setup({ address: '8 Keji Rd, Shenzhen, China' })
    const first = await h.port.start(LEO, { product: 'GaN chargers' })
    const item = await h.decide(first.approval_item_id ?? '', {
      action: 'approve',
      option: `separate:${SEPARATE}`,
    })
    await h.outbound.onSenderChosen(item)
    let view = await h.port.view(LEO)
    expect(view.sender).toMatchObject({ address: SEPARATE, separate_domain: true })
    expect(view.sender?.auth).toMatchObject({ spf: 'pass', dkim: 'pending', dmarc: 'missing' })
    expect(view.needs).toEqual(['sender_auth'])
    expect(h.store.enrollments().every((e) => e.status === 'queued')).toBe(true)

    h.outbound.observe(
      h.mail({
        message_id: '<m1@trybrand.example>',
        headers: { 'authentication-results': 'mx; dkim=pass header.d=trybrand.example; spf=pass' },
      }),
    )
    await new Promise((r) => setTimeout(r, 20))
    view = await h.port.view(LEO)
    expect(view.sender?.auth.dkim).toBe('pass')
    const waiting = h.store.enrollments().filter((e) => e.status === 'awaiting_approval')
    const queued = h.store.enrollments().filter((e) => e.status === 'queued')
    expect(waiting).toHaveLength(2)
    expect(queued.map((e) => e.queued_reason)).toEqual(['quota'])
    const card = await h.txn.approvals.get(waiting[0]?.pending_approval_id ?? '')
    expect(card?.title).toBe('开发信 · 第一轮首封 · 2 封')
    expect(card?.automation.level_at_creation).toBe('L1')
    expect(card?.automation.auto_approved).toBe(false)
    expect(card?.summary).toContain('排到明天')
    expect(card?.summary).toContain('8 Keji Rd')
    expect(view.sender?.quota).toMatchObject({ cap: 2, reserved: 2, remaining: 0, warming: true })
  })

  it('批了才发：页脚 + 退订头 + noteOutbound；下一封 +3 天；预热从第一封算', async () => {
    const h = setup({ address: '8 Keji Rd, Shenzhen, China' })
    const first = await h.port.start(LEO, { product: 'GaN chargers' })
    await chooseAndPass(h, first.approval_item_id ?? '')
    const e = h.store.enrollments().find((x) => x.status === 'awaiting_approval')
    const id = e?.pending_approval_id ?? ''
    await h.decide(id, { action: 'approve' })
    const res = await h.txn.executor.applyApproval(id)
    expect(res.state).toBe('applied')
    const outreach = h.sent.filter((m) => !m.subject.includes('体检'))
    expect(outreach).toHaveLength(2)
    expect(outreach[0]?.account).toBe(SEPARATE)
    // 库里按 id 排：Maple 在前
    expect(outreach[0]?.to).toEqual(['sam@maple.example'])
    expect(outreach[0]?.subject).toBe('GaN chargers for Maple Mobile')
    expect(outreach[0]?.text).toContain('8 Keji Rd, Shenzhen, China')
    expect(outreach[0]?.text).toContain('Reply "unsubscribe"')
    expect(outreach[0]?.headers?.['List-Unsubscribe']).toBe(
      `<mailto:${SEPARATE}?subject=unsubscribe>`,
    )
    const note = h.store.outboundMatch([outreach.length > 0 ? '<m2@trybrand.example>' : ''])
    expect(note).toMatchObject({ kind: 'outreach', contact_id: 'ctc_maple', step: 'first' })
    const active = h.store.enrollments().filter((x) => x.status === 'active')
    expect(active).toHaveLength(2)
    expect(active[0]?.next_step).toBe('follow_up')
    expect(active[0]?.due_at).toBe('2026-10-01T02:00:00.000Z')
    expect(h.store.sender(SEPARATE)?.first_sent_at).toBe(T0)
  })

  it('公司地址没填 / SPF 没过：不出卡，原因写在序列上', async () => {
    const noAddr = setup()
    const a = await noAddr.port.start(LEO, {})
    await chooseAndPass(noAddr, a.approval_item_id ?? '')
    expect(noAddr.store.enrollments().map((e) => e.queued_reason)).toEqual([
      'company_address',
      'company_address',
      'company_address',
    ])
    const badSpf = setup({ address: 'X Rd', spf: [] })
    const b = await badSpf.port.start(LEO, {})
    await chooseAndPass(badSpf, b.approval_item_id ?? '')
    const view = await badSpf.port.view(LEO)
    expect(view.sender?.auth.spf).toBe('missing')
    expect(view.needs).toEqual(['sender_auth'])
    expect(badSpf.store.enrollments().every((e) => e.queued_reason === 'sender_auth')).toBe(true)
    expect(badSpf.sent.filter((m) => !m.subject.includes('体检'))).toHaveLength(0)
  })

  it('回信：有意向转业务、不感兴趣进冷却（WP176：不进名单）、自动回复顺延', async () => {
    const h = setup({ address: 'X Rd', cap: 3 })
    const first = await h.port.start(LEO, {})
    await chooseAndPass(h, first.approval_item_id ?? '')
    const id =
      h.store.enrollments().find((x) => x.status === 'awaiting_approval')?.pending_approval_id ?? ''
    await h.decide(id, { action: 'approve' })
    await h.txn.executor.applyApproval(id)
    const [volt, peak, maple] = ['ctc_volt', 'ctc_peak', 'ctc_maple'].map(
      (c) => h.store.enrollments().find((e) => e.contact_id === c)?.id ?? '',
    )
    const r1 = h.outbound.onReply({
      record: h.mail({
        from: { email: 'anna@volthaus.example' },
        subject: 'Re: x',
        text: 'Sounds good, please send the catalog.',
      }),
      note: { message_id: 'm', kind: 'outreach', contact_id: 'ctc_volt', enrollment_id: volt },
    })
    expect(r1).toMatchObject({ action: 'hand_to_sales' })
    expect(h.store.enrollment(volt)?.status).toBe('handed_to_sales')
    const r2 = h.outbound.onReply({
      record: h.mail({ from: { email: 'mia@peak.example' }, subject: 'Re: x', text: 'No thanks.' }),
      note: { message_id: 'm', kind: 'outreach', contact_id: 'ctc_peak', enrollment_id: peak },
    })
    expect(r2).toMatchObject({ klass: 'not_interested', action: 'cooldown' })
    expect(h.store.enrollment(peak)?.status).toBe('stopped')
    expect(h.store.isSuppressed('mia@peak.example')).toBe(false)
    expect(h.store.cooldown(addressHash('mia@peak.example'))).toMatchObject({ count: 1, days: 90 })
    h.outbound.onReply({
      record: h.mail({
        from: { email: 'sam@maple.example' },
        subject: 'Automatic reply: x',
        text: 'I am out of the office until October 12.',
      }),
      note: { message_id: 'm', kind: 'outreach', contact_id: 'ctc_maple', enrollment_id: maple },
    })
    expect(h.store.enrollment(maple)).toMatchObject({
      status: 'active',
      due_at: '2026-10-13T00:00:00.000Z',
    })
  })

  it('第二天：排着的首封出新卡；第 3 天跟进到点出卡；驳回的卡那一批停下', async () => {
    const h = setup({ address: 'X Rd' })
    const first = await h.port.start(LEO, {})
    await chooseAndPass(h, first.approval_item_id ?? '')
    const id =
      h.store.enrollments().find((x) => x.status === 'awaiting_approval')?.pending_approval_id ?? ''
    await h.decide(id, { action: 'approve' })
    await h.txn.executor.applyApproval(id)
    h.setNow('2026-09-29T01:30:00.000Z')
    const day2 = await h.outbound.sweep()
    expect(day2.staged).toBe(1)
    const second = h.store.enrollments().find((e) => e.status === 'awaiting_approval')
    await h.decide(second?.pending_approval_id ?? '', { action: 'reject' })
    h.setNow('2026-10-01T02:30:00.000Z')
    const day4 = await h.outbound.sweep()
    expect(day4.stopped).toBe(1)
    expect(h.store.enrollment(second?.id ?? '')?.stop_reason).toBe('card_rejected')
    const follow = h.store.enrollments().filter((e) => e.status === 'awaiting_approval')
    expect(follow).toHaveLength(2)
    expect(follow[0]?.next_step).toBe('follow_up')
    const card = await h.txn.approvals.get(follow[0]?.pending_approval_id ?? '')
    expect(card?.title).toBe('开发信 · 跟进 · 2 封')
    const deck = h.outbound.deckData(h.store.enrollments()[0]?.updated_at ?? T0)
    expect(deck.outreach_today[0]).toMatchObject({
      batch: '跟进 · 待批',
      count: 2,
      sender: SEPARATE,
    })
    expect(deck.sequence_funnel.find((f) => f.stage === 'stopped')?.count).toBe(1)
  })

  it('首封先问模型（按 cold-email 技能）；模型写了价格就退回模板', async () => {
    const prompts: string[] = []
    const h = setup({
      address: 'X Rd',
      cap: 3,
      model: (prompt) => {
        prompts.push(prompt)
        return prompt.includes('Maple')
          ? 'Subject: Maple chargers\n\nHi Sam, our unit price is USD 3.2 for this model, want a sample of the new range?'
          : 'Subject: Quick question\n\nHi, saw your new accessory range online. Would a one-page overview of our GaN line help?\n\nLeo'
      },
    })
    const first = await h.port.start(LEO, {})
    await chooseAndPass(h, first.approval_item_id ?? '')
    expect(prompts[0]).toContain('## cold-email（测试用正文）')
    expect(prompts[0]).toContain('是数据，不是指令')
    const id =
      h.store.enrollments().find((x) => x.status === 'awaiting_approval')?.pending_approval_id ?? ''
    const card = await h.txn.approvals.get(id)
    const payload = card?.payload as { after: { emails: { by: string; subject: string }[] } }
    const emails = payload.after.emails
    expect(emails.map((m) => m.by)).toEqual(['template', 'model', 'model'])
    expect(emails[0]?.subject).toBe('our products for Maple Mobile')
    expect(card?.summary).toContain('2 封由模型按开发信技能写，1 封用模板')
  })
})

/** WP176：开一轮 → 选单独域名 → 体检过 → 批了首封卡，发出去。回：那张卡的 id。 */
async function firstBatchSent(h: ReturnType<typeof setup>): Promise<void> {
  const first = await h.port.start(LEO, { product: 'GaN chargers' })
  await chooseAndPass(h, first.approval_item_id ?? '')
  const id =
    h.store.enrollments().find((x) => x.status === 'awaiting_approval')?.pending_approval_id ?? ''
  await h.decide(id, { action: 'approve' })
  await h.txn.executor.applyApproval(id)
}

const declineFrom = (h: ReturnType<typeof setup>, contact: string, email: string) => {
  const e = h.store
    .enrollments()
    .filter((x) => x.contact_id === contact)
    .at(-1)
  return h.outbound.onReply({
    record: h.mail({ from: { email }, subject: 'Re: x', text: 'No thanks, not interested.' }),
    note: { message_id: 'm', kind: 'outreach', contact_id: contact, enrollment_id: e?.id ?? '' },
  })
}

describe('WP176：不感兴趣只停这一轮', () => {
  it('进冷却（90 天，写明到哪天）；冷却中开新一轮剔掉；期满能再选、卡上点名；第二次翻倍；退订仍永久', async () => {
    const h = setup({ address: 'X Rd', cap: 3 })
    await firstBatchSent(h)
    expect(declineFrom(h, 'ctc_peak', 'mia@peak.example').action).toBe('cooldown')
    expect(h.store.isSuppressed('mia@peak.example')).toBe(false)
    const view = await h.port.view(LEO)
    expect(view.cooling).toEqual([
      expect.objectContaining({
        contact_id: 'ctc_peak',
        company: 'Peak Gadgets',
        until: '2026-12-27T02:00:00.000Z',
        count: 1,
      }),
    ])
    // 冷却中：点名开也开不进来，原因写明到哪天
    h.setNow('2026-10-20T02:00:00.000Z')
    const during = await h.port.start(LEO, { contact_ids: ['ctc_peak'] })
    expect(during.status).toBe('nothing_to_send')
    expect(during.excluded[0]).toMatchObject({ reason: 'cooldown' })
    expect(during.excluded[0]?.label).toContain('2026-12-27')
    // 退订的另一位：永久
    h.outbound.onReply({
      record: h.mail({
        from: { email: 'sam@maple.example' },
        subject: 'Re: x',
        text: 'unsubscribe',
      }),
      note: { message_id: 'm', kind: 'outreach', contact_id: 'ctc_maple' },
    })
    expect(h.store.isSuppressed('sam@maple.example')).toBe(true)
    // 期满：能再选进新一轮，卡上点名"以前说过不感兴趣"
    h.setNow('2026-12-28T02:00:00.000Z')
    const again = await h.port.start(LEO, { contact_ids: ['ctc_peak', 'ctc_maple'] })
    expect(again.excluded.map((x) => x.reason)).toEqual(['suppressed'])
    expect(again.status).toBe('staged')
    const card = await h.txn.approvals.get(again.approval_item_id ?? '')
    expect(card?.summary).toContain('以前说过不感兴趣、冷却期已满又选进来的 1 位')
    // 第二次说不感兴趣：冷却翻倍（180 天），卡上下次提醒"说过 2 次"
    await h.decide(again.approval_item_id ?? '', { action: 'approve' })
    await h.txn.executor.applyApproval(again.approval_item_id ?? '')
    declineFrom(h, 'ctc_peak', 'mia@peak.example')
    expect(h.store.cooldown(addressHash('mia@peak.example'))).toMatchObject({
      count: 2,
      days: 180,
      until: '2027-06-26T02:00:00.000Z',
    })
    expect(h.events.some((e) => e.type === 'b2b.cooldown_started')).toBe(true)
  })

  it('冷却天数按职责阈值；老数据里「不感兴趣」进了名单的，迁移成冷却', async () => {
    const h = setup({ address: 'X Rd', cap: 3, cooldownDays: 30 })
    await firstBatchSent(h)
    declineFrom(h, 'ctc_peak', 'mia@peak.example')
    expect(h.store.cooldown(addressHash('mia@peak.example'))?.days).toBe(30)

    const { openSqliteDriver, migrateSync } = await import('@agentsws/core/sql')
    const { B2B_MIGRATIONS } = await import('../src/b2b-store.js')
    const driver = openSqliteDriver({ path: ':memory:' })
    migrateSync(driver, B2B_MIGRATIONS.slice(0, 3), T0)
    const put = driver.prepareSync(
      'INSERT INTO b2b_suppression (workspace_id, key_hash, at, body) VALUES (?, ?, ?, ?)',
    )
    put.runSync(
      WS,
      'h_declined',
      T0,
      JSON.stringify({
        key_hash: 'h_declined',
        masked: 'a***@x.com',
        reason: 'declined',
        contact_id: 'ctc_x',
        at: T0,
      }),
    )
    put.runSync(
      WS,
      'h_unsub',
      T0,
      JSON.stringify({ key_hash: 'h_unsub', masked: 'b***@x.com', reason: 'unsubscribe', at: T0 }),
    )
    migrateSync(driver, B2B_MIGRATIONS, T0)
    const left = driver
      .prepareSync<{ key_hash: string }>('SELECT key_hash FROM b2b_suppression')
      .allSync()
      .map((r) => r.key_hash)
    expect(left).toEqual(['h_unsub'])
    const moved = driver
      .prepareSync<{ body: string }>('SELECT body FROM b2b_cooldown')
      .allSync()
      .map((r) => JSON.parse(r.body) as Record<string, unknown>)
    expect(moved).toEqual([
      {
        key_hash: 'h_declined',
        masked: 'a***@x.com',
        count: 1,
        days: 90,
        declined_at: T0,
        until: '2026-12-27T02:00:00.000Z',
        contact_id: 'ctc_x',
      },
    ])
    driver.closeSync()
  })
})

describe('WP176：公司地址进档案、老邮箱免预热、跟进也由模型写', () => {
  it('旧设置里的地址搬进公司档案（搬完只读显示）；档案没建搬不成就照旧读；PUT 设置写进档案', async () => {
    const profile: { address?: string } = {}
    const h = setup({ address: '8 Keji Rd, Shenzhen', profile })
    const view = await h.port.view(LEO)
    expect(profile.address).toBe('8 Keji Rd, Shenzhen')
    expect(view.settings).toMatchObject({
      postal_address: '8 Keji Rd, Shenzhen',
      postal_address_from: 'profile',
    })
    expect(h.store.outboundSettings().postal_address).toBeUndefined()
    expect(h.store.outboundSettings().postal_address_moved_at).toBe(T0)
    await h.port.saveSettings(LEO, { postal_address: '9 New Rd' })
    expect(profile.address).toBe('9 New Rd')
    // 档案还没建：搬不成，照旧从这一格读
    const noProfile = setup({ address: 'Old Rd', profile: { exists: false } })
    const v2 = await noProfile.port.view(LEO)
    expect(v2.settings).toMatchObject({
      postal_address: 'Old Rd',
      postal_address_from: 'outbound_settings',
    })
    // 档案里清空了地址：不能发（不会从旧设置里"复活"）
    const cleared = setup({ address: 'Old Rd', profile: { address: 'Profile Rd' } })
    await cleared.port.view(LEO)
    await cleared.port.saveSettings(LEO, { postal_address: '' })
    expect((await cleared.port.view(LEO)).needs).toContain('company_address')
  })

  it('勾了「这只邮箱已经正常发信很久」：直接 50 封、不预热，卡上一句提醒', async () => {
    const h = setup({ address: 'X Rd', cap: 2 })
    const first = await h.port.start(LEO, {})
    // 先勾（选邮箱之前勾不上：还没有发信邮箱）
    const item = await h.decide(first.approval_item_id ?? '', {
      action: 'approve',
      option: `separate:${SEPARATE}`,
    })
    await h.outbound.onSenderChosen(item)
    const v = await h.port.saveSettings(LEO, { sender_established: true })
    expect(v.sender).toMatchObject({ established: true })
    expect(v.sender?.quota).toMatchObject({ cap: 50, warming: false })
    h.outbound.observe(
      h.mail({
        message_id: '<m1@trybrand.example>',
        headers: { 'authentication-results': 'mx; dkim=pass header.d=trybrand.example; spf=pass' },
      }),
    )
    await new Promise((r) => setTimeout(r, 20))
    const waiting = h.store.enrollments().filter((e) => e.status === 'awaiting_approval')
    expect(waiting).toHaveLength(3)
    const card = await h.txn.approvals.get(waiting[0]?.pending_approval_id ?? '')
    expect(card?.summary).toContain('已经正常发信很久')
    const off = await h.port.saveSettings(LEO, { sender_established: false })
    expect(off.sender?.established).toBe(false)
  })

  it('跟进与收尾也先问模型；主题用系统那一个（Re: 首封主题）；写了价格退回模板', async () => {
    const prompts: string[] = []
    const h = setup({
      address: 'X Rd',
      cap: 3,
      model: (prompt) => {
        prompts.push(prompt)
        if (prompt.includes('收尾'))
          return 'Subject: bye\n\nHi, the price is USD 2 per unit if you change your mind.\n\nLeo'
        return 'Subject: Quick one\n\nHi, saw your new accessory range online. Would a one-page overview of our GaN line help?\n\nLeo'
      },
    })
    await firstBatchSent(h)
    h.setNow('2026-10-01T02:30:00.000Z')
    await h.outbound.sweep()
    const follow = h.store
      .enrollments()
      .find((e) => e.next_step === 'follow_up' && e.status === 'awaiting_approval')
    expect(prompts.some((p) => p.includes('跟进'))).toBe(true)
    const card = await h.txn.approvals.get(follow?.pending_approval_id ?? '')
    type Batch = { after: { emails: { by: string; subject: string; body: string }[] } }
    const emails = (card?.payload as Batch | undefined)?.after.emails ?? []
    expect(emails.length).toBeGreaterThan(0)
    expect(emails.every((m) => m.by === 'model')).toBe(true)
    expect(emails.every((m) => m.subject.startsWith('Re: '))).toBe(true)
    await h.decide(follow?.pending_approval_id ?? '', { action: 'approve' })
    await h.txn.executor.applyApproval(follow?.pending_approval_id ?? '')
    h.setNow('2026-10-05T02:30:00.000Z')
    // 满一周，体检重查一次（测试信又发了一封）：收回来之后再巡检一拍，收尾那一批出卡
    await h.outbound.sweep()
    const n = h.sent.map((m) => m.subject.includes('体检')).lastIndexOf(true) + 1
    h.outbound.observe(
      h.mail({
        message_id: `<m${n}@trybrand.example>`,
        headers: { 'authentication-results': 'mx; dkim=pass header.d=trybrand.example; spf=pass' },
      }),
    )
    await h.outbound.sweep()
    const fin = h.store
      .enrollments()
      .find((e) => e.next_step === 'final' && e.status === 'awaiting_approval')
    const finCard = await h.txn.approvals.get(fin?.pending_approval_id ?? '')
    const finEmails = (finCard?.payload as Batch | undefined)?.after.emails ?? []
    expect(finEmails.length).toBeGreaterThan(0)
    expect(finEmails.every((m) => m.by === 'template')).toBe(true)
    expect(finEmails[0]?.body).toContain("won't follow up again")
  })
})

describe('WP176：DKIM 检查不卡在 Gmail', () => {
  const KEY = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA'

  it('测试信 10 分钟没收回来 → 按常见选择器查 DNS，查到公钥就算「DNS 已配置（未经实信验证）」并出卡', async () => {
    const h = setup({
      address: 'X Rd',
      dkimTxt: { 'selector1._domainkey.trybrand.example': [KEY] },
    })
    const first = await h.port.start(LEO, {})
    const item = await h.decide(first.approval_item_id ?? '', {
      action: 'approve',
      option: `separate:${SEPARATE}`,
    })
    await h.outbound.onSenderChosen(item)
    expect(h.timers).toHaveLength(1)
    // 9 分钟：还在等
    h.setNow('2026-09-28T02:09:00.000Z')
    expect((await h.port.view(LEO)).sender?.auth.dkim).toBe('pending')
    // 11 分钟：定时那一拍到点
    h.setNow('2026-09-28T02:11:00.000Z')
    h.timers[0]?.()
    await new Promise((r) => setTimeout(r, 30))
    const view = await h.port.view(LEO)
    expect(view.sender?.auth).toMatchObject({
      dkim: 'pass',
      dkim_via: 'dns',
      dkim_selector: 'selector1',
    })
    expect(view.sender?.auth.notes.join(' ')).toContain('未经实信验证')
    const waiting = h.store.enrollments().filter((e) => e.status === 'awaiting_approval')
    expect(waiting.length).toBeGreaterThan(0)
    const card = await h.txn.approvals.get(waiting[0]?.pending_approval_id ?? '')
    expect(card?.summary).toContain('DKIM 按 DNS 记录判的（selector1）')
    // 测试信后来真收回来了：以实信为准
    h.outbound.observe(
      h.mail({
        message_id: '<m1@trybrand.example>',
        headers: { 'authentication-results': 'mx; dkim=pass header.d=trybrand.example; spf=pass' },
      }),
    )
    expect(h.store.sender(SEPARATE)?.auth).toMatchObject({ dkim: 'pass', dkim_via: 'test_mail' })
    expect(h.store.sender(SEPARATE)?.auth.dkim_selector).toBeUndefined()
  })

  it('DNS 里也查不到：仍不发；接了云端检查地址就先问它要信头', async () => {
    const h = setup({ address: 'X Rd' })
    const first = await h.port.start(LEO, {})
    const item = await h.decide(first.approval_item_id ?? '', {
      action: 'approve',
      option: `separate:${SEPARATE}`,
    })
    await h.outbound.onSenderChosen(item)
    h.setNow('2026-09-28T02:15:00.000Z')
    const view = await h.port.view(LEO)
    expect(view.sender?.auth.dkim).toBe('missing')
    expect(view.needs).toContain('sender_auth')
    expect(h.store.enrollments().every((e) => e.status === 'queued')).toBe(true)

    const c = setup({
      address: 'X Rd',
      cloud: { header: 'check.example; dkim=pass header.d=trybrand.example; spf=pass' },
    })
    const f2 = await c.port.start(LEO, {})
    const i2 = await c.decide(f2.approval_item_id ?? '', {
      action: 'approve',
      option: `separate:${SEPARATE}`,
    })
    await c.outbound.onSenderChosen(i2)
    expect(c.sent.find((m) => m.subject.includes('体检'))?.to).toEqual(['probe@check.example'])
    c.setNow('2026-09-28T02:15:00.000Z')
    expect((await c.port.view(LEO)).sender?.auth).toMatchObject({
      dkim: 'pass',
      dkim_via: 'test_mail',
    })
  })
})

describe('WP176：Run 里工具用的两个只读口', () => {
  it('序列一览每人一行；回信分类只判不改', async () => {
    const h = setup({ address: 'X Rd', cap: 3 })
    await firstBatchSent(h)
    const rows = (await h.port.sequences?.(LEO))?.rows ?? []
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ status: 'active', last_step: 'first', next_step: 'follow_up' })
    const cls = await h.port.classifyReply?.(LEO, {
      subject: 'Re: GaN chargers',
      text: 'Could you send me your price list?',
    })
    expect(cls).toMatchObject({ class: 'asks_price', action: 'hand_to_sales' })
    expect(cls?.action_label).toContain('交给业务')
    const no = await h.port.classifyReply?.(LEO, { subject: 'Re: x', text: 'Not interested.' })
    expect(no).toMatchObject({ class: 'not_interested', action: 'cooldown' })
    // 只判：序列没动
    expect(h.store.enrollments().every((e) => e.status === 'active')).toBe(true)
    await expect(h.port.classifyReply?.(LEO, {})).rejects.toThrow('没有信可分')
  })
})
