import type {
  ChangeKind,
  ChatMessage,
  Clock,
  ContextItem,
  Iso8601,
  ObjectRef,
  RunEvent,
  RunOutput,
  RunRequest,
  RunResult,
  RuntimeAdapter,
  ToolDef,
} from '@agentsws/contracts'
import { canonicalJson, Provenance, sha256 } from '@agentsws/core'
import { staticPrefixHash } from '@agentsws/model-gateway'
import { orderTools, runOntologyBrief } from '@agentsws/ontology'
import type { BoundaryItem } from '@agentsws/support-core'
import { renderReplyBody } from '@agentsws/support-core'
import { boundaryGate, describeRun } from './support.js'

export interface ToolExecution {
  status: 'ok' | 'error' | 'blocked'
  data?: unknown
  reason?: string
  provenance?: ObjectRef[]
}

export type ToolExecutor = (call: {
  name: string
  input: Record<string, unknown>
  request: RunRequest
}) => Promise<ToolExecution>

/** 15 §5 stage 的意图：stub 只表达"要改什么"，账本与门禁由注入的回调（真实 txn 包）负责。 */
export interface StageIntent {
  request: RunRequest
  kind: ChangeKind
  target: ObjectRef
  field?: string
  before: unknown
  after: unknown
  money?: { amount: number; currency: string }
  notes: string[]
  requester?: { channel: string; external_id: string }
}

export type StageFn = (intent: StageIntent) => Promise<{ change_id: string } | undefined>

export interface DraftPayload {
  request: RunRequest
  channel: 'email'
  to: string[]
  subject: string
  body: string
  thread_external_id?: string
  child_change_ids: string[]
  citations: { fact_card_id: string; quote: string }[]
}

export type CreateDraftFn = (
  payload: DraftPayload,
) => Promise<{ approval_item_id: string } | undefined>

/**
 * 36 §2.2 的选择题卡：第一次遇到一条没答过的业务边界时问一次。
 * 宿主不接这个回调时什么都不会发生——起草照常，只是少了那张卡。
 */
export type CreatePolicyQuestionFn = (input: {
  request: RunRequest
  boundary: BoundaryItem
}) => Promise<{ approval_item_id: string } | undefined>

export interface StubRuntimeOptions {
  clock: Clock
  /** 26 §3：seed 决定一切随机；同 seed 同请求 → 同事件序列。 */
  seed?: number
  executeTool?: ToolExecutor
  stage?: StageFn
  createDraft?: CreateDraftFn
  createPolicyQuestion?: CreatePolicyQuestionFn
  /** policy 上下文里读不到窗口时的默认退货窗口天数。 */
  defaultReturnWindowDays?: number
  signature?: string
}

const DAY = 86_400_000

// ---------- 上下文读取 ----------

function itemsOfKind(req: RunRequest, kind: ContextItem['kind']): ContextItem[] {
  return req.context.filter((c) => c.kind === kind)
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function plainText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(plainText).join('\n')
  const o = asRecord(v)
  if (!o) return String(v)
  const preferred = ['body', 'text', 'message', 'content', 'subject', 'summary']
  const picked = preferred.filter((k) => typeof o[k] === 'string').map((k) => o[k] as string)
  if (picked.length > 0) return picked.join('\n')
  return Object.values(o).map(plainText).join('\n')
}

function refOf(item: ContextItem): ObjectRef | undefined {
  const src = item.source_ref
  if (typeof src === 'string') return undefined
  return src
}

interface OrderView {
  ref: ObjectRef
  id: string
  name: string
  email?: string
  currency: string
  total_price: number
  refunded_amount: number
  financial_status: string
  fulfillment_status: string
  delivered_at?: Iso8601
  customer_name?: string
  record_version?: string
}

