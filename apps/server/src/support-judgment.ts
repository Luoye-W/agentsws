/**
 * WP125（72 §1.I / §P0-1）：**客服的判断层接进生产**。
 *
 * 这是这张派工单的头号交付，也是 `docs/72` 的头号发现：
 *
 * > `packages/support-core` 的 `draftReply` / `computeSla` / `shouldEscalate` /
 * > `evaluateAutonomyGates` / `findUnansweredBoundary` / `knowledgeCandidate`
 * > 在 `apps/server` 下的生产引用数是 **0**——它们只活在合成世界与单测里。
 * > 真邮件进来走的是通用 Agent + 一份提示词技能，**没有门**。
 *
 * 本文件把这六个函数接上真路径。**只接线，不改任何纯函数签名**：判定全在
 * `@agentsws/support-core` 里，卡片全经审批总线（14 §1），时间全经 `Clock`。
 *
 * ## 一封客服来信在这里走的顺序（照 `packages/simulation/src/world.ts` 那一串）
 *
 * ```text
 * 分拣判成 support ──▶ 线程归并（thread ledger）
 *                        │
 *                        ├─① classifyText        意图 / 紧急度 / 实体 / 语言
 *                        ├─② computeSla+targetsFor 这封信的首响死线
 *                        ├─③ findUnansweredBoundary 第一次撞到的那条未答边界 → 选择题卡
 *                        ├─④ draftReply           模板草稿（数字只从订单事实来）
 *                        ├─⑤ shouldEscalate       要不要交给人（含强制人工词面、SLA 破线）
 *                        └─⑥ evaluateAutonomyGates 三道门：能不能**自主**发
 *                              │
 *                              ▼
 *                     auto_reply / pending_review / boundary_question / handoff
 * ```
 *
 * ## 三条纪律
 *
 * 1. **fail-closed**。门内报错 = 不自主（`evaluateAutonomyGates` 自己就是这么写的）；
 *    这一层再加一条：判断层自己抛了异常，结论一律退到 `pending_review`——
 *    一个装配错误不该变成"那就自动发吧"。
 * 2. **被扫的文本不落库**。事件与卡片证据里只有门名、结论、规则 id、规则集哈希、
 *    命中长度。客户原文与商家指导原文一个字都不进（同 `gates.ts` 与 `leak-guard.ts`）。
 * 3. **SLA 不出卡**。超时没回的来信进**岗位面板与通知**，不是卡片——
 *    `docs/36` §2.2b「只有要人拍板的才是卡」：一封信超时了，要的是"去看一眼"，
 *    不是"在两个选项里挑一个"。
 *
 * ## 线程账本为什么在内存里
 *
 * SLA 要一个锚点（最后一条**买家**消息的时刻）与一个停表点（我们最后一次回复）。
 * 这两样今天在事项时间线上（`Work`）与消息库里各有一份形态，但都不是按"线程 →
 * 锚点"索引的。本层自己记一份**内存账本**：零新表、零迁移，进程重启后由下一封
 * 来信重新补上。代价写在 `docs/35` 的偏离里：重启后那一窗口内已经在等的线程，
 * 要等下一次来信或下一次回复才重新进巡检。
 */

