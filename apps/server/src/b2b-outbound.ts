/**
 * WP173（docs/84 §2 / §11.1）：**B2B 开发信序列**——`/v1/b2b/outbound/*` 与执行器、定时巡检、回信停序列。
 *
 * 接起来的东西：`b2b-store.ts`（序列 / 发信邮箱 / 设置三张表，WP172 的「我们发出去的信」）、
 * 变更账本（`b2b_outreach` 卡走 guardrail）、`@agentsws/b2b-core`（筛人、模板、页脚、体检、回信分类）、
 * `@agentsws/core` 的序列与预热（红人共用那一份）、消息层的 `sendMail`（outbox 七态、急停、幂等）。
 *
 * 六条纪律：
 *
 * 1. **每一轮首封批量一张卡**（强制 L1，一次看完这一批）；跟进与收尾按自动化级别（yml 起步 L1）。
 * 2. **发信域名建议而不强制**：第一次开序列时出一张选择卡（`b2b_sender_choice`），由用户选；
 *    **不问不设**。选哪只都要过体检：SPF / DKIM 没过不发（执行器发之前再查一次），DMARC 缺只提示。
 * 3. **配额按发信邮箱、按自然日**：预热期（第一次发起 14 天）20 封，之后 50 封；待批的卡里占着的也算；
 *    超了排到明天（面板写明）。
 * 4. **页脚由系统加**（公司实体地址 + 退订方式 + 首封写来源）；公司地址没填就不能发。退订走
 *    「回复 unsubscribe」+ `List-Unsubscribe: mailto:`——不需要公网退订页。
 * 5. **德国 / 奥地利没有往来的默认不发**，面板与卡上一句原因；用户在设置里勾选并确认风险后才发。
 * 6. **任何一封真回信都让这个人的序列停下**：有意向 / 要资料 / 问价交给业务（b2b-mail 落成询盘），
 *    不感兴趣 / 退订进抑制名单，自动回复按回来日期顺延。发出去的每一封都调 `noteOutbound`。
 */
