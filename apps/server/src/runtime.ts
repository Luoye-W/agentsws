/**
 * 运行时装配（17 §4）+ 37 §2.2b 的 `startRun`。
 *
 * 这一层做两件事，别的都不做：
 *
 * 1. **挑一个运行时适配器**：环境里配了模型 provider（`DEEPSEEK_API_KEY`）就用
 *    `@agentsws/runtime-direct` 的 turn loop（模型经 22 的网关）；没配就用
 *    `@agentsws/stand-ins` 的 stub 运行时（确定性、不叫模型，demo 与测试用它）。
 *    换运行时只换这一处——世界的其余部分原样不动（31 I6）。
 * 2. **把「委托」与「在事项里说话」接上运行时**：组 `RunRequest`（`work_item = matter`，
 *    ContextItem 注入 `matter_summary` + pinned 记录，`tools.allow` 按岗位），跑，
 *    运行事件进事项时间线与事件日志，运行结束更新事项摘要，跑出来的卡回填到待办。
 *
 * 纪律：
 * - 卡片一律经审批总线（14 §1「所有改变都以一条审批项进同一条队列」），这里不绕过预检；
 * - 收件人只从「这次运行读过的」里取（31 §3.3），拿不到 ObjectRef 就不建卡；
 * - 时间经 `Clock`、随机经注入的 `random`，没有一处 `Date.now()` / `Math.random()`；
 * - 秘密只从环境变量读，且不进事件日志。
 */
import type {
  ApprovalItem,
  AssignmentId,
  Clock,
  ContextItem,
  EventEnvelope,
  Matter,
  ModelRef,
  ObjectRef,
  PersonId,
  RunEvent,
  RunRequest,
  RuntimeAdapter,
  StartRun,
  TodoId,
} from '@agentsws/contracts'
import { canonicalJson } from '@agentsws/core'
import { type SkillResolver, skillPromptSections } from '@agentsws/learning'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import { createDirectRuntime, withToolChoice } from '@agentsws/runtime-direct'
import type { CreatePolicyQuestionFn, DraftPayload, ToolExecutor } from '@agentsws/stand-ins'
import { createStubRuntime } from '@agentsws/stand-ins'
import type { CreateApprovalInput } from '@agentsws/txn'
import { cardRefOf, type Work } from '@agentsws/work'

/**
 * 卡片的出口。用 `@agentsws/txn` 的输入类型是因为收件人门禁（31 §3.3）要 `context`，
 * 而契约的 `ApprovalBus.create` 还没有这一项（见交付报告 §4 的契约建议）。
 */
export interface ApprovalSink {
  create<P>(input: CreateApprovalInput<P>): Promise<ApprovalItem<P>>
}

/** 只读目录：没接连接器时 stub / direct 也照样能走完（工具执行器缺席就是一条 error 结果）。 */
const DEFAULT_TOOLS = ['get_order', 'get_product', 'list_orders', 'search_policies'] as const

/** ObjectRef.type → ContextItem.kind；不认识的按摘要注入。 */
const KIND_BY_REF: Record<string, ContextItem['kind']> = {
  order: 'order',
  customer: 'customer',
  thread: 'thread',
  fact_card: 'fact_card',
  policy: 'policy',
}

const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8')

/** 进模型的内容先规范化（键排序），回放才是恒等变换（同 simulation 的纪律）。 */
function canonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T
}

const refKey = (ref: ObjectRef): string => `${ref.type}:${ref.id}`

/**
 * 事项现场能提供的记录。demo 里由合成世界提供，装了真连接器后换成真的；
 * 一个都不给也能跑——那就是「只有摘要」的运行。
 */
export interface MatterRecordSource {
  /** ObjectRef → 可注入模型的记录内容；不认识回 undefined（不编造） */
  record?(ref: ObjectRef): unknown
  /** ObjectRef → 人话 */
  label?(ref: ObjectRef): string | undefined
  /** email → 联系人 ObjectRef；收件人门禁（31 §3.3）要它，拿不到就不建草稿卡 */
  contactOf?(email: string): ObjectRef | undefined
  /** 只读连接令牌（18）；不给就是空串，运行时拿不到写口 */
  readToken?(assignment_id: AssignmentId): Promise<string> | string
  /** 工具执行器；不给的话运行时的工具调用一律 `no_tool_executor` */
  executeTool?: ToolExecutor
}

