/**
 * 门禁插件（dsh 插件，`@deepseek-ai/cordis`）。
 *
 * 17 §4 列的 seam 全部在这里落地，业务代码不直接 import dsh：
 * - `tools/pre-execute`：allowlist + 16 §3 副作用分类（executor 下 `write_external` 一律拒）
 * - `tools/post-execute`：结果过 `EXTERNAL_FENCE`、实体 id 进 Provenance、发 `tool.result`
 * - `approval/request` answerer：把 dsh 的审批请求转成我们的审批项，fail-closed
 * - `systemPrompt.section`：persona 段（`complete` 段，遮蔽 dsh 自带的 persona 前后缀）
 * - `systemPrompt.context`：每个 ContextItem 一段，注册即发 `context.injected`
 * - `ctx.tools.restrict({ allow })`：在 preset 的 agent scope 里生效
 */
import type { ObjectRef, RunEvent, RunRequest } from '@agentsws/contracts'
import { EXTERNAL_FENCE, type Provenance } from '@agentsws/core'
import type {
  BoundaryGate,
  CreateDraftFn,
  DraftPayload,
  StageFn,
  StageIntent,
} from '@agentsws/stand-ins'
import { boundaryGate, contextItemHash, ontologyBriefOf } from '@agentsws/stand-ins'
import type { Context } from '@deepseek-ai/cordis'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { PostToolDecision, PreToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { inferRefs, plainText } from './reading.js'
import { buildToolDefinitions, classifySideEffect, DRAFT_TOOL, STAGE_TOOL } from './tools.js'
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

export interface GateInput {
  request: RunRequest
  sink: (e: RunEvent) => void
  provenance: Provenance
  options: DshRuntimeOptions
  /** 由运行时提供：把工具入参补成完整的 stage 意图（运行时才知道订单与政策）。 */
  buildStageIntent(args: {
    amount: number
    currency?: string
    reason?: string
  }): StageIntent | undefined
  buildDraftPayload(args: { subject: string; body: string }): DraftPayload | undefined
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
  scope: Scope
  records: Map<string, GateRecord>
  /** 已发过 `tool.result` 的 call_id。 */
  emitted: Set<string>
  /** 注入模型的上下文段名（按注册顺序），回放校验用。 */
  contextNames: string[]
  /** 36 §2.2 的边界判定（与 stub / direct-llm 同一份：`@agentsws/stand-ins` 的 `boundaryGate`）。 */
  boundary: BoundaryGate
  /**
   * 把没答过的边界发成选择题卡（`policy_change`），同一次运行只发一次。
   * `tools/pre-execute` 拒掉 stage 时调它；运行时也调它（跳过 stage 那条路）。
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

  const agent: object = { preset: request.runtime.preset, run_id: request.id }
  const scope = createScope(ctx, agent)

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
  const draftResults = new Map<string, { approval_item_id: string }>()

  const api: GateApi = {
    ctx,
    agent,
    scope,
    records: new Map(),
    emitted: new Set(),
    contextNames: [],
    boundary,
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
      await scope.dispose()
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
        return stageResults.get(callId)
      },
      async draft(callId, args) {
        const payload = input.buildDraftPayload(args)
        if (payload === undefined) return undefined
        pendingDraft.set(callId, payload)
        const outcome = await api.requestApproval({
          toolName: DRAFT_TOOL,
          callId,
          reason: payload.subject,
        })
        if (outcome !== GRANT) return undefined
        return draftResults.get(callId)
      },
    },
  )
  for (const def of definitions) ctx.tools.register(def)

  // ── `ctx.tools.restrict`：preset 的工具集按 RunRequest.tools.allow ───────
  const visible = definitions.map((d) => d.name).filter((n) => allow.has(n))
  if (visible.length > 0) scope.ctx.tools.restrict({ allow: visible })

  // ── `tools/pre-execute`：两道门（17 §6.3）────────────────────────────────
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const call_id = String(exec.callId)
    if (!allow.has(exec.name)) {
      const reason = `not_in_allowlist: ${exec.name}`
      note(api, {
        call_id,
        tool: exec.name,
        status: 'blocked',
        reason,
        provenance_added: [],
      })
      emitResult(api, sink, call_id)
      return { kind: 'deny', reason }
    }
    // 36 §2.2：没答过的边界挡着变更——拒掉这次 stage，同时把选择题发给商家
    if (exec.name === STAGE_TOOL && !boundary.allowed) {
      await api.askBoundaries()
      const reason = `boundary_unanswered: ${boundary.missing.map((b) => b.id).join(',')}`
      note(api, { call_id, tool: exec.name, status: 'blocked', reason, provenance_added: [] })
      emitResult(api, sink, call_id)
      return { kind: 'deny', reason }
    }
    const effect = classifySideEffect(exec.name, options.sideEffects)
    if (effect === 'write_external' && request.tools.side_effect_policy === 'executor') {
      const reason = `write_external_requires_executor: ${exec.name}`
      note(api, { call_id, tool: exec.name, status: 'blocked', reason, provenance_added: [] })
      emitResult(api, sink, call_id)
      return { kind: 'deny', reason }
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
        const res = await create(payload)
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
  // 真正喂给模型的那一份仍然是 `assemblePrompt(req)`（`runtime.ts` 里），
  // 两边同一个生成器，所以 `systemText()` 看到的与模型看到的是同一段话。
  const persona = [...request.persona.sections]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((s) => `## ${s.id} ${s.name}\n${s.text}`)
    .join('\n\n')
  const brief = ontologyBriefOf(request)
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