function orderView(source: unknown, fallbackRef?: ObjectRef): OrderView | undefined {
  const o = asRecord(source)
  if (!o) return undefined
  const id = typeof o.id === 'string' ? o.id : fallbackRef?.id
  if (id === undefined) return undefined
  const address = asRecord(o.shipping_address)
  return {
    ref: { type: 'order', id },
    id,
    name: typeof o.name === 'string' ? o.name : id,
    currency: typeof o.currency === 'string' ? o.currency : 'USD',
    total_price: typeof o.total_price === 'number' ? o.total_price : 0,
    refunded_amount: typeof o.refunded_amount === 'number' ? o.refunded_amount : 0,
    financial_status: typeof o.financial_status === 'string' ? o.financial_status : 'unknown',
    fulfillment_status: typeof o.fulfillment_status === 'string' ? o.fulfillment_status : 'unknown',
    ...(typeof o.email === 'string' ? { email: o.email } : {}),
    ...(typeof o.delivered_at === 'string' ? { delivered_at: o.delivered_at } : {}),
    ...(typeof address?.name === 'string' ? { customer_name: address.name } : {}),
    ...(typeof o.record_version === 'string' ? { record_version: o.record_version } : {}),
  }
}

/** 从 policy / fact_card 里读退货窗口天数（`14 days` / `14 天` / `return_window_days: 14`）。 */
function returnWindowDays(
  req: RunRequest,
  fallback: number,
): { days: number; source?: ContextItem } {
  const candidates = [...itemsOfKind(req, 'policy'), ...itemsOfKind(req, 'fact_card')]
  for (const item of candidates) {
    const o = asRecord(item.content)
    const explicit = o?.return_window_days
    if (typeof explicit === 'number' && Number.isFinite(explicit)) {
      return { days: explicit, source: item }
    }
    const m = plainText(item.content).match(/(\d{1,3})\s*(?:days?|天)/i)
    if (m?.[1]) return { days: Number.parseInt(m[1], 10), source: item }
  }
  return { days: fallback }
}

function hitsRule(text: string, rule: RunRequest['grounding'][number]): boolean {
  const lower = text.toLowerCase()
  return [...rule.intent_terms, ...rule.cue_terms].some(
    (t) => t.length > 0 && lower.includes(t.toLowerCase()),
  )
}

// ---------- prompt 装配 ----------

/**
 * 17 §1 的两个产出工具：它们是宿主回调，不在 `tools.allow` 里，但模型看得见、
 * 也确实调得到——所以按岗位裁剪登记表时必须把它们算进"你能做什么"。
 *
 * 只有一处定义（`runtime-direct` 的 `outputToolDefs` 也用它），否则两边一错位，
 * 提示词里许诺的工具与真正注册的工具就对不上了。
 */
export function outputToolNames(req: RunRequest): string[] {
  const wants = new Set(req.expectations.outputs)
  const names: string[] = []
  if (wants.has('draft')) names.push(DRAFT_REPLY_TOOL)
  if (wants.has('staged_change') || req.expectations.must_stage_if_change_requested)
    names.push(STAGE_REFUND_TOOL)
  return names.sort()
}

export const DRAFT_REPLY_TOOL = 'draft_reply'
export const STAGE_REFUND_TOOL = 'stage_refund'

/**
 * 47 J3：工具面按**查对象 → 查知识 → 提议动作**三组排列。
 * 排序规则在 `@agentsws/ontology`（登记表知道每个 Action 读的是哪类对象、是读是写）；
 * 这里只负责让三个运行时用同一份顺序——名字一个字都不改，只换先后。
 */
function toolDefs(req: RunRequest): ToolDef[] {
  return orderTools(req.tools.allow).map((name) => ({
    name,
    description: `stand-in tool ${name}`,
    input_schema: { type: 'object' },
  }))
}

/**
 * 17 §1 装配顺序：静态前缀（persona 段 + skills 索引行 + 登记表那一段 + 工具定义）→
 * 策略层 → 工作项上下文 → 用户消息。静态前缀只由请求里稳定的部分构成，字节稳定。
 *
 * 导出给模拟回路（17 §6.1、26 §6）：回放事件日志时用同一个函数重组 prompt，
 * 与 `prompt.assembled.hash` 比对——同一个定义，不允许两处实现。
 *
 * **47 J3 那一段"你能查什么、能做什么"从本体登记表生成**，不手写：它是纯函数
 * （输入只有 `actor` 与 `tools.allow`），所以回放照样重组得出同一份字节。
 */