import type {
  B2bActor,
  B2bOutboundPort,
  B2bOutboundSettingsInput,
  B2bOutboundView,
  B2bSequenceStartInput,
  B2bSequenceStartView,
} from '@agentsws/api'
import {
  B2B_REPLY_ACTION,
  B2B_REPLY_ZH,
  type B2bExcludeReason,
  type B2bOutreachDraft,
  type B2bOutreachVars,
  type B2bProspect,
  classifyB2bReply,
  coldEmailPrompt,
  domainOfAddress,
  draftB2bOutreach,
  EXCLUDE_REASON_ZH,
  evaluateSenderAuth,
  hasRelationship,
  isSeparateSendingDomain,
  listUnsubscribeHeader,
  localDay,
  outreachFooter,
  PRIMARY_DOMAIN_RISK,
  parseModelDraft,
  parseSenderChoice,
  reviewB2bOutreach,
  SENDER_CHOICE_SUMMARY,
  screenProspects,
  senderAuthOk,
  senderChoiceOptions,
  sequenceFunnel,
  splitByQuota,
} from '@agentsws/b2b-core'
import type {
  ApprovalBus,
  ApprovalItem,
  AssignmentId,
  B2bAccount,
  B2bContact,
  B2bEnrollment,
  B2bQueuedReason,
  B2bSender,
  B2bSequenceStep,
  Clock,
  EffectiveConfig,
  EventEnvelope,
  Mandate,
  MessageRecord,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import { B2B_DE_AT_REASON, B2B_SENDER_CHOICE_KIND } from '@agentsws/contracts'
import { nextInSequence, outreachQuota, warmupCap } from '@agentsws/core'
import type { B2bDeckData } from '@agentsws/deck'
import type { BackendResult, StageInput, StageOutcome } from '@agentsws/txn'
import { B2B_SECRET_FIELD } from './b2b-service.js'
import { addressHash, type B2bOutboundNote, type B2bStore } from './b2b-store.js'
import type { DirectMailInput, DirectMailResult } from './channels.js'
import { maskAddress } from './mailbox-actions.js'

/** 职责 yml 里那条动作。 */
export const B2B_OUTREACH_ACTION = 'stage_b2b_outreach'

/** 持「主动开发」的那一条分配（定时巡检用它去提卡）。 */
export interface B2bOutboundHolder {
  person_id: PersonId
  assignment_id: AssignmentId
  role_id: RoleId
}

export interface B2bOutboundOptions {
  workspace_id: WorkspaceId
  store: B2bStore
  clock: Clock
  random(): number
  /** 配额按这个时区的自然日算（与定时任务同一个时区）。 */
  timeZone(): string
  ledger: { stage(input: StageInput): Promise<StageOutcome> }
  approvals?: ApprovalBus
  effectiveConfig(id: AssignmentId): EffectiveConfig
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 本机加密库（发信时取收件人明文；只在这一刻、只取这一格）。 */
  secrets?: { get(id: string): Record<string, string> | undefined }
  /** 现在接着的邮箱地址。 */
  mailboxes(): readonly string[]
  /** 主域名：公司档案的域名 + 客服邮箱的域名（单独发信域名要与它们都不同）。 */
  primaryDomains(): readonly string[]
  /** 页脚公司名的兜底（公司档案全称 / 品牌名）。 */
  companyName(): string | undefined
  /** 发信（消息层的 `sendMail`：outbox 七态、急停、幂等）。不给 = 这台机器发不了信。 */
  sendMail?(input: DirectMailInput): Promise<DirectMailResult>
  /** DNS TXT 查询（服务进程用 `node:dns`，测试与模拟用替身）。不给 = 查不了，记 unknown。 */
  dns?: { txt(name: string): Promise<readonly string[]> }
  outboundHolder(): B2bOutboundHolder | undefined
  /** 模型口（每次现取；没配模型回 undefined → 用模板）。 */
  drafter?(meta: {
    assignment_id: string
    role_id: string
    run_id: string
  }): ((input: { prompt: string }) => Promise<{ text: string }>) | undefined
  /** `cold-email` 技能正文。 */
  coldEmailSkill?(): string | undefined
}

export interface B2bOutboundAssembly {
  port: B2bOutboundPort
  /** 执行器在 `b2b_outreach` 卡批准之后调（不是这种卡回 `undefined`）。 */
  apply(change: { id: string; kind: string; after?: unknown }): Promise<BackendResult | undefined>
  /** 「发信域名」那张卡被选了（服务进程在 `decide` 之后调）。 */
  onSenderChosen(item: ApprovalItem): Promise<void>
  /** 每封收进来的信过一遍：认体检测试信（读 DKIM）。 */
  observe(record: MessageRecord): void
  /** 回我们开发信的那一封：分类、停序列、该进名单的进名单。 */
  onReply(input: { record: MessageRecord; note: B2bOutboundNote }): {
    klass: B2bEnrollment['reply_class'] & string
    action: 'hand_to_sales' | 'suppress' | 'postpone' | 'stop'
    label: string
  }
  /** 退订 / 硬退信（分拣时认出来的）：这个人的序列停下。 */
  stopContact(contact_id: string, reason: string): void
  /** 每天一轮：到点的跟进 / 收尾出卡、排着的首封再走一遍、驳回的卡落账。 */
  sweep(): Promise<{ staged: number; queued: number; stopped: number }>
  /** 面板那三块（今天待发 · 序列漏斗 · 回复待分）。 */
  deckData(now: string): Pick<B2bDeckData, 'outreach_today' | 'sequence_funnel' | 'replies'>
}

/** 还在序列里（没停、没走完）。 */
export const LIVE: ReadonlySet<B2bEnrollment['status']> = new Set([
  'queued',
  'awaiting_approval',
  'active',
])

export const STEP_ZH: Readonly<Record<'first' | 'follow_up' | 'final', string>> = {
  first: '第一轮首封',
  follow_up: '跟进',
  final: '收尾',
}

export const QUEUED_ZH: Readonly<Record<B2bQueuedReason, string>> = {
  quota: '今天配额满了，明天发',
  sender_choice: '还没选发信邮箱',
  sender_auth: '发信邮箱体检没过',
  company_address: '公司地址没填',
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** 联系人库里那一行（WP172 的服务端格：`email_ref` / `email_key_hash`）。 */
type ContactRow = B2bContact & { email_ref?: string; email_key_hash?: string; note?: string }

export function createB2bOutbound(options: B2bOutboundOptions): B2bOutboundAssembly {
  const { workspace_id, store, clock } = options

  let seq = 0
  const nextId = (prefix: string): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `${prefix}_${rand}${seq.toString(36)}`
  }

  const emit = (type: string, payload: Record<string, unknown>): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'system', id: 'b2b_outbound' },
      correlation: { trace_id: `tr_b2bout_${clock.now()}` },
      payload,
    })
  }

  /** 这条动作的额度与等级（查不到按最严的 L1）。 */
  const actionOf = (
    assignment_id: AssignmentId,
  ): { mandate: Mandate; level: 'L1' | 'L2' | 'L3' } => {
    try {
      const config = options.effectiveConfig(assignment_id)
      return {
        mandate: config.actions.find((a) => a.id === B2B_OUTREACH_ACTION)?.mandate ?? { caps: {} },
        level: config.automation[B2B_OUTREACH_ACTION]?.level ?? 'L1',
      }
    } catch {
      return { mandate: { caps: {} }, level: 'L1' }
    }
  }

  const settingsOf = () => store.outboundSettings()
  const saveEnrollment = (e: B2bEnrollment, patch: Partial<B2bEnrollment>): B2bEnrollment => {
    const next = { ...e, ...patch, updated_at: clock.now() }
    store.saveEnrollment(next)
    return next
  }

  /** 这只邮箱今天的配额（预热 + 自然日 + 待批占着的）。 */
  const quotaOf = (sender: B2bSender, assignment_id: AssignmentId | undefined) => {
    const now = clock.now()
    const caps = (assignment_id === undefined ? { caps: {} } : actionOf(assignment_id).mandate)
      .caps as Record<string, unknown>
    const w = warmupCap({
      policy: {
        ...(num(caps.max_outreach_per_day) === undefined
          ? {}
          : { cap_new: num(caps.max_outreach_per_day) as number }),
        ...(num(caps.max_outreach_per_day_warmed) === undefined
          ? {}
          : { cap_warmed: num(caps.max_outreach_per_day_warmed) as number }),
        ...(num(caps.warmup_days) === undefined
          ? {}
          : { warmup_days: num(caps.warmup_days) as number }),
      },
      ...(sender.first_sent_at === undefined ? {} : { first_sent_at: sender.first_sent_at }),
      now,
    })
    const tz = options.timeZone()
    const today = localDay(now, tz)
    const mine = store
      .enrollments()
      .filter((e) => e.sender.toLowerCase() === sender.address.toLowerCase())
    const sent_at = mine
      .flatMap((e) => e.steps)
      .filter((s) => localDay(s.at, tz) === today)
      .map((s) => s.at)
    const q = outreachQuota({ cap: w.cap, sent_at, now })
    const reserved = mine.filter((e) => e.status === 'awaiting_approval').length
    return {
      cap: w.cap,
      sent_today: q.sent_today,
      reserved,
      remaining: Math.max(0, q.remaining - reserved),
      warming: w.warming,
      ...(w.warm_from === undefined ? {} : { warm_from: w.warm_from }),
    }
  }

  /** 库里的联系人 → 待筛的人（没有明文邮箱；有往来 = 公司阶段 / 来过询盘）。 */
  const prospectsOf = (ids?: readonly string[]): B2bProspect[] => {
    const accounts = new Map(store.list<B2bAccount>('b2b_account').map((a) => [a.id, a]))
    const inquired = new Set(
      store
        .inquiries()
        .map((i) => i.account_id)
        .filter((x): x is string => x !== undefined),
    )
    const suppressed = new Set(store.suppressions().map((s) => s.key_hash))
    const enrolled = new Set(store.enrollments().map((e) => e.contact_id))
    return store
      .list<ContactRow>('b2b_contact')
      .filter((c) => ids === undefined || ids.includes(c.id))
      .map((c) => {
        const a = accounts.get(c.account_id)
        return {
          contact_id: c.id,
          account_id: c.account_id,
          name: c.name,
          company: a?.name ?? c.account_id,
          ...(a?.country === undefined ? {} : { country: a.country }),
          has_email: typeof c.email_ref === 'string',
          ...(c.source === undefined ? {} : { source: c.source }),
          ...(c.public_source === undefined ? {} : { public_source: c.public_source }),
          existing_relationship:
            (a !== undefined && hasRelationship(a)) || inquired.has(c.account_id),
          suppressed: typeof c.email_key_hash === 'string' && suppressed.has(c.email_key_hash),
          in_sequence: enrolled.has(c.id),
        }
      })
  }

  const excludedSummary = (
    excluded: readonly { reason: B2bExcludeReason }[],
  ): B2bOutboundView['excluded'] => {
    const counts = new Map<B2bExcludeReason, number>()
    for (const x of excluded) counts.set(x.reason, (counts.get(x.reason) ?? 0) + 1)
    return [...counts].map(([reason, count]) => ({
      reason,
      label: EXCLUDE_REASON_ZH[reason],
      count,
    }))
  }

  /* ── 发信邮箱：选择卡与体检 ───────────────────────────────────────────── */

  const currentSender = (): B2bSender | undefined => {
    const address = settingsOf().sender_address
    return address === undefined ? undefined : store.sender(address)
  }

  /**
   * 「发信域名」那张卡（docs/84 §11.1 第 4 条）：还没答过、也没有一张在等 → 出一张。
   * 一只邮箱都没接就不出（没得选），回 `undefined`，由调用方说"先接一只邮箱"。
   */
  const ensureChoiceCard = async (actor: B2bActor): Promise<string | undefined> => {
    const approvals = options.approvals
    if (approvals === undefined) return undefined
    const settings = settingsOf()
    if (settings.choice_card_id !== undefined) {
      const prior = await approvals.get(settings.choice_card_id)
      if (prior !== undefined && (prior.state === 'pending' || prior.state === 'in_review'))
        return prior.id
    }
    const mailboxes = options.mailboxes()
    if (mailboxes.length === 0) return undefined
    const primary_domains = [...options.primaryDomains()]
    const choices = senderChoiceOptions({ mailboxes, primary_domains })
    const item = await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: B2B_SENDER_CHOICE_KIND,
      role_id: actor.role_id,
      subject: { object: { type: 'b2b_outbound', id: workspace_id } },
      dedupe_key: `${workspace_id}:b2b_sender_choice:${clock.now().slice(0, 10)}`,
      title: '开发信从哪只邮箱发？',
      summary: SENDER_CHOICE_SUMMARY,
      payload: {
        options: choices.map((o) => ({ id: o.id, label: o.label })),
        recommended: choices[0]?.id,
        primary_domains,
        tutorial: 'agentsws://help/b2b-sending-domain',
      },
      options: choices.map((o) => ({ id: o.id, label: o.label })),
      evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
      proposer: { kind: 'agent', id: `agent_${actor.role_id}`, assignment_id: actor.assignment_id },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: actor.person_id, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    })
    store.saveOutboundSettings({
      ...settingsOf(),
      choice_card_id: item.id,
      updated_at: clock.now(),
    })
    emit('b2b.sender_choice_asked', { options: choices.map((o) => o.kind) })
    return item.id
  }

  const txt = async (name: string): Promise<string[] | undefined> => {
    if (options.dns === undefined) return undefined
    try {
      return [...(await options.dns.txt(name))]
    } catch {
      return undefined
    }
  }

  /** 体检：查 DNS（SPF / DMARC），给自己发一封测试信（DKIM 等它收回来再判）。 */
  const runCheck = async (address: string): Promise<B2bSender | undefined> => {
    const sender = store.sender(address)
    if (sender === undefined) return undefined
    const now = clock.now()
    const [spf_txt, dmarc_txt] = await Promise.all([
      txt(sender.domain),
      txt(`_dmarc.${sender.domain}`),
    ])
    let test_message_id: string | undefined
    const notes: string[] = []
    if (options.sendMail !== undefined) {
      const sent = await options.sendMail({
        account: sender.address,
        to: [sender.address],
        subject: 'Agents 工坊发信体检（可以删掉）',
        text: '这是一封发信体检的测试信：Agents 工坊读它的信头，看 DKIM 签没签上。可以直接删掉。',
        idempotency_key: `b2b-auth:${sender.address}:${now}`,
        thread_ref: `b2b-auth:${sender.address}`,
      })
      if (sent.ok) test_message_id = sent.message_id
      else notes.push(`测试信没发出去：${sent.error ?? '原因不明'}`)
    } else notes.push('这台机器上没有能发信的邮箱，测试信发不了。')
    const ev = evaluateSenderAuth({
      domain: sender.domain,
      spf_txt,
      dmarc_txt,
      test_sent: test_message_id !== undefined,
    })
    const next: B2bSender = {
      ...sender,
      auth: {
        ...ev,
        notes: [...ev.notes, ...notes],
        checked_at: now,
        ...(test_message_id === undefined ? {} : { test_message_id }),
      },
      dns: {
        ...(spf_txt === undefined ? {} : { spf_txt }),
        ...(dmarc_txt === undefined ? {} : { dmarc_txt }),
      },
    }
    store.saveSender(next)
    emit('b2b.sender_checked', {
      domain: sender.domain,
      spf: ev.spf,
      dkim: ev.dkim,
      dmarc: ev.dmarc,
    })
    return next
  }

  /* ── 面板与设置 ─────────────────────────────────────────────────────── */

  const view = (actor?: B2bActor): B2bOutboundView => {
    const settings = settingsOf()
    const sender = currentSender()
    const enrollments = store.enrollments()
    const queued: B2bOutboundView['queued'] = {}
    for (const e of enrollments)
      if (e.status === 'queued' && e.queued_reason !== undefined)
        queued[e.queued_reason] = (queued[e.queued_reason] ?? 0) + 1
    const screened = screenProspects(prospectsOf(), {
      de_at_confirmed: settings.de_at !== undefined,
    })
    const needs: B2bQueuedReason[] = []
    if (sender === undefined) needs.push('sender_choice')
    if ((settings.postal_address ?? '').trim() === '') needs.push('company_address')
    if (sender !== undefined && !senderAuthOk(sender.auth)) needs.push('sender_auth')
    return {
      settings: {
        ...(settings.company_name === undefined ? {} : { company_name: settings.company_name }),
        ...(settings.postal_address === undefined
          ? {}
          : { postal_address: settings.postal_address }),
        ...(settings.sender_name === undefined ? {} : { sender_name: settings.sender_name }),
        de_at_confirmed: settings.de_at !== undefined,
        ...(settings.sender_choice === undefined ? {} : { sender_choice: settings.sender_choice }),
        ...(settings.sender_address === undefined
          ? {}
          : { sender_address: settings.sender_address }),
        ...(settings.choice_card_id === undefined
          ? {}
          : { choice_card_id: settings.choice_card_id }),
      },
      ...(sender === undefined
        ? {}
        : {
            sender: {
              address: sender.address,
              separate_domain: sender.separate_domain,
              auth: sender.auth,
              quota: quotaOf(
                sender,
                actor?.assignment_id ?? options.outboundHolder()?.assignment_id,
              ),
            },
          }),
      needs,
      funnel: sequenceFunnel(enrollments),
      queued,
      eligible: screened.eligible.length,
      excluded: excludedSummary(screened.excluded.filter((x) => x.reason !== 'in_sequence')),
    }
  }

  const saveSettings = (actor: B2bActor, input: B2bOutboundSettingsInput): B2bOutboundView => {
    const prior = settingsOf()
    const trim = (v: string | undefined): string | undefined =>
      v === undefined ? undefined : v.trim() === '' ? undefined : v.trim()
    const next = { ...prior, updated_at: clock.now() }
    if (input.company_name !== undefined) next.company_name = trim(input.company_name) as string
    if (input.postal_address !== undefined)
      next.postal_address = trim(input.postal_address) as string
    if (input.sender_name !== undefined) next.sender_name = trim(input.sender_name) as string
    for (const k of ['company_name', 'postal_address', 'sender_name'] as const)
      if (next[k] === undefined) delete next[k]
    if (input.de_at_confirm === true)
      next.de_at = { confirmed_by: actor.person_id, confirmed_at: clock.now() }
    if (input.de_at_confirm === false) delete next.de_at
    store.saveOutboundSettings(next)
    if (input.de_at_confirm !== undefined)
      emit('b2b.de_at_confirmation', { confirmed: input.de_at_confirm, by: actor.person_id })
    return view(actor)
  }

  /* ── 起草与出卡 ─────────────────────────────────────────────────────── */

  /** 一批里最多几封让模型写（其余用模板；一张卡上注明几封是模型写的）。 */
  const MODEL_DRAFTS_PER_BATCH = 20

  interface BatchEmail {
    enrollment_id: string
    contact_id: string
    account_id: string
    subject: string
    body: string
    by: 'template' | 'model'
  }

  const ourCompany = (): string =>
    settingsOf().company_name ?? options.companyName() ?? store.workspace_id

  /** 一封：首封先问模型（按 cold-email 技能），不合规矩就退回模板；跟进与收尾用模板。 */
  const draftOne = async (
    actor: B2bActor,
    step: B2bSequenceStep,
    e: B2bEnrollment,
    budget: { model: number },
  ): Promise<BatchEmail> => {
    const contact = store.get<ContactRow>('b2b_contact', e.contact_id)
    const account = store.get<B2bAccount>('b2b_account', e.account_id)
    const settings = settingsOf()
    const vars: B2bOutreachVars = {
      first_name: (contact?.name ?? '').split(/\s+/)[0] ?? '',
      company: account?.name ?? '',
      our_company: ourCompany(),
      product: settings.product ?? 'our products',
      sender_name: settings.sender_name ?? ourCompany(),
      ...(contact?.note === undefined ? {} : { observation: contact.note }),
      ...(e.steps[0]?.subject === undefined ? {} : { first_subject: e.steps[0].subject }),
    }
    let draft: B2bOutreachDraft = draftB2bOutreach(step, vars)
    const skill = options.coldEmailSkill?.()
    const model =
      step === 'first' && budget.model > 0 && skill !== undefined
        ? options.drafter?.({
            assignment_id: actor.assignment_id,
            role_id: actor.role_id,
            run_id: `run_b2b_draft_${nextId('d')}`,
          })
        : undefined
    if (model !== undefined && skill !== undefined) {
      budget.model -= 1
      try {
        const out = await model({
          prompt: coldEmailPrompt({
            skill,
            vars,
            prospect: {
              ...(contact?.title === undefined ? {} : { title: contact.title }),
              ...(account?.country === undefined ? {} : { country: account.country }),
              ...(contact?.source?.url === undefined ? {} : { source_url: contact.source.url }),
              ...(contact?.note === undefined ? {} : { note: contact.note }),
            },
          }),
        })
        const parsed = parseModelDraft(out.text)
        if (parsed !== undefined && reviewB2bOutreach({ step, ...parsed }).ok)
          draft = { step, ...parsed, by: 'model' }
      } catch {
        // 模型这次没写成：用模板（卡上照实写几封是模板）
      }
    }
    return {
      enrollment_id: e.id,
      contact_id: e.contact_id,
      account_id: e.account_id,
      subject: draft.subject,
      body: draft.body,
      by: draft.by,
    }
  }

  /**
   * 一批出一张卡（`b2b_outreach`）。guardrail 认的那几格摆在 `after` 顶层：页脚、来源、体检、
   * 主域名、德奥、抑制名单、条数。首封强制 L1（一次看完这一批）；跟进与收尾按自动化级别。
   */
  const stageBatch = async (
    actor: B2bActor,
    step: B2bSequenceStep,
    list: readonly B2bEnrollment[],
    sender: B2bSender,
    notes: readonly string[],
  ): Promise<{ ok: boolean; message: string; approval_item_id?: string; change_id?: string }> => {
    const settings = settingsOf()
    const budget = { model: MODEL_DRAFTS_PER_BATCH }
    const emails: BatchEmail[] = []
    for (const e of list) emails.push(await draftOne(actor, step, e, budget))
    const contacts = list.map((e) => store.get<ContactRow>('b2b_contact', e.contact_id))
    const accounts = new Map(store.list<B2bAccount>('b2b_account').map((a) => [a.id, a]))
    const inquired = new Set(store.inquiries().map((i) => i.account_id))
    const related = (account_id: string): boolean => {
      const a = accounts.get(account_id)
      return (a !== undefined && hasRelationship(a)) || inquired.has(account_id)
    }
    const countries = [
      ...new Set(
        list
          .filter((e) => !related(e.account_id))
          .map((e) => accounts.get(e.account_id)?.country?.toUpperCase())
          .filter((c): c is string => c !== undefined),
      ),
    ]
    const quota = quotaOf(sender, actor.assignment_id)
    const { mandate, level } = actionOf(actor.assignment_id)
    const footer = outreachFooter({
      company_name: ourCompany(),
      postal_address: settings.postal_address,
      step,
      source: contacts[0]?.source,
    })
    const batch_id = nextId('obt')
    const run_id = `run_b2b_out_${nextId('r')}`
    const ids = list.map((e) => e.contact_id)
    const byModel = emails.filter((m) => m.by === 'model').length
    const sample = emails[0]
    const names = list
      .slice(0, 3)
      .map(
        (e, i) =>
          `${accounts.get(e.account_id)?.name ?? e.account_id}（${contacts[i]?.name ?? '—'}）`,
      )
    const summary = [
      `${STEP_ZH[step]} · ${list.length} 封 · 从 ${sender.address} 发${sender.separate_domain ? '' : `（主域名：${PRIMARY_DOMAIN_RISK}）`}`,
      `收件：${names.join('、')}${list.length > 3 ? ` 等 ${list.length} 家` : ''}`,
      ...notes,
      byModel > 0 ? `${byModel} 封由模型按开发信技能写，${emails.length - byModel} 封用模板。` : '',
      '',
      sample === undefined ? '' : `样稿（第 1 封）：\nSubject: ${sample.subject}\n\n${sample.body}`,
      footer === undefined ? '' : `\n${footer}`,
    ]
      .filter((x, i, all) => x !== '' || (i > 0 && all[i - 1] !== ''))
      .join('\n')
    const outcome = await options.ledger.stage({
      workspace_id,
      role_id: actor.role_id,
      assignment_id: actor.assignment_id,
      run_id,
      change_set_id: `cs_${run_id}`,
      kind: 'b2b_outreach',
      target: { type: 'b2b_outreach_batch', id: batch_id },
      before: {},
      after: {
        step,
        batch_id,
        sender: sender.address,
        count: emails.length,
        emails,
        subject: sample?.subject ?? '',
        body: emails.map((m) => `${m.subject}\n${m.body}`).join('\n\n---\n\n'),
        recipients: contacts.map((c) => c?.email_key_hash ?? ''),
        suppressed: store.suppressions().map((s) => s.key_hash),
        suppression_checked: true,
        footer_unsubscribe: footer !== undefined,
        footer_address: footer !== undefined,
        contacts_missing_source: contacts.filter((c) => c?.source?.observed_at === undefined)
          .length,
        sender_auth: { spf: sender.auth.spf, dkim: sender.auth.dkim, dmarc: sender.auth.dmarc },
        shared_sending_domain: !sender.separate_domain,
        countries,
        de_at_confirmed: settings.de_at !== undefined,
        existing_relationship: countries.length === 0,
      },
      notes: [summary.split('\n')[0] ?? ''],
      created_by: { kind: 'agent', id: `agent_${actor.role_id}` },
      // 今天这只邮箱的上限（预热）就是 guardrail 那道 max_outreach_per_day
      mandate: { ...mandate, caps: { ...mandate.caps, max_outreach_per_day: quota.cap } },
      level: step === 'first' ? 'L1' : level,
      provenance: {
        run_id,
        seen: { b2b_outreach_batch: [batch_id], b2b_contact: ids },
        read_full: ids,
        recorded_at: clock.now(),
      },
      approval: {
        title: `开发信 · ${STEP_ZH[step]} · ${list.length} 封`,
        summary,
        recipients: [{ person: actor.person_id, via: 'role_holder' }],
        proposer: {
          kind: 'agent',
          id: `agent_${actor.role_id}`,
          assignment_id: actor.assignment_id,
        },
        rule: 'role_holder',
        separation_of_duties: false,
        source_events: [],
      },
    })
    if (!outcome.ok) {
      const rules = (outcome.guardrail?.hits ?? []).map((h) => h.rule)
      emit('b2b.outreach_blocked', { step, count: list.length, rules })
      for (const e of list)
        saveEnrollment(e, {
          status: step === 'first' ? 'queued' : e.status,
          ...(rules.includes('sender_auth') ? { queued_reason: 'sender_auth' as const } : {}),
        })
      return { ok: false, message: outcome.message }
    }
    for (const e of list)
      saveEnrollment(e, {
        status: 'awaiting_approval',
        sender: sender.address,
        next_step: step,
        pending_change_id: outcome.change.id,
        pending_approval_id: outcome.approval.id,
      })
    emit('b2b.outreach_staged', {
      step,
      count: list.length,
      change_id: outcome.change.id,
      auto_approved: outcome.approval.automation.auto_approved,
      by_model: byModel,
    })
    return {
      ok: true,
      message: summary.split('\n')[0] ?? '',
      approval_item_id: outcome.approval.id,
      change_id: outcome.change.id,
    }
  }

  /* ── 开一轮：排着的首封往前推 ─────────────────────────────────────────── */

  type Advance = Omit<B2bSequenceStartView, 'excluded'>

  const markQueued = (list: readonly B2bEnrollment[], reason: B2bQueuedReason): void => {
    for (const e of list) saveEnrollment(e, { status: 'queued', queued_reason: reason })
  }

  /**
   * 排着的首封往前推一步：选发信邮箱 → 公司地址 → 体检 → 今天配额。卡在哪一步就停在哪一步，
   * 原因写在序列上（面板照实写）；过了四道就出一张批量首封卡，超了配额的排到明天。
   */
  const advance = async (actor: B2bActor, notes: readonly string[] = []): Promise<Advance> => {
    const pending = store.enrollments().filter((e) => e.status === 'queued' && e.steps.length === 0)
    const none: Advance = {
      status: 'nothing_to_send',
      message: '没有排着的人。',
      picked: 0,
      queued_tomorrow: 0,
    }
    if (pending.length === 0) return none
    const settings = settingsOf()
    const sender = currentSender()
    if (sender === undefined) {
      const card = await ensureChoiceCard(actor)
      markQueued(pending, 'sender_choice')
      return {
        status: 'queued',
        queued_reason: 'sender_choice',
        picked: 0,
        queued_tomorrow: 0,
        ...(card === undefined ? {} : { approval_item_id: card }),
        message:
          settings.sender_choice === 'separate_pending'
            ? '你选了单独的发信域名，还没接上那只邮箱：照教程买好、配好，在连接页接上，再回来开。'
            : card === undefined
              ? '还没接邮箱：先在连接页接一只（建议用单独的发信域名那一只）。'
              : '先在卡上选用哪只邮箱发（强烈建议单独的发信域名）。',
      }
    }
    if ((settings.postal_address ?? '').trim() === '') {
      markQueued(pending, 'company_address')
      return {
        status: 'queued',
        queued_reason: 'company_address',
        picked: 0,
        queued_tomorrow: 0,
        message: '每封开发信的页脚都要公司实体地址（法规要求），先在「主动开发」里填上再发。',
      }
    }
    let checked = sender
    if (!senderAuthOk(checked.auth) && checked.auth.checked_at === undefined)
      checked = (await runCheck(sender.address)) ?? sender
    if (!senderAuthOk(checked.auth)) {
      markQueued(pending, 'sender_auth')
      const a = checked.auth
      return {
        status: 'queued',
        queued_reason: 'sender_auth',
        picked: 0,
        queued_tomorrow: 0,
        message: `发信邮箱 ${checked.address} 体检没过（SPF ${a.spf} · DKIM ${a.dkim}），没过不发。${a.notes.join(' ')}`,
      }
    }
    const quota = quotaOf(checked, actor.assignment_id)
    const { today, later } = splitByQuota(pending, quota.remaining)
    markQueued(later, 'quota')
    if (today.length === 0)
      return {
        status: 'queued',
        queued_reason: 'quota',
        picked: 0,
        queued_tomorrow: later.length,
        message: `今天 ${checked.address} 的配额用完了（${quota.cap} 封），排到明天。`,
      }
    const extra =
      later.length > 0 ? [`另有 ${later.length} 位超了今天配额（${quota.cap} 封），排到明天。`] : []
    const out = await stageBatch(actor, 'first', today, checked, [...extra, ...notes])
    if (!out.ok)
      return { status: 'blocked', message: out.message, picked: 0, queued_tomorrow: later.length }
    return {
      status: 'staged',
      message: out.message,
      picked: today.length,
      queued_tomorrow: later.length,
      ...(later.length > 0 ? { queued_reason: 'quota' as const } : {}),
      ...(out.approval_item_id === undefined ? {} : { approval_item_id: out.approval_item_id }),
      ...(out.change_id === undefined ? {} : { change_id: out.change_id }),
    }
  }

  const start = async (
    actor: B2bActor,
    input: B2bSequenceStartInput,
  ): Promise<B2bSequenceStartView> => {
    if (input.product !== undefined)
      store.saveOutboundSettings({
        ...settingsOf(),
        product: input.product.trim(),
        updated_at: clock.now(),
      })
    const settings = settingsOf()
    const { eligible, excluded } = screenProspects(prospectsOf(input.contact_ids), {
      de_at_confirmed: settings.de_at !== undefined,
    })
    const shown = excluded
      .filter((x) => input.contact_ids !== undefined || x.reason !== 'in_sequence')
      .map((x) => ({
        contact_id: x.prospect.contact_id,
        name: x.prospect.name,
        company: x.prospect.company,
        reason: x.reason,
        label: EXCLUDE_REASON_ZH[x.reason],
      }))
    const now = clock.now()
    for (const p of eligible)
      store.saveEnrollment({
        id: nextId('enr'),
        workspace_id,
        contact_id: p.contact_id,
        account_id: p.account_id,
        sender: settings.sender_address ?? '',
        status: 'queued',
        steps: [],
        next_step: 'first',
        created_at: now,
        updated_at: now,
      })
    emit('b2b.sequence_started', {
      enrolled: eligible.length,
      excluded: excludedSummary(excluded).map((x) => ({ reason: x.reason, count: x.count })),
    })
    const deAt = excluded.filter((x) => x.reason === 'de_at').length
    const notes = deAt > 0 ? [`德国 / 奥地利 ${deAt} 位没放进来：${B2B_DE_AT_REASON}。`] : []
    if (eligible.length === 0)
      return {
        status: 'nothing_to_send',
        message:
          deAt > 0 && deAt === shown.length
            ? `这一批都在德国 / 奥地利，默认不发：${B2B_DE_AT_REASON}。要发得在「主动开发」里勾选并确认风险。`
            : '这一批没有能发的人（原因逐个写在下面）。',
        picked: 0,
        queued_tomorrow: 0,
        excluded: shown,
      }
    return { ...(await advance(actor, notes)), excluded: shown }
  }

  const checkSender = async (actor: B2bActor): Promise<B2bOutboundView> => {
    const sender = currentSender()
    if (sender !== undefined) await runCheck(sender.address)
    return view(actor)
  }

  const holderActor = (): B2bActor | undefined => {
    const h = options.outboundHolder()
    return h === undefined
      ? undefined
      : { workspace_id, person_id: h.person_id, assignment_id: h.assignment_id, role_id: h.role_id }
  }

  /** 体检过了 / 选好邮箱之后，排着的往前推（钩子里调，出错只记一笔）。 */
  const advanceLater = (): void => {
    const actor = holderActor()
    if (actor === undefined) return
    void advance(actor).catch((e: unknown) => {
      emit('b2b.outreach_advance_failed', { detail: String(e).slice(0, 160) })
    })
  }

  /* ── 执行器：卡批了才发 ─────────────────────────────────────────────── */

  const apply = async (change: {
    id: string
    kind: string
    after?: unknown
  }): Promise<BackendResult | undefined> => {
    if (change.kind !== 'b2b_outreach') return undefined
    const after = (change.after ?? {}) as {
      step?: B2bSequenceStep
      sender?: string
      emails?: BatchEmail[]
    }
    const step = after.step ?? 'first'
    const emails = Array.isArray(after.emails) ? after.emails : []
    const sender = after.sender === undefined ? undefined : store.sender(after.sender)
    const mine = emails
      .map((m) => ({ m, e: store.enrollment(m.enrollment_id) }))
      // 批之前回过信 / 退订了 / 被别的卡接走了：这一封不发（序列已经停了）
      .filter(
        (x): x is { m: BatchEmail; e: B2bEnrollment } =>
          x.e !== undefined &&
          x.e.status === 'awaiting_approval' &&
          x.e.pending_change_id === change.id,
      )
    const failed = (message: string, reason?: B2bQueuedReason): BackendResult => {
      if (reason !== undefined)
        markQueued(
          mine.map((x) => x.e),
          reason,
        )
      emit('b2b.outreach_not_sent', { change_id: change.id, reason: reason ?? 'error' })
      return { status: 'failed', error: { message, retryable: false } }
    }
    if (sender === undefined) return failed('找不到这张卡上的发信邮箱，没发。', 'sender_choice')
    // 发之前再查一次：体检没过就不发（fail-closed，docs/84 §11.1 第 4 条）
    if (!senderAuthOk(sender.auth))
      return failed(`发信邮箱 ${sender.address} 体检没过（SPF / DKIM），没发。`, 'sender_auth')
    const settings = settingsOf()
    if (options.sendMail === undefined) return failed('这台机器上没有能发信的邮箱，没发。')
    const now = clock.now()
    let sent = 0
    let retry = false
    const errors: string[] = []
    for (const { m, e } of mine) {
      const contact = store.get<ContactRow>('b2b_contact', e.contact_id)
      const footer = outreachFooter({
        company_name: ourCompany(),
        postal_address: settings.postal_address,
        step,
        source: contact?.source,
      })
      if (footer === undefined)
        return failed('公司实体地址没填，页脚加不上，没发。', 'company_address')
      if (
        typeof contact?.email_key_hash === 'string' &&
        store.suppressions().some((s) => s.key_hash === contact.email_key_hash)
      ) {
        saveEnrollment(e, { status: 'stopped', stop_reason: 'suppressed' })
        continue
      }
      const address =
        contact?.email_ref === undefined
          ? undefined
          : options.secrets?.get(contact.email_ref)?.[B2B_SECRET_FIELD]
      if (address === undefined) {
        errors.push(`${contact?.name ?? e.contact_id}：加密库里取不到邮箱`)
        continue
      }
      const prior = e.steps.map((s) => s.message_id).filter((x): x is string => x !== undefined)
      const result = await options.sendMail({
        account: sender.address,
        to: [address],
        subject: m.subject,
        text: `${m.body}\n\n${footer}`,
        headers: { 'List-Unsubscribe': listUnsubscribeHeader(sender.address) },
        idempotency_key: `b2b-outreach:${change.id}:${e.id}`,
        thread_ref: `b2b-seq:${e.id}`,
        ...(prior.length === 0
          ? {}
          : { in_reply_to: prior[prior.length - 1] as string, references: prior }),
      })
      if (!result.ok) {
        if (result.retryable === true) retry = true
        errors.push(`${contact?.name ?? e.contact_id}：${result.error ?? '没发出去'}`)
        continue
      }
      sent += 1
      store.noteOutbound(
        {
          message_id: result.message_id,
          kind: 'outreach',
          contact_id: e.contact_id,
          account_id: e.account_id,
          enrollment_id: e.id,
          step,
        },
        now,
      )
      const steps = [
        ...e.steps,
        { step, at: now, message_id: result.message_id, change_id: change.id, subject: m.subject },
      ]
      const next = nextInSequence({
        sent: steps,
        replied: false,
        contact: e.contact_id,
        suppressed: [],
      })
      const {
        next_step: _n,
        due_at: _d,
        pending_change_id: _p,
        pending_approval_id: _a,
        ...rest
      } = e
      store.saveEnrollment(
        next === undefined
          ? // 收尾那封发完了：真停，序列里没有第四封
            { ...rest, steps, status: 'finished', stop_reason: 'finished', updated_at: now }
          : {
              ...rest,
              steps,
              status: 'active',
              next_step: next.step,
              due_at: next.due_at,
              updated_at: now,
            },
      )
    }
    if (sent > 0 && sender.first_sent_at === undefined)
      store.saveSender({ ...sender, first_sent_at: now })
    emit('b2b.outreach_sent', { change_id: change.id, step, sent, failed: errors.length })
    if (errors.length > 0 && sent === 0)
      return {
        status: 'failed',
        error: { message: errors.join('；').slice(0, 400), retryable: retry },
      }
    return {
      status: 'ok',
      execution_id: `b2b_out_${change.id}`,
      outcome_ref: {
        type: 'b2b_outreach_batch',
        id: String((change.after as { batch_id?: string }).batch_id ?? change.id),
      },
    }
  }

  /* ── 钩子：选择卡、测试信、回信、退订 ───────────────────────────────── */

  const onSenderChosen = async (item: ApprovalItem): Promise<void> => {
    if (item.kind !== B2B_SENDER_CHOICE_KIND || item.workspace_id !== workspace_id) return
    if (item.state !== 'approved' && item.state !== 'applied' && item.state !== 'approved_edited')
      return
    // 工作台那一路把选项放在 edited_payload 里（`deck/decide.ts`：选择题 = approve_edited）
    const edited = item.decision?.edited_payload as { selected_option_id?: unknown } | undefined
    const option =
      item.decision?.selected_option_id ??
      (typeof edited?.selected_option_id === 'string' ? edited.selected_option_id : '')
    const picked = parseSenderChoice(option)
    if (picked === undefined) return
    const now = clock.now()
    const settings = { ...settingsOf(), updated_at: now }
    settings.sender_choice = picked.kind === 'separate_setup' ? 'separate_pending' : picked.kind
    if (picked.address !== undefined) {
      settings.sender_address = picked.address
      if (store.sender(picked.address) === undefined)
        store.saveSender({
          address: picked.address,
          domain: domainOfAddress(picked.address),
          separate_domain: isSeparateSendingDomain(picked.address, options.primaryDomains()),
          chosen_at: now,
          ...(item.decision?.by === undefined || item.decision.by === 'mandate'
            ? {}
            : { chosen_by: item.decision.by }),
          auth: { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', notes: [] },
        })
    }
    store.saveOutboundSettings(settings)
    emit('b2b.sender_chosen', { choice: settings.sender_choice })
    if (picked.address !== undefined) await runCheck(picked.address)
    advanceLater()
  }

  const norm = (id: string): string => id.trim().toLowerCase().replace(/^<|>$/g, '')

  const observe = (record: MessageRecord): void => {
    if (record.folder_kind === 'sent' || record.message_id === undefined) return
    const sender = store
      .senders()
      .find(
        (s) =>
          s.auth.test_message_id !== undefined &&
          norm(s.auth.test_message_id) === norm(record.message_id as string),
      )
    if (sender === undefined) return
    const ev = evaluateSenderAuth({
      domain: sender.domain,
      spf_txt: sender.dns?.spf_txt,
      dmarc_txt: sender.dns?.dmarc_txt,
      auth_header: record.headers['authentication-results'] ?? '',
      test_sent: true,
    })
    const { test_message_id: _t, ...rest } = sender.auth
    store.saveSender({ ...sender, auth: { ...rest, ...ev, checked_at: clock.now() } })
    emit('b2b.sender_checked', {
      domain: sender.domain,
      spf: ev.spf,
      dkim: ev.dkim,
      dmarc: ev.dmarc,
      from: 'test_mail',
    })
    if (senderAuthOk(ev)) advanceLater()
  }

  const enrollmentOf = (note: B2bOutboundNote): B2bEnrollment | undefined =>
    (note.enrollment_id === undefined ? undefined : store.enrollment(note.enrollment_id)) ??
    store
      .enrollments()
      .filter((e) => e.contact_id === note.contact_id && LIVE.has(e.status))
      .at(-1)

  const onReply: B2bOutboundAssembly['onReply'] = ({ record, note }) => {
    const now = clock.now()
    const cls = classifyB2bReply({
      subject: record.subject,
      text: record.text,
      headers: record.headers,
      now,
    })
    const action = B2B_REPLY_ACTION[cls.klass]
    const e = enrollmentOf(note)
    if (e !== undefined && LIVE.has(e.status)) {
      if (action === 'postpone') {
        const back =
          cls.return_date === undefined
            ? undefined
            : Date.parse(`${cls.return_date}T00:00:00Z`) + 86_400_000
        const shifted = new Date(
          Math.max(Date.parse(e.due_at ?? now), back ?? Date.parse(now) + 7 * 86_400_000),
        ).toISOString()
        saveEnrollment(e, { due_at: shifted })
      } else {
        saveEnrollment(e, {
          status:
            action === 'hand_to_sales'
              ? 'handed_to_sales'
              : action === 'suppress'
                ? 'stopped'
                : 'replied',
          reply_class: cls.klass,
          replied_at: now,
          ...(action === 'suppress' ? { stop_reason: cls.klass } : {}),
        })
      }
    }
    if (action === 'suppress')
      store.suppress({
        key_hash: addressHash(record.from.email),
        masked: maskAddress(record.from.email),
        reason: cls.klass === 'unsubscribe' ? 'unsubscribe' : 'declined',
        message_id: record.id,
        ...(note.contact_id === undefined ? {} : { contact_id: note.contact_id }),
        at: now,
      })
    emit('b2b.sequence_reply', {
      class: cls.klass,
      action,
      ...(note.contact_id === undefined ? {} : { contact_id: note.contact_id }),
      stopped: action !== 'postpone',
    })
    return { klass: cls.klass, action, label: B2B_REPLY_ZH[cls.klass] }
  }

  const stopContact = (contact_id: string, reason: string): void => {
    for (const e of store.enrollments())
      if (e.contact_id === contact_id && LIVE.has(e.status))
        saveEnrollment(e, { status: 'stopped', stop_reason: reason })
  }

  /* ── 每天一轮 ─────────────────────────────────────────────────────── */

  const CLOSED_CARD: ReadonlySet<string> = new Set([
    'rejected',
    'expired',
    'withdrawn',
    'superseded',
  ])
  const RECHECK_MS = 7 * 86_400_000

  const sweep: B2bOutboundAssembly['sweep'] = async () => {
    const out = { staged: 0, queued: 0, stopped: 0 }
    // ① 驳回 / 过期的卡：那一批停下（人说了不发）
    for (const e of store.enrollments()) {
      if (e.status !== 'awaiting_approval' || e.pending_approval_id === undefined) continue
      const item = await options.approvals?.get(e.pending_approval_id)
      if (item !== undefined && CLOSED_CARD.has(item.state)) {
        saveEnrollment(e, { status: 'stopped', stop_reason: `card_${item.state}` })
        out.stopped += 1
      }
    }
    const actor = holderActor()
    if (actor === undefined) return out
    // ② 体检过期了（一周）再查一次；测试信还在路上的不重发
    const sender = currentSender()
    if (
      sender !== undefined &&
      sender.auth.dkim !== 'pending' &&
      (sender.auth.checked_at === undefined ||
        Date.parse(clock.now()) - Date.parse(sender.auth.checked_at) > RECHECK_MS)
    )
      await runCheck(sender.address)
    // ③ 到点的跟进 / 收尾：按（发信邮箱, 第几封）一批一张卡；配额不够的留到明天
    const now = Date.parse(clock.now())
    const suppressed = new Set(store.suppressions().map((s) => s.key_hash))
    const due = store.enrollments().filter((e) => {
      if (e.status !== 'active' || e.next_step === undefined || e.due_at === undefined) return false
      if (Date.parse(e.due_at) > now) return false
      const hash = store.get<ContactRow>('b2b_contact', e.contact_id)?.email_key_hash
      if (hash !== undefined && suppressed.has(hash)) {
        saveEnrollment(e, { status: 'stopped', stop_reason: 'suppressed' })
        out.stopped += 1
        return false
      }
      return true
    })
    for (const step of ['follow_up', 'final'] as const) {
      const groups = new Map<string, B2bEnrollment[]>()
      for (const e of due.filter((x) => x.next_step === step))
        groups.set(e.sender, [...(groups.get(e.sender) ?? []), e])
      for (const [address, list] of groups) {
        const s = store.sender(address)
        if (s === undefined || !senderAuthOk(s.auth)) {
          out.queued += list.length
          continue
        }
        const { today, later } = splitByQuota(list, quotaOf(s, actor.assignment_id).remaining)
        out.queued += later.length
        if (today.length === 0) continue
        const r = await stageBatch(actor, step, today, s, [])
        if (r.ok) out.staged += 1
      }
    }
    // ④ 排着的首封再走一遍（选好邮箱了 / 体检过了 / 新的一天配额回来了）
    const first = await advance(actor)
    if (first.status === 'staged') out.staged += 1
    out.queued += store.enrollments().filter((e) => e.status === 'queued').length
    return out
  }

  /* ── 面板那三块 ───────────────────────────────────────────────────── */

  const deckData: B2bOutboundAssembly['deckData'] = (now) => {
    const enrollments = store.enrollments()
    const accounts = new Map(store.list<B2bAccount>('b2b_account').map((a) => [a.id, a]))
    const sender = currentSender()
    const today: B2bDeckData['outreach_today'] = []
    const cards = new Map<string, B2bEnrollment[]>()
    for (const e of enrollments.filter((x) => x.status === 'awaiting_approval'))
      cards.set(e.pending_change_id ?? e.id, [...(cards.get(e.pending_change_id ?? e.id) ?? []), e])
    for (const list of cards.values()) {
      const e = list[0] as B2bEnrollment
      today.push({
        batch: `${STEP_ZH[e.next_step ?? 'first']} · 待批`,
        count: list.length,
        sender: e.sender,
        separate_domain: store.sender(e.sender)?.separate_domain ?? true,
      })
    }
    const queued = new Map<B2bQueuedReason, number>()
    for (const e of enrollments.filter((x) => x.status === 'queued'))
      queued.set(e.queued_reason ?? 'quota', (queued.get(e.queued_reason ?? 'quota') ?? 0) + 1)
    for (const [reason, count] of queued)
      today.push({
        batch: `排着 · ${QUEUED_ZH[reason]}`,
        count,
        sender: sender?.address ?? '—',
        separate_domain: sender?.separate_domain ?? true,
      })
    const since = Date.parse(now) - 14 * 86_400_000
    const replies = store
      .inquiries()
      .filter(
        (i) =>
          i.basis === 'our_thread' &&
          i.reply_class !== undefined &&
          Date.parse(i.received_at) >= since,
      )
      .map((i) => ({
        account:
          (i.account_id === undefined ? undefined : accounts.get(i.account_id)?.name) ??
          i.from_domain,
        category: B2B_REPLY_ZH[i.reply_class ?? 'unknown'],
        received_at: i.received_at,
      }))
      // 待分的排前面（要人读）
      .sort((a, b) => Number(b.category === '待分') - Number(a.category === '待分'))
    return { outreach_today: today, sequence_funnel: sequenceFunnel(enrollments), replies }
  }

  const port: B2bOutboundPort = {
    view: (actor) => view(actor),
    saveSettings,
    start,
    checkSender,
  }

  return { port, apply, onSenderChosen, observe, onReply, stopContact, sweep, deckData }
}
