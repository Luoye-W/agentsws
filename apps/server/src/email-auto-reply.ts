/**
 * WP440（docs/108 M9，Luoye 10-21）：**邮件客服也按把握直接回**——照在线客服 WP428 那一套。
 *
 * 「邮件客服也照在线客服那套按把握直接发。」
 *
 * 以前：客服判断层的三道自主门放行时结论是 `auto_reply`，但出卡处一律 L1、审批总线 L1 永不自动批，
 * 于是邮件里的「自动回复」只是个标记，每封都要人批。现在一封客服来信在**起 Run 之前**过这一道：
 *
 * ```text
 * 判断层说 auto_reply（三道门放行）── 开关开着、不是 Amazon、不是影子模式、认得出原发件人
 *        │
 *        ├─ 剥掉引用的旧邮件与签名，只拿新写的部分当问句（splitEmailForAnswer）
 *        ├─ 同一个分类与涉钱词表（退款 / 赔偿 / 改单 / 要人工一律转人）
 *        ├─ 一次轻模型起草：材料带编号、句后标出处、末尾自评（同聊天）
 *        ├─ 同一个判定 scoreAutoAnswer（一律转人清单、打分、三档、出处与数字核对、学到的同类）
 *        ├─ 三道自主门再扫一遍真要发的那一版
 *        ▼
 * outbound_draft（L2 + confident_reply）──▶ 审批总线自动批 ──▶ 执行器施行 ──▶ 出站门（急停 / Amazon 硬闸 / outbox）
 *        │ 施行没过（出站门拦下）──▶ 退回成卡（L1，标题后写「出站门拦下」）
 * ```
 *
 * 任何一步不过：照旧起 Run、出卡，卡标题后面写一句为什么（`heldNote`，同 WP428 的理由词）。
 * **不绕开审批总线和出站门**：自动批的是总线自己核过的（`txn` 的 `autoApprovable`），发信的是执行器那一条路。
 *
 * 学到的「不该直接回」与在线客服的「这句不该直接答」是**同一份**（`learnedHolds` / `learn` 接到聊天车道上）。
 * 记录落盘 `email-auto-reply.json`：只存问句词面与出处，不存客户原话。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ApprovalItem,
  Clock,
  CreateApprovalInput,
  EventEnvelope,
  GateDecision,
  ObjectRef,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import {
  type AutoAnswerSource,
  type AutoAnswerStrictness,
  type ChatLearnedHold,
  chatTokens,
  composeEmailReply,
  DEFAULT_CHAT_AUTO_ANSWER_STRICTNESS,
  type EmailHold,
  emailAnswerPlan,
  emailAnswerPrompt,
  emailAnswerSystem,
  emailAutoReplyGate,
  emailHeldShort,
  scoreAutoAnswer,
  splitEmailForAnswer,
} from '@agentsws/support-core'
import { cardRefOf, type Work } from '@agentsws/work'
import type { EmailAutoReplyOutcome, EmailAutoReplyRequest } from './channels.js'
import { type ChatKnowledgeHit, orderRefIn, privateValuesOf } from './chat.js'

const FILE = 'email-auto-reply.json'
const MAX_RECORDS = 2000
const MAX_KNOWLEDGE_HITS = 4
const MAX_HELD_THREADS = 500

/** 这只邮箱现在的设置（「消息渠道 → 每只邮箱」那一处）。 */
export interface EmailAutoReplySetting {
  on: boolean
  strictness?: AutoAnswerStrictness
  shadow_mode?: boolean
}

