/**
 * WP182（docs/84 §3 / §11.1）：**B2B 业务**——询盘接客服那条管线、六类事实卡、报价单与 PDF、样品、离职交接。
 *
 * 接起来的东西：`b2b-mail.ts`（分拣落成的询盘交到这里）、`b2b-service.ts`（草稿 → 卡 → 落库，样品往前走借它）、
 * 变更账本（`b2b_reply` / `b2b_sample` / `b2b_account_transfer` 走 guardrail）、`@agentsws/b2b-core`
 * （分级、首回、事实卡模板、报价单、样品提醒、交接清单）、`@agentsws/support-core`（打码围栏、语言、防泄露——
 * 起草复用客服那条管线，不另写）。
 *
 * 六条纪律：
 *
 * 1. **首回永远出卡**（`b2b_reply`，L1 起）；碰价格 / 交期 / 认证 / MOQ / 独家 / 账期，guardrail 另报一条
 *    `b2b_commitment`。**诈骗嫌疑不起草**，出红卡（`b2b_fraud_alert`，落老板、业务员同收）。
 * 2. **起草只引生效了的 B2B 事实卡**；模板只引卡上英文那一句，没有就说「我去确认」。模型写的过不了自查退回模板。
 * 3. **报价单发给客户也出卡**（同一种 `b2b_reply`，报价单 PDF 附在卡上），批了才发；发的时候按那一版现生成
 *    （同输入同字节），不存文件。
 * 4. **样品往前走一步出一张 `b2b_sample` 卡**（借 `b2b-service` 的草稿口）；标「已寄」的卡批了，再出一张寄样通知卡。
 *    超期不寄、超期没反馈开待办提醒（同一个截止日只提醒一次）。
 * 5. **离职交接出一张卡给老板批**（`b2b_account_transfer`，`route_to: owner`）；批了才改客户 / 商机 / 询盘的归属。
 * 6. 收件人明文**不进卡**：询盘回信按消息库那封信取发件人，报价 / 寄样按联系人的加密库那一格取，都在发的那一刻取。
 */
