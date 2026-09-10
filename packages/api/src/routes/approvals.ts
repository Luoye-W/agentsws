/** 14 §10 审批 API。写路由（decide / retry-apply）属 send / apply 类，受 outbound 急停。 */
import type {
  ApprovalItem,
  ApprovalKind,
  ApprovalState,
  DecideInput,
  Diff,
  Todo,
} from '@agentsws/contracts'
import { projectCard, resolveDecision } from '@agentsws/deck'
import { z } from 'zod'
import { ApiError, normalizeError } from '../errors.js'
import {
  assignmentOf,
  body,
  listParam,
  ok,
  param,
  principalOf,
  redactItem,
  tokenFor,
} from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'
import { DuplicateAck, type GuardResult, guardSimilar, recordCatalogNote } from './catalog.js'
import { fromDeckError } from './workstation.js'

const READ = {
  domain: 'approval',
  op: 'read',
  range: 'own',
  sensitivity: 'internal',
} as const
const DECIDE = {
  domain: 'approval',
  op: 'approve',
  range: 'own',
  sensitivity: 'internal',
} as const
/**
 * 人主动建审批项（14 §10 表里第一行「人也可（`kind: policy_change` 等）」）的准入：
 * **`approval.stage`**——提议 ≠ 决定，这正是 SoD 的前提。
 *
 * WP33 时三个职责包一条 `approval.stage` 都没给，真按 `stage` 判会让所有人 403，于是
 * 暂时沿用了 `read`；WP35 给 `common.owner` / `common.member` / `dtc.aftersales` 都补上了
 * stage（owner workspace、另两个 own），这里改回该有的那一条。范围要 `own` 就够：
 * 提议的是自己那一张，owner 的 workspace 覆盖它。
 *
 * 写侧的纪律仍在处理器里：提议者一律是调用者本人、工作区一律是本人的、
 * 等级一律 L1 且不自动通过、决定与施行走 14 的原状态机。
 */
const PROPOSE = {
  domain: 'approval',
  op: 'stage',
  range: 'own',
  sensitivity: 'internal',
} as const

const ACTIONS = ['approve', 'approve_edited', 'reject', 'redirect', 'defer', 'withdraw'] as const
/**
 * 36 §2.1 的五动作矩阵：工作台按钮发的是这几个动词，翻译成 14 的状态机动作由
 * `@agentsws/deck` 的 `resolveDecision` 做（选择题裸 approve 拒、instruct 必须带作用域、
 * version 乐观并发都在那里）。`redirect / defer / withdraw / approve_edited` 是 14 的原生动作，
 * 走老路，不经卡片投影。
 */
const DECK_ACTIONS = ['approve', 'reject', 'instruct', 'snooze'] as const
const INSTRUCTION_SCOPES = ['single_reply', 'similar_cases', 'global_rule'] as const
const VIA = ['workstation', 'im_card', 'email', 'api', 'batch'] as const
const RedirectTo = z.object({
  person_id: z.string().optional(),
  role_id: z.string().optional(),
})

const DecideBody = z.object({
  /** 缺省时用本人那张有效投递 token（工作台内不必回传） */
  decision_token: z.string().min(1).optional(),
  action: z.enum([...ACTIONS, 'instruct', 'snooze'] as const),
  reason: z.string().optional(),
  edited_payload: z.unknown().optional(),
  redirect_to: RedirectTo.optional(),
  defer_until: z.string().optional(),
  via: z.enum(VIA).optional(),
  /** 选择题卡必填（36 §2.1；裸 approve 会被 OPTION_REQUIRED 拒） */
  selected_option_id: z.string().min(1).optional(),
  /** 指导抽屉：先选作用域，再一句话 */
  instruction: z.object({ scope: z.enum(INSTRUCTION_SCOPES), text: z.string().min(1) }).optional(),
  /** 乐观并发：与卡片的 version（= revision）不一致即 409 */
  version: z.number().int().nonnegative().optional(),
  /**
   * 40 §2.2「建之前先查」：`instruction.scope === 'global_rule'` 会落成一条**规矩**，
   * 规矩也是"被建出来的东西"。公司里已经有一条差不多的规矩时，这里回
   * `409 similar_exists`；"我这个不一样，仍新建"要写一句为什么。
   */
  duplicate_ack: DuplicateAck.optional(),
})