export function assemblePrompt(req: RunRequest): { messages: ChatMessage[]; tools: ToolDef[] } {
  const persona = [...req.persona.sections]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((s) => `## ${s.id} ${s.name}\n${s.text}`)
    .join('\n\n')
  const skills = req.skills
    .map((s) => `- ${s.name}${s.min_version ? `@${s.min_version}` : ''} (${s.tier}/${s.load})`)
    .join('\n')
  const messages: ChatMessage[] = [
    { role: 'system', content: persona },
    { role: 'system', content: `# skills\n${skills}` },
  ]
  const brief = ontologyBriefOf(req)
  if (brief !== '') messages.push({ role: 'system', content: brief })
  const ordered = [
    ...itemsOfKind(req, 'policy'),
    ...req.context.filter(
      (c) => c.kind !== 'policy' && c.kind !== 'thread' && c.kind !== 'app_events',
    ),
    ...itemsOfKind(req, 'app_events'),
    ...itemsOfKind(req, 'thread'),
  ]
  for (const item of ordered) {
    messages.push({
      role: item.kind === 'thread' ? 'user' : 'system',
      content: `[${item.kind}:${item.id}]\n${plainText(item.content)}`,
    })
  }
  return { messages, tools: toolDefs(req) }
}

/** 47 J3 的那一段（按这次运行的工具面裁剪登记表）。 */
export function ontologyBriefOf(req: RunRequest): string {
  return runOntologyBrief({
    assignment_id: req.actor.assignment_id,
    role_id: req.actor.role_id,
    tools: [...req.tools.allow, ...outputToolNames(req)],
  })
}

/**
 * `prompt.assembled.hash` 的计算式（17 §2）。运行时发事件与回放校验共用这一处。
 */
export function promptHash(prompt: { messages: ChatMessage[]; tools: ToolDef[] }): string {
  return sha256(canonicalJson(prompt))
}

/** 从 RunRequest 直接算出 `prompt.assembled.hash`（装配 + 哈希）。 */
export function assemblePromptHash(req: RunRequest): string {
  return promptHash(assemblePrompt(req))
}

/** 单个 ContextItem 的 `context.injected.hash` 计算式（17 §2）。 */
export function contextItemHash(item: ContextItem): string {
  return sha256(canonicalJson(item.content))
}

function estimateTokens(messages: ChatMessage[], tools: ToolDef[]): number {
  const chars =
    messages.reduce((n, m) => n + m.content.length + m.role.length, 0) + canonicalJson(tools).length
  return Math.ceil(chars / 4)
}

// ---------- 适配器 ----------

/**
 * 26 §3 / 17 §4 `stub` 运行时：按规则出草稿（fast 档）。
 * 读 RunRequest 的 context 与 grounding，先调工具、再起草回复、需要改动就 stage，
 * 全程发 17 §2 的事件；预算是硬的；同 seed 同请求 → 逐条相同的事件序列。
 */
