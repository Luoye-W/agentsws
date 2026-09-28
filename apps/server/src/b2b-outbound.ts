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
  B2bReplyClassifyInput,
  B2bReplyClassifyView,
  B2bSequenceRowView,
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
  type B2bReplyAction,
  classifyB2bReply,
  coldEmailPrompt,
  cooldownLabel,
  DKIM_TEST_WAIT_MS,
  declineCooldown,
  dkimWaitedTooLong,
  domainOfAddress,
  draftB2bOutreach,
  EXCLUDE_REASON_ZH,
  evaluateDkimDns,
  evaluateSenderAuth,
  hasRelationship,
  inCooldown,
  isSeparateSendingDomain,
  listUnsubscribeHeader,
  localDay,
  outreachBatchAfter,
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
  B2bDeclineCooldown,
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
import {
  B2B_DE_AT_REASON,
  B2B_DECLINED_COOLDOWN_DAYS,
  B2B_DKIM_SELECTORS,
  B2B_SENDER_CHOICE_KIND,
} from '@agentsws/contracts'
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
  /** WP176：「不感兴趣」冷却天数（职责阈值 `b2b_declined_cooldown_days`；不给 = 90）。 */
  declinedCooldownDays?(): number | undefined
  /**
   * WP176：公司档案上的公司实体地址（开发信页脚、报价单、单证同一份）。不给 = 老装配：
   * 仍用「主动开发」设置里那一格。
   */
  companyAddress?(): string | undefined
  /** WP176：写回公司档案（旧设置里的地址搬过去 / 老客户端 PUT 设置时）。档案还没建回 `false`。 */
  saveCompanyAddress?(address: string | undefined): boolean
  /**
   * WP176：云端检查地址（测试信发到云端、由云端读信头；网关那边做，这里只留接口）。
   * 给了且回得出地址，测试信就发到那里，等满 10 分钟先问它要信头，要不到再按 DNS 兜底。
   */
  cloudAuthCheck?: {
    address(sender: string): string | undefined
    result(test_message_id: string): Promise<string | undefined>
  }
  /** WP176：定个时（测试信等满 10 分钟再按 DNS 查 DKIM）。不给用 `setTimeout`（unref）。 */
  later?(fn: () => void, ms: number): void
  /** WP176：按消息库 id 取一封信（Run 里「把一封回信分类」用）。 */
  message?(
    id: string,
  ):
    | { subject: string; text: string; headers: Record<string, string> }
    | undefined
    | Promise<{ subject: string; text: string; headers: Record<string, string> } | undefined>
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
    /** WP176 加 `cooldown`：不感兴趣只停这一轮、进冷却（不进抑制名单）。 */
    action: B2bReplyAction
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