import type {
  B2bActor,
  B2bFactCategoryView,
  B2bFactsView,
  B2bQuoteSendInput,
  B2bQuoteSheetView,
  B2bSalesPort,
  B2bSalesView,
  B2bSampleAdvanceInput,
  B2bStagedView,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import {
  B2B_FACT_CATEGORIES,
  B2B_FACT_PREFILL_LOCATOR,
  type B2bFactCategoryId,
  type B2bFactRef,
  type B2bFactTemplate,
  b2bFactCategoryOf,
  b2bFactTemplates,
  buildQuoteSheet,
  draftInquiryReply,
  gradeB2bInquiry,
  type IndustryGuess,
  type InquiryDrafter,
  planHandover,
  quoteBreachText,
  renderQuotePdf,
  SAMPLE_STATUS_ZH,
  sampleReminders,
  sampleShippedNotice,
  sampleStepProblem,
} from '@agentsws/b2b-core'
import type {
  ApprovalBus,
  AssignmentId,
  B2bAccount,
  B2bContact,
  B2bInquiry,
  B2bInquiryGrade,
  B2bOpportunity,
  B2bQuote,
  B2bQuoteVersion,
  B2bSample,
  Clock,
  EffectiveConfig,
  EventEnvelope,
  Mandate,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import { B2B_FRAUD_ALERT_KIND, B2B_INQUIRY_GRADE_ZH } from '@agentsws/contracts'
import { B2B_COMMITMENT_LABELS, sha256 } from '@agentsws/core'
import type { B2bDeckData } from '@agentsws/deck'
import type { BackendResult, StageInput, StageOutcome } from '@agentsws/txn'
import type { Work } from '@agentsws/work'
import type { B2bHolder } from './b2b-mail.js'
import { B2B_SECRET_FIELD, type B2bServiceAssembly } from './b2b-service.js'
import { type B2bStore, sampleReminderId } from './b2b-store.js'
import type { DirectMailInput, DirectMailResult } from './channels.js'
import { maskAddress } from './mailbox-actions.js'

/** 职责 yml 里的几个动作。 */
export const B2B_REPLY_ACTION = 'stage_b2b_reply'
export const B2B_TRANSFER_ACTION = 'stage_b2b_account_transfer'

/** 这一单出的 `b2b_reply` 卡是哪一种（执行器只认这三种，别的掉回原路）。 */
export type B2bReplyPurpose = 'inquiry_first_reply' | 'quote_send' | 'sample_notice'
const PURPOSES: ReadonlySet<string> = new Set([
  'inquiry_first_reply',
  'quote_send',
  'sample_notice',
])

/** 一张 B2B 事实卡在服务进程里的样子（知识库那张卡摘出来的几格）。 */
export interface B2bFactCardLite {
  id: string
  status: string
  key: string
  statement: string
  structured?: Record<string, unknown>
  locator?: string
}

/** 询盘那封信（从消息库摘的几格；正文只在起草这一刻用，不落 B2B 库）。 */
export interface B2bInquiryMail {
  from_email: string
  from_name?: string
  subject: string
  text: string
  attachments: readonly string[]
  message_id: string
  thread_id: string
  references: readonly string[]
  /** 哪只邮箱收的（回信从这一只发）。 */
  account: string
}

export interface B2bSalesOptions {
  workspace_id: WorkspaceId
  store: B2bStore
  clock: Clock
  random(): number
  ledger: { stage(input: StageInput): Promise<StageOutcome> }
  approvals?: ApprovalBus
  effectiveConfig(id: AssignmentId): EffectiveConfig
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 草稿 → 卡（样品往前走一步借它）。 */
  service: Pick<B2bServiceAssembly, 'port'>
  /** 这个工作区里现在持着 B2B 职责的分配（每次现查）。 */
  holders(): readonly B2bHolder[]
  owner(): Promise<PersonId | undefined>
  /**
   * WP275（docs/95 §5）：没有审批流（① 个人 / ② 同事互联）时，诈骗嫌疑这张红卡只给这件事是谁的
   * 那个人（持 B2B 职责的业务员）点——硬闸三种模式都关不掉，只是不再另外抄给老板。不给按 ③。
   */
  approvalFlow?(): boolean | Promise<boolean>
  personName?(person_id: PersonId): Promise<string | undefined>
  /** 本机加密库（报价 / 寄样通知发的那一刻取联系人邮箱明文；WhatsApp 号码当场存进去）。 */
  secrets?: {
    get(id: string): Record<string, string> | undefined
    put?(id: string, fields: Record<string, string>): unknown
  }
  /** 消息库里那封信（询盘回信发的那一刻取发件人、Message-ID、线程）。 */
  messageOf?(
    message_id: string,
  ): Promise<
    | { from: string; rfc_message_id?: string; references: readonly string[]; account: string }
    | undefined
  >
  /** 知识库里的 B2B 事实卡（`subject.type = b2b_fact`，任何状态）。不给 = 没有知识库。 */
  factCards?(): Promise<readonly B2bFactCardLite[]>
  /** 提议一张事实卡（一律 proposed）。 */
  proposeFact?(t: B2bFactTemplate, source_url: string | undefined): Promise<string>
  /** 按官网判断的行业（品牌分析那一份；没分析过 = undefined）。 */
  industry?():
    | Promise<(IndustryGuess & { website?: string }) | undefined>
    | (IndustryGuess & { website?: string })
    | undefined
  /** `b2b-inquiry` 技能正文。 */
  inquirySkill?(): string | undefined
  /** 公司层口径（品牌语气等；不许原样抄进回信，防泄露那一道比它）。 */
  companyInstructions?(): readonly string[]
  /** 模型口（每次现取；没配模型回 undefined → 模板）。 */
  drafter?(meta: {
    assignment_id: string
    role_id: string
    run_id: string
  }): InquiryDrafter | undefined
  companyName(): string | undefined
  companyAddress?(): string | undefined
  companyWebsite?(): string | undefined
  /** 品牌设计：主色与字体（报价单信头）。 */
  letterhead?(): { color?: string; font_family?: string }
  /** 发信（消息层的 `sendMail`：outbox、急停、幂等）。 */
  sendMail?(input: DirectMailInput): Promise<DirectMailResult>
  /** WhatsApp 发一条（24 小时窗口那道闸在适配器里还有一道）。不给 = 这台机器发不了。 */
  sendWhatsApp?(input: {
    to: string
    text: string
    last_inbound_at?: string
    template_id?: string
  }): Promise<{ ok: boolean; external_id?: string; message?: string }>
  work?: Work
}

export interface B2bSalesAssembly {
  port: B2bSalesPort
  /**
   * 分拣落成的一条询盘：分级 → 诈骗嫌疑出红卡 / 其余起草首回出卡。回分级与卡。
   * `b2b-mail` 在开完事项之后调（不再为询盘起 Run：分级与首回在这里一次做完）。
   */
  onInquiry(input: {
    inquiry: B2bInquiry
    mail: B2bInquiryMail
    holder: B2bHolder
    known: boolean
  }): Promise<{
    grade: B2bInquiryGrade
    reasons: string[]
    reply_approval_id?: string
    red_card_id?: string
    blocked?: string
  }>
  /** WhatsApp 来的询盘：同一条路（记询盘 → 分级 → 起草 → 出卡，卡上带 24 小时窗口）。 */
  intakeWhatsApp(input: {
    from_phone: string
    from_name?: string
    text: string
    message_id: string
    received_at: string
    opt_in?: boolean
  }): Promise<{
    accepted: boolean
    inquiry_id?: string
    grade?: B2bInquiryGrade
    reply_approval_id?: string
  }>
  /** 执行器：`b2b_reply`（这一单的三种）批了就发；`b2b_account_transfer` 批了就改归属。 */
  apply(change: { id: string; kind: string; after?: unknown }): Promise<BackendResult | undefined>
  /** 执行器落完库之后：样品标「已寄」生效了 → 出寄样通知卡。 */
  afterApplied(change: { id: string; kind: string; after?: unknown }): Promise<void>
  /** 每天一拍：超期不寄 / 超期没反馈开待办提醒。 */
  sweep(): Promise<{ reminders: number }>
  /** 业务员离职 / 被移出：他的客户、商机、未回询盘出一张交接卡给老板。 */
  onMemberLeft(
    person_id: PersonId,
    by: PersonId,
  ): Promise<{ handover_id?: string; approval_item_id?: string }>
  /** 面板「业务」四块里这一单补的几格（询盘分级、样品超期）。 */
  deckPatch(now: string, base: B2bDeckData): B2bDeckData
}

const DAY = 86_400_000
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

export function createB2bSales(options: B2bSalesOptions): B2bSalesAssembly {
  const { workspace_id, store, clock, ledger } = options

  let seq = 0
  const nextId = (prefix: string): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `${prefix}_${rand}${seq.toString(36)}`
  }

  const emit = (type: string, payload: Record<string, unknown>, subject?: string): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'system', id: 'b2b_sales' },
      ...(subject === undefined ? {} : { subject: { type: 'b2b', id: subject } }),
      correlation: { trace_id: `tr_b2bsales_${clock.now()}` },
      payload,
    })
  }

  /** 额度与等级（查不到按最严的 L1）。 */
  const actionOf = (
    assignment_id: AssignmentId,
    action: string,
  ): { mandate: Mandate; level: 'L1' | 'L2' | 'L3'; caps: Record<string, unknown> } => {
    try {
      const config = options.effectiveConfig(assignment_id)
      const spec = config.actions.find((a) => a.id === action)
      const mandate = spec?.mandate ?? { caps: {} }
      return {
        mandate,
        level: config.automation[action]?.level ?? 'L1',
        caps: (mandate.caps ?? {}) as Record<string, unknown>,
      }
    } catch {
      return { mandate: { caps: {} }, level: 'L1', caps: {} }
    }
  }

  const salesHolder = (): B2bHolder | undefined =>
    options.holders().find((h) => h.role_id === 'b2b.sales') ?? options.holders()[0]
  const holderOf = (person_id: PersonId | undefined): B2bHolder | undefined =>
    (person_id === undefined
      ? undefined
      : options.holders().find((h) => h.person_id === person_id && h.role_id === 'b2b.sales')) ??
    salesHolder()

  const ourCompany = (): string => options.companyName() ?? workspace_id
  const senderName = async (person_id: PersonId): Promise<string> =>
    (await options.personName?.(person_id)) ?? ourCompany()

  /** 生效了的 B2B 事实卡（起草只引这些）。 */
  const activeFacts = async (): Promise<B2bFactRef[]> => {
    const cards = (await options.factCards?.()) ?? []
    return cards.flatMap((c) => {
      const category = b2bFactCategoryOf(c.key)
      if (category === undefined || c.status !== 'active') return []
      const reply_en = str(c.structured?.reply_en)
      return [
        {
          id: c.id,
          category,
          statement: c.statement,
          ...(reply_en === undefined ? {} : { reply_en }),
        },
      ]
    })
  }

  /** 出一张改动卡（账本那道门）。收件人默认是提的这个人自己（`role_holder`）。 */
  const stageCard = async (input: {
    holder: B2bHolder
    action: string
    kind: StageInput['kind']
    target: { type: string; id: string }
    before?: unknown
    after: Record<string, unknown>
    title: string
    summary: string
    recipients?: StageInput['approval']['recipients']
    rule?: 'role_holder' | 'scope_manager' | 'owner'
    proposer?: 'agent' | 'person'
  }): Promise<StageOutcome> => {
    const { mandate, level } = actionOf(input.holder.assignment_id, input.action)
    const run_id = `run_b2bsales_${nextId('r')}`
    const agent = input.proposer !== 'person'
    return ledger.stage({
      workspace_id,
      role_id: input.holder.role_id,
      assignment_id: input.holder.assignment_id,
      run_id,
      change_set_id: `cs_${run_id}`,
      kind: input.kind,
      target: input.target,
      before: input.before ?? {},
      after: input.after,
      notes: [input.summary],
      created_by: agent
        ? { kind: 'agent', id: `agent_${input.holder.role_id}` }
        : { kind: 'person', id: input.holder.person_id },
      mandate,
      level,
      provenance: {
        run_id,
        seen: { [input.target.type]: [input.target.id] },
        read_full: [input.target.id],
        recorded_at: clock.now(),
      },
      approval: {
        title: input.title,
        summary: input.summary,
        recipients: input.recipients ?? [{ person: input.holder.person_id, via: 'role_holder' }],
        proposer: agent
          ? {
              kind: 'agent',
              id: `agent_${input.holder.role_id}`,
              assignment_id: input.holder.assignment_id,
            }
          : {
              kind: 'person',
              id: input.holder.person_id,
              assignment_id: input.holder.assignment_id,
            },
        rule: input.rule ?? 'role_holder',
        separation_of_duties: false,
        source_events: [],
      },
    })
  }

  /* ── 询盘：分级 → 红卡 / 首回卡 ─────────────────────────────────────── */

  /** 诈骗嫌疑的红卡：落老板、业务员同收；不起草、不点链接、不开附件。 */
  const scamCard = async (
    inquiry: B2bInquiry,
    holder: B2bHolder,
    reasons: string[],
  ): Promise<string | undefined> => {
    const approvals = options.approvals
    if (approvals === undefined) return undefined
    // WP275：① ② 没有审批流——红卡落在业务员自己身上（硬闸照旧，一律要人点）
    const owner =
      (await options.approvalFlow?.()) === false
        ? holder.person_id
        : ((await options.owner()) ?? holder.person_id)
    const item = await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: B2B_FRAUD_ALERT_KIND,
      role_id: holder.role_id,
      subject: { object: { type: 'thread', id: inquiry.thread_id } },
      dedupe_key: `${workspace_id}:b2b_scam:${inquiry.thread_id}`,
      title: `疑似诈骗询盘：${inquiry.from_masked}`,
      summary: `命中：${reasons.join('；')}。没起草回信。不点信里的链接、不开附件、不回任何具体信息；真想接，先查这家公司、打电话核实。`,
      payload: {
        reason: 'scam_suspect',
        from: inquiry.from_masked,
        subject: inquiry.subject,
        signals: reasons,
        adopted: false,
        thread_id: inquiry.thread_id,
        message_id: inquiry.message_id,
        inquiry_id: inquiry.id,
      },
      evidence: {
        source_events: [],
        provenance: { seen: [{ type: 'thread', id: inquiry.thread_id }] },
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
        mandate_check: { within: false, caps_hit: ['scam_suspect'] },
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

  /** 首回卡的那句中文摘要（卡上一眼看懂：几档、引了哪几类、要去确认什么、问了对方什么）。 */
  const replySummary = (
    grade: B2bInquiryGrade,
    reasons: string[],
    draft: Awaited<ReturnType<typeof draftInquiryReply>>,
    facts: readonly B2bFactRef[],
  ): string => {
    const cited = draft.cited
      .map((id) => facts.find((f) => f.id === id)?.category)
      .filter((c): c is B2bFactCategoryId => c !== undefined)
      .map((c) => B2B_FACT_CATEGORIES.find((x) => x.id === c)?.name ?? c)
    const asked: Record<string, string> = {
      quantity: '数量',
      target_price: '目标价',
      certification: '认证',
      lead_time: '交期',
      packaging: '包装',
      payment: '付款方式',
    }
    return [
      `${B2B_INQUIRY_GRADE_ZH[grade]}（${reasons.slice(0, 2).join('、')}）。`,
      cited.length === 0 ? '没有引事实卡。' : `数字取自事实卡：${[...new Set(cited)].join('、')}。`,
      draft.to_confirm.length === 0
        ? ''
        : `事实卡里没有、回信里说去确认：${draft.to_confirm.join('、')}。`,
      draft.asked.length === 0
        ? ''
        : `问对方：${draft.asked.map((a) => asked[a] ?? a).join('、')}。`,
      draft.by === 'model'
        ? '按询盘回复技能写的。'
        : `用的模板${draft.fallback_reason === undefined ? '' : `（模型那一版没用：${draft.fallback_reason}）`}。`,
    ]
      .filter((s) => s !== '')
      .join('')
  }

  /** 起草首回并出卡（邮件与 WhatsApp 同一条路）。 */
  const draftAndStage = async (
    inquiry: B2bInquiry,
    mail: Pick<B2bInquiryMail, 'subject' | 'text' | 'from_name'>,
    holder: B2bHolder,
    grade: B2bInquiryGrade,
    reasons: string[],
    extra: Record<string, unknown>,
  ): Promise<{
    approval_item_id?: string
    change_id?: string
    blocked?: string
    by: 'model' | 'template'
  }> => {
    const facts = await activeFacts()
    const run_id = `run_b2b_inquiry_${nextId('d')}`
    const model = options.drafter?.({
      assignment_id: holder.assignment_id,
      role_id: holder.role_id,
      run_id,
    })
    const skill = options.inquirySkill?.()
    const first = mail.from_name?.trim().split(/\s+/)[0]
    const draft = await draftInquiryReply({
      subject: mail.subject,
      text: mail.text,
      ...(first === undefined || first === '' ? {} : { first_name: first }),
      our_company: ourCompany(),
      sender_name: await senderName(holder.person_id),
      facts,
      grade: B2B_INQUIRY_GRADE_ZH[grade],
      ...(skill === undefined ? {} : { skill }),
      ...(model === undefined ? {} : { model }),
      instructions: options.companyInstructions?.() ?? [],
    })
    const summary = replySummary(grade, reasons, draft, facts)
    const outcome = await stageCard({
      holder,
      action: B2B_REPLY_ACTION,
      kind: 'b2b_reply',
      target: { type: 'thread', id: inquiry.thread_id },
      after: {
        purpose: 'inquiry_first_reply' satisfies B2bReplyPurpose,
        channel: inquiry.channel ?? 'email',
        subject: draft.subject,
        body: draft.body,
        inquiry_id: inquiry.id,
        thread_id: inquiry.thread_id,
        message_id: inquiry.message_id,
        to_masked: inquiry.from_masked,
        grade,
        grade_label: B2B_INQUIRY_GRADE_ZH[grade],
        grade_reasons: reasons,
        cited_facts: draft.cited,
        to_confirm: draft.to_confirm,
        asked: draft.asked,
        by: draft.by,
        ...(draft.fallback_reason === undefined ? {} : { fallback_reason: draft.fallback_reason }),
        ...(inquiry.account_id === undefined ? {} : { account_id: inquiry.account_id }),
        ...(inquiry.contact_id === undefined ? {} : { contact_id: inquiry.contact_id }),
        ...extra,
      },
      title: `回询盘：${inquiry.subject || inquiry.from_domain}`,
      summary,
    })
    if (!outcome.ok) {
      emit('b2b.inquiry_reply_blocked', {
        inquiry_id: inquiry.id,
        message: outcome.message.slice(0, 200),
      })
      return { blocked: outcome.message, by: draft.by }
    }
    store.saveInquiry({
      ...inquiry,
      reply_change_id: outcome.change.id,
      reply_approval_id: outcome.approval.id,
      reply_by: draft.by,
    })
    return { approval_item_id: outcome.approval.id, change_id: outcome.change.id, by: draft.by }
  }

  const onInquiry: B2bSalesAssembly['onInquiry'] = async ({ inquiry, mail, holder, known }) => {
    const out = await onInquiryChannel(inquiry, holder, mail, {}, known)
    emit(
      'b2b.inquiry_graded',
      {
        grade: out.grade,
        reasons: out.reasons,
        red_card: out.red_card_id !== undefined,
        reply_staged: out.reply_approval_id !== undefined,
      },
      inquiry.id,
    )
    return out
  }

  /** WhatsApp 来的询盘：记询盘 → 同一条路。窗口从这条消息算（24 小时）。 */
  const intakeWhatsApp: B2bSalesAssembly['intakeWhatsApp'] = async (input) => {
    const holder = salesHolder()
    if (holder === undefined) return { accepted: false }
    const digits = input.from_phone.replace(/\D/g, '')
    const masked =
      digits.length <= 4 ? '****' : `+${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`
    // 号码明文只进加密库；线程与 key 名用哈希（日志里认不出是谁）
    const phoneKey = sha256(`b2b-wa|${digits}`).slice(0, 16)
    const thread_id = `wa:${phoneKey}`
    const to_ref = `b2b.wa.${phoneKey}`
    if (options.secrets?.put === undefined)
      throw new ApiError('invalid_input', '本机加密库没开，存不了 WhatsApp 号码（明文不落库）。')
    options.secrets.put(to_ref, { [B2B_SECRET_FIELD]: digits })
    const existing = store.inquiryByMessage(input.message_id)
    if (existing !== undefined) return { accepted: true, inquiry_id: existing.id }
    const inquiry: B2bInquiry = {
      id: `inq_wa_${nextId('w')}`,
      workspace_id,
      kind: 'inquiry',
      basis: 'model',
      channel: 'whatsapp',
      subject: input.text.split('\n')[0]?.slice(0, 80) ?? 'WhatsApp',
      from_masked: masked,
      from_domain: '',
      mailbox_masked: 'WhatsApp',
      message_id: input.message_id,
      thread_id,
      commitments: [],
      status: 'new',
      last_inbound_at: input.received_at,
      received_at: input.received_at,
      created_at: clock.now(),
    }
    store.saveInquiry(inquiry)
    const out = await onInquiryChannel(
      inquiry,
      holder,
      {
        from_email: '',
        ...(input.from_name === undefined ? {} : { from_name: input.from_name }),
        subject: inquiry.subject,
        text: input.text,
        attachments: [],
        message_id: input.message_id,
        thread_id,
        references: [],
        account: 'whatsapp',
      },
      {
        window_open: Date.parse(clock.now()) - Date.parse(input.received_at) < DAY,
        last_inbound_at: input.received_at,
        opt_in_verified: input.opt_in === true,
        wa_to_ref: to_ref,
      },
    )
    return {
      accepted: true,
      inquiry_id: inquiry.id,
      grade: out.grade,
      ...(out.reply_approval_id === undefined ? {} : { reply_approval_id: out.reply_approval_id }),
    }
  }

  /** 邮件与 WhatsApp 共用：分级 → 红卡或首回卡（WhatsApp 多带窗口那几格）。 */
  async function onInquiryChannel(
    inquiry: B2bInquiry,
    holder: B2bHolder,
    mail: B2bInquiryMail,
    extra: Record<string, unknown>,
    known = false,
  ): Promise<{
    grade: B2bInquiryGrade
    reasons: string[]
    reply_approval_id?: string
    red_card_id?: string
    blocked?: string
  }> {
    const { grade, reasons } = gradeB2bInquiry({
      subject: mail.subject,
      text: mail.text,
      from_email: mail.from_email,
      attachments: mail.attachments,
      known,
    })
    const graded: B2bInquiry = {
      ...inquiry,
      grade,
      grade_reasons: reasons,
      owner_person_id: holder.person_id,
    }
    store.saveInquiry(graded)
    if (grade === 'scam') {
      let red: string | undefined
      try {
        red = await scamCard(graded, holder, reasons)
      } catch (e) {
        emit('b2b.scam_alert_failed', { detail: String(e).slice(0, 160) }, inquiry.id)
      }
      store.saveInquiry({ ...graded, ...(red === undefined ? {} : { fraud_alert_id: red }) })
      return { grade, reasons, ...(red === undefined ? {} : { red_card_id: red }) }
    }
    const staged = await draftAndStage(graded, mail, holder, grade, reasons, extra)
    return {
      grade,
      reasons,
      ...(staged.approval_item_id === undefined
        ? {}
        : { reply_approval_id: staged.approval_item_id }),
      ...(staged.blocked === undefined ? {} : { blocked: staged.blocked }),
    }
  }

  /* ── 六类事实卡 ──────────────────────────────────────────────────────── */

  const factsView = async (): Promise<B2bFactsView> => {
    const cards = (await options.factCards?.()) ?? []
    const industry = await options.industry?.()
    const categories: B2bFactCategoryView[] = B2B_FACT_CATEGORIES.map((c) => {
      const mine = cards.filter((x) => b2bFactCategoryOf(x.key) === c.id)
      // 生效的优先；同一类有好几张就取最后一张（后改的赢）
      const card = mine.filter((x) => x.status === 'active').at(-1) ?? mine.at(-1)
      const reply_en = str(card?.structured?.reply_en)
      return {
        category: c.id,
        name: c.name,
        description: c.description,
        covers: c.covers.map((k) => B2B_COMMITMENT_LABELS[k]),
        ...(card === undefined
          ? {}
          : {
              card: {
                id: card.id,
                status: card.status,
                statement: card.statement,
                ...(reply_en === undefined ? {} : { reply_en }),
                ...(card.structured?.prefilled === 'industry' ||
                card.locator === B2B_FACT_PREFILL_LOCATOR
                  ? { prefilled: true }
                  : {}),
              },
            }),
      }
    })
    return {
      ...(industry === undefined ? {} : { industry: industry.industry }),
      recommended_certifications: industry?.certifications ?? [],
      categories,
      ready: categories.filter((c) => c.card?.status === 'active').length,
    }
  }

  /** 按官网行业预填：库里没有的那几类各提议一张（已有的那一类不动，不重复提）。 */
  const setupFacts = async (): Promise<B2bFactsView & { proposed: number }> => {
    if (options.proposeFact === undefined || options.factCards === undefined)
      throw new ApiError('not_implemented', '这个服务进程没接知识库，建不了事实卡。')
    const have = new Set(
      (await options.factCards())
        .filter((c) => c.status === 'active' || c.status === 'proposed')
        .map((c) => b2bFactCategoryOf(c.key)),
    )
    const industry = await options.industry?.()
    let proposed = 0
    for (const t of b2bFactTemplates(industry)) {
      if (have.has(t.category)) continue
      await options.proposeFact(t, industry?.website)
      proposed += 1
    }
    emit('b2b.facts_setup', { proposed, industry: industry?.industry ?? null })
    return { ...(await factsView()), proposed }
  }

  /* ── 报价单（PDF）与发给客户 ─────────────────────────────────────────── */

  const accountName = (id: string | undefined): string =>
    (id === undefined ? undefined : store.get<B2bAccount>('b2b_account', id)?.name) ?? id ?? '—'

  /** 报价这一版：批了的版本表 + 在批的那一份草稿（预览在批的那一版也要看得到）。 */
  const quoteVersionOf = (
    quote_id: string,
    version?: number,
  ): { quote: Record<string, unknown>; v: B2bQuoteVersion; applied: boolean } => {
    const applied = store.quoteVersions(quote_id)
    const pending = store
      .drafts({ collection: 'b2b_quote' })
      .filter(
        (d) =>
          d.record_id === quote_id && d.status === 'submitted' && d.quote_version !== undefined,
      )
    const row = store.get<Record<string, unknown>>('b2b_quote', quote_id) ?? pending.at(-1)?.record
    if (row === undefined) throw new ApiError('not_found', `没有这张报价：${quote_id}`)
    const all = [
      ...applied.map((v) => ({ v, applied: true })),
      ...pending.flatMap((d) =>
        d.quote_version === undefined ? [] : [{ v: d.quote_version, applied: false }],
      ),
    ].sort((a, b) => a.v.version - b.v.version)
    const hit = version === undefined ? all.at(-1) : all.find((x) => x.v.version === version)
    if (hit === undefined)
      throw new ApiError(
        'not_found',
        version === undefined ? '这张报价还没有版本' : `没有第 ${version} 版`,
      )
    return { quote: row, v: hit.v, applied: hit.applied }
  }

  const factLine = (
    facts: readonly B2bFactRef[],
    category: B2bFactCategoryId,
  ): string | undefined =>
    facts.find((f) => f.category === category && f.reply_en !== undefined)?.reply_en

  const sheetOf = async (quote_id: string, version?: number) => {
    const { quote, v, applied } = quoteVersionOf(quote_id, version)
    const facts = await activeFacts()
    const lh = options.letterhead?.() ?? {}
    const account = store.get<B2bAccount>('b2b_account', String(quote.account_id ?? ''))
    const moq = factLine(facts, 'pricing_moq')
    const lead_time = factLine(facts, 'delivery')
    const address = options.companyAddress?.()
    const website = options.companyWebsite?.()
    const sheet = buildQuoteSheet({
      letterhead: {
        company: ourCompany(),
        ...(address === undefined ? {} : { address }),
        ...(website === undefined ? {} : { website }),
        ...(lh.color === undefined ? {} : { color: lh.color }),
        ...(lh.font_family === undefined ? {} : { font_family: lh.font_family }),
      },
      number: String(quote.number ?? quote_id),
      version: v,
      customer: {
        name: account?.name ?? String(quote.account_id ?? '—'),
        ...(account?.country === undefined ? {} : { country: account.country }),
      },
      ...(moq === undefined ? {} : { moq }),
      ...(lead_time === undefined ? {} : { lead_time }),
      notes: [
        'Prices exclude import duties, taxes and destination charges unless the price term says otherwise.',
        'Custom logo, color box or packaging: separate MOQ and plate fee, quoted on request.',
      ],
      issued_at: v.created_at,
    })
    return { sheet, quote, v, applied, lh }
  }

  const quoteSheet = async (quote_id: string, version?: number): Promise<B2bQuoteSheetView> => {
    const { sheet, quote, v, lh } = await sheetOf(quote_id, version)
    const pdf = renderQuotePdf(sheet)
    return {
      quote_id,
      number: String(quote.number ?? quote_id),
      version: v.version,
      account: accountName(quote.account_id as string | undefined),
      total_usd: sheet.total_usd,
      incoterm_text: sheet.incoterm_text,
      payment_text: sheet.payment_text,
      valid_until: sheet.valid_until,
      ...(sheet.input.moq === undefined ? {} : { moq: sheet.input.moq }),
      ...(sheet.input.lead_time === undefined ? {} : { lead_time: sheet.input.lead_time }),
      issues: [
        ...sheet.issues,
        ...(pdf.lossy ? ['有字符编不进 PDF（中文等），换成了「?」：公司名 / 客户名请用英文'] : []),
      ],
      font: pdf.font,
      ...(lh.color === undefined ? {} : { color: lh.color }),
      ...(lh.font_family === undefined ? {} : { brand_font: lh.font_family }),
      lossy: pdf.lossy,
    }
  }

  const quotePdf = async (
    quote_id: string,
    version?: number,
  ): Promise<{ bytes: Uint8Array; filename: string }> => {
    const { sheet, quote, v } = await sheetOf(quote_id, version)
    return {
      bytes: renderQuotePdf(sheet).bytes,
      filename: `Quotation-${String(quote.number ?? quote_id)}-V${v.version}.pdf`,
    }
  }

  /** 这家客户第一位有邮箱的联系人（发报价 / 寄样通知给他）。 */
  const contactOf = (
    account_id: string | undefined,
    contact_id?: string,
  ): B2bContact | undefined => {
    if (contact_id !== undefined) return store.get<B2bContact>('b2b_contact', contact_id)
    return store
      .list<B2bContact>('b2b_contact')
      .find((c) => c.account_id === account_id && c.email_ref !== undefined)
  }
  const maskedOf = (c: B2bContact | undefined): string =>
    (c as { email_masked?: string } | undefined)?.email_masked ?? c?.name ?? '—'

  const actorHolder = (actor: B2bActor): B2bHolder => ({
    person_id: actor.person_id,
    assignment_id: actor.assignment_id,
    role_id: actor.role_id,
  })

  const sendQuote = async (
    actor: B2bActor,
    quote_id: string,
    input: B2bQuoteSendInput,
  ): Promise<B2bStagedView> => {
    const { sheet, quote, v, applied } = await sheetOf(quote_id, input.version)
    if (!applied)
      throw new ApiError('conflict', `第 ${v.version} 版还在批，批了才能发给客户（报价永远出卡）。`)
    const account_id = quote.account_id as string | undefined
    const contact = contactOf(account_id, input.contact_id)
    if (contact?.email_ref === undefined)
      throw new ApiError('invalid_input', '这家客户还没有带邮箱的联系人，报价单发不出去。')
    const number = String(quote.number ?? quote_id)
    const filename = `Quotation-${number}-V${v.version}.pdf`
    const first = contact.name.split(/\s+/)[0] ?? ''
    const body = [
      `Hi ${first || 'there'},`,
      '',
      `Please find attached our quotation ${number} (version ${v.version}).`,
      `Price term: ${sheet.incoterm_text}. The quotation is valid until ${sheet.valid_until}.`,
      ...(input.note === undefined || input.note.trim() === '' ? [] : ['', input.note.trim()]),
      '',
      'Happy to go through any of the details.',
      '',
      'Best regards,',
      await senderName(actor.person_id),
      ourCompany(),
    ].join('\n')
    const outcome = await stageCard({
      holder: actorHolder(actor),
      action: B2B_REPLY_ACTION,
      kind: 'b2b_reply',
      target: { type: 'b2b_quote', id: quote_id },
      after: {
        purpose: 'quote_send' satisfies B2bReplyPurpose,
        channel: 'email',
        subject: `Quotation ${number} V${v.version} — ${ourCompany()}`,
        body,
        quote_id,
        version: v.version,
        account_id,
        contact_id: contact.id,
        to_masked: maskedOf(contact),
        attachments: [{ kind: 'quote_pdf', quote_id, version: v.version, filename }],
        total_usd: sheet.total_usd,
        sheet_issues: sheet.issues,
      },
      title: `发报价单：${number} V${v.version} → ${accountName(account_id)}`,
      summary: `把报价单 ${number} 第 ${v.version} 版（${sheet.total_usd} 美元，${sheet.incoterm_text}）发给 ${accountName(account_id)}，PDF 附在卡上${sheet.issues.length === 0 ? '' : `。自查：${sheet.issues.join('；')}`}。`,
      proposer: 'person',
    })
    if (!outcome.ok) return { staged: false, draft_id: '', message: outcome.message }
    emit('b2b.quote_send_staged', { quote_id, version: v.version, change_id: outcome.change.id })
    return {
      staged: true,
      draft_id: '',
      change_id: outcome.change.id,
      approval_item_id: outcome.approval.id,
      level: outcome.approval.automation.level_at_creation,
    }
  }

  /* ── 样品：往前走一步、寄样通知、超期提醒 ─────────────────────────────── */

  const sampleRule = (): { ship_grace_days: number; feedback_days: number } => {
    const holder = salesHolder()
    const caps = holder === undefined ? {} : actionOf(holder.assignment_id, 'stage_b2b_sample').caps
    const n = (v: unknown, d: number): number => (typeof v === 'number' ? v : d)
    return {
      ship_grace_days: n(caps.sample_overdue_days, 0),
      feedback_days: n(caps.feedback_overdue_days, 14),
    }
  }

  const itemsText = (s: B2bSample): string => s.items.map((i) => `${i.sku} ×${i.qty}`).join('、')

  const advanceSample = async (
    actor: B2bActor,
    sample_id: string,
    input: B2bSampleAdvanceInput,
  ): Promise<B2bStagedView> => {
    const sample = store.get<B2bSample>('b2b_sample', sample_id)
    if (sample === undefined) throw new ApiError('not_found', `没有这份样品：${sample_id}`)
    // 顺序在这里判；「已寄要单号」交给 guardrail（最后那道闸，拦下来回那句人话）
    const order = sampleStepProblem(sample.status, input.status, 'x')
    if (order !== undefined) return { staged: false, draft_id: '', message: order }
    const now = clock.now()
    const { feedback_days } = sampleRule()
    const record: Record<string, unknown> = {
      status: input.status,
      ...(input.tracking_no === undefined ? {} : { tracking_no: input.tracking_no.trim() }),
      ...(input.carrier === undefined ? {} : { carrier: input.carrier.trim() }),
      ...(input.feedback === undefined ? {} : { feedback: input.feedback.trim() }),
      ...(input.status === 'delivered'
        ? {
            delivered_at: now,
            ...(sample.feedback_by === undefined
              ? { feedback_by: new Date(Date.parse(now) + feedback_days * DAY).toISOString() }
              : {}),
          }
        : {}),
    }
    const { draft } = await options.service.port.saveDraft(actor, 'b2b_sample', {
      record_id: sample_id,
      record,
    })
    const staged = await options.service.port.submitDraft(actor, 'b2b_sample', draft.id)
    emit('b2b.sample_advance_staged', {
      sample_id,
      to: input.status,
      staged: staged.staged,
    })
    return staged
  }

  /** 标「已寄」那张卡批了：给客户的寄样通知再出一张卡（寄样通知出卡）。 */
  const afterApplied = async (change: {
    id: string
    kind: string
    after?: unknown
  }): Promise<void> => {
    if (change.kind !== 'b2b_sample') return
    const after = (change.after ?? {}) as Record<string, unknown>
    const rec = (after.record ?? {}) as Record<string, unknown>
    if (after.collection !== 'b2b_sample' || rec.status !== 'shipped') return
    const sample = store.get<B2bSample>('b2b_sample', String(rec.id))
    if (sample?.tracking_no === undefined) return
    const account = store.get<B2bAccount>('b2b_account', sample.account_id)
    const contact = contactOf(sample.account_id, sample.contact_id)
    const holder = holderOf(account?.owner_person_id)
    if (holder === undefined) return
    if (contact?.email_ref === undefined) {
      emit('b2b.sample_notice_skipped', { sample_id: sample.id, reason: 'no_contact_email' })
      return
    }
    const notice = sampleShippedNotice({
      first_name: contact.name.split(/\s+/)[0] ?? '',
      items: itemsText(sample),
      ...(sample.carrier === undefined ? {} : { carrier: sample.carrier }),
      tracking_no: sample.tracking_no,
      sender_name: await senderName(holder.person_id),
      our_company: ourCompany(),
    })
    const outcome = await stageCard({
      holder,
      action: B2B_REPLY_ACTION,
      kind: 'b2b_reply',
      target: { type: 'b2b_sample', id: sample.id },
      after: {
        purpose: 'sample_notice' satisfies B2bReplyPurpose,
        channel: 'email',
        subject: notice.subject,
        body: notice.body,
        sample_id: sample.id,
        account_id: sample.account_id,
        contact_id: contact.id,
        to_masked: maskedOf(contact),
      },
      title: `寄样通知：${account?.name ?? sample.account_id}`,
      summary: `样品（${itemsText(sample)}）已寄出，单号 ${sample.tracking_no}。这封通知发给 ${maskedOf(contact)}。`,
    })
    emit('b2b.sample_notice_staged', { sample_id: sample.id, staged: outcome.ok })
  }

  /** 每天一拍：超期不寄 / 超期没反馈 → 给业务员开一条待办（同一个截止日只提醒一次）。 */
  const sweep = async (): Promise<{ reminders: number }> => {
    const now = clock.now()
    const samples = store.list<B2bSample & { delivered_at?: string }>('b2b_sample')
    let reminders = 0
    for (const due of sampleReminders(samples, now, sampleRule())) {
      const sample = samples.find((s) => s.id === due.sample_id)
      if (sample === undefined) continue
      const account = store.get<B2bAccount>('b2b_account', sample.account_id)
      const holder = holderOf(account?.owner_person_id)
      const title =
        due.kind === 'ship_overdue'
          ? `样品超期 ${due.days_over} 天还没寄：${account?.name ?? sample.account_id}`
          : `样品寄出后 ${due.days_over} 天没反馈，去问一声：${account?.name ?? sample.account_id}`
      const seen = new Set(store.sampleReminders().map((r) => sampleReminderId(r)))
      if (seen.has(sampleReminderId(due))) continue
      const todo_id =
        options.work !== undefined && holder !== undefined
          ? options.work.createTodo({
              title,
              owner: holder.person_id,
              note: itemsText(sample),
              horizon: 'today',
              position_id: holder.assignment_id as never,
            }).id
          : undefined
      store.saveSampleReminder({
        sample_id: sample.id,
        kind: due.kind,
        due: due.due,
        days_over: due.days_over,
        ...(todo_id === undefined ? {} : { todo_id }),
        at: now,
      })
      reminders += 1
      emit('b2b.sample_reminder', {
        sample_id: sample.id,
        kind: due.kind,
        days_over: due.days_over,
        todo: todo_id !== undefined,
      })
    }
    return { reminders }
  }

  /* ── 离职交接 ────────────────────────────────────────────────────────── */

  const KIND_ZH: Readonly<Record<string, string>> = {
    account: '客户',
    deal: '商机',
    inquiry: '询盘',
  }

  const onMemberLeft = async (
    person_id: PersonId,
    _by: PersonId,
  ): Promise<{ handover_id?: string; approval_item_id?: string }> => {
    const accounts = store.list<B2bAccount>('b2b_account')
    const opportunities = store.list<B2bOpportunity>('b2b_opportunity')
    const inquiries = store.inquiries()
    const owner = await options.owner()
    // 接手的人：还在做「业务」的同事（离开的人的分配已经撤了）；一个都没有就交给老板
    const successors = [
      ...new Set(
        options
          .holders()
          .filter((h) => h.role_id === 'b2b.sales' && h.person_id !== person_id)
          .map((h) => h.person_id),
      ),
    ]
      .sort()
      .map((id) => ({ person_id: id }))
    const fallback = successors[0]?.person_id ?? owner
    const plan = planHandover({
      departing: person_id,
      accounts,
      opportunities,
      inquiries,
      successors,
      ...(fallback === undefined ? {} : { fallback }),
    })
    if (plan.items.length + plan.unassigned.length === 0) return {}
    const departingName = (await options.personName?.(person_id)) ?? person_id
    const names = new Map<string, string>()
    for (const i of plan.items)
      if (i.successor_id !== undefined && !names.has(i.successor_id))
        names.set(i.successor_id, (await options.personName?.(i.successor_id)) ?? i.successor_id)
    const id = `hov_${nextId('h')}`
    const where = (i: { region?: string; product_line?: string }): string =>
      [i.region, i.product_line].filter(Boolean).join(' · ')
    const lines = [
      ...plan.items.map(
        (i) =>
          `· ${KIND_ZH[i.kind] ?? i.kind}「${i.name}」${where(i) === '' ? '' : `（${where(i)}）`} → ${names.get(i.successor_id ?? '') ?? '—'}`,
      ),
      ...plan.unassigned.map(
        (i) => `· ${KIND_ZH[i.kind] ?? i.kind}「${i.name}」→ 没人接，批了先归你`,
      ),
    ]
    const summary = [
      `${departingName}离开了。他名下 ${plan.totals.accounts} 家客户、${plan.totals.deals} 个商机、${plan.totals.inquiries} 条没回的询盘，按接手的人在管的地区 / 产品线分：`,
      ...lines.slice(0, 30),
      ...(lines.length > 30 ? [`…还有 ${lines.length - 30} 条`] : []),
      '批了才改归属；不批就都先留在原处。',
    ].join('\n')
    const holder: B2bHolder = options.holders().find((h) => h.role_id === 'b2b.sales') ??
      options.holders()[0] ?? {
        person_id: (owner ?? person_id) as PersonId,
        assignment_id: `asg_b2b_handover_${workspace_id}` as AssignmentId,
        role_id: 'b2b.sales' as RoleId,
      }
    const recipient = owner ?? holder.person_id
    const outcome = await stageCard({
      holder,
      action: B2B_TRANSFER_ACTION,
      kind: 'b2b_account_transfer',
      target: { type: 'person', id: person_id },
      after: {
        handover_id: id,
        departing: person_id,
        departing_name: departingName,
        items: plan.items.map((i) => ({ ...i, successor_name: names.get(i.successor_id ?? '') })),
        unassigned: plan.unassigned,
        totals: plan.totals,
        value_usd: plan.totals.value_usd,
      },
      title: `离职交接：${departingName} 的客户交给谁`,
      summary,
      recipients: [{ person: recipient, via: 'owner' }],
      rule: 'owner',
    })
    store.saveHandover({
      id,
      departing: person_id,
      items: plan.items,
      unassigned: plan.unassigned,
      status: outcome.ok ? 'pending' : 'rejected',
      ...(outcome.ok
        ? { change_id: outcome.change.id, approval_item_id: outcome.approval.id }
        : {}),
      created_at: clock.now(),
    })
    emit('b2b.handover_staged', {
      handover_id: id,
      items: plan.items.length,
      unassigned: plan.unassigned.length,
      staged: outcome.ok,
    })
    return outcome.ok
      ? { handover_id: id, approval_item_id: outcome.approval.id }
      : { handover_id: id }
  }

  /** 交接卡批了：改客户 / 商机 / 询盘的归属（没人接的归批的人——老板）。 */
  const applyHandover = async (change: {
    id: string
    after?: unknown
  }): Promise<BackendResult | undefined> => {
    const after = (change.after ?? {}) as Record<string, unknown>
    const hid = str(after.handover_id)
    const h = hid === undefined ? undefined : store.handover(hid)
    if (h === undefined) return undefined
    const owner = await options.owner()
    const now = clock.now()
    const reassign = (kind: string, id: string, to: PersonId): void => {
      if (kind === 'account') {
        const a = store.get<B2bAccount>('b2b_account', id)
        if (a !== undefined)
          store.put('b2b_account', { ...a, owner_person_id: to, updated_at: now })
      } else if (kind === 'deal') {
        const o = store.get<B2bOpportunity>('b2b_opportunity', id)
        if (o !== undefined)
          store.put('b2b_opportunity', { ...o, owner_person_id: to, updated_at: now })
      } else if (kind === 'inquiry') {
        const i = store.inquiry(id)
        if (i !== undefined) store.saveInquiry({ ...i, owner_person_id: to })
      }
    }
    for (const i of h.items)
      if (i.successor_id !== undefined) reassign(i.kind, i.id, i.successor_id)
    if (owner !== undefined) for (const i of h.unassigned) reassign(i.kind, i.id, owner)
    store.saveHandover({ ...h, status: 'applied', applied_at: now })
    emit('b2b.handover_applied', {
      handover_id: h.id,
      moved: h.items.length,
      to_owner: h.unassigned.length,
    })
    return {
      status: 'ok',
      execution_id: `b2b_handover_${change.id}`,
      outcome_ref: { type: 'person', id: h.departing },
    }
  }

  /* ── 执行器：回信 / 报价单 / 寄样通知批了就发 ────────────────────────── */

  const failed = (message: string, retryable = false): BackendResult => ({
    status: 'failed',
    error: { message, retryable },
  })

  const contactAddress = (contact_id: string | undefined): string | undefined => {
    const c =
      contact_id === undefined ? undefined : store.get<B2bContact>('b2b_contact', contact_id)
    return c?.email_ref === undefined
      ? undefined
      : options.secrets?.get(c.email_ref)?.[B2B_SECRET_FIELD]
  }

  const applyReply = async (change: {
    id: string
    after?: unknown
  }): Promise<BackendResult | undefined> => {
    const after = (change.after ?? {}) as Record<string, unknown>
    const purpose = str(after.purpose) as B2bReplyPurpose | undefined
    if (purpose === undefined || !PURPOSES.has(purpose)) return undefined
    const subject = str(after.subject) ?? ''
    const body = typeof after.body === 'string' ? after.body : ''
    const inquiry =
      str(after.inquiry_id) === undefined ? undefined : store.inquiry(String(after.inquiry_id))
    const now = clock.now()

    if (after.channel === 'whatsapp') {
      const to =
        str(after.wa_to_ref) === undefined
          ? undefined
          : options.secrets?.get(String(after.wa_to_ref))?.[B2B_SECRET_FIELD]
      if (to === undefined) return failed('找不到这位 WhatsApp 联系人的号码（加密库里没有）。')
      if (options.sendWhatsApp === undefined) return failed('这台机器还没接 WhatsApp 发信。')
      const sent = await options.sendWhatsApp({
        to,
        text: body,
        ...(str(after.last_inbound_at) === undefined
          ? {}
          : { last_inbound_at: String(after.last_inbound_at) }),
        ...(str(after.template_id) === undefined ? {} : { template_id: String(after.template_id) }),
      })
      if (!sent.ok) return failed(sent.message ?? 'WhatsApp 没发出去。')
      if (inquiry !== undefined) store.saveInquiry({ ...inquiry, status: 'replied' })
      emit('b2b.reply_sent', { purpose, channel: 'whatsapp', change_id: change.id })
      return {
        status: 'ok',
        execution_id: `b2b_reply_${change.id}`,
        outcome_ref: { type: 'thread', id: inquiry?.thread_id ?? change.id },
      }
    }

    if (options.sendMail === undefined) return failed('这台机器发不了信（没有接上的邮箱）。')
    let to: string | undefined
    let in_reply_to: string | undefined
    let references: string[] = []
    let account: string | undefined
    if (purpose === 'inquiry_first_reply') {
      const m = await options.messageOf?.(String(after.message_id ?? ''))
      to = m?.from
      in_reply_to = m?.rfc_message_id
      references = [
        ...(m?.references ?? []),
        ...(m?.rfc_message_id === undefined ? [] : [m.rfc_message_id]),
      ]
      account = m?.account
    } else {
      to = contactAddress(str(after.contact_id))
    }
    if (to === undefined) return failed('找不到收件人（原信不在消息库里了，或联系人没有邮箱）。')
    const attachments: { filename: string; content_type: string; content: Uint8Array }[] = []
    if (purpose === 'quote_send') {
      try {
        const pdf = await quotePdf(String(after.quote_id), Number(after.version))
        attachments.push({
          filename: pdf.filename,
          content_type: 'application/pdf',
          content: pdf.bytes,
        })
      } catch (e) {
        return failed(`报价单生成不了：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const res = await options.sendMail({
      ...(account === undefined ? {} : { account }),
      to: [to],
      subject,
      text: body,
      ...(in_reply_to === undefined ? {} : { in_reply_to }),
      ...(references.length === 0 ? {} : { references }),
      ...(attachments.length === 0 ? {} : { attachments }),
      thread_ref: str(after.thread_id) ?? `b2b:${purpose}:${change.id}`,
      idempotency_key: `b2b_reply:${change.id}`,
    })
    if (!res.ok) return failed(res.error ?? '没发出去。', res.retryable === true)
    store.noteOutbound(
      {
        message_id: res.message_id,
        kind: purpose === 'quote_send' ? 'quote' : 'reply',
        ...(str(after.account_id) === undefined ? {} : { account_id: String(after.account_id) }),
        ...(str(after.contact_id) === undefined ? {} : { contact_id: String(after.contact_id) }),
      },
      now,
    )
    if (inquiry !== undefined) store.saveInquiry({ ...inquiry, status: 'replied' })
    if (purpose === 'quote_send') {
      const q = store.get<B2bQuote>('b2b_quote', String(after.quote_id))
      if (q !== undefined) store.put('b2b_quote', { ...q, status: 'sent', updated_at: now })
    }
    emit('b2b.reply_sent', {
      purpose,
      channel: 'email',
      change_id: change.id,
      attachments: attachments.length,
    })
    return {
      status: 'ok',
      execution_id: `b2b_reply_${change.id}`,
      outcome_ref: { type: 'message', id: res.message_id },
    }
  }

  const apply = async (change: {
    id: string
    kind: string
    after?: unknown
  }): Promise<BackendResult | undefined> => {
    if (change.kind === 'b2b_account_transfer') return applyHandover(change)
    if (change.kind === 'b2b_reply') return applyReply(change)
    return undefined
  }

  /* ── 「业务」职责页那一块与面板补丁 ───────────────────────────────────── */

  const overdueOf = (now: string) => {
    const due = sampleReminders(
      store.list<B2bSample & { delivered_at?: string }>('b2b_sample'),
      now,
      sampleRule(),
    )
    return new Map(due.map((d) => [d.sample_id, d]))
  }

  /** 面板打开时顺带看一眼超期样品（每小时最多一次；定时那一拍可能没建——没人做主动开发时）。 */
  let lastSweep = 0
  const view = async (): Promise<B2bSalesView> => {
    const now = clock.now()
    if (Date.parse(now) - lastSweep >= 3_600_000) {
      lastSweep = Date.parse(now)
      await sweep().catch(() => undefined)
    }
    const overdue = overdueOf(now)
    const drafts = store.drafts()
    const pendingOf = (collection: 'b2b_quote' | 'b2b_sample', id: string) =>
      drafts
        .filter(
          (d) => d.collection === collection && d.record_id === id && d.status === 'submitted',
        )
        .at(-1)
    const quoteRows = new Map<string, Record<string, unknown>>()
    for (const q of store.list<Record<string, unknown> & { id: string }>('b2b_quote'))
      quoteRows.set(q.id, q)
    for (const d of drafts)
      if (d.collection === 'b2b_quote' && d.status === 'submitted' && !quoteRows.has(d.record_id))
        quoteRows.set(d.record_id, { ...d.record, id: d.record_id })
    const quotes = [...quoteRows.values()].map((q) => {
      const id = String(q.id)
      const versions = store.quoteVersions(id)
      const latest = versions.at(-1)
      const pending = pendingOf('b2b_quote', id)
      const v = pending?.quote_version ?? latest
      return {
        id,
        number: String(q.number ?? id),
        account: accountName(q.account_id as string | undefined),
        version: v?.version ?? 0,
        amount_usd: v?.amount_usd ?? 0,
        status: String(q.status ?? 'draft'),
        ...(pending?.quote_version === undefined
          ? {}
          : {
              pending: {
                version: pending.quote_version.version,
                ...(pending.approver === undefined ? {} : { approver: pending.approver }),
                breaches: pending.breaches ?? [],
                ...(pending.approval_item_id === undefined
                  ? {}
                  : { approval_item_id: pending.approval_item_id }),
              },
            }),
      }
    })
    const samples = store
      .list<B2bSample>('b2b_sample')
      .filter((s) => s.status !== 'feedback')
      .map((s) => {
        const o = overdue.get(s.id)
        const due = s.status === 'to_ship' ? s.ship_by : s.feedback_by
        return {
          id: s.id,
          account: accountName(s.account_id),
          items: itemsText(s),
          status: s.status,
          ...(s.tracking_no === undefined ? {} : { tracking_no: s.tracking_no }),
          ...(due === undefined ? {} : { due: due.slice(0, 10) }),
          ...(o === undefined ? {} : { overdue: o.kind, overdue_days: o.days_over }),
          ...(pendingOf('b2b_sample', s.id) === undefined ? {} : { pending: true }),
        }
      })
      .sort((a, b) => (b.overdue_days ?? 0) - (a.overdue_days ?? 0))
    const handovers = await Promise.all(
      store
        .handovers()
        .filter((h) => h.status === 'pending')
        .map(async (h) => ({
          id: h.id,
          departing: (await options.personName?.(h.departing)) ?? h.departing,
          items: h.items.length,
          unassigned: h.unassigned.length,
          status: h.status,
        })),
    )
    return { facts: await factsView(), quotes, samples, handovers }
  }

  /** 面板「业务」四块：询盘带上分级，样品带上超期（数据仍是 `b2bDeckFromStore` 那一份）。 */
  const deckPatch = (now: string, base: B2bDeckData): B2bDeckData => {
    const overdue = overdueOf(now)
    const byKey = new Map(
      store
        .inquiries()
        .filter((i) => i.status === 'new')
        .map((i) => [`${i.subject}|${i.received_at}`, i]),
    )
    const samples = store.list<B2bSample>('b2b_sample').filter((s) => s.status !== 'feedback')
    return {
      ...base,
      inquiries: base.inquiries.map((r) => {
        const i = byKey.get(`${r.subject}|${r.received_at}`)
        return i?.grade === undefined ? r : { ...r, grade: B2B_INQUIRY_GRADE_ZH[i.grade] }
      }),
      samples: base.samples.map((r, idx) => {
        const s = samples[idx]
        const o = s === undefined ? undefined : overdue.get(s.id)
        return o === undefined ? r : { ...r, overdue_days: o.days_over }
      }),
    }
  }

  const port: B2bSalesPort = {
    view: () => view(),
    facts: () => factsView(),
    setupFacts: () => setupFacts(),
    quoteSheet: (_actor, id, version) => quoteSheet(id, version),
    quotePdf: (_actor, id, version) => quotePdf(id, version),
    sendQuote,
    advanceSample,
  }

  void SAMPLE_STATUS_ZH
  void quoteBreachText
  void maskAddress

  return {
    port,
    onInquiry,
    intakeWhatsApp,
    apply,
    afterApplied,
    sweep,
    onMemberLeft,
    deckPatch,
  }
}

/**
 * 报价单信头的色与字（品牌设计 `DESIGN.md` 那一份）：主色取名字像 primary / brand 的那一格，
 * 没有就取第一个不是黑白灰的；字体取标题那一格，没有就取第一个。一样都没有 = 用默认（深灰 + Helvetica）。
 */
export function b2bLetterheadOf(
  profile:
    | {
        colors?: Record<string, { value: string }>
        typography?: Record<string, { value: { fontFamily?: string } }>
      }
    | undefined,
): { color?: string; font_family?: string } {
  const colors = Object.entries(profile?.colors ?? {})
  const hex = (v: string): string | undefined => {
    const m = /^#?([0-9a-f]{6})$/i.exec(v.trim())
    return m?.[1] === undefined ? undefined : `#${m[1].toLowerCase()}`
  }
  const vivid = (v: string): boolean => {
    const h = hex(v)
    if (h === undefined) return false
    const n = Number.parseInt(h.slice(1), 16)
    const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    return Math.max(...rgb) - Math.min(...rgb) > 40
  }
  const named = colors.find(
    ([k, v]) => /primary|brand|accent/i.test(k) && hex(v.value) !== undefined,
  )
  const color = hex(
    named?.[1].value ??
      colors.find(([, v]) => vivid(v.value))?.[1].value ??
      colors[0]?.[1].value ??
      '',
  )
  const fonts = Object.entries(profile?.typography ?? {})
  const font =
    fonts.find(([k]) => /heading|display|title|h1/i.test(k))?.[1].value.fontFamily ??
    fonts.find(([, v]) => v.value.fontFamily !== undefined)?.[1].value.fontFamily
  return {
    ...(color === undefined ? {} : { color }),
    ...(font === undefined ? {} : { font_family: font }),
  }
}