export function createStubRuntime(options: StubRuntimeOptions): RuntimeAdapter {
  const { clock } = options
  const seed = options.seed ?? 1
  const defaultWindow = options.defaultReturnWindowDays ?? 14
  const signature = options.signature ?? 'Customer Care'
  const seenPrefixes = new Set<string>()

  return {
    name: 'stub',

    capabilities() {
      return { tool_choice: true, streaming: false, followup: false, seedable: true }
    },

    async health() {
      return { ok: true }
    },

    async run(
      req: RunRequest,
      sink: (e: RunEvent) => void,
      signal: AbortSignal,
    ): Promise<RunResult> {
      const startedMs = Date.parse(clock.now())
      const prov = new Provenance(req.id)
      const outputs: RunOutput[] = []
      let toolCalls = 0
      let exhausted: { which: keyof RunRequest['budget']; used: number; cap: number } | undefined

      const finish = (
        status: RunResult['status'],
        summary: string,
        extra?: { no_stage?: boolean },
      ): RunResult => {
        const seconds = Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000)
        const result: RunResult = {
          request_id: req.id,
          status,
          outputs,
          provenance: prov.toState(clock.now()),
          memory_candidates: [],
          lessons: [],
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cached_tokens: usage.cached_tokens,
            tool_calls: toolCalls,
            seconds,
            cost_base: 0,
          },
          session_ref: {
            runtime: 'stub',
            session_id: sha256(canonicalJson({ request: req.id, seed })).slice(0, 26),
            log_uri: `memory://stub/${req.id}`,
          },
          summary,
          ...(extra?.no_stage === true ? { no_stage: true } : {}),
        }
        return result
      }

      const usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }

      sink({ type: 'run.started', request_id: req.id, runtime: 'stub', model: req.runtime.model })
      if (signal.aborted) {
        sink({ type: 'run.cancelled' })
        return finish('cancelled', '运行开始前即被中断')
      }

      // 1) 逐项注入上下文（Model-visible ⟺ logged）
      for (const item of req.context) {
        sink({
          type: 'context.injected',
          item_id: item.id,
          kind: item.kind,
          bytes: item.bytes,
          hash: contextItemHash(item),
        })
        const ref = refOf(item)
        if (ref) prov.see([ref])
      }

      // 2) 装配 prompt
      const { messages, tools } = assemblePrompt(req)
      const prefixHash = staticPrefixHash(messages, tools)
      const total_tokens = estimateTokens(messages, tools)
      usage.input_tokens = total_tokens
      if (seenPrefixes.has(prefixHash)) {
        usage.cached_tokens = estimateTokens(
          messages.filter((m, i) => i < 2 && m.role === 'system'),
          tools,
        )
      } else {
        seenPrefixes.add(prefixHash)
      }
      sink({
        type: 'prompt.assembled',
        hash: promptHash({ messages, tools }),
        static_prefix_hash: prefixHash,
        total_tokens,
      })

      if (total_tokens > req.budget.max_tokens) {
        sink({
          type: 'budget.exhausted',
          which: 'max_tokens',
          used: total_tokens,
          cap: req.budget.max_tokens,
        })
        sink({
          type: 'run.completed',
          usage: { ...usage, tool_calls: 0, seconds: 0, cost_base: 0 },
          outputs,
          summary: 'max_tokens 预算耗尽',
        })
        return finish('budget_exhausted', 'max_tokens 预算耗尽')
      }

      // 3) 定位订单 / 线程 / 政策
      const readTools: string[] = []
      const threadItem = itemsOfKind(req, 'thread')[0]
      const threadText = threadItem ? plainText(threadItem.content) : ''
      const orderItem = itemsOfKind(req, 'order')[0]
      let order = orderItem ? orderView(orderItem.content, refOf(orderItem)) : undefined
      const policy = returnWindowDays(req, defaultWindow)

      // 4) grounding：命中即先调工具；没命中但有订单 → 默认 get_order
      const hitRules = req.grounding.filter((r) => hitsRule(threadText, r))
      const plannedTools =
        hitRules.length > 0 ? hitRules.map((r) => r.tool) : order || orderItem ? ['get_order'] : []

      for (const tool of plannedTools) {
        if (signal.aborted) {
          sink({ type: 'run.cancelled' })
          return finish('cancelled', '运行被中断')
        }
        const call_id = `call_${toolCalls + 1}`
        const input = toolInput(tool, { order, orderItem, threadItem, threadText })
        sink({ type: 'tool.call', call_id, tool, input })

        if (toolCalls >= req.budget.max_tool_calls) {
          exhausted = { which: 'max_tool_calls', used: toolCalls, cap: req.budget.max_tool_calls }
          sink({ type: 'budget.exhausted', ...exhausted })
          // 17 §5.3：补齐未闭合的工具调用再结束
          sink({ type: 'tool.result', call_id, status: 'blocked', reason: 'budget_exhausted' })
          break
        }
        if (toolCalls + 1 === req.budget.max_tool_calls) {
          sink({
            type: 'budget.warning',
            which: 'max_tool_calls',
            used: toolCalls + 1,
            cap: req.budget.max_tool_calls,
          })
        }

        const exec = options.executeTool
        if (!exec) {
          sink({ type: 'tool.result', call_id, status: 'error', reason: 'no_tool_executor' })
          toolCalls += 1
          continue
        }
        const res = await exec({ name: tool, input, request: req })
        toolCalls += 1
        if (res.status === 'ok') readTools.push(tool)
        const refs = res.status === 'ok' ? (res.provenance ?? inferRefs(res.data)) : []
        if (refs.length > 0) prov.see(refs, { full: true })
        if (res.status === 'ok' && !order) order = orderView(res.data)
        sink({
          type: 'tool.result',
          call_id,
          status: res.status,
          ...(res.reason === undefined ? {} : { reason: res.reason }),
          ...(refs.length > 0 ? { provenance_added: refs } : {}),
        })
      }

      // 5) 起草回复（+ 窗口内的 stage_refund 意图）
      // 1c：分类与边界判定都交给共享判定（`support.ts`），三个运行时同一份口径
      const subjectLine = threadSubject(threadItem)
      const gate = boundaryGate({
        request: req,
        now: clock.now(),
        defaultReturnWindowDays: defaultWindow,
      })
      const wantsChange = gate.wantsChange
      const deliveredMs = order?.delivered_at ? Date.parse(order.delivered_at) : undefined
      const nowMs = Date.parse(clock.now())
      const daysSince =
        deliveredMs === undefined ? undefined : Math.floor((nowMs - deliveredMs) / DAY)
      const withinWindow =
        !exhausted && daysSince !== undefined && daysSince <= policy.days && order !== undefined
      const refundAmount =
        order === undefined
          ? undefined
          : Math.round((order.total_price - order.refunded_amount) * 100) / 100

      const childChangeIds: string[] = []
      let staged = false
      if (
        !exhausted &&
        wantsChange &&
        gate.allowed &&
        withinWindow &&
        order &&
        refundAmount !== undefined &&
        refundAmount > 0 &&
        options.stage &&
        (req.expectations.outputs.includes('staged_change') ||
          req.expectations.must_stage_if_change_requested)
      ) {
        if (prov.has(order.ref)) {
          const intent: StageIntent = {
            request: req,
            kind: 'refund',
            target: order.ref,
            field: 'refunded_amount',
            before: order.refunded_amount,
            after: order.refunded_amount + refundAmount,
            money: { amount: refundAmount, currency: order.currency },
            notes: [
              `退货窗口 ${policy.days} 天内（签收 ${daysSince ?? '?'} 天）`,
              '由 stub 运行时按政策提出',
            ],
            ...(order.email === undefined
              ? {}
              : { requester: { channel: 'email', external_id: order.email } }),
          }
          const res = await options.stage(intent)
          if (res) {
            staged = true
            childChangeIds.push(res.change_id)
            sink({ type: 'change.staged', change_id: res.change_id })
            outputs.push({ kind: 'staged_change', change_id: res.change_id })
          }
        }
      }

      const askedBoundaries: string[] = []
      if (!exhausted && gate.missing.length > 0 && options.createPolicyQuestion) {
        for (const boundary of gate.missing) {
          const asked = await options.createPolicyQuestion({ request: req, boundary })
          if (asked === undefined) continue
          askedBoundaries.push(boundary.label)
          sink({
            type: 'proposal.created',
            approval_item_id: asked.approval_item_id,
            kind: 'policy_change',
          })
          outputs.push({ kind: 'proposal', approval_item_id: asked.approval_item_id })
        }
      }

      let body = ''
      if (!exhausted && req.expectations.outputs.includes('draft') && options.createDraft) {
        const customer =
          order?.customer_name ??
          order?.email?.split('@')[0] ??
          threadRecipient(threadItem) ??
          'there'
        const subject = subjectLine ?? (order ? `Re: order ${order.name}` : 'Re: your message')
        body = renderReplyBody({
          windowDays: policy.days,
          withinWindow,
          signature,
          customer,
          ...(order === undefined ? {} : { order }),
          ...(daysSince === undefined ? {} : { daysSinceDelivery: daysSince }),
          ...(staged && refundAmount !== undefined ? { refundAmount } : {}),
        })
        const payload: DraftPayload = {
          request: req,
          channel: 'email',
          to: order?.email ? [order.email] : threadParticipants(threadItem),
          subject,
          body,
          child_change_ids: childChangeIds,
          citations: policy.source
            ? [
                {
                  fact_card_id: policy.source.id,
                  quote: `returns within ${policy.days} days of delivery`,
                },
              ]
            : [],
          ...(threadItem === undefined ? {} : { thread_external_id: threadItem.id }),
        }
        const draft = await options.createDraft(payload)
        if (draft) {
          sink({
            type: 'proposal.created',
            approval_item_id: draft.approval_item_id,
            kind: 'outbound_draft',
          })
          outputs.push({ kind: 'draft', approval_item_id: draft.approval_item_id })
        }
      }

      usage.output_tokens = Math.ceil(body.length / 4) + (seed % 7)

      const noStage = req.expectations.must_stage_if_change_requested && wantsChange && !staged
      // 17 §3：摘要是给下一次运行与人看的，写成一句人话（三个运行时同一份拼法）
      const summary = describeRun({
        readTools,
        drafted: body.length > 0,
        askedBoundaries,
        ...(order === undefined ? {} : { orderName: order.name }),
        ...(staged && refundAmount !== undefined && order !== undefined
          ? { staged: { kind: 'refund', amount: refundAmount, currency: order.currency } }
          : {}),
        ...(exhausted === undefined ? {} : { exhausted: exhausted.which }),
      })
      sink({
        type: 'run.completed',
        usage: {
          ...usage,
          tool_calls: toolCalls,
          seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
          cost_base: 0,
        },
        outputs,
        summary,
      })
      return finish(
        exhausted ? 'budget_exhausted' : 'completed',
        summary,
        noStage ? { no_stage: true } : undefined,
      )
    },
  }
}