/** WP176：回信之后接下来怎么办（Run 里分类工具回的那一句）。 */
export const REPLY_ACTION_ZH: Readonly<Record<B2bReplyAction, string>> = {
  hand_to_sales: '停序列，交给业务',
  suppress: '停序列，进抑制名单（永久）',
  postpone: '自动回复，不算回信：按回来日期顺延',
  stop: '停序列',
  cooldown: '停这一轮，进冷却（期满可以再联系）',
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

  /**
   * WP176（Fable 09-28）：公司实体地址搬进公司档案。「主动开发」设置里原来那一格有值、档案里还没有，
   * 就搬过去（档案里已经有了以档案为准），搬完把这一格清掉。档案还没建过就搬不成，照旧读这一格。
   */
  const moveAddress = (): void => {
    const settings = settingsOf()
    const old = settings.postal_address?.trim()
    if (old === undefined || old === '' || options.saveCompanyAddress === undefined) return
    const current = options.companyAddress?.()?.trim()
    const had = current !== undefined && current !== ''
    if (!had && !options.saveCompanyAddress(old)) return
    const { postal_address: _moved, ...rest } = settings
    const now = clock.now()
    store.saveOutboundSettings({ ...rest, postal_address_moved_at: now, updated_at: now })
    emit('b2b.company_address_moved', { profile_had_address: had })
  }

  /** 页脚用的公司实体地址（公司档案为准；档案还没建时兜底用旧设置那一格）。 */
  const postalAddress = (): { value?: string; from: 'profile' | 'outbound_settings' } => {
    moveAddress()
    const profile = options.companyAddress?.()?.trim()
    if (profile !== undefined && profile !== '') return { value: profile, from: 'profile' }
    const old = settingsOf().postal_address?.trim()
    if (old !== undefined && old !== '') return { value: old, from: 'outbound_settings' }
    return { from: options.companyAddress === undefined ? 'outbound_settings' : 'profile' }
  }

  /* ── WP176：「不感兴趣」冷却 ─────────────────────────────────────────── */

  const cooldownDays = (): number => {
    const d = options.declinedCooldownDays?.()
    return d !== undefined && Number.isFinite(d) && d > 0 ? d : B2B_DECLINED_COOLDOWN_DAYS
  }

  /** 冷却记录两种认法：地址哈希（同一个人换了联系人记录也认得出）、联系人 id（从别的地址回的信）。 */
  const cooldownIndex = (): {
    byHash: Map<string, B2bDeclineCooldown>
    byContact: Map<string, B2bDeclineCooldown>
  } => {
    const byHash = new Map<string, B2bDeclineCooldown>()
    const byContact = new Map<string, B2bDeclineCooldown>()
    for (const c of store.cooldowns()) {
      byHash.set(c.key_hash, c)
      if (c.contact_id === undefined) continue
      const prior = byContact.get(c.contact_id)
      if (prior === undefined || prior.until < c.until) byContact.set(c.contact_id, c)
    }
    return { byHash, byContact }
  }
  const cooldownOf = (
    index: ReturnType<typeof cooldownIndex>,
    contact: { id: string; email_key_hash?: string } | undefined,
  ): B2bDeclineCooldown | undefined => {
    if (contact === undefined) return undefined
    const a =
      contact.email_key_hash === undefined ? undefined : index.byHash.get(contact.email_key_hash)
    const b = index.byContact.get(contact.id)
    if (a === undefined) return b
    if (b === undefined) return a
    return a.until >= b.until ? a : b
  }
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
      // WP176：用户勾了「这只邮箱已经正常发信很久」——不预热
      established: sender.established !== undefined,
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
    // WP176：说过不感兴趣而停下的那一轮不算"开过序列"——冷却期满可以再开；其余开过的照旧不自动重开
    const declined = new Set<string>()
    const enrolled = new Set<string>()
    for (const e of store.enrollments())
      (e.reply_class === 'not_interested' ? declined : enrolled).add(e.contact_id)
    const cooling = cooldownIndex()
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
          ...(() => {
            const cd = cooldownOf(cooling, c)
            return {
              // 说过不感兴趣却找不到冷却记录（不该有）：按"开过序列"算，宁可不发
              in_sequence: enrolled.has(c.id) || (declined.has(c.id) && cd === undefined),
              ...(cd === undefined ? {} : { cooldown_until: cd.until, declined_count: cd.count }),
            }
          })(),
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
      title: '开发信从哪只邮箱发？强烈建议用单独的发信域名',
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
    // WP176：接了云端检查地址就发到那里（Gmail 自己发给自己的信常常不进收件箱）；没接照旧发给自己
    const probe = options.cloudAuthCheck?.address(sender.address)
    if (options.sendMail !== undefined) {
      const sent = await options.sendMail({
        account: sender.address,
        to: [probe ?? sender.address],
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
        ...(test_message_id === undefined ? {} : { test_message_id, test_sent_at: now }),
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
    // WP176：测试信 10 分钟还没收回来，就按 DNS 查 DKIM（到点再看一眼；那时已收回来就什么都不做）
    if (test_message_id !== undefined) {
      const tick = (): void => {
        void settleDkim()
          .then((ok) => {
            if (ok) advanceLater()
          })
          .catch((e: unknown) => {
            emit('b2b.sender_check_failed', { detail: String(e).slice(0, 160) })
          })
      }
      if (options.later !== undefined) options.later(tick, DKIM_TEST_WAIT_MS + 1_000)
      else setTimeout(tick, DKIM_TEST_WAIT_MS + 1_000).unref?.()
    }
    return next
  }

  /** 测试信的信头到手了（收件箱里收回来 / 云端检查地址读到）：判 DKIM。回 SPF + DKIM 过没过。 */
  const applyTestHeader = (sender: B2bSender, header: string, from: string): boolean => {
    const ev = evaluateSenderAuth({
      domain: sender.domain,
      spf_txt: sender.dns?.spf_txt,
      dmarc_txt: sender.dns?.dmarc_txt,
      auth_header: header,
      test_sent: true,
    })
    const {
      test_message_id: _t,
      test_sent_at: _s,
      dkim_selector: _k,
      dkim_via: _v,
      ...rest
    } = sender.auth
    store.saveSender({ ...sender, auth: { ...rest, ...ev, checked_at: clock.now() } })
    emit('b2b.sender_checked', {
      domain: sender.domain,
      spf: ev.spf,
      dkim: ev.dkim,
      dmarc: ev.dmarc,
      from,
    })
    return senderAuthOk(ev)
  }

  /**
   * WP176（Fable 09-28）：**DKIM 检查不卡在 Gmail**。测试信发出去满 10 分钟还没收回来：
   * 先问云端检查地址要信头（接了的话），要不到就按常见选择器查 DKIM 的 DNS 记录——查到公钥就算
   * 「DNS 已配置（未经实信验证）」，允许发（卡上写明）；查不到仍不发。测试信的 Message-ID 留着：
   * 之后真收回来了，照样按信头再判一次（实信结果为准）。回：有没有哪只邮箱因此变成能发了。
   */
  const settleDkim = async (): Promise<boolean> => {
    const now = clock.now()
    let unlocked = false
    for (const sender of store.senders()) {
      if (!dkimWaitedTooLong(sender.auth, now)) continue
      const cloud = options.cloudAuthCheck
      const id = sender.auth.test_message_id
      if (cloud !== undefined && id !== undefined) {
        let header: string | undefined
        try {
          header = await cloud.result(id)
        } catch {
          header = undefined
        }
        if (header !== undefined) {
          if (applyTestHeader(sender, header, 'cloud_probe')) unlocked = true
          continue
        }
      }
      const records: { selector: string; txt: string[] | undefined }[] = []
      for (const selector of B2B_DKIM_SELECTORS) {
        const t = await txt(`${selector}._domainkey.${sender.domain}`)
        records.push({ selector, txt: t })
        if (
          evaluateDkimDns({ domain: sender.domain, records: [{ selector, txt: t }] }).dkim ===
          'pass'
        )
          break
      }
      const r = evaluateDkimDns({ domain: sender.domain, records })
      const { dkim_selector: _k, dkim_via: _v, ...rest } = sender.auth
      const auth = {
        ...rest,
        dkim: r.dkim,
        notes: [...rest.notes.filter((n) => !n.startsWith('DKIM：')), r.note],
        checked_at: now,
        ...(r.dkim === 'pass' && r.selector !== undefined
          ? { dkim_via: 'dns' as const, dkim_selector: r.selector }
          : {}),
      }
      store.saveSender({ ...sender, auth })
      emit('b2b.sender_checked', {
        domain: sender.domain,
        spf: auth.spf,
        dkim: auth.dkim,
        dmarc: auth.dmarc,
        from: 'dns_selector',
        ...(r.selector === undefined ? {} : { selector: r.selector }),
      })
      if (senderAuthOk(auth)) unlocked = true
    }
    return unlocked
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
    const now = clock.now()
    const screened = screenProspects(prospectsOf(), {
      de_at_confirmed: settings.de_at !== undefined,
      now,
    })
    const address = postalAddress()
    const needs: B2bQueuedReason[] = []
    if (sender === undefined) needs.push('sender_choice')
    if (address.value === undefined) needs.push('company_address')
    if (sender !== undefined && !senderAuthOk(sender.auth)) needs.push('sender_auth')
    return {
      settings: {
        ...(settings.company_name === undefined ? {} : { company_name: settings.company_name }),
        ...(address.value === undefined ? {} : { postal_address: address.value }),
        postal_address_from: address.from,
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
              established: sender.established !== undefined,
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
      cooling: coolingList(now),
    }
  }

  /** WP176：冷却中的人（最先到期的在前，最多 50 位）。名字从联系人库里取，认不出只给遮过的地址。 */
  const coolingList = (now: string): NonNullable<B2bOutboundView['cooling']> => {
    const contacts = new Map(store.list<ContactRow>('b2b_contact').map((c) => [c.id, c]))
    const byHash = new Map<string, ContactRow>()
    for (const c of contacts.values())
      if (c.email_key_hash !== undefined) byHash.set(c.email_key_hash, c)
    const accounts = new Map(store.list<B2bAccount>('b2b_account').map((a) => [a.id, a]))
    return store
      .cooldowns()
      .filter((c) => inCooldown(c.until, now))
      .slice(0, 50)
      .map((c) => {
        const contact =
          (c.contact_id === undefined ? undefined : contacts.get(c.contact_id)) ??
          byHash.get(c.key_hash)
        const company = contact === undefined ? undefined : accounts.get(contact.account_id)?.name
        return {
          ...(contact === undefined ? {} : { contact_id: contact.id, name: contact.name }),
          ...(company === undefined ? {} : { company }),
          masked: c.masked,
          until: c.until,
          count: c.count,
        }
      })
  }

  const saveSettings = (actor: B2bActor, input: B2bOutboundSettingsInput): B2bOutboundView => {
    const prior = settingsOf()
    const trim = (v: string | undefined): string | undefined =>
      v === undefined ? undefined : v.trim() === '' ? undefined : v.trim()
    const next = { ...prior, updated_at: clock.now() }
    if (input.company_name !== undefined) next.company_name = trim(input.company_name) as string
    // WP176：地址的真源是公司档案——写得进档案就写档案（这一格清掉），档案还没建才落在这里
    if (input.postal_address !== undefined) {
      const moved = options.saveCompanyAddress?.(trim(input.postal_address)) === true
      if (moved) {
        delete next.postal_address
        next.postal_address_moved_at = clock.now()
      } else next.postal_address = trim(input.postal_address) as string
    }
    if (input.sender_name !== undefined) next.sender_name = trim(input.sender_name) as string
    for (const k of ['company_name', 'postal_address', 'sender_name'] as const)
      if (next[k] === undefined) delete next[k]
    if (input.de_at_confirm === true)
      next.de_at = { confirmed_by: actor.person_id, confirmed_at: clock.now() }
    if (input.de_at_confirm === false) delete next.de_at
    store.saveOutboundSettings(next)
    if (input.de_at_confirm !== undefined)
      emit('b2b.de_at_confirmation', { confirmed: input.de_at_confirm, by: actor.person_id })
    // WP176：「这只邮箱已经正常发信很久」——勾了不预热（新域名别勾）
    const sender = currentSender()
    if (input.sender_established !== undefined && sender !== undefined) {
      const { established: _e, ...rest } = sender
      store.saveSender(
        input.sender_established
          ? { ...rest, established: { by: actor.person_id, at: clock.now() } }
          : rest,
      )
      emit('b2b.sender_established', {
        domain: sender.domain,
        established: input.sender_established,
      })
    }
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

  /**
   * 一封：先问模型（按 cold-email 技能），不合规矩就退回模板。WP176（Fable 09-28）：跟进与收尾
   * 也由模型写（和首封同一个上限、同一道承诺词自查）；它们回在首封那条线程里，主题一律用系统那一个。
   */
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
      budget.model > 0 && skill !== undefined
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
            step,
            prospect: {
              ...(contact?.title === undefined ? {} : { title: contact.title }),
              ...(account?.country === undefined ? {} : { country: account.country }),
              ...(contact?.source?.url === undefined ? {} : { source_url: contact.source.url }),
              ...(contact?.note === undefined ? {} : { note: contact.note }),
            },
          }),
        })
        const raw = parseModelDraft(out.text)
        // 跟进 / 收尾回在同一条线程里：主题用系统那一个（`Re:` + 首封主题），模型写的主题不用
        const parsed =
          raw === undefined || step === 'first' ? raw : { ...raw, subject: draft.subject }
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
      postal_address: postalAddress().value,
      step,
      source: contacts[0]?.source,
    })
    // WP176：以前说过不感兴趣、冷却期满又选进来的人——卡上点名（说过两次的另外提醒）
    const cooling = cooldownIndex()
    const again = (step === 'first' ? list : [])
      .map((e, i) => ({ e, c: contacts[i], cd: cooldownOf(cooling, contacts[i]) }))
      .filter((x) => x.cd !== undefined)
    const againNotes =
      again.length === 0
        ? []
        : [
            `以前说过不感兴趣、冷却期已满又选进来的 ${again.length} 位：${again
              .slice(0, 3)
              .map(
                (x) =>
                  `${accounts.get(x.e.account_id)?.name ?? x.e.account_id}（${x.c?.name ?? '—'}${(x.cd?.count ?? 0) >= 2 ? `，说过 ${x.cd?.count} 次` : ''}）`,
              )
              .join('、')}${again.length > 3 ? ' 等' : ''}。`,
            ...(again.some((x) => (x.cd?.count ?? 0) >= 2)
              ? ['说过两次以上不感兴趣的，这一轮再没回音就别再找了。']
              : []),
          ]
    const senderNotes = [
      ...(sender.established === undefined
        ? []
        : ['这只邮箱标了「已经正常发信很久」，不走预热（每天按上限发）；新域名别这么标。']),
      ...(sender.auth.dkim_via === 'dns'
        ? [
            `DKIM 按 DNS 记录判的（${sender.auth.dkim_selector ?? '常见选择器'}）：测试信没收回来，未经实信验证。`,
          ]
        : []),
    ]
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
      ...againNotes,
      ...senderNotes,
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
      after: outreachBatchAfter({
        step,
        batch_id,
        sender,
        emails,
        recipients: contacts.map((c) => c?.email_key_hash ?? ''),
        suppressed: store.suppressions().map((s) => s.key_hash),
        footer: footer !== undefined,
        contacts_missing_source: contacts.filter((c) => c?.source?.observed_at === undefined)
          .length,
        countries,
        de_at_confirmed: settings.de_at !== undefined,
        extra: { emails },
      }),
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
    // WP176：测试信等满 10 分钟没收回来的，先按 DNS 把 DKIM 判了
    await settleDkim()
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
    if (postalAddress().value === undefined) {
      markQueued(pending, 'company_address')
      return {
        status: 'queued',
        queued_reason: 'company_address',
        picked: 0,
        queued_tomorrow: 0,
        message:
          '每封开发信的页脚都要公司实体地址（法规要求），先在「设置 → 公司档案」里填上再发。',
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
    // 德奥默认没放进来的那几位：卡上也写一句原因（选邮箱之后才出卡时，开一轮那一刻的说明已经过去了）
    const deAt = screenProspects(prospectsOf(), {
      de_at_confirmed: settings.de_at !== undefined,
      now: clock.now(),
    }).excluded.filter((x) => x.reason === 'de_at').length
    const deAtNote =
      deAt > 0 && !notes.some((n) => n.includes(B2B_DE_AT_REASON))
        ? [`德国 / 奥地利 ${deAt} 位没放进来：${B2B_DE_AT_REASON}。`]
        : []
    const extra =
      later.length > 0 ? [`另有 ${later.length} 位超了今天配额（${quota.cap} 封），排到明天。`] : []
    const out = await stageBatch(actor, 'first', today, checked, [...extra, ...deAtNote, ...notes])
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
      now: clock.now(),
    })
    const shown = excluded
      .filter((x) => input.contact_ids !== undefined || x.reason !== 'in_sequence')
      .map((x) => ({
        contact_id: x.prospect.contact_id,
        name: x.prospect.name,
        company: x.prospect.company,
        reason: x.reason,
        // WP176：冷却中的写明到哪天
        label:
          x.reason === 'cooldown' && x.prospect.cooldown_until !== undefined
            ? cooldownLabel(x.prospect.cooldown_until)
            : EXCLUDE_REASON_ZH[x.reason],
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
    if (options.sendMail === undefined) return failed('这台机器上没有能发信的邮箱，没发。')
    const now = clock.now()
    const postal = postalAddress().value
    const cooling = cooldownIndex()
    let sent = 0
    let retry = false
    const errors: string[] = []
    for (const { m, e } of mine) {
      const contact = store.get<ContactRow>('b2b_contact', e.contact_id)
      const footer = outreachFooter({
        company_name: ourCompany(),
        postal_address: postal,
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
      // WP176：批卡之前这个人说了不感兴趣（从别的线程 / 别的联系人记录）——冷却中，这一封不发
      const cd = contact === undefined ? undefined : cooldownOf(cooling, contact)
      if (cd !== undefined && inCooldown(cd.until, now)) {
        saveEnrollment(e, { status: 'stopped', stop_reason: 'cooldown' })
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
    if (applyTestHeader(sender, record.headers['authentication-results'] ?? '', 'test_mail'))
      advanceLater()
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
              : action === 'suppress' || action === 'cooldown'
                ? 'stopped'
                : 'replied',
          reply_class: cls.klass,
          replied_at: now,
          ...(action === 'suppress' || action === 'cooldown' ? { stop_reason: cls.klass } : {}),
        })
      }
    }
    /*
     * WP176（Luoye 09-28）：「不感兴趣」只停这一轮——进冷却（默认 90 天，职责阈值可改），
     * 期满可以再被选进新一轮；同一个人第二次说冷却翻倍。**不进永久抑制名单**。
     */
    let cooldown: B2bDeclineCooldown | undefined
    if (action === 'cooldown') {
      const key_hash = addressHash(record.from.email)
      const prior = cooldownOf(cooldownIndex(), {
        id: note.contact_id ?? '',
        email_key_hash: key_hash,
      })
      const next = declineCooldown({
        prior_count: prior?.count ?? 0,
        base_days: cooldownDays(),
        now,
      })
      cooldown = {
        key_hash,
        masked: maskAddress(record.from.email),
        ...(note.contact_id === undefined ? {} : { contact_id: note.contact_id }),
        count: next.count,
        days: next.days,
        declined_at: now,
        until: next.until,
        message_id: record.id,
      }
      store.saveCooldown(cooldown)
      emit('b2b.cooldown_started', {
        ...(note.contact_id === undefined ? {} : { contact_id: note.contact_id }),
        count: next.count,
        days: next.days,
        until: next.until,
      })
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
      ...(cooldown === undefined ? {} : { cooldown_until: cooldown.until }),
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
    // ②a WP176：测试信等满 10 分钟没收回来的，按 DNS 判 DKIM
    await settleDkim()
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
          // 分过类的 + 没分出来还开着的（WP172 那一种，待分）
          (i.reply_class !== undefined || i.status === 'new') &&
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
    return {
      outreach_today: today,
      // 还没开过序列 = 空态（不画一排 0）
      sequence_funnel: enrollments.length === 0 ? [] : sequenceFunnel(enrollments),
      replies,
    }
  }

  /* ── WP176：Run 里的开发信工具用的两个只读口 ─────────────────────────── */

  const sequences = (_actor: B2bActor): { rows: B2bSequenceRowView[] } => {
    const contacts = new Map(store.list<ContactRow>('b2b_contact').map((c) => [c.id, c]))
    const accounts = new Map(store.list<B2bAccount>('b2b_account').map((a) => [a.id, a]))
    const rows = store
      .enrollments()
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((e) => {
        const last = e.steps.at(-1)?.step
        return {
          enrollment_id: e.id,
          contact_id: e.contact_id,
          name: contacts.get(e.contact_id)?.name ?? e.contact_id,
          company: accounts.get(e.account_id)?.name ?? e.account_id,
          status: e.status,
          ...(last === undefined ? {} : { last_step: last }),
          ...(e.next_step === undefined || !LIVE.has(e.status) ? {} : { next_step: e.next_step }),
          ...(e.due_at === undefined || e.status !== 'active' ? {} : { due_at: e.due_at }),
          ...(e.queued_reason === undefined || e.status !== 'queued'
            ? {}
            : { queued_reason: e.queued_reason }),
          ...(e.reply_class === undefined ? {} : { reply_class: e.reply_class }),
        }
      })
    return { rows }
  }

  /** 只判不改：真回信停序列、进冷却 / 名单，是邮件分拣那一路（`onReply`）的事。 */
  const classifyReply = async (
    _actor: B2bActor,
    input: B2bReplyClassifyInput,
  ): Promise<B2bReplyClassifyView> => {
    let subject = input.subject ?? ''
    let text = input.text ?? ''
    let headers: Record<string, string> = {}
    const inquiry = input.inquiry_id === undefined ? undefined : store.inquiry(input.inquiry_id)
    if (input.inquiry_id !== undefined && inquiry === undefined)
      throw new Error(`找不到这条往来记录：${input.inquiry_id}`)
    if (inquiry !== undefined) {
      const m = await options.message?.(inquiry.message_id)
      subject = m?.subject ?? inquiry.subject
      text = m?.text ?? text
      headers = m?.headers ?? {}
    }
    if (subject.trim() === '' && text.trim() === '')
      throw new Error('没有信可分：给一条往来记录的 id，或者给信的主题与正文。')
    const cls = classifyB2bReply({ subject, text, headers, now: clock.now() })
    const action = B2B_REPLY_ACTION[cls.klass]
    return {
      class: cls.klass,
      label: B2B_REPLY_ZH[cls.klass],
      action,
      action_label: REPLY_ACTION_ZH[action],
      signals: cls.signals,
      ...(cls.return_date === undefined ? {} : { return_date: cls.return_date }),
      ...(inquiry === undefined ? {} : { inquiry_id: inquiry.id }),
    }
  }

  const port: B2bOutboundPort = {
    // WP176：面板一刷新，测试信等满 10 分钟没收回来的就按 DNS 判 DKIM
    view: async (actor) => {
      if (await settleDkim()) advanceLater()
      return view(actor)
    },
    saveSettings,
    start,
    checkSender,
    sequences,
    classifyReply,
  }

  return { port, apply, onSenderChosen, observe, onReply, stopContact, sweep, deckData }
}