export interface RuntimeOptions {
  workspace_id: string
  clock: Clock
  random: () => number
  env: Record<string, string | undefined>
  models: ModelGatewayApi
  /** 卡片进的那条队列（demo 里是接进来的世界的总线） */
  approvals: ApprovalSink
  roles: RoleStore
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  source?: MatterRecordSource
  /** seed 化的随机（运行时的确定性）；不给按 `random` 起一个 */
  seed?: number
  /** 运行时的名字；缺省按有没有模型 provider 配置自动选 */
  prefer?: 'stub' | 'direct'
  /**
   * WP25：这台机器上有没有能用的模型。
   *
   * 以前只看 `DEEPSEEK_API_KEY` 在不在，用户在设置页里填了 key 也没用（要重启）。
   * 现在由模型面回答（本机加密库里的配置 + 环境变量兜底）；不给就退回看环境变量。
   */
  hasModel?: () => boolean
  /** WP25：现在生效的默认模型（进 `RunRequest.runtime.model`）。 */
  modelRef?: () => ModelRef
  /**
   * WP29：技能库。给了就把 `resolve` 出来的技能正文当 persona 段拼进 prompt——
   * 学习回路采纳的那条 overlay 是靠这一步生效的（"下次运行用新版本"）。
   * 不给就是老行为：prompt 里只有技能名。
   */
  skills?: SkillResolver
}

export interface RuntimeAssembly {
  adapter: RuntimeAdapter
  /** 注入 `createWork`；工作模型与 startRun 互相需要，靠这一步打断环 */
  bind(work: Work): void
  startRun: StartRun
}

/**
 * 有没有配真模型 provider（22 §5：业务代码里没有 key，只看它在不在）。
 *
 * WP25 之后这是**兜底**——服务进程会传 `hasModel`，让模型面（加密库里的配置）说了算；
 * 没有界面的部署（CI、脚本）仍然靠这个环境变量。
 */
export function hasModelProvider(env: Record<string, string | undefined>): boolean {
  const key = env.DEEPSEEK_API_KEY
  return key !== undefined && key.trim() !== ''
}

interface RunScope {
  run_id: string
  matter: Matter
  todo_id?: TodoId
  person_id: PersonId
  assignment_id: AssignmentId
  /** 这次运行「读过」的对象（15 §6）；收件人门禁与 provenance 都从它取 */
  seen: ObjectRef[]
}