import type {
  ApprovalItem,
  Clock,
  CreateApprovalInput,
  EventEnvelope,
  GateDecision,
  Iso8601,
  KnowledgeGapWaiter,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import type { PriorityBand } from '@agentsws/deck'
import type { ScheduleInput } from '@agentsws/schedule'
import {
  type AutonomyGateDecision,
  type BoundaryItem,
  type BusinessCalendar,
  boundaryDedupeKey,
  type Classification,
  canAutoPropose,
  classifyText,
  computeSla,
  DEFAULT_BUSINESS_CALENDAR,
  type DraftedReply,
  draftReply,
  type EscalationDecision,
  escalationDedupeKey,
  evaluateAutonomyGates,
  evaluateLeakGuard,
  findUnansweredBoundary,
  type KnowledgeCandidate,
  type KnowledgeHit,
  knowledgeCandidate,
  LEAK_REWRITE_INSTRUCTION,
  policyQuestionRequest,
  type SlaState,
  type SupportPolicy,
  shouldEscalate,
  targetsFor,
  type Vertical,
} from '@agentsws/support-core'

/* ------------------------------------------------------------------ */
/* 巡检的登记（25 §5：调度器只认识一个名字）                               */
/* ------------------------------------------------------------------ */

export const SUPPORT_SLA_HANDLER = 'support.sla_sweep'
export const SUPPORT_SLA_TASK_ID = 'sched_support_sla_sweep'

/**
 * 15 分钟一拍。
 *
 * 邮件的首响窗口按小时算（缺省 24 小时，投诉与高紧急度压到 4 小时），
 * 一刻钟的分辨率足够——把它调到一分钟只会让巡检空跑 15 倍，不会让任何人早收到提醒。
 */
export const SUPPORT_SLA_SWEEP_INTERVAL_MS = 15 * 60_000

export function supportSlaTask(base: {
  workspace_id: WorkspaceId
  owner: PersonId
  role_id: RoleId
  assignment_id: string
}): Omit<ScheduleInput, 'id'> {
  return {
    ...base,
    title: '看一眼超时没回的客户来信（首响 SLA）',
    handler: SUPPORT_SLA_HANDLER,
    trigger: { kind: 'interval', every_ms: SUPPORT_SLA_SWEEP_INTERVAL_MS },
    created_by: 'user',
    // 错过了就跳过：补跑一堆过期巡检没有意义，下一拍一刻钟后就到
    misfire_policy: 'skip',
  }
}

/* ------------------------------------------------------------------ */
/* 对外类型                                                             */
/* ------------------------------------------------------------------ */

/** 这一封的结论。四选一，顺序即优先级。 */
export type SupportAction = 'handoff' | 'boundary_question' | 'pending_review' | 'auto_reply'

export interface ApprovalSink {
  create<P>(input: CreateApprovalInput<P>): Promise<ApprovalItem<P>>
}

export interface InboundJudgmentInput {
  /** 线程 id（归并键；也是知识缺口等待队列的去重键）。 */
  thread_id: string
  text: string
  subject?: string
  from?: string
  /** 这条线程是不是已经被客服职责接管过（分类器据此继续跟进）。 */
  thread_taken_over?: boolean
  /** 事项 id（卡片要挂上去）。 */
  matter_id?: string
  /** 这次运行的 id（进证据）。 */
  run_id?: string
  /** 关系授权门禁已经把这条挡下（15 §6.1）。 */
  authorization_blocked?: boolean
  /** 知识命中（起草引用条款时用）；不给就没有出处。 */
  knowledge_hits?: readonly KnowledgeHit[]
}

export interface InboundJudgment {
  classification: Classification
  sla: SlaState
  escalation: EscalationDecision
  /** 第一次撞到的那条未答边界（出了选择题卡就有值）。 */
  boundary?: BoundaryItem
  boundary_card_id?: string
  /** 模板草稿：数字只从订单事实来，边界没答过时它**不提退款**。 */
  draft: DraftedReply
  gates: AutonomyGateDecision
  action: SupportAction
  /** 派生的优先级带（不存列，见 `@agentsws/deck` 的 `bands.ts`）。 */
  band: PriorityBand
  /** 给人看的一句话（卡面副标题 / 时间线）。**零裸枚举**。 */
  note: string
}

export interface DraftJudgmentInput {
  channel: 'email' | 'chat'
  thread_id: string
  /** 被回复的那封来信正文（Tier-2 盲扫用；不落库）。 */
  inbound_text: string
  /** 拟发出去的正文（承诺扫描与泄漏守卫用；不落库）。 */
  reply_text: string
  /** 草稿来源。人写的不能走自主发送。 */
  generated_by?: string
  missing_info?: string | null
  /** 这条回复已经因为泄漏被重写过几次。 */
  rewrites?: number
  classification?: Classification
}

export interface DraftJudgment {
  /** `send` = 三道门都放行且没泄漏；`rewrite` = 打回重写；`card` = 出卡等人点头。 */
  action: 'send' | 'rewrite' | 'card'
  /** 打回重写时给写正文那一跳的中文原因。 */
  rewrite_instruction?: string
  gates: AutonomyGateDecision
  /** 泄漏守卫：只有长度与结论，**没有内容**。 */
  leak: { leaked: boolean; matched_chars: number }
  /** 进 `ApprovalItem.context.gates` 的那一份（只有门名与结论）。 */
  gate_context: GateDecision[]
}

export interface OverdueThread {
  thread_id: string
  matter_id?: string
  anchor_at: Iso8601
  due_at: Iso8601
  /** 逾期多少分钟（负数 = 还没到）。 */
  overdue_minutes: number
  tier: SlaState['tier']
}

export interface SlaSweepReport {
  scanned: number
  /** 进了提醒档的（剩余 ≤12 小时）。 */
  reminded: number
  /** 已经破线的。 */
  breached: number
}

export interface SupportGapPort {
  /** 落一条缺口（或拿回已经开着的那一条），回 gap id。 */
  openGap(input: { question: string; subject_key: string; run_id?: string }): string | undefined
  /** 记一个等待者（按线程去重）。 */
  addWaiter(gap_id: string, waiter: KnowledgeGapWaiter): void
}

export interface SupportJudgmentOptions {
  workspace_id: WorkspaceId
  clock: Clock
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 卡片出口（14 §1）。不给就只出结论不出卡（测试与最小装配）。 */
  approvals?: ApprovalSink
  /** 这条线挂谁名下。 */
  position?(): { person_id: PersonId; assignment_id: string; role_id: RoleId } | undefined
  /**
   * 已经答过的业务边界（server.ts 的 `detectAnsweredBoundaries` 那一份）。
   *
   * 可以回 Promise——真源在知识库里（**答案不另存一张表**，见 server.ts 的
   * `boundaries` 那一段），读它要过一次异步查询。`judgeInbound` 本来就是 async。
   */
  policies?(): readonly SupportPolicy[] | Promise<readonly SupportPolicy[]>
  /** 48 v2 L2：这个工作区卖的是什么。 */
  vertical?(): Vertical | undefined
  /** SLA 的工作日历；不给按东八区 9–18 点、周一到周五。 */
  calendar?(): BusinessCalendar | undefined
  /** 落款（模板草稿要它）。 */
  signature?(): string
  /**
   * 商家教过这条线程的那几句中文。泄漏守卫要它——**只读不存**，
   * 这一层不会把它写进任何卡片、事件或日志。
   */
  instructions?(thread_id: string): readonly string[]
  /** 知识缺口等待闭环（72 §P0-3）；不给就只出卡不落缺口。 */
  gaps?: SupportGapPort
}

/* ------------------------------------------------------------------ */
/* 线程账本（内存；见文件头「线程账本为什么在内存里」）                      */
/* ------------------------------------------------------------------ */

interface ThreadLedgerRow {
  thread_id: string
  matter_id?: string
  /** 最后一条**买家**消息（SLA 的唯一时钟锚）。 */
  anchor_at: Iso8601
  /** 我们最后一次对外回复（晚于锚点即停表）。 */
  last_outbound_at?: Iso8601
  messages: number
  agent_replies: number
  targets: ReturnType<typeof targetsFor>
  classification?: Classification
  /** 已经因为超时提醒过一次（不重复打扰）。 */
  reminded_at?: Iso8601
}

export interface SupportJudgment {
  /** 入站：分类 → SLA → 边界 → 起草 → 升级 → 三道门。 */
  judgeInbound(input: InboundJudgmentInput): Promise<InboundJudgment>
  /** 出站：泄漏守卫 + 三道自主门。**投递 / 建卡之前**跑。 */
  judgeDraft(input: DraftJudgmentInput): DraftJudgment
  /** 我们回了一封（停表）。 */
  noteOutbound(thread_id: string, at?: Iso8601): void
  /** 巡检：超时没回的来信 → 岗位面板 + 通知（**不出卡**）。 */
  sweepSla(): Promise<SlaSweepReport>
  /** 岗位面板读它（"超时没回的来信 N 封"）。 */
  overdue(): OverdueThread[]
  /** 「教一句」→ 知识候选（承诺类永不自动发布）。 */
  teachCandidate(input: {
    thread_id: string
    instruction: string
    question?: string
    at?: Iso8601
  }): { candidate: KnowledgeCandidate; auto_proposable: boolean } | undefined
  /** 答不上来 → 落缺口 + 记一个等待者（72 §P0-3）。 */
  recordGap(input: {
    thread_id: string
    channel: 'email' | 'chat'
    question: string
    subject_key: string
    language?: string
    run_id?: string
  }): string | undefined
}

export function createSupportJudgment(options: SupportJudgmentOptions): SupportJudgment {
  const { clock, workspace_id } = options
  const ledger = new Map<string, ThreadLedgerRow>()
  /** 已经问过的边界（同一条只问一次，与卡的 `dedupe_key` 是同一把键）。 */
  const askedBoundaries = new Set<string>()

  const policies = async (): Promise<readonly SupportPolicy[]> => (await options.policies?.()) ?? []
  const vertical = (): Vertical | undefined => options.vertical?.()
  const calendar = (): BusinessCalendar => options.calendar?.() ?? DEFAULT_BUSINESS_CALENDAR

  const emit = (type: string, thread_id: string, payload: Record<string, unknown>): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type: type as EventEnvelope['type'],
      actor: { kind: 'system', id: 'support:judgment' },
      subject: { type: 'thread', id: thread_id },
      correlation: { trace_id: `tr_support_${thread_id}` },
      payload,
    })
  }

  /* ── 边界选择题卡（第一次撞到，问一次） ───────────────────────────── */

  const askBoundary = async (
    boundary: BoundaryItem,
    input: InboundJudgmentInput,
    classification: Classification,
  ): Promise<string | undefined> => {
    const key = boundaryDedupeKey(workspace_id, boundary.id)
    if (askedBoundaries.has(key)) return undefined
    askedBoundaries.add(key)
    const approvals = options.approvals
    const position = options.position?.()
    if (approvals === undefined || position === undefined) return undefined
    const request = policyQuestionRequest(boundary, {
      workspace_id,
      ...(input.run_id === undefined ? {} : { run_id: input.run_id }),
      conversation_id: input.thread_id,
      intent: classification.intent,
    })
    const item = await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'policy_change',
      role_id: position.role_id,
      subject: {
        object: { type: 'policy', id: boundary.id },
        ...(input.matter_id === undefined
          ? {}
          : { matter_id: input.matter_id, work_item_id: input.matter_id }),
      },
      dedupe_key: request.dedupe_key,
      title: request.title,
      summary: request.summary,
      payload: request.payload,
      evidence: {
        run_id: input.run_id ?? `run_support_${input.thread_id}`,
        source_events: [],
        provenance: { seen: [{ type: 'thread', id: input.thread_id }] },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: {
        kind: 'agent',
        id: position.assignment_id,
        assignment_id: position.assignment_id,
      },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: position.person_id, via: 'owner' }],
        rule: 'owner',
        escalation: { after_hours: 48, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      // 边界问句没有人在等：它是「无人等待」那一带（P3）
      priority: request.priority,
      options: boundary.options.map((o) => ({ id: o.id, label: o.label })),
    })
    return item.state === 'blocked' ? undefined : item.id
  }

  /* ── 入站 ──────────────────────────────────────────────────────── */

  const judgeInbound = async (input: InboundJudgmentInput): Promise<InboundJudgment> => {
    const now = clock.now()
    const v = vertical()
    const answered = await policies()

    // ① 意图分类（零模型，词表；模型分类在 messages.ts 那一跳已经跑过，这里是判定口径）
    const classification = classifyText(
      {
        text: input.text,
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.from === undefined ? {} : { from: input.from }),
      },
      {
        now,
        ...(v === undefined ? {} : { vertical: v }),
        ...(input.thread_taken_over === undefined
          ? {}
          : { thread_taken_over: input.thread_taken_over }),
      },
    )

    // ② 线程归并 + SLA。锚点是这封买家来信；首响时限按意图与紧急度压档
    const targets = targetsFor(classification)
    const prior = ledger.get(input.thread_id)
    const row: ThreadLedgerRow = {
      thread_id: input.thread_id,
      ...(input.matter_id === undefined ? {} : { matter_id: input.matter_id }),
      anchor_at: now,
      ...(prior?.last_outbound_at === undefined
        ? {}
        : { last_outbound_at: prior.last_outbound_at }),
      messages: (prior?.messages ?? 0) + 1,
      agent_replies: prior?.agent_replies ?? 0,
      targets,
      classification,
    }
    ledger.set(input.thread_id, row)
    const sla = computeSla({
      anchor_at: row.anchor_at,
      now,
      ...(row.last_outbound_at === undefined ? {} : { last_outbound_at: row.last_outbound_at }),
      targets,
      calendar: calendar(),
    })

    // ③ 第一次撞到的那条未答边界 → 一张选择题卡（不是空白输入框）
    const boundary = findUnansweredBoundary(classification, answered, {
      ...(v === undefined ? {} : { vertical: v }),
    })
    const boundary_card_id =
      boundary === undefined ? undefined : await askBoundary(boundary, input, classification)

    // ④ 模板草稿。边界没答过时它**不提退款**（`gateChange` 在 draftReply 里）
    const draft = draftReply({
      inbound: {
        text: input.text,
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.from === undefined ? {} : { from: input.from }),
      },
      classification,
      policies: answered,
      knowledge_hits: input.knowledge_hits ?? [],
      persona: { signature: options.signature?.() ?? '客服团队' },
      locale: classification.language,
      now,
      ...(v === undefined ? {} : { vertical: v }),
    })

    // ⑤ 要不要交给人（强制人工词面、未答边界、SLA 破线、反复来信、声称的承诺）
    const escalation = shouldEscalate(
      classification,
      {
        messages: row.messages,
        agent_replies: row.agent_replies,
        inbound_text: input.text,
        draft_text: draft.body,
        sla,
        ...(input.authorization_blocked === undefined
          ? {}
          : { authorization_blocked: input.authorization_blocked }),
      },
      answered,
    )

    // ⑥ 三道门：这一封能不能**自主**发
    const gates = evaluateAutonomyGates({
      channel: 'email',
      classification: {
        intent: classification.intent,
        source: 'email_classification',
        risk_level: classification.urgency === 'high' ? 'high' : 'normal',
      },
      inbound_text: input.text,
      proposed_reply_text: draft.body,
      draft: { generated_by: 'ai' },
    })

    const action: SupportAction = escalation.escalate
      ? escalation.severity === 'high'
        ? 'handoff'
        : boundary !== undefined
          ? 'boundary_question'
          : 'pending_review'
      : boundary !== undefined
        ? 'boundary_question'
        : gates.autonomous
          ? 'auto_reply'
          : 'pending_review'

    const band = bandOf(action, sla)

    emit('guardrail.gate_decided', input.thread_id, {
      channel: 'email',
      action,
      band,
      intent: classification.intent,
      // 被扫的文本一个字都不进：只有门名、结论、规则 id、规则集哈希
      gates: gates.results.map((r) => ({
        gate: r.gate,
        status: r.status,
        ...(r.reason === undefined ? {} : { reason: r.reason }),
      })),
      ruleset_hash: gates.ruleset_hash,
      escalation_reasons: escalation.reasons,
      sla_tier: sla.tier,
      ...(boundary === undefined ? {} : { boundary_id: boundary.id }),
      ...(boundary_card_id === undefined ? {} : { boundary_card_id }),
    })

    return {
      classification,
      sla,
      escalation,
      draft,
      gates,
      action,
      band,
      note: noteOf(action, escalation, boundary, sla),
      ...(boundary === undefined ? {} : { boundary }),
      ...(boundary_card_id === undefined ? {} : { boundary_card_id }),
    }
  }

  /* ── 出站 ──────────────────────────────────────────────────────── */

  const judgeDraft = (input: DraftJudgmentInput): DraftJudgment => {
    // 泄漏守卫先跑：一封注定要重写的草稿，不必让三道门去解释它
    const leak = evaluateLeakGuard({
      reply: input.reply_text,
      instructions: options.instructions?.(input.thread_id) ?? [],
      ...(input.rewrites === undefined ? {} : { rewrites: input.rewrites }),
    })
    const classification = input.classification
    const gates = evaluateAutonomyGates({
      channel: input.channel,
      classification:
        classification === undefined
          ? { source: 'none', risk_level: 'normal' }
          : {
              intent: classification.intent,
              source: input.channel === 'chat' ? 'chat_classification' : 'email_classification',
              risk_level: classification.urgency === 'high' ? 'high' : 'normal',
            },
      inbound_text: input.inbound_text,
      proposed_reply_text: input.reply_text,
      draft: {
        generated_by: input.generated_by ?? 'ai',
        ...(input.missing_info === undefined ? {} : { missing_info: input.missing_info }),
      },
    })
    const gate_context = gates.results.map((r) => ({
      gate: r.gate,
      status: r.status,
      ruleset_hash: r.ruleset_hash,
      ...(r.reason === undefined ? {} : { reason: r.reason }),
      ...(r.evidence === undefined ? {} : { evidence: r.evidence }),
    }))
    if (leak.action === 'rewrite') {
      emit('guardrail.gate_decided', input.thread_id, {
        channel: input.channel,
        guard: 'instruction_leak',
        action: 'rewrite',
        // 只有长度：商家那句话一个字都不进日志
        matched_chars: leak.matched_chars,
      })
      return {
        action: 'rewrite',
        rewrite_instruction: LEAK_REWRITE_INSTRUCTION,
        gates,
        leak: { leaked: true, matched_chars: leak.matched_chars },
        gate_context,
      }
    }
    const leaked = leak.leaked
    if (leaked) {
      emit('guardrail.gate_decided', input.thread_id, {
        channel: input.channel,
        guard: 'instruction_leak',
        action: 'human_review',
        matched_chars: leak.matched_chars,
      })
    }
    return {
      // 泄漏过一次又改不掉 → 不自主，出卡等人看
      action: !leaked && gates.autonomous ? 'send' : 'card',
      gates,
      leak: { leaked, matched_chars: leak.matched_chars },
      gate_context,
    }
  }

  /* ── SLA 巡检（不出卡） ────────────────────────────────────────── */

  const overdue = (): OverdueThread[] => {
    const now = clock.now()
    const out: OverdueThread[] = []
    for (const row of ledger.values()) {
      const sla = computeSla({
        anchor_at: row.anchor_at,
        now,
        ...(row.last_outbound_at === undefined ? {} : { last_outbound_at: row.last_outbound_at }),
        targets: row.targets,
        calendar: calendar(),
      })
      if (sla.stopped || sla.tier === 'ok') continue
      out.push({
        thread_id: row.thread_id,
        ...(row.matter_id === undefined ? {} : { matter_id: row.matter_id }),
        anchor_at: row.anchor_at,
        due_at: sla.first_response_due_at,
        overdue_minutes: -sla.first_response_remaining_minutes,
        tier: sla.tier,
      })
    }
    // 逾期久的在前
    return out.sort((a, b) => b.overdue_minutes - a.overdue_minutes)
  }

  const sweepSla = async (): Promise<SlaSweepReport> => {
    const now = clock.now()
    const rows = overdue()
    let reminded = 0
    let breached = 0
    for (const row of rows) {
      if (row.tier === 'breached') breached += 1
      const ledgerRow = ledger.get(row.thread_id)
      if (ledgerRow === undefined) continue
      // 同一个锚点只提醒一次：巡检一刻钟一拍，重复提醒会把通知变成噪声
      if (ledgerRow.reminded_at !== undefined && ledgerRow.reminded_at >= ledgerRow.anchor_at) {
        continue
      }
      ledger.set(row.thread_id, { ...ledgerRow, reminded_at: now })
      reminded += 1
      /*
       * 36 §2.2b：**这不是卡**。超时没回要的是"去看一眼"，不是"在两个选项里挑一个"。
       * 它进岗位面板（`overdue()`）与一条通知事件；去重键与升级卡同形，
       * 于是同一条线程的超时提醒与将来的升级卡不会各说各的。
       */
      emit('notification.sent', row.thread_id, {
        reason: 'sla_first_response',
        dedupe_key: escalationDedupeKey({
          workspace_id,
          family: 'sla_first_response',
          thread_id: row.thread_id,
        }),
        tier: row.tier,
        overdue_minutes: row.overdue_minutes,
        due_at: row.due_at,
      })
    }
    return { scanned: ledger.size, reminded, breached }
  }

  /* ── 教一句 / 知识缺口 ─────────────────────────────────────────── */

  const teachCandidate: SupportJudgment['teachCandidate'] = (input) => {
    const candidate = knowledgeCandidate({
      text: input.instruction,
      source: 'human_reply',
      ref: input.thread_id,
      at: input.at ?? clock.now(),
      ...(input.question === undefined ? {} : { question: input.question }),
    })
    if (candidate === undefined) return undefined
    // 19：承诺类永不自动发布。`canAutoPropose` 说不行的，候选照样落，只是要人点头
    return { candidate, auto_proposable: canAutoPropose(candidate) }
  }

  const recordGap: SupportJudgment['recordGap'] = (input) => {
    const gaps = options.gaps
    if (gaps === undefined) return undefined
    const gap_id = gaps.openGap({
      question: input.question,
      subject_key: input.subject_key,
      ...(input.run_id === undefined ? {} : { run_id: input.run_id }),
    })
    if (gap_id === undefined) return undefined
    gaps.addWaiter(gap_id, {
      thread_id: input.thread_id,
      channel: input.channel,
      since: clock.now(),
      ...(input.language === undefined ? {} : { language: input.language }),
    })
    return gap_id
  }

  return {
    judgeInbound,
    judgeDraft,
    noteOutbound(thread_id, at): void {
      const row = ledger.get(thread_id)
      const when = at ?? clock.now()
      if (row === undefined) return
      ledger.set(thread_id, {
        ...row,
        last_outbound_at: when,
        agent_replies: row.agent_replies + 1,
        messages: row.messages + 1,
      })
    },
    sweepSla,
    overdue,
    teachCandidate,
    recordGap,
  }
}

