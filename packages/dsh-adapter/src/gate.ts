/**
 * 门禁插件（dsh 插件，`@deepseek-ai/cordis`）。
 *
 * 17 §4 列的 seam 全部在这里落地，业务代码不直接 import dsh：
 * - `tools/pre-execute`：预算 + allowlist + 业务边界 + 15 §6 provenance + 16 §3 副作用分类
 * - `tools/post-execute`：结果过 `EXTERNAL_FENCE`、实体 id 进 Provenance、发 `tool.result`
 * - `approval/request` answerer：把 dsh 的审批请求转成我们的审批项，fail-closed
 * - `systemPrompt.section`：persona 段（`complete` 段，遮蔽 dsh 自带的 persona 前后缀）
 * - `systemPrompt.context`：每个 ContextItem 一段，注册即发 `context.injected`
 * - `ctx.tools.restrict({ allow })`：在 **Agent 的 scoped ctx** 上调（全局 ctx 会抛）
 *
 * WP81：回合改由 dsh 的 agent-loop 驱动之后，两个产出工具（stage / draft）由**模型**调，
 * 门禁因此多担三件事——预算计数、`15 §6 先读后写`、产出物登记（`change.staged` /
 * `proposal.created` 与 `RunResult.outputs`）。这些以前在 `runtime.ts` 自排回合时做。
 */