export function createRuntime(options: RuntimeOptions): RuntimeAssembly {
  const { clock, workspace_id, roles, approvals } = options
  const source = options.source ?? {}
  const seed = options.seed ?? Math.floor(options.random() * 0x7fffffff)
  let work: Work | undefined
  let seq = 0
  const newId = (prefix: string): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff).toString(36)
    return `${prefix}_${rand}${seq.toString(36)}`
  }

  /** 当前这次运行的现场；stub / direct 的回调是同步回到宿主的，所以一个变量够用。 */
  let scope: RunScope | undefined

  const appendRunEvent = (req: RunRequest, e: RunEvent): void => {
    const { type, ...payload } = e
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'agent', id: req.actor.assignment_id, run_id: req.id },
      correlation: {
        trace_id: '',
        run_id: req.id,
        ...(req.work_item === undefined ? {} : { work_item_id: req.work_item.id }),
      },
      payload,
    })
  }

  /** 跑出来的卡：进事项时间线 + 回填到待办（37 §2.1 交点一）。 */
  const backfill = (item: ApprovalItem): void => {
    work?.onCard(cardRefOf(item))
  }

  /**
   * 起草回复 → `outbound_draft` 审批项。
   * 收件人必须解析成一个 ObjectRef 且是这次运行读过的，否则宁可不建卡（31 §3.3）。
   */
  const createDraft = async (
    payload: DraftPayload,
  ): Promise<{ approval_item_id: string } | undefined> => {
    const s = scope
    if (s === undefined || work === undefined) return undefined
    const email = payload.to[0]
    if (email === undefined) return undefined
    const to = source.contactOf?.(email)
    if (to === undefined) return undefined
    const seen = [...s.seen]
    if (!seen.some((r) => refKey(r) === refKey(to))) return undefined
    const subject = seen.find((r) => r.type === 'thread') ?? seen.find((r) => r.type === 'order')
    const assignment = roles.assignments.get(s.assignment_id)
    const item = await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'outbound_draft',
      role_id: assignment?.role_id ?? 'common.member',
      subject: {
        object: subject ?? to,
        matter_id: s.matter.id,
        work_item_id: s.matter.id,
        ...(s.todo_id === undefined ? {} : { todo_id: s.todo_id }),
        conversation_id: s.matter.id,
      },
      dedupe_key: `${workspace_id}:outbound_draft:${s.matter.id}:${s.run_id}`,
      title: `回复 ${source.label?.(to) ?? email}：${payload.subject}`,
      summary: payload.subject,
      payload: {
        channel: payload.channel,
        to,
        body: { subject: payload.subject, text: payload.body },
        ...(payload.thread_external_id === undefined
          ? {}
          : { thread_ref: payload.thread_external_id }),
      },
      evidence: {
        run_id: s.run_id,
        source_events: [],
        provenance: { seen },
        precheck: {},
        citations: payload.citations,
      },
      proposer: { kind: 'agent', id: s.assignment_id, assignment_id: s.assignment_id },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: s.person_id, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: {
          after_hours: 8,
          business_hours: true,
          chain: ['owner'],
          escalated_at: [],
        },
        separation_of_duties: true,
      },
      priority: 'queue',
      context: { thread_participants: [to.id], verified_contacts: [to.id] },
    })
    if (item.state === 'blocked') return undefined
    backfill(item)
    return { approval_item_id: item.id }
  }

  /**
   * 36 §2.2 的业务边界选择题（第一次遇到才问一次；`dedupe_key` 保证不重复问）。
   */
  const createPolicyQuestion: CreatePolicyQuestionFn = async ({ boundary }) => {
    const s = scope
    if (s === undefined) return undefined
    const assignment = roles.assignments.get(s.assignment_id)
    const item = await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'policy_change',
      role_id: assignment?.role_id ?? 'common.member',
      subject: {
        object: { type: 'policy', id: boundary.id },
        matter_id: s.matter.id,
        work_item_id: s.matter.id,
        ...(s.todo_id === undefined ? {} : { todo_id: s.todo_id }),
      },
      dedupe_key: `${workspace_id}:policy_change:${boundary.id}`,
      title: boundary.question,
      summary: `定一个答案，以后 Agent 自己按它走，不再问你（${boundary.label}）`,
      payload: {
        target: 'workspace_policy',
        boundary_id: boundary.id,
        before: null,
        after: { boundary_id: boundary.id },
        affected_assignments: [s.assignment_id],
        options: boundary.options.map((o) => ({ id: o.id, label: o.label })),
      },
      evidence: {
        run_id: s.run_id,
        source_events: [],
        provenance: { seen: [...s.seen] },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: { kind: 'agent', id: s.assignment_id, assignment_id: s.assignment_id },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: s.person_id, via: 'owner' }],
        rule: 'owner',
        escalation: { after_hours: 48, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
      options: boundary.options.map((o) => ({ id: o.id, label: o.label })),
    })
    if (item.state === 'blocked') return undefined
    backfill(item)
    return { approval_item_id: item.id }
  }

  const hasModel = options.hasModel ?? ((): boolean => hasModelProvider(options.env))
  const useDirect = (options.prefer ?? (hasModel() ? 'direct' : 'stub')) === 'direct'

  const adapter: RuntimeAdapter = useDirect
    ? createDirectRuntime({
        gateway: withToolChoice({
          complete: (r) => options.models.complete(r),
          embed: (t, meta, model) => options.models.embed(t, meta, model),
          usage: (f) => options.models.usage(f),
          budget: (s) => options.models.budget(s),
        }),
        clock,
        seed,
        createDraft,
        ...(source.executeTool === undefined ? {} : { executeTool: source.executeTool }),
      })
    : createStubRuntime({
        clock,
        seed,
        createDraft,
        createPolicyQuestion,
        ...(source.executeTool === undefined ? {} : { executeTool: source.executeTool }),
      })

  /** 事项现场 → ContextItem[]（37 §2.2b：摘要 + pinned 记录，围栏与出处照旧）。 */
  const contextOf = (matter: Matter, brief: string): ContextItem[] => {
    const items: ContextItem[] = []
    const summary = matter.context.summary.trim()
    if (summary !== '') {
      const content = canonical({ title: matter.title, status: matter.status, summary })
      items.push({
        id: `matter_${matter.id}`,
        kind: 'matter_summary',
        source_ref: { type: 'matter', id: matter.id },
        sensitivity: 'internal',
        content,
        bytes: bytesOf(content),
      })
    }
    for (const ref of matter.context.pinned) {
      const record = source.record?.(ref)
      const label = source.label?.(ref)
      const content = canonical(record ?? { ref, label })
      items.push({
        id: `pin_${ref.type}_${ref.id}`,
        kind: KIND_BY_REF[ref.type] ?? 'summary',
        source_ref: ref,
        sensitivity: 'internal',
        content,
        bytes: bytesOf(content),
      })
    }
    const brief_content = canonical({ subject: matter.title, participants: [], text: brief })
    items.push({
      id: `brief_${matter.id}`,
      kind: 'thread',
      source_ref: { type: 'matter', id: matter.id },
      sensitivity: 'internal',
      content: brief_content,
      bytes: bytesOf(brief_content),
    })
    return items
  }

  const buildRequest = async (input: {
    run_id: string
    matter: Matter
    brief: string
    person_id: PersonId
    assignment_id: AssignmentId
  }): Promise<RunRequest> => {
    const config = roles.effectiveConfig(input.assignment_id)
    const allow = [...new Set([...config.grounding.map((g) => g.tool), ...DEFAULT_TOOLS])].sort()
    const connect_token = (await source.readToken?.(input.assignment_id)) ?? ''
    return {
      id: input.run_id,
      schema_version: 1,
      workspace_id,
      kind: 'work_item',
      actor: {
        person_id: input.person_id,
        assignment_id: input.assignment_id,
        role_id: config.role_id,
      },
      // 17 §1：`work_item` 就是这个 Matter（37 §2.2b 正名）
      work_item: {
        id: input.matter.id,
        conversation_id: input.matter.id,
        role_id: config.role_id,
      },
      trigger: { event_id: input.run_id, source: 'manual' },
      context: contextOf(input.matter, input.brief),
      grounding: config.grounding,
      // 16 §3：公司端 write_external 一律经执行器，运行时拿不到写口
      tools: { allow, connect_token, side_effect_policy: 'executor' },
      skills: config.skills,
      persona: {
        sections: [
          ...(config.persona === undefined
            ? []
            : [{ id: 'role', name: config.role_id, order: 20, text: config.persona }]),
          // 24 §1：解析后的技能正文（包 → 公司 → 部门 → 个人叠加完的那一份）
          ...(options.skills === undefined
            ? []
            : await skillPromptSections({
                skills: config.skills,
                actor: { person_id: input.person_id, workspace_id },
                registry: options.skills,
              })),
        ],
      },
      budget: { max_tokens: 60_000, max_tool_calls: 8, max_seconds: 120, max_cost_base: 5 },
      // 变更仍走各自的管线（渠道 / 执行器）；事项里的一次运行只出草稿与提案
      expectations: { outputs: ['draft', 'answer'], must_stage_if_change_requested: false },
      runtime: {
        preset: config.role_id,
        profile: 'server',
        plugins: [],
        model: useDirect
          ? (options.modelRef?.() ?? { provider: 'deepseek', model: 'default', region: 'cn' })
          : { provider: 'stub', model: 'default', region: 'cn' },
        seed,
      },
      idempotency_key: `idem_${input.run_id}`,
    }
  }

  const startRun: StartRun = async (input) => {
    const run_id = newId('run')
    const request = await buildRequest({
      run_id,
      matter: input.matter,
      brief: input.brief,
      person_id: input.actor.person_id,
      assignment_id: input.actor.assignment_id,
    })
    const byId = new Map(request.context.map((c) => [c.id, c]))
    const seen: ObjectRef[] = []
    scope = {
      run_id,
      matter: input.matter,
      person_id: input.actor.person_id,
      assignment_id: input.actor.assignment_id,
      seen,
      ...(input.todo_id === undefined ? {} : { todo_id: input.todo_id }),
    }
    const answers: string[] = []
    let summary = ''
    const sink = (e: RunEvent): void => {
      appendRunEvent(request, e)
      // 15 §6 provenance：只证明「读过」——注入的记录与工具真回来的实体
      if (e.type === 'context.injected') {
        const ref = byId.get(e.item_id)?.source_ref
        if (
          ref !== undefined &&
          typeof ref !== 'string' &&
          !seen.some((r) => refKey(r) === refKey(ref))
        )
          seen.push(ref)
      }
      if (e.type === 'tool.result' && e.status === 'ok') {
        for (const ref of e.provenance_added ?? [])
          if (!seen.some((r) => refKey(r) === refKey(ref))) seen.push(ref)
      }
      if (e.type === 'run.completed') {
        summary = e.summary
        for (const out of e.outputs) if (out.kind === 'answer') answers.push(out.text)
      }
    }
    try {
      const result = await adapter.run(request, sink, new AbortController().signal)
      summary = result.summary
      for (const out of result.outputs) if (out.kind === 'answer') answers.push(out.text)
      // 37 §2.2b：Agent 说的话进时间线；摘要与会话引用由 onRunCompleted 落到事项上
      if (answers.length > 0) {
        work?.appendEvent(input.matter.id, {
          kind: 'agent_message',
          text: answers.join('\n'),
          actor: { kind: 'agent', id: input.actor.assignment_id },
          run_id,
        })
      }
      work?.onRunCompleted({
        matter_id: input.matter.id,
        run_id,
        summary,
        session_ref: result.session_ref,
      })
    } catch (err) {
      work?.appendEvent(input.matter.id, {
        kind: 'status',
        text: `这次运行没跑成：${err instanceof Error ? err.message : String(err)}`,
        actor: { kind: 'system', id: 'runtime' },
        run_id,
      })
    } finally {
      scope = undefined
    }
    return { run_id }
  }

  return {
    adapter,
    bind(w) {
      work = w
    },
    startRun,
  }
}