/* ------------------------------------------------------------------ */
/* 小零件（纯函数，好断言）                                               */
/* ------------------------------------------------------------------ */

/**
 * 结论 + SLA → 优先级带（72 §1.E）。**派生不存列**。
 *
 * - `handoff` 与"已经破线"：客户在等（P0）
 * - `pending_review`：待你确认（P1）——回信草稿、涉钱、高风险
 * - `auto_reply`：需要处理（P2）——自动发了，留一条记录
 * - `boundary_question`：无人等待（P3）——一答定终身的选择题，没人对着屏幕等
 */
export function bandOf(action: SupportAction, sla: SlaState): PriorityBand {
  if (action === 'handoff' || sla.first_response_breached) return 'P0'
  if (action === 'pending_review') return 'P1'
  if (action === 'auto_reply') return 'P2'
  return 'P3'
}

/** 给人看的一句话。**零裸枚举**（不出现 `returns_refunds` / `l3_denylist` 这类内部值）。 */
export function noteOf(
  action: SupportAction,
  escalation: EscalationDecision,
  boundary: BoundaryItem | undefined,
  sla: SlaState,
): string {
  if (action === 'handoff') {
    return sla.first_response_breached
      ? '这封信超过了首次回复的时限，而且要人来处理。'
      : '这封信要人来处理，AI 已经把材料准备好了。'
  }
  if (action === 'boundary_question') {
    return boundary === undefined
      ? '有一条业务边界还没有答案，AI 这次不自作主张。'
      : `第一次遇到与「${boundary.label}」有关的场景，定一个答案，以后就不用再问。`
  }
  if (action === 'pending_review') {
    return escalation.escalate
      ? '这封回信里有需要你确认的地方，AI 不自己发。'
      : 'AI 拟好了一版回信，等你点头再发。'
  }
  return 'AI 按已确认的口径自己回了这一封。'
}