import type { ObjectRef, RunEvent, RunOutput, RunRequest } from '@agentsws/contracts'
import { EXTERNAL_FENCE, type Provenance } from '@agentsws/core'
import type {
  BoundaryGate,
  CreateDraftFn,
  CreateDraftResult,
  DraftPayload,
  StageFn,
  StageIntent,
} from '@agentsws/stand-ins'
import {
  boundaryGate,
  contextItemHash,
  ontologyBriefOf,
  rewriteForChannelGuard,
} from '@agentsws/stand-ins'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { PostToolDecision, PreToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { browserBrief, checkBrowserNavigation } from './browser.js'
import { inferRefs, plainText } from './reading.js'
import {
  browserToolName,
  buildToolDefinitions,
  classifySideEffect,
  DRAFT_TOOL,
  STAGE_TOOL,
} from './tools.js'
import type { DshRuntimeOptions, GateRecord } from './types.js'

/** dsh 的审批 seam 词汇（我们只用它的四个结果值，其余靠 answerer 自己判断）。 */
const GRANT: ApprovalOutcome = 'allowed-once'
const OUTCOMES: readonly string[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/** persona 段的名字：`complete` 段是唯一有效段，等于遮蔽 dsh 的 `deployment:persona-*`。 */
export const PERSONA_SECTION = 'agentsws:persona'
/** 每个 ContextItem 一段，名字稳定可回放。 */
export const CONTEXT_PREFIX = 'agentsws:context:'
/** ContextItem 段的起始 order（dsh 中央分配的位置最大 120，往后排不撞名）。 */
const CONTEXT_ORDER_BASE = 1000

/** 模型给 stage 的入参（`STAGE_PARAMS`）。 */
export interface StageArgs {
  order_id?: string
  amount: number
  currency?: string
  reason?: string
  notes?: string[]
}

/** 模型给 draft 的入参（`DRAFT_PARAMS`）。 */
export interface DraftArgs {
  subject: string
  body: string
  to?: string[]
  citations?: { fact_card_id: string; quote: string }[]
  /** 本次运行已经挂上的变更（门禁填，不是模型给的）。 */
  child_change_ids: string[]
}

export interface GateInput {
  request: RunRequest
  sink: (e: RunEvent) => void
  provenance: Provenance
  options: DshRuntimeOptions
  /** 由运行时提供：把工具入参补成完整的 stage 意图（运行时才知道订单与政策）。 */
  buildStageIntent(args: StageArgs): StageIntent | undefined
  buildDraftPayload(args: DraftArgs): DraftPayload | undefined
  /** dsh 官方 Agent（scoped dispatch 与 `tools.restrict` 的路由键）。 */
  agent?: Agent
  /** Agent 的 scoped ctx；`tools.restrict` 只能在它上面调。缺省时自己开一个 scope。 */
  agentCtx?: Context
  /** 一次读工具成功之后回调运行时（运行时据此更新订单等事实）。 */
  onToolResult?: (tool: string, value: unknown) => void
  /** 预算耗尽：宿主发 `budget.exhausted` 并把 Agent 停下。 */
  onBudgetExhausted?: (which: keyof RunRequest['budget'], used: number, cap: number) => void
}

/** 一张发出去的边界选择题卡。 */
export interface AskedBoundary {
  approval_item_id: string
  label: string
}

export interface GateApi {
  ctx: Context
  /** preset 的 agent scope key：`tools.restrict` 与 scoped dispatch 都按它路由。 */
  agent: object
  scope?: Scope
  records: Map<string, GateRecord>
  /** 已发过 `tool.result` 的 call_id。 */
  emitted: Set<string>
  /** 注入模型的上下文段名（按注册顺序），回放校验用。 */
  contextNames: string[]
  /** 36 §2.2 的边界判定（与 stub / direct-llm 同一份：`@agentsws/stand-ins` 的 `boundaryGate`）。 */
  boundary: BoundaryGate
  /** 本次运行的产物（17 §2 的 `RunResult.outputs`）。 */
  outputs: RunOutput[]
  /** 真的读成功过的工具（按调用顺序，摘要用）。 */
  readTools: string[]
  /** 已经消耗的工具调用数（预算）。 */
  toolCalls: number
  staged: boolean
  drafted: boolean
  stagedMoney?: { kind: string; amount: number; currency: string }
  stagedChangeIds: string[]
  /** 预算耗尽的那一项（运行时据此收成 `budget_exhausted`）。 */
  exhausted?: { which: keyof RunRequest['budget']; used: number; cap: number }
  /**
   * 把没答过的边界发成选择题卡（`policy_change`），同一次运行只发一次。
   * `tools/pre-execute` 拒掉 stage 时调它；运行时也调它（模型压根没提变更那条路）。
   */
  askBoundaries(): Promise<AskedBoundary[]>
  /** 供契约测试直接驱动 answerer waterfall。 */
  requestApproval(req: {
    toolName: string
    callId?: string
    reason?: string
  }): Promise<ApprovalOutcome>
  /** 经 dsh 工具流水线执行一次调用（带 agent scope）。 */
  execute(
    call_id: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<ToolExecutionResult>
  dispose(): Promise<void>
}

function isOutcome(v: unknown): v is ApprovalOutcome {
  return typeof v === 'string' && OUTCOMES.includes(v)
}

/** 记一条判定；同一 call_id 只记第一条（pre-execute 的拒绝优先于后续）。 */
function note(api: GateApi, record: GateRecord): void {
  if (!api.records.has(record.call_id)) api.records.set(record.call_id, record)
}

function emitResult(api: GateApi, sink: (e: RunEvent) => void, call_id: string): void {
  if (api.emitted.has(call_id)) return
  const rec = api.records.get(call_id)
  if (rec === undefined) return
  api.emitted.add(call_id)
  sink({
    type: 'tool.result',
    call_id,
    status: rec.status,
    ...(rec.reason === undefined ? {} : { reason: rec.reason }),
    ...(rec.provenance_added.length > 0 ? { provenance_added: rec.provenance_added } : {}),
  })
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/**
 * 在一个已注入 `tools` / `systemPrompt` 的 context 上装好整套门禁。
 * 调用方保证 `ctx` 已经拿到服务（见 `harness.ts` 的 inject 行）。
 */
export function installGate(ctx: Context, input: GateInput): GateApi {
  const { request, sink, provenance, options } = input
  const allow = new Set(request.tools.allow)
  // staging 工具是我们自己的出口，不在 Connect 的 allowlist 里，但必须可调
  allow.add(STAGE_TOOL)
  allow.add(DRAFT_TOOL)
  /*
   * WP82（55 §3）：浏览器工具不是 Connect 发的，也不在职责的 `tools.allow` 里——
   * 它们由官方 provider 按 Agent 注册（`harness.ts` 的 `setup`）。**这一整组在不在，
   * 只取决于 `RunRequest.browser` 给没给**：不给就连 provider 都不挂，一个都不存在。
   *
   * 给了就整个命名空间（`mcp__playwright-mcp__*`）过 allowlist 这一关——不逐个列名，
   * 理由是上游随时会增删工具，写死一张名单只会让新工具变成"不在 allowlist"这种
   * 看不懂的拒绝。**真正管着它们的是后面三道**：域名白名单、读写分类（表外一律按写，
   * 公司端因此拒）、注 JS 公司端硬拒。新来的工具默认落到"按写"，方向是对的。
   */
  const browserOn = request.browser !== undefined
  const allowed = (name: string): boolean =>
    allow.has(name) || (browserOn && browserToolName(name) !== undefined)

  // Agent 层在场时用真 Agent 当 scope key（官方语义）；没有时退回一个占位键 + 自开 scope。
  const agent: object = input.agent ?? { preset: request.runtime.preset, run_id: request.id }
  const scope: Scope | undefined =
    input.agentCtx === undefined ? createScope(ctx, agent) : undefined
  const scopedCtx: Context = input.agentCtx ?? (scope as Scope).ctx

  // 36 §2.2：管着这次变更的边界答过没有。三个运行时同一份判定。
  const boundary = boundaryGate({
    request,
    now: options.clock.now(),
    defaultReturnWindowDays: options.defaultReturnWindowDays ?? 14,
  })
  let askedOnce: Promise<AskedBoundary[]> | undefined

  const pendingStage = new Map<string, StageIntent>()
  const pendingDraft = new Map<string, DraftPayload>()
  const stageResults = new Map<string, { change_id: string }>()
  const draftResults = new Map<string, Exclude<CreateDraftResult, undefined>>()

  const api: GateApi = {
    ctx,
    agent,
    ...(scope === undefined ? {} : { scope }),
    records: new Map(),
    emitted: new Set(),
    contextNames: [],
    boundary,
    outputs: [],
    readTools: [],
    toolCalls: 0,
    staged: false,
    drafted: false,
    stagedChangeIds: [],
    async askBoundaries() {
      if (askedOnce === undefined) askedOnce = askAll()
      return askedOnce
    },
    async requestApproval(req) {
      try {
        // 17 §4 的 answerer waterfall：任一 answerer 认领即返回；没人认领 → `unavailable`（fail-closed）
        const out: unknown = await ctx.waterfall(
          'approval/request',
          { agent, toolName: req.toolName, callId: req.callId, reason: req.reason } as never,
          async () => 'unavailable' as ApprovalOutcome,
        )
        return isOutcome(out) ? out : 'unavailable'
      } catch {
        return 'unavailable'
      }
    },
    async execute(call_id, name, toolInput) {
      return ctx.tools.execute({
        callId: call_id as never,
        name,
        arguments: toolInput,
        agent: agent as never,
        signal: new AbortController().signal,
      })
    },
    async dispose() {
      await scope?.dispose()
    },
  }

  /** 逐条把没答过的边界发成卡；宿主不接回调就什么都不发生。 */
  async function askAll(): Promise<AskedBoundary[]> {
    const ask = options.createPolicyQuestion
    if (ask === undefined || boundary.missing.length === 0) return []
    const out: AskedBoundary[] = []
    for (const item of boundary.missing) {
      const asked = await ask({ request, boundary: item })
      if (asked === undefined) continue
      out.push({ approval_item_id: asked.approval_item_id, label: item.label })
      sink({
        type: 'proposal.created',
        approval_item_id: asked.approval_item_id,
        kind: 'policy_change',
      })
      api.outputs.push({ kind: 'proposal', approval_item_id: asked.approval_item_id })
    }
    return out
  }

  // ── 工具：注册进 dsh 的注册表，读走注入的出口，写走审批 seam ────────────
  const definitions = buildToolDefinitions(
    request,
    {
      async run(name, toolInput) {
        const exec = options.executeTool
        if (exec === undefined) return { status: 'error', reason: 'no_tool_executor' }
        return exec({ name, input: toolInput, request })
      },
      note(callId, tool, status, reason) {
        note(api, { call_id: callId, tool, status, reason, provenance_added: [] })
      },
      provenance(callId, refs) {
        provenance.see(refs, { full: true })
        const rec = api.records.get(callId)
        if (rec !== undefined) rec.provenance_added.push(...refs)
        else {
          api.records.set(callId, {
            call_id: callId,
            tool: '',
            status: 'ok',
            provenance_added: [...refs],
          })
        }
      },
    },
    {
      async stage(callId, args) {
        const intent = input.buildStageIntent(args)
        if (intent === undefined) return undefined
        pendingStage.set(callId, intent)
        const outcome = await api.requestApproval({
          toolName: STAGE_TOOL,
          callId,
          reason: intent.notes.join('；'),
        })
        if (outcome !== GRANT) return undefined
        const res = stageResults.get(callId)
        if (res === undefined) return undefined
        // 15 §6：动过的实体钉住；产物与事件在这里登记（一次运行只此一处）
        api.staged = true
        api.stagedMoney = {
          kind: intent.kind,
          amount: intent.money?.amount ?? args.amount,
          currency: intent.money?.currency ?? args.currency ?? 'USD',
        }
        api.stagedChangeIds.push(res.change_id)
        provenance.pin(intent.target)
        sink({ type: 'change.staged', change_id: res.change_id })
        api.outputs.push({ kind: 'staged_change', change_id: res.change_id })
        return res
      },
      async draft(callId, args) {
        const payload = input.buildDraftPayload({
          ...args,
          child_change_ids: [...api.stagedChangeIds],
        })
        if (payload === undefined) return undefined
        pendingDraft.set(callId, payload)
        const outcome = await api.requestApproval({
          toolName: DRAFT_TOOL,
          callId,
          reason: payload.subject,
        })
        if (outcome !== GRANT) return undefined
        const res = draftResults.get(callId)
        if (res === undefined || !('approval_item_id' in res)) return undefined
        api.drafted = true
        sink({
          type: 'proposal.created',
          approval_item_id: res.approval_item_id,
          kind: 'outbound_draft',
        })
        api.outputs.push({ kind: 'draft', approval_item_id: res.approval_item_id })
        return res
      },
    },
  )
  for (const def of definitions) ctx.tools.register(def)

  // ── `ctx.tools.restrict`：preset 的工具集按 RunRequest.tools.allow ───────
  //
  // WP82 查证：**浏览器工具不用（也不能）列进这里**。`restrict` 只遮"继承下来的
  // 全局工具"，上游原话是 "Restrictions intersect; scoped registrations remain
  // visible"；而官方 provider 是在它自己那个 `createScope(ctx, agent)` 里注册
  // MCP 工具的（scoped registration），本来就不受这张白名单影响。真列进去反而会抛
  // ——restrict 只认调用当刻**已经全局注册**的名字，而 provider 是在 `agent/created`
  // 之后才挂的，比 `setup` 晚一步。
  const visible = definitions.map((d) => d.name).filter((n) => allow.has(n))
  if (visible.length > 0) scopedCtx.tools.restrict({ allow: visible })

  // ── `tools/pre-execute`：预算 + 三道门（17 §6.3）────────────────────────
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const call_id = String(exec.callId)
    const deny = (reason: string): PreToolDecision => {
      note(api, { call_id, tool: exec.name, status: 'blocked', reason, provenance_added: [] })
      emitResult(api, sink, call_id)
      return { kind: 'deny', reason }
    }
    // 17 §5.3：工具调用预算是硬的，超了当场拒并补齐这条调用
    const cap = request.budget.max_tool_calls
    if (api.toolCalls >= cap) {
      if (api.exhausted === undefined) {
        api.exhausted = { which: 'max_tool_calls', used: api.toolCalls, cap }
        input.onBudgetExhausted?.('max_tool_calls', api.toolCalls, cap)
      }
      return deny('budget_exhausted')
    }
    if (api.toolCalls + 1 === cap) {
      sink({ type: 'budget.warning', which: 'max_tool_calls', used: api.toolCalls + 1, cap })
    }
    api.toolCalls += 1

    if (!allowed(exec.name)) return deny(`not_in_allowlist: ${exec.name}`)
    // 36 §2.2：没答过的边界挡着变更——拒掉这次 stage，同时把选择题发给商家
    if (exec.name === STAGE_TOOL && !boundary.allowed) {
      await api.askBoundaries()
      return deny(`boundary_unanswered: ${boundary.missing.map((b) => b.id).join(',')}`)
    }
    // 15 §6：只能对本次运行「读过」的实体动手
    if (exec.name === STAGE_TOOL) {
      const orderId = asRecord(exec.arguments).order_id
      if (typeof orderId === 'string' && !provenance.has({ type: 'order', id: orderId })) {
        return deny('provenance_missing')
      }
    }
    const args = asRecord(exec.arguments)
    // WP82（55 §3）：注 JS 公司端一律拒 + 域名白名单（只看要打开的那个地址）
    const browserDenial = checkBrowserNavigation({
      tool: exec.name,
      args,
      allowedHosts: request.allowed_hosts,
      policy: request.tools.side_effect_policy,
    })
    if (browserDenial !== undefined) return deny(browserDenial)

    const effect = classifySideEffect(exec.name, options.sideEffects, args)
    if (effect === 'write_external' && request.tools.side_effect_policy === 'executor') {
      return deny(`write_external_requires_executor: ${exec.name}`)
    }
    /*
     * WP82：个人档放行浏览器的写操作（点击、输入、提交）——那是用户自己的浏览器、
     * 自己的登录态。放行归放行，**得留下痕迹**：这一条 `progress` 就是
     * 「AI 在我的浏览器里动了手」在时间线上的那一行，与 `tool.call` / `tool.result`
     * 一起构成 16 §2 的 Model-visible ⟺ logged。
     */
    if (effect === 'write_external' && browserToolName(exec.name) !== undefined) {
      sink({ type: 'progress', step: 'browser_write', note: exec.name })
    }
    return next()
  })

  // ── `tools/post-execute`：围栏 + provenance + 事件 ───────────────────────
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const call_id = String(exec.callId)
    const decision = await next()
    if (decision.kind === 'block') {
      note(api, {
        call_id,
        tool: exec.name,
        status: 'blocked',
        reason: 'post_execute_block',
        provenance_added: [],
      })
      emitResult(api, sink, call_id)
      return decision
    }
    if (result.isError) {
      // 失败结果不允许被替换 value（dsh 的规矩），只登记与发事件
      const existing = api.records.get(call_id)
      note(api, {
        call_id,
        tool: exec.name,
        status: existing?.status ?? 'error',
        reason: existing?.reason ?? result.error.message,
        provenance_added: [],
      })
      emitResult(api, sink, call_id)
      return decision
    }
    // 结果是外部文本：围栏（fencing 在入口，运行时不再信任任何外部文本）
    const fenced = EXTERNAL_FENCE.sanitizeValue(result.value) as JsonValue
    const refs: ObjectRef[] = inferRefs(result.value)
    if (refs.length > 0) provenance.see(refs, { full: true })
    const rec = api.records.get(call_id)
    const added = [...(rec?.provenance_added ?? [])]
    for (const ref of refs) {
      if (!added.some((r) => r.type === ref.type && r.id === ref.id)) added.push(ref)
    }
    api.records.set(call_id, {
      call_id,
      tool: exec.name,
      status: 'ok',
      provenance_added: added,
    })
    if (exec.name !== STAGE_TOOL && exec.name !== DRAFT_TOOL) {
      api.readTools.push(exec.name)
      input.onToolResult?.(exec.name, result.value)
    }
    emitResult(api, sink, call_id)
    return { kind: 'accept', value: fenced }
  })

  // ── `approval/request` answerer：dsh 的审批请求 → 我们的审批项 ────────────
  ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
    const callId = typeof req.callId === 'string' ? req.callId : undefined
    if (callId === undefined) return next()
    try {
      if (req.toolName === STAGE_TOOL) {
        const intent = pendingStage.get(callId)
        if (intent === undefined) return 'unavailable'
        const stage: StageFn | undefined = options.stage
        if (stage === undefined) return 'unavailable'
        const res = await stage(intent)
        if (res === undefined) return 'rejected'
        stageResults.set(callId, res)
        return GRANT
      }
      if (req.toolName === DRAFT_TOOL) {
        const payload = pendingDraft.get(callId)
        if (payload === undefined) return 'unavailable'
        const create: CreateDraftFn | undefined = options.createDraft
        if (create === undefined) return 'unavailable'
        // WP55 / 48 §4 L3 #2：出站硬闸的重写循环。拦下 = **打回重写**——原因回到
        // 写正文的这一跳，重写一版再提交给闸判一次；绝不静默删改后照发。
        // 循环在 answerer 里而不是在 turn loop 里：重写是同一次 `draft_reply`
        // 调用内部的事，跑成两次工具调用会让 dsh 这一档的工具计数与另外两个
        // 运行时对不上。只重写一次：修不好的那几类本来就不该进重写循环。
        let res = await create(payload)
        if (res !== undefined && 'rewrite' in res) {
          sink({
            type: 'progress',
            step: 'channel_guard_rewrite',
            note: res.rewrite.split('\n')[1] ?? '',
          })
          res = await create({ ...payload, body: rewriteForChannelGuard(payload.body) })
        }
        if (res === undefined) return 'rejected'
        draftResults.set(callId, res)
        return GRANT
      }
      return next()
    } catch {
      // fail closed：answerer 抛错等于没有答案
      return 'unavailable'
    }
  })

  // ── `systemPrompt.section`：persona（complete 段 = 唯一有效段）──────────
  //
  // 47 J3 的那一段"你能查什么、能做什么"跟着 persona 一起进这个段：
  // preset 的白名单里 complete 段是**唯一**有效段（16 §2），另开一段会被遮掉。
  // WP81 起这一份**真的送模型**：dsh 的 `systemPrompt.assemble()` 就是 agent-loop
  // 每一步的系统提示词（54（将改号 55）§2.2 第三条）。
  const persona = [...request.persona.sections]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((s) => `## ${s.id} ${s.name}\n${s.text}`)
    .join('\n\n')
  //
  // WP82：浏览器那一段也进**这一个**段。官方 provider 自己加的 `mcp:playwright-mcp`
  // 段会被 complete 段遮掉（WP70 实测），所以"能打开哪些站、遇到登录页怎么办"
  // 只能由我们自己写进来——不写的话模型对这两件事一无所知。
  const brief = [
    ontologyBriefOf(request),
    ...(browserOn
      ? [
          browserBrief({
            allowedHosts: request.allowed_hosts,
            policy: request.tools.side_effect_policy,
          }),
        ]
      : []),
  ]
    .filter((t) => t !== '')
    .join('\n\n')
  ctx.systemPrompt.section({
    name: PERSONA_SECTION,
    order: 0,
    text: brief === '' ? persona : `${persona}\n\n${brief}`,
    complete: true,
  })

  // ── `systemPrompt.context`：每个 ContextItem 一段 + `context.injected` ───
  request.context.forEach((item, i) => {
    const name = `${CONTEXT_PREFIX}${item.id}`
    ctx.systemPrompt.context({
      name,
      order: CONTEXT_ORDER_BASE + i,
      text: `[${item.kind}:${item.id}]\n${plainText(item.content)}`,
    })
    api.contextNames.push(name)
    sink({
      type: 'context.injected',
      item_id: item.id,
      kind: item.kind,
      bytes: item.bytes,
      hash: contextItemHash(item),
    })
    const ref = typeof item.source_ref === 'string' ? undefined : item.source_ref
    if (ref !== undefined) provenance.see([ref])
  })

  return api
}