const KINDS = [
  'outbound_draft',
  'staged_change',
  'knowledge_update',
  'skill_promotion',
  'skill_lesson',
  'claim',
  'policy_change',
  'home_suggestion',
  'scheduled_task',
  'app_install',
  'app_upgrade',
  'app_uninstall',
  'upstream_upgrade',
  'join_mapping',
  'dev_handoff_result',
  'ai_question',
  'daily_plan',
  'review',
] as const

const ObjectRefBody = z.object({ type: z.string().min(1), id: z.string().min(1) })

/**
 * `POST /v1/approvals` 的入参。
 *
 * 只收「提议者说得清的那些」：种类、关于什么、去重键、标题与人话摘要、载荷、证据、
 * 收件人与优先级。`id` / `revision` / `state` / `deliveries` / `links.children` /
 * `execution_snapshot` / `automation.auto_approved` 一律由 14 的实现算——
 * 让调用方填这些等于把状态机交出去。
 */
const CreateBody = z.object({
  kind: z.enum(KINDS),
  subject: z.object({
    object: ObjectRefBody,
    matter_id: z.string().min(1).optional(),
    todo_id: z.string().min(1).optional(),
    conversation_id: z.string().min(1).optional(),
  }),
  /** 14 §2 去重：同键再提一次是同一张卡的新 revision，不是第二张卡。 */
  dedupe_key: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(2000),
  payload: z.unknown().optional(),
  evidence: z
    .object({
      run_id: z.string().min(1).optional(),
      source_events: z.array(z.string().min(1)).optional(),
      provenance_seen: z.array(ObjectRefBody).optional(),
      diff: z
        .object({ before: z.unknown(), after: z.unknown(), summary: z.string().optional() })
        .optional(),
    })
    .optional(),
  routing: z
    .object({
      recipients: z
        .array(
          z.object({
            person: z.string().min(1),
            via: z.enum(['role_holder', 'scope_manager', 'owner', 'explicit', 'escalation']),
          }),
        )
        .min(1)
        .optional(),
      rule: z.enum(['role_holder', 'scope_manager', 'owner', 'explicit', 'unclaimed']).optional(),
      escalate_after_hours: z
        .number()
        .int()
        .positive()
        .max(24 * 30)
        .optional(),
    })
    .optional(),
  priority: z.enum(['immediate', 'queue', 'digest']).optional(),
  due_at: z.string().min(1).optional(),
  /** 36 §2 选择题卡。 */
  options: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).optional(),
  /** 挂在哪张卡下面（`links.parent`）。 */
  parent: z.string().min(1).optional(),
})

const BatchDecideBody = z.object({
  entries: z
    .array(z.object({ id: z.string().min(1), decision_token: z.string().min(1).optional() }))
    .min(1),
  action: z.enum(ACTIONS),
  reason: z.string().optional(),
  edited_payload: z.unknown().optional(),
  redirect_to: RedirectTo.optional(),
  defer_until: z.string().optional(),
})

async function mustGet(deps: GatewayDeps, id: string, workspace_id: string): Promise<ApprovalItem> {
  const item = await deps.approvals.get(id)
  // 跨工作区不泄漏存在性：一律 404。
  if (!item || item.workspace_id !== workspace_id)
    throw new ApiError('not_found', `审批项不存在：${id}`)
  return item
}

const optional = <T>(v: T | undefined, key: string): Record<string, T> =>
  v === undefined ? {} : ({ [key]: v } as Record<string, T>)

/** zod 出来的 `summary?: string | undefined` 与契约的 `summary?: string` 在 exactOptional 下不同型。 */
function diffOf(
  d: { before: unknown; after: unknown; summary?: string | undefined } | undefined,
): Diff | undefined {
  if (d === undefined) return undefined
  return { before: d.before, after: d.after, ...optional(d.summary, 'summary') }
}

/**
 * 36 §2.1 指导的**作用域落地**（原来只是把 scope 原样回给调用方）：
 *
 * | scope | 落到哪 |
 * |---|---|
 * | `single_reply` | 就这一条：reject + 指导文本，Agent 重做（14 §9 的强负样本），不建新卡 |
 * | `similar_cases` | 24 的学习回路：建一张 `skill_lesson` 卡（技能 overlay 提案），人再批一次才改行为 |
 * | `global_rule` | 05 的策略层：建一张 `policy_change` 卡，批了才改职责策略 |
 *
 * 两条纪律：**指导本身不改任何东西**（它只是提议），且提议照样走 14 的预检与队列。
 */
