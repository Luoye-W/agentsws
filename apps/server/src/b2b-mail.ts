/**
 * WP172（docs/84 §5）：**邮件分拣之后 B2B 这一路**——消息同步判成 `b2b` 的信交到这里。
 *
 * 入口只有一个（WP167：收信只走消息同步），这个文件不收信、不挪信，只做三件事：
 *
 * 1. **分拣要问的两句话**：这封信回的是不是我们发出去的 B2B 信（{@link B2bMail.isOurThread}），
 *    发件人在不在 B2B 客户 / 联系人库里（{@link B2bMail.isKnownSender}）。
 * 2. **落成询盘或往来记录**（{@link B2bMail.intake}）：新需求 / 平台通知 = 询盘，
 *    已有客户 / 回我们的信 = 往来记录。**B2B 岗位开着才开事项、起 Run**（同 WP163 的规矩）；
 *    平台通知信的正文在平台后台，不起 Run，开一条「去后台回复」的待办；
 *    信里要求改收款账户 → 红卡（`b2b_fraud_alert`，落老板），不起 Run、不采纳。
 * 3. **退订与退信**（{@link B2bMail.observe}）：分拣时认出来就直接进抑制名单，不等 Run；
 *    对上了联系人就写一条「这个人的开发序列停了」（序列本身是下一单的事）。
 *
 * 日志纪律（63 §10）：事件里没有正文、地址一律遮过。
 */

import {
  bounceOf,
  platformInquiryOf,
  senderDomain,
  type TriageInput,
  unsubscribeReplyOf,
} from '@agentsws/channels'
import type {
  ApprovalBus,
  AssignmentId,
  B2bAccount,
  B2bInquiry,
  B2bMailBasis,
  Clock,
  EventEnvelope,
  MessageRecord,
  MessageTriage,
  PersonId,
  RoleId,
  StartRun,
  WorkspaceId,
} from '@agentsws/contracts'
import { B2B_FRAUD_ALERT_KIND } from '@agentsws/contracts'
import {
  B2B_COMMITMENT_LABELS,
  detectPaymentAccountChange,
  scanB2bCommitments,
  sha256,
} from '@agentsws/core'
import type { Work } from '@agentsws/work'
import { addressHash, type B2bStore } from './b2b-store.js'
import { maskAddress } from './mailbox-actions.js'

/** 免费邮箱：公司域名对不上的那一类（`gmail.com` 上的人不等于"这家客户"）。 */
const FREE_MAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'qq.com',
  '163.com',
  '126.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.de',
  'web.de',
  'mail.ru',
  'yandex.ru',
])

export interface B2bHolder {
  person_id: PersonId
  assignment_id: AssignmentId
  role_id: RoleId
}

export interface B2bMailOptions {
  workspace_id: WorkspaceId
  store: B2bStore
  clock: Clock
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 这个工作区里现在持着 B2B 职责的分配（每次现查）。空 = 没开 B2B 岗位。 */
  holders(): readonly B2bHolder[]
  owner(): Promise<PersonId | undefined>
  approvals?: ApprovalBus
  work?: Work
  startRun?: StartRun
}

export interface B2bIntakeResult {
  accepted: boolean
  matter_id?: string
  inquiry_id?: string
}

export interface B2bMail {
  /** B2B 岗位开着吗（有人持着 `b2b.*` 里任何一条）。 */
  enabled(): boolean
  isOurThread(thread_id: string, refs: readonly string[]): boolean
  isKnownSender(from_email: string): boolean
  /** 判成 B2B 的一封信落进库（分拣判的，或人在「待确认」里点的）。同一封信只落一次。 */
  intake(
    record: MessageRecord,
    triage: MessageTriage,
    by: 'triage' | 'user',
  ): Promise<B2bIntakeResult>
  /** 退订 / 退信 → 抑制名单。回这一封进了几条（0 = 不是退订也不是硬退信，或早就在名单上）。 */
  observe(record: MessageRecord): number
}