export interface EmailAutoReplyOptions {
  workspace_id: WorkspaceId
  clock: Clock
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 卡片出口（14 §1）：自动批也是这一个口，总线自己核。 */
  approvals: { create<P>(input: CreateApprovalInput<P>): Promise<ApprovalItem<P>> }
  /** 自动批下来的那张立刻施行（`txn.executor.applyApproval(id, { skip_cancel_window: true })`）。 */
  applyNow(item_id: string): Promise<ApprovalItem>
  models?: ModelGatewayApi
  /** 客服那条职责挂谁名下。 */
  position(): { person_id: PersonId; assignment_id: string; role_id: RoleId } | undefined
  /** WP488：`ctx.thread` = 这条邮件线程（同一线程售前 / 售后只让 AI 判一次）。 */
  searchKnowledge?(
    text: string,
    limit: number,
    ctx?: { thread?: string },
  ): Promise<ChatKnowledgeHit[]>
  /** 来信里报了订单号 → 只读查这一单（与聊天同一个记录源）。 */
  lookupOrder?(order_ref: string): Promise<unknown | undefined>
  /** 按收信那只邮箱取开关与档位；认不出邮箱（`undefined`）按缺省。 */
  setting(account: string | undefined): EmailAutoReplySetting
  /** 学到的「不该直接答 / 回」（与在线客服同一份）。 */
  learnedHolds(): readonly ChatLearnedHold[]
  learn(hold: ChatLearnedHold & { message_id: string }): void
  /**
   * 三道自主门 + 泄漏守卫再扫一遍**真要发的那一版**（`support-judgment.ts` 的 `judgeDraft`）。
   * 不给 = 不直接回（没有门就不自主）。
   */
  judgeDraft?(input: {
    thread_id: string
    inbound_text: string
    reply_text: string
  }): { action: 'send' | 'rewrite' | 'card'; gate_context: GateDecision[] } | undefined
  /** 回信真发出去 → 首响 SLA 停表。 */
  noteOutbound?(thread_id: string): void
  work?: Work
  /** 落款（品牌 / 团队名）；不给按来信语言用「客服团队」/「Customer Support」。 */
  signature?(): string | undefined
  /** 不直接回的渠道细分；不给 = `EMAIL_AUTO_REPLY_EXCLUDED_SUB_CHANNELS`（Amazon）。 */
  excluded_sub_channels?: readonly string[]
  dbDir?: string
}

/** 直接回的一封记一笔（时间线「AI 直接回 · 出处」与「这封不该直接回」都读它）。 */
interface AutoReplyRecord {
  approval_item_id: string
  matter_id: string
  thread_id: string
  /** 问句的词面（不存原话）。 */
  tokens: string[]
  intent: string
  sources: { kind: string; id: string; label: string }[]
  score: number
  strictness: AutoAnswerStrictness
  at: string
  /** 发出去那封的开头一段（给人对得上是哪一封）。 */
  excerpt: string
  flagged?: { by: string; at: string }
}

export interface EmailAutoReplyMark {
  approval_item_id: string
  at: string
  score: number
  sources: { kind: string; label: string }[]
  excerpt: string
  flagged: boolean
}

export interface EmailAutoReply {
  /** 一封客服来信：能直接回就回（回 `sent: true`）；不能就说为什么。 */
  attempt(input: EmailAutoReplyRequest): Promise<EmailAutoReplyOutcome>
  /** 这条线程最近一次「为什么没直接回」（运行时那张回信卡的标题后面那一句）。 */
  heldNote(thread_id: string): string | undefined
  /** 人点「这封不该直接回」→ 记进学习回路；不是直接回的那一封回 `undefined`。 */
  flag(input: { approval_item_id: string; by: PersonId }): { learned: boolean } | undefined
  /** 这张卡是不是 AI 直接回的那一封。 */
  of(approval_item_id: string): EmailAutoReplyMark | undefined
  /** 这几件事上 AI 直接回的那几封（消息页「全部」时间线读它）。 */
  forMatters(matter_ids: readonly string[]): EmailAutoReplyMark[]
}

const markOf = (r: AutoReplyRecord): EmailAutoReplyMark => ({
  approval_item_id: r.approval_item_id,
  at: r.at,
  score: r.score,
  sources: r.sources.map((s) => ({ kind: s.kind, label: s.label })),
  excerpt: r.excerpt,
  flagged: r.flagged !== undefined,
})