async function landInstruction(
  deps: GatewayDeps,
  input: {
    item: ApprovalItem
    scope: string
    text: string
    person_id: string
    workspace_id: string
    assignment_id: string
    /** 40 §2.2：`global_rule` 的查重在 `decide` **之前**就做完了，结果传进来 */
    guard: GuardResult
  },
): Promise<{ kind: string; approval_item_id: string } | undefined> {
  const { item, scope, text, guard } = input
  if (scope !== 'similar_cases' && scope !== 'global_rule') return undefined
  const lesson = scope === 'similar_cases'
  const routing = {
    recipients: [{ person: input.person_id, via: lesson ? 'role_holder' : 'owner' } as const],
    rule: (lesson ? 'role_holder' : 'owner') as 'role_holder' | 'owner',
    escalation: {
      after_hours: lesson ? 72 : 48,
      business_hours: true,
      chain: ['owner' as const],
      escalated_at: [],
    },
    separation_of_duties: false,
  }
  const common = {
    workspace_id: input.workspace_id,
    schema_version: 1 as const,
    role_id: item.role_id,
    proposer: { kind: 'person' as const, id: input.person_id },
    // 指导产的卡永远 L1：指导本身不改任何东西，改不改由人再批一次
    automation: { level_at_creation: 'L1' as const },
    routing,
    priority: 'queue' as const,
    links: { parent: item.id },
  }
  const created = lesson
    ? await deps.approvals.create({
        ...common,
        kind: 'skill_lesson' as const,
        subject: {
          object: { type: 'skill', id: item.role_id },
          ...(item.subject.matter_id === undefined ? {} : { matter_id: item.subject.matter_id }),
        },
        dedupe_key: `${input.workspace_id}:skill_lesson:instruction:${item.id}`,
        title: `把这条指导变成规矩：${text.slice(0, 40)}`,
        summary: '你刚才说的这一条，以后类似情况都按它来。采纳后进技能 overlay（24）。',
        payload: {
          form: 'skill_lesson',
          scope: 'similar_cases',
          skill: item.role_id,
          text,
          source_card_id: item.id,
          source_kind: item.kind,
        },
        evidence: {
          source_events: [],
          diff: { before: null, after: text, summary: '技能 overlay 追加一条' },
          provenance: { seen: [item.subject.object] },
          precheck: { permission_diff: 'ok' },
        },
      })
    : await deps.approvals.create({
        ...common,
        kind: 'policy_change' as const,
        subject: {
          object: { type: 'policy', id: `instruction_${item.id}` },
          ...(item.subject.matter_id === undefined ? {} : { matter_id: item.subject.matter_id }),
        },
        dedupe_key: `${input.workspace_id}:policy_change:instruction:${item.id}`,
        title: `以后都这样：${text.slice(0, 40)}`,
        summary: '这条要写进职责策略。批准后对这个岗位一律生效（05）。',
        payload: {
          target: 'workspace_policy',
          before: null,
          after: { rule: text },
          affected_assignments: [input.assignment_id],
          source_card_id: item.id,
        },
        evidence: {
          source_events: [],
          provenance: { seen: [item.subject.object] },
          precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
        },
      })
  if (created.state === 'blocked') return undefined
  if (!lesson) {
    // 规矩在别处没有一张自己的表：目录替它保管一份，工具箱上才看得见
    await deps.catalog?.record?.({
      kind: 'rule',
      id: `rule:${created.id}`,
      title: text.slice(0, 60),
      summary: '指导落成的规矩：批准后对这个岗位一律生效（05）',
      owner: input.person_id,
      layer: 'personal',
      used_by_positions: [input.assignment_id],
      runs_30d: 0,
      workspace_id: input.workspace_id,
    })
    await recordCatalogNote(deps, {
      workspace_id: input.workspace_id,
      entry_id: `rule:${created.id}`,
      guard,
    })
  }
  return { kind: created.kind, approval_item_id: created.id }
}

