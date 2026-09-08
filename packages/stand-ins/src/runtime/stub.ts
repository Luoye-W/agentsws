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

export interface StubRuntimeOptions {
  clock: Clock
  /** 26 §3：seed 决定一切随机；同 seed 同请求 → 同事件序列。 */
  seed?: number
  executeTool?: ToolExecutor
  stage?: StageFn
  createDraft?: CreateDraftFn
  /** policy 上下文里读不到窗口时的默认退货窗口天数。 */
  defaultReturnWindowDays?: number
  signature?: string
}

const DAY = 86_400_000
const RETURN_TERMS = ['refund', 'return', 'money back', '退款', '退货', '退回']

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

function looksLikeChangeRequest(text: string): boolean {
  const lower = text.toLowerCase()
  return RETURN_TERMS.some((t) => lower.includes(t))
}

// ---------- prompt 装配 ----------

function toolDefs(req: RunRequest): ToolDef[] {
  return [...req.tools.allow].sort().map((name) => ({
    name,
    description: `stand-in tool ${name}`,
    input_schema: { type: 'object' },
  }))
}

/**
 * 17 §1 装配顺序：静态前缀（persona 段 + skills 索引行 + 工具定义）→ 策略层 → 工作项上下文 → 用户消息。
 * 静态前缀只由请求里稳定的部分构成，字节稳定。
 */
function assemble(req: RunRequest): { messages: ChatMessage[]; tools: ToolDef[] } {
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

function estimateTokens(messages: ChatMessage[], tools: ToolDef[]): number {
  const chars =
    messages.reduce((n, m) => n + m.content.length + m.role.length, 0) + canonicalJson(tools).length
  return Math.ceil(chars / 4)
}

// ---------- 草稿模板 ----------

interface DraftInput {
  order?: OrderView
  windowDays: number
  withinWindow: boolean
  daysSinceDelivery?: number
  refundAmount?: number
  signature: string
  customer: string
}

/** 固定模板：引用政策 + 订单状态；窗口内附带退款意图。不回显任何外部原文（围栏纪律）。 */
function draftBody(d: DraftInput): string {
  const lines: string[] = [`Hi ${d.customer},`, '']
  if (d.order) {
    lines.push(
      `Thanks for reaching out about order ${d.order.name}. Its payment status is "${d.order.financial_status}" and its fulfillment status is "${d.order.fulfillment_status}".`,
    )
  } else {
    lines.push('Thanks for reaching out.')
  }
  lines.push('')
  lines.push(`Our return policy allows returns within ${d.windowDays} days of delivery.`)
  if (d.order?.delivered_at && d.daysSinceDelivery !== undefined) {
    lines.push(
      `Your order was delivered on ${d.order.delivered_at.slice(0, 10)}, ${d.daysSinceDelivery} day(s) ago.`,
    )
  }
  lines.push('')
  if (d.withinWindow && d.refundAmount !== undefined && d.order) {
    lines.push(
      `That is inside the ${d.windowDays}-day window, so we have prepared a refund of ${d.refundAmount} ${d.order.currency} to your original payment method. It is waiting for a colleague to confirm and will be issued right after.`,
    )
  } else if (d.withinWindow && d.order) {
    lines.push(
      `That is inside the ${d.windowDays}-day window, so a return is possible. A colleague will confirm the next step with you.`,
    )
  } else if (d.order) {
    lines.push(
      `That is outside the ${d.windowDays}-day window, so a refund is not available for this order. Tell us what went wrong and we will look at the options that do apply.`,
    )
  } else {
    lines.push('Tell us the order number and we will check what applies.')
  }
  lines.push('', 'Kind regards,', d.signature)
  return lines.join('\n')
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
          hash: sha256(canonicalJson(item.content)),
        })
        const ref = refOf(item)
        if (ref) prov.see([ref])
      }

      // 2) 装配 prompt
      const { messages, tools } = assemble(req)
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
        hash: sha256(canonicalJson({ messages, tools })),
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
      const wantsChange = looksLikeChangeRequest(threadText)
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

      let body = ''
      if (!exhausted && req.expectations.outputs.includes('draft') && options.createDraft) {
        const customer =
          order?.customer_name ??
          order?.email?.split('@')[0] ??
          threadRecipient(threadItem) ??
          'there'
        const subject =
          threadSubject(threadItem) ?? (order ? `Re: order ${order.name}` : 'Re: your message')
        body = draftBody({
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
      const summary = exhausted
        ? `预算耗尽（${exhausted.which}）：已补齐未闭合的工具调用`
        : `stub 运行：${toolCalls} 次工具调用，${outputs.length} 项产物`
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