const threadRef = (id: string): ObjectRef => ({ type: 'thread', id })

/** 「Re: 」只加一次。 */
const replySubject = (subject: string | undefined): string => {
  const s = (subject ?? '').trim()
  if (s === '') return 'Re:'
  return /^re\s*[:：]/i.test(s) ? s : `Re: ${s}`
}

const SYSTEM = [
  '你是这家店的邮件客服。只按给你的材料回答；材料里没有的事不编。',
  '短、具体、礼貌；不承诺钱、不许具体到哪天的时间、不复述客户的个人信息。',
].join('\n')

export function createEmailAutoReply(options: EmailAutoReplyOptions): EmailAutoReply {
  const { clock, workspace_id } = options
  const file = options.dbDir === undefined ? undefined : join(options.dbDir, FILE)
  let records: AutoReplyRecord[] = []
  if (file !== undefined && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { records?: unknown }
      if (Array.isArray(parsed.records)) records = parsed.records as AutoReplyRecord[]
    } catch {
      // 读坏了从空开始（它是记录与学习信号，不是账：账在审批总线里）
    }
  }
  const flush = (): void => {
    if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS)
    if (file === undefined) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ version: 1, records })}\n`, 'utf8')
  }
  /** 线程 → 最近一次没直接回的那句短理由（卡标题用；只在内存里，进程重启后下一封来信重新算）。 */
  const heldByThread = new Map<string, string>()
  let seq = 0

  const emit = (type: string, thread_id: string, payload: Record<string, unknown>): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type: type as EventEnvelope['type'],
      actor: { kind: 'system', id: 'support:email_auto_reply' },
      subject: { type: 'thread', id: thread_id },
      correlation: { trace_id: `tr_support_${thread_id}` },
      payload,
    })
  }

  const held = (
    req: EmailAutoReplyRequest,
    hold: EmailHold,
    extra: { score?: number; reasons?: string[]; note?: string; card_id?: string } = {},
  ): EmailAutoReplyOutcome => {
    const short = emailHeldShort(hold.kind)
    heldByThread.delete(req.thread_id)
    heldByThread.set(req.thread_id, short)
    while (heldByThread.size > MAX_HELD_THREADS) {
      const first = heldByThread.keys().next().value
      if (first === undefined) break
      heldByThread.delete(first)
    }
    emit('support.email_auto_reply_held', req.thread_id, {
      reason: hold.kind,
      ...(extra.score === undefined ? {} : { score: extra.score }),
      ...(extra.card_id === undefined ? {} : { approval_item_id: extra.card_id }),
    })
    return {
      sent: false,
      kind: hold.kind,
      ...(extra.note === undefined ? {} : { note: extra.note }),
      ...(extra.card_id === undefined ? {} : { card_id: extra.card_id }),
    }
  }

  /** 材料：知识（K1…）+ 来信里报了订单号就现查那一单（O1）。同聊天。 */
  const sourcesFor = async (question: string, thread?: string): Promise<AutoAnswerSource[]> => {
    const sources: AutoAnswerSource[] = []
    const orderRef = orderRefIn(question)
    if (orderRef !== undefined && options.lookupOrder !== undefined) {
      const order = await options.lookupOrder(orderRef).catch(() => undefined)
      if (order !== undefined)
        sources.push({
          ref: 'O1',
          kind: 'order',
          id: orderRef,
          label: `订单 ${orderRef}（刚查的）`,
          text: JSON.stringify(order).slice(0, 1500),
          private_values: privateValuesOf(order),
        })
    }
    const hits =
      (await options
        .searchKnowledge?.(question, MAX_KNOWLEDGE_HITS, thread === undefined ? {} : { thread })
        .catch(() => [])) ?? []
    for (const [i, h] of hits.entries())
      sources.push({
        ref: `K${i + 1}`,
        kind: h.layer === 'policy' ? 'policy' : 'fact_card',
        id: h.fact_card_id,
        label: h.statement.replace(/\s+/g, ' ').slice(0, 24),
        text: h.statement,
        ...(h.stale === true ? { stale: true } : {}),
      })
    return sources
  }

  /** 卡挂谁、发给谁、长什么样（直接发的那张与「退回成卡」那张同一份，只差等级与标题）。 */
  const cardInput = (
    req: EmailAutoReplyRequest,
    contact: ObjectRef,
    position: { person_id: PersonId; assignment_id: string; role_id: RoleId },
    body: { subject: string; text: string },
    auto: Record<string, unknown>,
    mode:
      | {
          direct: true
          gates: GateDecision[]
          confident: { score: number; strictness: string; source_ids: string[] }
        }
      | { direct: false; title_note: string; gates: GateDecision[] },
    citations: { fact_card_id: string; quote: string }[],
  ): CreateApprovalInput<Record<string, unknown>> => {
    seq += 1
    const who = req.from_display ?? '来信人'
    const subjectLine = req.subject ?? body.subject
    return {
      workspace_id,
      schema_version: 1,
      kind: 'outbound_draft',
      role_id: position.role_id,
      subject: {
        object: threadRef(req.thread_id),
        matter_id: req.matter.id,
        work_item_id: req.matter.id,
        conversation_id: req.matter.id,
      },
      dedupe_key: `${workspace_id}:email_auto_reply:${req.matter.id}:${clock.now()}:${seq}${mode.direct ? '' : ':held'}`,
      title: `回复 ${who}：${subjectLine}${mode.direct ? '' : `（${mode.title_note}）`}`,
      summary: body.text.split('\n').filter((l) => l.trim() !== '')[1] ?? subjectLine,
      payload: {
        channel: 'email',
        to: contact,
        body,
        thread_ref: req.thread_id,
        auto_reply: auto,
      },
      evidence: {
        run_id: `run_email_auto_${req.matter.id}_${seq}`,
        source_events: [],
        provenance: { seen: [threadRef(req.thread_id), contact] },
        precheck: {},
        citations,
      },
      proposer: {
        kind: 'agent',
        id: position.assignment_id,
        assignment_id: position.assignment_id,
      },
      automation: {
        // 直接发的那张是 L2（总线只在 confident_reply + 三道门全放行时自动批）；退回成卡的那张照旧 L1
        level_at_creation: mode.direct ? 'L2' : 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: position.person_id, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 8, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: true,
      },
      priority: 'queue',
      context: {
        thread_participants: [contact.id],
        verified_contacts: [contact.id],
        ...(mode.gates.length === 0 ? {} : { gates: mode.gates }),
        ...(mode.direct ? { confident_reply: mode.confident } : {}),
      },
    }
  }

  const attempt = async (req: EmailAutoReplyRequest): Promise<EmailAutoReplyOutcome> => {
    const setting = options.setting(req.account)
    const gate = emailAutoReplyGate({
      enabled: setting.on,
      inbound_action: req.inbound_action,
      ...(req.sub_channel === undefined ? {} : { sub_channel: req.sub_channel }),
      ...(options.excluded_sub_channels === undefined
        ? {}
        : { excluded_sub_channels: options.excluded_sub_channels }),
      has_recipient: req.contact !== undefined,
      ...(setting.shadow_mode === undefined ? {} : { shadow_mode: setting.shadow_mode }),
    })
    if (gate !== undefined) return held(req, gate)
    const contact = req.contact as ObjectRef
    const position = options.position()
    const models = options.models
    if (position === undefined || models === undefined)
      return held(req, { kind: 'no_model', reason: '没接模型，先给你看' })

    // ① 先剥：只拿这一封新写的部分（签名里的电话、地址不让它转人——个人信息只看回复）
    const { question } = splitEmailForAnswer(req.text)
    // ② 同一个分类与涉钱词表：退款 / 赔偿 / 改单 / 要人工 → 不问模型，照旧出卡
    const plan = emailAnswerPlan(question)
    if (plan.action !== 'answer' || plan.money_touch)
      return held(req, { kind: 'money', reason: '涉及退款、赔偿、改单或要人工，一律转人' })

    // ③ 一次轻模型起草：材料带编号、句后标出处、末尾自评
    const sources = await sourcesFor(question, req.thread_id)
    // 一条材料都没有：不可能逐句有出处——不花这一次模型，照旧出卡（同判定里的「没出处」）
    if (sources.length === 0)
      return held(req, { kind: 'no_source', reason: '知识库和订单里都没有能对上的出处' })
    let raw: string
    try {
      const completion = await models.complete({
        messages: [
          // WP471：固定说明 + 出处要求在系统提示（同品牌每封信逐字一样），信件和材料在用户消息
          { role: 'system', content: emailAnswerSystem(SYSTEM) },
          {
            role: 'user',
            content: emailAnswerPrompt({
              sources,
              question,
              ...(req.subject === undefined ? {} : { subject: req.subject }),
            }),
          },
        ],
        meta: {
          workspace_id,
          assignment_id: position.assignment_id,
          role_id: position.role_id,
          run_id: `run_email_auto_${req.matter.id}_${clock.now()}`,
          purpose: 'run',
        },
      })
      raw = completion.text.trim()
    } catch {
      // 模型挂了 / 预算耗尽 / 急停：不编一封信，照旧出卡
      return held(req, { kind: 'no_model', reason: '模型这会儿用不了' })
    }
    if (raw === '') return held(req, { kind: 'no_model', reason: '模型没写出东西' })

    // ④ 同一个判定（一律转人清单、打分、三档、出处与数字核对、学到的同类）
    const strictness = setting.strictness ?? DEFAULT_CHAT_AUTO_ANSWER_STRICTNESS
    const verdict = scoreAutoAnswer({
      plan,
      turn_text: question,
      reply: raw,
      sources,
      strictness,
      learned_holds: options.learnedHolds(),
    })
    if (!verdict.send)
      return held(req, verdict.hold ?? { kind: 'low_confidence', reason: '把握不够' }, {
        score: verdict.score,
        reasons: verdict.reasons,
      })

    const signature = options.signature?.()
    const text = composeEmailReply({
      answer: verdict.text,
      question,
      ...(req.from_display === undefined ? {} : { from_display: req.from_display }),
      ...(signature === undefined ? {} : { signature }),
    })
    // ⑤ 三道自主门 + 泄漏守卫再扫一遍真要发的那一版
    const judged = options.judgeDraft?.({
      thread_id: req.thread_id,
      inbound_text: question,
      reply_text: text,
    })
    if (judged === undefined || judged.action !== 'send')
      return held(
        req,
        { kind: 'not_autonomous', reason: '三道自主门没放行这一版回信' },
        {
          score: verdict.score,
        },
      )

    const used = verdict.sources_used.map((x) => ({ kind: x.kind, id: x.id, label: x.label }))
    const auto = {
      score: verdict.score,
      strictness,
      sources: used,
      factors: verdict.factors,
    }
    const citations = verdict.sources_used
      .filter((x) => x.kind !== 'order')
      .map((x) => ({ fact_card_id: x.id, quote: x.text.slice(0, 200) }))
    const body = { subject: replySubject(req.subject), text }
    const item = await options.approvals.create(
      cardInput(
        req,
        contact,
        position,
        body,
        auto,
        {
          direct: true,
          gates: judged.gate_context,
          confident: {
            score: verdict.score,
            strictness,
            source_ids: used.map((x) => x.id),
          },
        },
        citations,
      ),
    )
    if (item.state === 'blocked')
      return held(
        req,
        { kind: 'outbound_blocked', reason: '出站门拦下（收件人 / 内容）' },
        {
          score: verdict.score,
        },
      )
    if (item.state !== 'auto_approved') {
      // 总线没放行自动批（等级 / 门的结论对不上）：它已经是一张等人批的卡了，不再起 Run 重复出一张
      options.work?.onCard(cardRefOf(item))
      return held(
        req,
        { kind: 'not_autonomous', reason: '审批总线没放行自动发' },
        {
          score: verdict.score,
          card_id: item.id,
          note: 'AI 拟好了一版回信，等你点头再发。',
        },
      )
    }

    // ⑥ 施行：执行器那一条路（出站急停、Amazon 硬闸、outbox 只发一次）
    let applied: ApprovalItem | undefined
    let error: string | undefined
    try {
      applied = await options.applyNow(item.id)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    if (applied?.state !== 'applied') {
      const why =
        error ??
        applied?.apply?.attempts.at(-1)?.error ??
        '出站门没放行（急停 / 平台规则 / 发信失败）'
      // 退回成卡：同一封回信，L1，标题后写「出站门拦下」；人改一改再发
      const card = await options.approvals.create(
        cardInput(
          req,
          contact,
          position,
          body,
          { ...auto, held: 'outbound_blocked', reasons: [why.split('\n')[0] ?? why] },
          {
            direct: false,
            title_note: emailHeldShort('outbound_blocked'),
            gates: judged.gate_context,
          },
          citations,
        ),
      )
      if (card.state !== 'blocked') options.work?.onCard(cardRefOf(card))
      return held(
        req,
        { kind: 'outbound_blocked', reason: why },
        {
          score: verdict.score,
          ...(card.state === 'blocked' ? {} : { card_id: card.id }),
          note: 'AI 拟好的回信被出站门拦下，退回成卡等你看。',
        },
      )
    }

    // ⑦ 发出去了：记一笔、进时间线、停表
    const at = clock.now()
    const record: AutoReplyRecord = {
      approval_item_id: item.id,
      matter_id: req.matter.id,
      thread_id: req.thread_id,
      tokens: [...chatTokens(question)].slice(0, 80),
      intent: plan.intent,
      sources: used,
      score: verdict.score,
      strictness,
      at,
      excerpt: verdict.text.replace(/\s+/g, ' ').slice(0, 140),
    }
    records.push(record)
    flush()
    heldByThread.delete(req.thread_id)
    options.work?.onCard(cardRefOf(applied))
    options.noteOutbound?.(req.thread_id)
    emit('support.email_auto_replied', req.thread_id, {
      approval_item_id: item.id,
      score: verdict.score,
      strictness,
      source_ids: used.map((x) => x.id),
      factors: verdict.factors,
    })
    const labels = used.map((x) => x.label).join('、')
    return {
      sent: true,
      approval_item_id: item.id,
      note: `AI 有把握，直接回了这一封${labels === '' ? '' : ` · 出处：${labels}`}。`,
    }
  }

  return {
    attempt,
    heldNote: (thread_id) => heldByThread.get(thread_id),
    flag(input) {
      const record = records.find((r) => r.approval_item_id === input.approval_item_id)
      if (record === undefined) return undefined
      if (record.flagged === undefined) {
        record.flagged = { by: input.by, at: clock.now() }
        options.learn({
          tokens: record.tokens,
          intent: record.intent,
          source_ids: record.sources.filter((x) => x.kind !== 'order').map((x) => x.id),
          message_id: record.approval_item_id,
        })
        flush()
        emit('support.email_auto_reply_flagged', record.thread_id, {
          approval_item_id: record.approval_item_id,
        })
      }
      return { learned: true }
    },
    of(approval_item_id) {
      const r = records.find((x) => x.approval_item_id === approval_item_id)
      return r === undefined ? undefined : markOf(r)
    },
    forMatters(matter_ids) {
      const set = new Set(matter_ids)
      return records.filter((r) => set.has(r.matter_id)).map(markOf)
    },
  }
}