export function approvalRoutes(): Route[] {
  return [
    route(
      {
        method: 'post',
        path: '/v1/approvals',
        operationId: 'createApproval',
        summary: '建一张审批项（14 §10：执行器 / 秘书 / 哨兵 / 市场，人也可）',
        tag: 'approval',
        auth: 'bearer',
        assignment: true,
        authz: PROPOSE,
        body: CreateBody,
        returns: 'ApprovalItem（同 dedupe_key 重复提交 → 14 §11 用例 1，revision 递增）',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const assignment = assignmentOf(c)
        const input = await body(c, CreateBody)
        // 收件人不给就是本人（个人档最常见的那种：自己给自己提一条待办式的卡）
        const recipients =
          input.routing?.recipients ?? ([{ person: p.person_id, via: 'role_holder' }] as const)
        const rule = input.routing?.rule ?? 'role_holder'
        const created = await deps.approvals.create({
          workspace_id: p.workspace_id,
          schema_version: 1,
          kind: input.kind,
          // 职责一律是本次绑定岗位的（31 §3.1：一次请求一个 Assignment，不跨并集）
          role_id: assignment.role_id,
          ...(assignment.ranges.length === 0 ? {} : { range: assignment.ranges }),
          subject: {
            object: input.subject.object,
            ...optional(input.subject.matter_id, 'matter_id'),
            ...optional(input.subject.todo_id, 'todo_id'),
            ...optional(input.subject.conversation_id, 'conversation_id'),
          },
          // 去重键带工作区与提议者：别的工作区 / 别的人的同名提议不会互相顶掉（14 §2）
          dedupe_key: `${p.workspace_id}:${input.kind}:${input.dedupe_key}`,
          title: input.title,
          summary: input.summary,
          payload: input.payload ?? {},
          evidence: {
            source_events: input.evidence?.source_events ?? [],
            provenance: { seen: input.evidence?.provenance_seen ?? [] },
            precheck: {},
            ...optional(input.evidence?.run_id, 'run_id'),
            ...optional(diffOf(input.evidence?.diff), 'diff'),
          },
          // 提议者一律是调用者本人：接口不接受「替别人提」（14 §7 撤回权跟着提议者走）
          proposer: { kind: 'person', id: p.person_id, assignment_id: assignment.id },
          // 14：人主动提的卡一律 L1（提议 ≠ 决定）。其余三项由 `ApprovalBus.create` 补齐——
          // 契约就是这么写的，宿主补默认值的义务在 WP35 落到了实处。
          automation: { level_at_creation: 'L1' },
          routing: {
            recipients: [...recipients],
            rule,
            escalation: {
              after_hours: input.routing?.escalate_after_hours ?? 24,
              business_hours: true,
              chain: ['scope_manager', 'owner'],
              escalated_at: [],
            },
            // 自己提、自己又是唯一收件人时打上 SoD 标记，由 14 按工作区档位裁决
            // （14 §11 用例 12：个人工作区允许自批并标 self_approved，公司工作区拒）
            separation_of_duties: recipients.every((r) => r.person === p.person_id),
          },
          priority: input.priority ?? 'queue',
          ...optional(input.due_at, 'due_at'),
          ...optional(input.options, 'options'),
          ...(input.parent === undefined ? {} : { links: { parent: input.parent } }),
        })
        return ok(c, redactItem(created, p.person_id), 201)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/approvals',
        operationId: 'listApprovals',
        summary: '审批队列',
        tag: 'approval',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'lane', in: 'query', description: 'mine | scope | unclaimed，默认 mine' },
          { name: 'kind', in: 'query', description: '审批项种类（14 §1）' },
          { name: 'role', in: 'query', description: 'role_id' },
          { name: 'state', in: 'query', description: '状态，逗号分隔；默认 pending,in_review' },
        ],
        returns: 'ApprovalItem[]（他人的 decision_token 已抹去）',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const lane = c.req.query('lane') ?? 'mine'
        if (lane !== 'mine' && lane !== 'scope' && lane !== 'unclaimed')
          throw new ApiError('invalid_input', 'lane 只能是 mine / scope / unclaimed')
        const kind = c.req.query('kind') as ApprovalKind | undefined
        const role = c.req.query('role')
        const state = listParam(c, 'state') as ApprovalState[] | undefined
        const items = await deps.approvals.queue({
          workspace_id: p.workspace_id,
          person_id: p.person_id,
          lane,
          ...optional(kind, 'kind'),
          ...optional(role, 'role_id'),
          ...optional(state, 'state'),
        })
        return ok(
          c,
          items.map((i) => redactItem(i, p.person_id)),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/approvals/batch/decide',
        operationId: 'decideApprovalsBatch',
        summary: '批量决定（14 §8：同 kind 同 role；一条失败不影响其他）',
        tag: 'approval',
        auth: 'bearer',
        assignment: true,
        authz: DECIDE,
        outbound: true,
        body: BatchDecideBody,
        returns: '{ results: [{ id, item?, error? }] }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const input = await body(c, BatchDecideBody)
        const entries: { id: string; decision_token: string }[] = []
        for (const e of input.entries) {
          const item = await mustGet(deps, e.id, p.workspace_id)
          const token = e.decision_token ?? tokenFor(item, p.person_id)
          if (token === undefined)
            throw new ApiError('forbidden', `没有属于本人的 decision_token：${e.id}`)
          entries.push({ id: e.id, decision_token: token })
        }
        const rest: Omit<DecideInput, 'decision_token' | 'via'> = {
          action: input.action,
          ...optional(input.reason, 'reason'),
          ...optional(input.edited_payload, 'edited_payload'),
          ...optional(input.redirect_to, 'redirect_to'),
          ...optional(input.defer_until, 'defer_until'),
        }
        const results = await deps.approvals.decideBatch(entries, p.person_id, rest)
        return ok(c, {
          results: results.map((r) => {
            const err = r.error === undefined ? undefined : normalizeError(r.error)
            return {
              id: r.id,
              ...(r.item ? { item: redactItem(r.item, p.person_id) } : {}),
              ...(err === undefined ? {} : { error: { code: err.code, message: err.message } }),
            }
          }),
        })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/approvals/:id',
        operationId: 'getApproval',
        summary: '审批项详情',
        tag: 'approval',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '审批项 id' }],
        returns: 'ApprovalItem',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const item = await mustGet(deps, param(c, 'id'), p.workspace_id)
        return ok(c, redactItem(item, p.person_id))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/approvals/:id/children',
        operationId: 'listApprovalChildren',
        summary: '这张卡下面挂着的卡（14 `links.children`：指导落地的提案、拆出来的子项）',
        tag: 'approval',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '审批项 id' }],
        returns: 'ApprovalItem[]（他人的 decision_token 已抹去；跨工作区的子项直接不出）',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const item = await mustGet(deps, param(c, 'id'), p.workspace_id)
        const children: ApprovalItem[] = []
        for (const child_id of item.links.children) {
          const child = await deps.approvals.get(child_id)
          // 跨工作区的子项一律不出（与详情一样：不泄漏存在性）
          if (child && child.workspace_id === p.workspace_id)
            children.push(redactItem(child, p.person_id))
        }
        return ok(c, children)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/approvals/:id/history',
        operationId: 'getApprovalHistory',
        summary: '修订与事件 id',
        tag: 'approval',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '审批项 id' }],
        returns: '{ revisions, events }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const id = param(c, 'id')
        await mustGet(deps, id, p.workspace_id)
        const history = await deps.approvals.history(id)
        return ok(c, {
          revisions: history.revisions.map((i) => redactItem(i, p.person_id)),
          events: history.events,
        })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/approvals/:id/decide',
        operationId: 'decideApproval',
        summary: '决定（人 / 卡片回调）',
        tag: 'approval',
        auth: 'bearer',
        assignment: true,
        authz: DECIDE,
        outbound: true,
        params: [{ name: 'id', in: 'path', required: true, description: '审批项 id' }],
        body: DecideBody,
        returns: 'ApprovalItem',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const id = param(c, 'id')
        const item = await mustGet(deps, id, p.workspace_id)
        const input = await body(c, DecideBody)
        const token = input.decision_token ?? tokenFor(item, p.person_id)
        if (token === undefined) throw new ApiError('forbidden', '没有属于本人的 decision_token')
        const via = input.via ?? 'workstation'

        // 卡片动词 → 14 的决定。卡片投影是纯函数，网关只是转译层。
        const deckAction = DECK_ACTIONS.find((a) => a === input.action)
        let resolved: {
          action: DecideInput['action']
          reason?: string
          edited_payload?: unknown
          defer_until?: string
          instruction_scope?: string
        }
        if (deckAction !== undefined) {
          const card = projectCard(item, {
            now: deps.clock.now(),
            position_id: c.req.header('X-Assignment') ?? '',
            ...(deps.workstation === undefined ? {} : { label: (r) => deps.workstation?.label(r) }),
          })
          try {
            resolved = resolveDecision(
              card,
              {
                action: deckAction,
                ...optional(input.selected_option_id, 'selected_option_id'),
                ...optional(input.instruction, 'instruction'),
                ...optional(input.reason, 'reason'),
                ...optional(input.edited_payload, 'edited_payload'),
                ...optional(input.defer_until, 'defer_until'),
                ...optional(input.version, 'version'),
              },
              { now: deps.clock.now() },
            )
          } catch (err) {
            return fromDeckError(err)
          }
        } else {
          resolved = {
            action: input.action as DecideInput['action'],
            ...optional(input.reason, 'reason'),
            ...optional(input.edited_payload, 'edited_payload'),
            ...optional(input.defer_until, 'defer_until'),
          }
        }

        /**
         * 40 §2.2：`global_rule` 落的是一条**规矩**，规矩也是"被建出来的东西"。
         * 查重必须在 `decide` **之前**——不然人的驳回已经生效了，却回一个 409，
         * 界面上就成了"我按了没反应但报错"。
         */
        const ruleGuard: GuardResult =
          resolved.instruction_scope === 'global_rule' && input.instruction !== undefined
            ? await guardSimilar(deps, {
                workspace_id: p.workspace_id,
                kind: 'rule',
                title: input.instruction.text,
                ...(input.duplicate_ack === undefined ? {} : { ack: input.duplicate_ack }),
              })
            : {}

        const out = await deps.approvals.decide(id, p.person_id, {
          decision_token: token,
          action: resolved.action,
          via,
          ...optional(resolved.reason, 'reason'),
          ...optional(resolved.edited_payload, 'edited_payload'),
          ...optional(input.redirect_to, 'redirect_to'),
          ...optional(resolved.defer_until, 'defer_until'),
        })
        // 36 §2.1：指导的作用域落地（similar_cases → overlay 提案；global_rule → 策略变更）
        const landed =
          resolved.instruction_scope === undefined || input.instruction === undefined
            ? undefined
            : await landInstruction(deps, {
                item: out,
                scope: resolved.instruction_scope,
                text: input.instruction.text,
                person_id: p.person_id,
                workspace_id: p.workspace_id,
                assignment_id: assignmentOf(c).id,
                guard: ruleGuard,
              })
        // 37 §4.1：认领卡接下来才形成责任（31 I13）——建一条挂在会议事项上的待办
        let claimed: Todo | undefined
        if (
          out.kind === 'claim' &&
          (resolved.action === 'approve' || resolved.action === 'approve_edited')
        ) {
          claimed = (await deps.work?.acceptClaim?.(
            {
              workspace_id: p.workspace_id,
              person_id: p.person_id,
              assignment_id: assignmentOf(c).id,
            },
            out,
          )) as Todo | undefined
        }
        return ok(c, {
          ...redactItem(out, p.person_id),
          // 指导的作用域决定它之后落到哪（本条回复 / 技能 overlay 提案 / 职责策略变更）；
          // v1 只原样回给调用方，路由到 24 / 05 的机器留给后续 WP（见交付报告）。
          ...optional(resolved.instruction_scope, 'instruction_scope'),
          ...optional(landed, 'instruction_proposal'),
          ...optional(claimed, 'todo'),
        })
      },
    ),
    ...(
      [
        ['claim', 'claimApproval', '认领'],
        ['release', 'releaseApproval', '释放'],
        ['withdraw', 'withdrawApproval', '撤回（提议者）'],
      ] as const
    ).map(([action, operationId, summary]) =>
      route(
        {
          method: 'post',
          path: `/v1/approvals/:id/${action}`,
          operationId,
          summary,
          tag: 'approval',
          auth: 'bearer',
          assignment: true,
          authz: DECIDE,
          params: [{ name: 'id', in: 'path', required: true, description: '审批项 id' }],
          returns: 'ApprovalItem',
        },
        async (c, deps) => {
          const p = principalOf(c)
          assignmentOf(c)
          const id = param(c, 'id')
          await mustGet(deps, id, p.workspace_id)
          const out = await deps.approvals[action](id, p.person_id)
          return ok(c, redactItem(out, p.person_id))
        },
      ),
    ),
    route(
      {
        method: 'post',
        path: '/v1/approvals/:id/retry-apply',
        operationId: 'retryApplyApproval',
        summary: '施行失败后重试（apply 类）',
        tag: 'approval',
        auth: 'bearer',
        assignment: true,
        authz: DECIDE,
        outbound: true,
        params: [{ name: 'id', in: 'path', required: true, description: '审批项 id' }],
        returns: 'ApprovalItem',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const id = param(c, 'id')
        await mustGet(deps, id, p.workspace_id)
        const out = await deps.approvals.retryApply(id, p.person_id)
        return ok(c, redactItem(out, p.person_id))
      },
    ),
  ]
}