function toolInput(
  tool: string,
  ctx: {
    order: OrderView | undefined
    orderItem: ContextItem | undefined
    threadItem: ContextItem | undefined
    threadText: string
  },
): Record<string, unknown> {
  const orderId = ctx.order?.id ?? refOfMaybe(ctx.orderItem)?.id ?? orderIdFromText(ctx.threadText)
  const bare = tool.includes('.') ? tool.slice(tool.indexOf('.') + 1) : tool
  switch (bare) {
    case 'get_order':
      return orderId === undefined ? {} : { order_id: orderId }
    case 'list_orders':
      return ctx.order?.email === undefined ? {} : { email: ctx.order.email }
    case 'get_product':
      return {}
    case 'search_policies':
      return { query: 'return window' }
    case 'list_threads':
      return ctx.threadItem === undefined ? {} : { thread_id: ctx.threadItem.id }
    default:
      return {}
  }
}

function refOfMaybe(item?: ContextItem): ObjectRef | undefined {
  return item === undefined ? undefined : refOf(item)
}

function orderIdFromText(text: string): string | undefined {
  const m = text.match(/#(\d{3,})/)
  return m?.[1] === undefined ? undefined : `ord_${m[1]}`
}

/** 工具结果里认得出的实体 → provenance（15 §6 只证明"读过"）。 */
function inferRefs(data: unknown): ObjectRef[] {
  const o =
    data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
  if (!o) return []
  const refs: ObjectRef[] = []
  if (typeof o.id === 'string') {
    if ('financial_status' in o || 'line_items' in o) refs.push({ type: 'order', id: o.id })
    else if ('price' in o && 'title' in o) refs.push({ type: 'product', id: o.id })
  }
  if (Array.isArray(o.orders)) {
    for (const item of o.orders) {
      const r =
        item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : undefined
      if (typeof r?.id === 'string') refs.push({ type: 'order', id: r.id })
    }
  }
  return refs
}

function threadSubject(item?: ContextItem): string | undefined {
  const o = item === undefined ? undefined : asRecord(item.content)
  const subject = o?.subject
  return typeof subject === 'string'
    ? subject.startsWith('Re:')
      ? subject
      : `Re: ${subject}`
    : undefined
}

function threadParticipants(item?: ContextItem): string[] {
  const o = item === undefined ? undefined : asRecord(item.content)
  const p = o?.participants
  if (Array.isArray(p)) return p.filter((x): x is string => typeof x === 'string')
  const from = o?.from
  return typeof from === 'string' ? [from] : []
}

function threadRecipient(item?: ContextItem): string | undefined {
  return threadParticipants(item)[0]?.split('@')[0]
}