/** 消息库那一行 → 分拣那几样（`@agentsws/channels` 的纯函数要的形状）。 */
export function triageInputOf(record: MessageRecord): TriageInput {
  return {
    from_email: record.from.email,
    ...(record.from.name === undefined ? {} : { from_name: record.from.name }),
    subject: record.subject,
    text: record.text,
    thread_id: record.thread_id,
    ...(record.in_reply_to === undefined ? {} : { in_reply_to: record.in_reply_to }),
    references: record.references,
    headers: record.headers,
    has_attachments: record.attachments.length > 0,
  }
}

export function createB2bMail(options: B2bMailOptions): B2bMail {
  const { store, clock, workspace_id } = options
  const holders = (): readonly B2bHolder[] => options.holders()
  /** 询盘落到谁名下：优先「业务」那一条，没有就随便一条 B2B 分配。 */
  const salesHolder = (): B2bHolder | undefined =>
    holders().find((h) => h.role_id === 'b2b.sales') ?? holders()[0]

  const emit = (type: string, payload: Record<string, unknown>, subject?: string): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'system', id: 'b2b_mail' },
      ...(subject === undefined ? {} : { subject: { type: 'message', id: subject } }),
      correlation: { trace_id: `tr_b2bmail_${clock.now()}` },
      payload,
    })
  }

  const accountByDomain = (domain: string): B2bAccount | undefined => {
    if (domain === '' || FREE_MAIL.has(domain)) return undefined
    return store
      .list<B2bAccount>('b2b_account')
      .find((a) => a.domain !== undefined && a.domain.trim().toLowerCase() === domain)
  }

  const contactAccountOf = (contact_id: string | undefined): string | undefined =>
    contact_id === undefined
      ? undefined
      : (store.get<{ account_id?: string }>('b2b_contact', contact_id)?.account_id ?? undefined)

  const isOurThread = (thread_id: string, refs: readonly string[]): boolean =>
    store.outboundMatch([thread_id, ...refs]) !== undefined

  const isKnownSender = (from_email: string): boolean =>
    store.contactIdByEmail(from_email) !== undefined ||
    accountByDomain(senderDomain(from_email)) !== undefined

  /** 这条线程已经钉在哪条事项上（后续来信挂过去，不另开）。 */
  const matterOfThread = (thread_id: string): string | undefined =>
    options.work
      ?.listMatters({ kind: 'conversation' })
      .find((m) => m.context.pinned.some((p) => p.type === 'thread' && p.id === thread_id))?.id

  /** 红卡：落老板，业务员同收。**卡上不抄那串账号**（WP171 同一条纪律）。 */
  const redCard = async (
    record: MessageRecord,
    holder: B2bHolder,
    phrases: string[],
    has_account_details: boolean,
  ): Promise<string | undefined> => {
    const approvals = options.approvals
    if (approvals === undefined) return undefined
    const owner = (await options.owner()) ?? holder.person_id
    const from = maskAddress(record.from.email)
    const item = await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: B2B_FRAUD_ALERT_KIND,
      role_id: holder.role_id,
      subject: { object: { type: 'thread', id: record.thread_id } },
      dedupe_key: `${workspace_id}:b2b_fraud:${record.thread_id}`,
      title: `疑似诈骗：${from} 要求改收款账户`,
      summary: `信里说「${phrases.join('」「')}」。收款账户只认事实卡上那一个，请打电话向对方核实，不要照信里的改。`,
      payload: {
        from,
        subject: record.subject,
        phrases,
        has_account_details,
        adopted: false,
        thread_id: record.thread_id,
        message_id: record.id,
      },
      evidence: {
        source_events: [],
        provenance: { seen: [{ type: 'thread', id: record.thread_id }] },
        precheck: { fencing: 'ok' },
      },
      proposer: {
        kind: 'agent',
        id: `agent_${holder.role_id}`,
        assignment_id: holder.assignment_id,
      },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: false, caps_hit: ['payment_account_change'] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [
          { person: owner, via: 'owner' },
          ...(holder.person_id === owner
            ? []
            : [{ person: holder.person_id, via: 'explicit' as const }]),
        ],
        explicit: owner,
        rule: 'owner',
        escalation: { after_hours: 2, business_hours: false, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'immediate',
    })
    return item.id
  }

  const basisOf = (
    record: MessageRecord,
    triage: MessageTriage,
    by: 'triage' | 'user',
  ): { basis: B2bMailBasis; platform?: string } => {
    if (by === 'user' || triage.by === 'user') return { basis: 'user' }
    if (isOurThread(record.thread_id, record.references)) return { basis: 'our_thread' }
    if (isKnownSender(record.from.email)) return { basis: 'known_sender' }
    const platform = platformInquiryOf(triageInputOf(record))
    if (platform !== undefined) return { basis: 'platform_notice', platform }
    return { basis: 'model' }
  }

  const intake = async (
    record: MessageRecord,
    triage: MessageTriage,
    by: 'triage' | 'user',
  ): Promise<B2bIntakeResult> => {
    // 没开 B2B 岗位：不落、不开事项（分拣本来也不会产出 b2b；这里防的是人点「这是 B2B」）
    const holder = salesHolder()
    if (holder === undefined) return { accepted: false }
    const existing = store.inquiryByMessage(record.id)
    if (existing !== undefined) {
      return {
        accepted: true,
        inquiry_id: existing.id,
        ...(existing.matter_id === undefined ? {} : { matter_id: existing.matter_id }),
      }
    }
    const now = clock.now()
    const { basis, platform } = basisOf(record, triage, by)
    const outbound = store.outboundMatch([record.thread_id, ...record.references])
    const contact_id = outbound?.contact_id ?? store.contactIdByEmail(record.from.email)
    const account_id =
      outbound?.account_id ??
      contactAccountOf(contact_id) ??
      accountByDomain(senderDomain(record.from.email))?.id
    const hay = `${record.subject}\n${record.text}`
    const commitments = [
      ...new Set(scanB2bCommitments(hay).map((h) => B2B_COMMITMENT_LABELS[h.category])),
    ]
    const fraud = detectPaymentAccountChange(hay)
    const kind: B2bInquiry['kind'] =
      basis === 'our_thread' || (basis === 'known_sender' && account_id !== undefined)
        ? 'correspondence'
        : 'inquiry'
    const inquiry: B2bInquiry = {
      id: `inq_${sha256(`${workspace_id}|${record.id}`).slice(0, 16)}`,
      workspace_id,
      kind,
      basis,
      ...(platform === undefined ? {} : { platform }),
      ...(account_id === undefined ? {} : { account_id }),
      ...(contact_id === undefined ? {} : { contact_id }),
      subject: record.subject,
      from_masked: maskAddress(record.from.email),
      from_domain: senderDomain(record.from.email),
      mailbox_masked: maskAddress(record.account),
      message_id: record.id,
      thread_id: record.thread_id,
      commitments,
      status: 'new',
      received_at: record.date,
      created_at: now,
    }

    // 事项：同一条线程的后续来信挂到原来那条上
    const work = options.work
    let matter_id = matterOfThread(record.thread_id)
    let opened = false
    if (work !== undefined && matter_id === undefined) {
      const matter = work.createMatter({
        kind: 'conversation',
        title:
          kind === 'correspondence'
            ? `B2B 往来：${record.subject || inquiry.from_domain}`
            : `B2B 询盘：${record.subject || inquiry.from_domain}`,
        pinned: [{ type: 'thread', id: record.thread_id }],
        position_id: holder.assignment_id,
        role_id: holder.role_id,
      })
      matter_id = matter.id
      opened = true
    }

    // 红卡：信里要改收款账户 → 不起 Run、不采纳
    let fraud_alert_id: string | undefined
    if (fraud.hit) {
      try {
        fraud_alert_id = await redCard(record, holder, fraud.phrases, fraud.has_account_details)
      } catch (e) {
        // 红卡没出成也不能照信里的办：询盘照落、不起 Run，记一笔
        emit('b2b.fraud_alert_failed', { detail: String(e).slice(0, 160) }, record.id)
      }
    }

    let run_id: string | undefined
    let todo = false
    if (work !== undefined && matter_id !== undefined && !fraud.hit) {
      if (basis === 'platform_notice') {
        // 平台询盘通知只有摘要，正文在平台后台（docs/84 §3.1）：开一条待办，不起 Run
        work.createTodo({
          title: `去 ${platform ?? '平台'} 后台回复这条询盘`,
          owner: holder.person_id,
          note: record.subject,
          matter_id,
          horizon: 'today',
          position_id: holder.assignment_id,
        })
        todo = true
      } else if (options.startRun !== undefined) {
        const matter = work.listMatters({ kind: 'conversation' }).find((m) => m.id === matter_id)
        if (matter !== undefined) {
          const out = await options.startRun({
            matter,
            brief: `${record.subject}\n\n${record.text.slice(0, 2000)}`,
            actor: { person_id: holder.person_id, assignment_id: holder.assignment_id },
          })
          run_id = out.run_id
          work.appendEvent(matter_id, {
            kind: 'run',
            text:
              kind === 'inquiry' ? '收到一条 B2B 询盘，开始处理' : '收到 B2B 客户来信，开始处理',
            actor: { kind: 'agent', id: holder.role_id },
            run_id,
          })
        }
      }
    }
    store.saveInquiry({
      ...inquiry,
      ...(matter_id === undefined ? {} : { matter_id }),
      ...(run_id === undefined ? {} : { run_id }),
      ...(fraud_alert_id === undefined ? {} : { fraud_alert_id }),
    })
    emit(
      'b2b.inquiry_recorded',
      {
        kind,
        basis,
        ...(platform === undefined ? {} : { platform }),
        by,
        from: inquiry.from_masked,
        account_matched: account_id !== undefined,
        commitments,
        matter_opened: opened,
        run_started: run_id !== undefined,
        todo_opened: todo,
        red_card: fraud_alert_id !== undefined,
      },
      record.id,
    )
    return {
      accepted: true,
      inquiry_id: inquiry.id,
      ...(matter_id === undefined ? {} : { matter_id }),
    }
  }

  const observe = (record: MessageRecord): number => {
    if (
      record.folder_kind === 'sent' ||
      record.folder_kind === 'drafts' ||
      record.folder_kind === 'trash'
    )
      return 0
    const input = triageInputOf(record)
    const at = clock.now()
    const hits: { address: string; reason: 'unsubscribe' | 'hard_bounce'; detail: string }[] = []
    const bounce = bounceOf(input)
    if (bounce?.hard === true && bounce.recipient !== undefined)
      hits.push({
        address: bounce.recipient,
        reason: 'hard_bounce',
        detail: bounce.status ?? 'hard',
      })
    const unsub = bounce === undefined ? unsubscribeReplyOf(input) : undefined
    if (unsub !== undefined)
      hits.push({ address: record.from.email, reason: 'unsubscribe', detail: unsub })
    let added = 0
    for (const hit of hits) {
      const contact_id = store.contactIdByEmail(hit.address)
      const fresh = store.suppress({
        key_hash: addressHash(hit.address),
        masked: maskAddress(hit.address),
        reason: hit.reason,
        message_id: record.id,
        ...(contact_id === undefined ? {} : { contact_id }),
        at,
      })
      if (!fresh) continue
      added += 1
      emit(
        'b2b.suppression_added',
        {
          reason: hit.reason,
          detail: hit.detail,
          address: maskAddress(hit.address),
          source: 'triage',
        },
        record.id,
      )
      // 这个联系人的开发序列就此停下（序列本身是下一单；先把这件事写成事件）
      if (contact_id !== undefined)
        emit('b2b.sequence_stopped', { contact_id, reason: hit.reason }, record.id)
    }
    return added
  }

  return {
    enabled: () => holders().length > 0,
    isOurThread,
    isKnownSender,
    intake,
    observe,
  }
}
