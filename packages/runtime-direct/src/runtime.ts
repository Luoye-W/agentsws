import type {
  ChatMessage,
  Clock,
  Completion,
  ContextItem,
  ModelGateway,
  ObjectRef,
  RunEvent,
  RunOutput,
  RunRequest,
  RunResult,
  RuntimeAdapter,
  RunUsage,
  ToolDef,
} from '@agentsws/contracts'
import { canonicalJson, EXTERNAL_FENCE, Provenance, sha256 } from '@agentsws/core'
import type { CreateDraftFn, StageFn, ToolExecution, ToolExecutor } from '@agentsws/stand-ins'
import { contextItemHash } from '@agentsws/stand-ins'
import { assembleDirect, DRAFT_REPLY_TOOL, STAGE_REFUND_TOOL } from './assemble.js'
import { failureOf } from './errors.js'
import { gateToolCall, inferRefs, type SideEffectLookup } from './gate.js'
import { CLOSED_TOOL_RESULT, compactHistory, historyTokens } from './history.js'
import { IDEMPOTENCY_WINDOW_MS, IdempotencyStore } from './idempotency.js'
import type { DirectGateway } from './tool-choice.js'
import { supportsToolChoice } from './tool-choice.js'
import type { OrderView } from './view.js'
import {
  asRecord,
  changeRequested,
  groundingHits,
  itemsOfKind,
  orderIdFromText,
  orderView,
  refOf,
  threadText,
} from './view.js'

export const RUNTIME_NAME = 'direct-llm'

export interface DirectRuntimeOptions {
  /** 22 模型网关。带 `completeWithToolChoice` 的网关可以强制第一轮工具。 */
  gateway: DirectGateway
  clock: Clock
  executeTool?: ToolExecutor
  stage?: StageFn
  createDraft?: CreateDraftFn
  /** 16 §3 副作用表；不给的工具按读处理（executeTool 是兜底那道门）。 */
  sideEffectOf?: SideEffectLookup
  /** turn loop 上限（防死循环）；默认 8。 */
  maxTurns?: number
  /** A9 compact_history 阈值（token）；默认 `min(max_tokens × 0.6, 12000)`。 */
  compactThresholdTokens?: number
  idempotencyWindowMs?: number
  seed?: number
}

const DEFAULT_MAX_TURNS = 8
const COMPACT_HARD_CAP = 12_000

interface CompleteArgsBase {
  messages: ChatMessage[]
  tools?: ToolDef[]
  meta: Parameters<ModelGateway['complete']>[0]['meta']
  seed?: number
  max_cost_base?: number
}

/**
 * 17 §4 `direct-llm` 运行时：不经 dsh，自己跑 turn loop（Commerce Agents 移植）。
 *
 * 装配 → grounding（强制工具 / 宿主预取）→ 工具循环（两道门 + 围栏 + provenance）→
 * 产出（stage / 起草经宿主回调）→ 预算硬中断（补齐未闭合调用）→ RunResult。
 * 存在的意义是证明 dsh 可替换（31 §1 I6）：同一条场景在它上面跑通并过六条不变量。
 */
export function createDirectRuntime(options: DirectRuntimeOptions): RuntimeAdapter {
  const { clock, gateway } = options
  const seed = options.seed ?? 1
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  const idempotency = new IdempotencyStore(
    clock,
    options.idempotencyWindowMs ?? IDEMPOTENCY_WINDOW_MS,
  )

  return {
    name: RUNTIME_NAME,

    capabilities() {
      // tool_choice：turn loop 自己控制第一轮；网关不支持强制时退到宿主预取（17 §5.4）
      return { tool_choice: true, streaming: false, followup: false, seedable: true }
    },

    async health() {
      return { ok: true }
    },

    async run(req: RunRequest, sink: (e: RunEvent) => void, signal: AbortSignal) {
      // 17 §5.7 幂等：窗口内同一把钥匙返回原来那份结果，不重跑、不重发事件
      const prior = idempotency.get(req.idempotency_key)
      if (prior !== undefined) return prior

      const startedMs = Date.parse(clock.now())
      const prov = new Provenance(req.id)
      const outputs: RunOutput[] = []
      const orders = new Map<string, OrderView>()
      const stagedChangeIds: string[] = []
      const openCalls = new Map<string, string>()
      const usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_base: 0 }
      let toolCalls = 0
      let staged = false
      let finalText = ''
      let exhausted: { which: keyof RunRequest['budget']; used: number; cap: number } | undefined

      const messages: ChatMessage[] = []
      let tools: ToolDef[] = []

      const secondsSoFar = (): number => Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000)

      const finish = (
        status: RunResult['status'],
        summary: string,
        extra?: { no_stage?: boolean },
      ): RunResult => {
        const runUsage: RunUsage = {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cached_tokens: usage.cached_tokens,
          tool_calls: toolCalls,
          seconds: secondsSoFar(),
          cost_base: usage.cost_base,
        }
        const result: RunResult = {
          request_id: req.id,
          status,
          outputs,
          provenance: prov.toState(clock.now()),
          memory_candidates: [],
          lessons: [],
          usage: runUsage,
          session_ref: {
            runtime: RUNTIME_NAME,
            session_id: sha256(canonicalJson({ request: req.id, seed })).slice(0, 26),
            log_uri: `memory://direct-llm/${req.id}`,
          },
          summary,
          ...(extra?.no_stage === true ? { no_stage: true } : {}),
        }
        idempotency.put(req.idempotency_key, result)
        return result
      }

      const complete = (summary: string, status: RunResult['status']): RunResult => {
        const noStage = req.expectations.must_stage_if_change_requested && wantsChange && !staged
        const result = finish(status, summary, noStage ? { no_stage: true } : undefined)
        sink({ type: 'run.completed', usage: result.usage, outputs, summary })
        return result
      }

      /** 17 §5.3 / §5.6：未闭合的工具调用必须补齐再结束。 */
      const closeOpenToolUses = (reason: string): void => {
        for (const [call_id] of openCalls) {
          sink({ type: 'tool.result', call_id, status: 'blocked', reason })
          messages.push({
            role: 'tool',
            content: CLOSED_TOOL_RESULT(reason),
            tool_call_id: call_id,
          })
        }
        openCalls.clear()
      }

      sink({
        type: 'run.started',
        request_id: req.id,
        runtime: RUNTIME_NAME,
        model: req.runtime.model,
      })
      if (signal.aborted) {
        sink({ type: 'run.cancelled' })
        return finish('cancelled', '运行开始前即被中断')
      }

      const wantsChange = changeRequested(threadText(req))

      // ── 工具执行（两道门 → 执行 → 围栏 → provenance）─────────────────
      const rememberOrders = (data: unknown): void => {
        const direct = orderView(data)
        if (direct !== undefined) orders.set(direct.id, direct)
        const list = asRecord(data)?.orders
        if (Array.isArray(list)) {
          for (const raw of list) {
            const view = orderView(raw)
            if (view !== undefined) orders.set(view.id, view)
          }
        }
      }

      const runTool = async (
        name: string,
        input: Record<string, unknown>,
        request: RunRequest,
      ): Promise<ToolExecution> => {
        if (options.executeTool === undefined) {
          return { status: 'error', reason: 'no_tool_executor' }
        }
        return options.executeTool({ name, input, request })
      }

      // ── grounding：命中即先调工具（强制 / 宿主预取）────────────────────
      const hits = groundingHits(req)
      const forced = hits[0]?.tool
      const canForce = supportsToolChoice(gateway)
      const useToolChoice = forced !== undefined && canForce
      const prefetchRules = useToolChoice ? [] : hits.filter((r) => r.prefetch)

      let effective = req
      const prefetchItems: ContextItem[] = []
      for (const rule of prefetchRules) {
        const input = defaultToolInput(rule.tool, req, orders)
        const call_id = `prefetch_${prefetchItems.length + 1}`
        sink({ type: 'tool.call', call_id, tool: rule.tool, input: redact(input) })
        openCalls.set(call_id, rule.tool)
        const decision = gateToolCall(rule.tool, req, options.sideEffectOf)
        const exec: ToolExecution = decision.allowed
          ? await runTool(rule.tool, input, req)
          : {
              status: 'blocked',
              ...(decision.reason === undefined ? {} : { reason: decision.reason }),
            }
        toolCalls += 1
        openCalls.delete(call_id)
        const refs = exec.status === 'ok' ? (exec.provenance ?? inferRefs(exec.data)) : []
        if (refs.length > 0) prov.see(refs, { full: true })
        if (exec.status === 'ok') rememberOrders(exec.data)
        sink({
          type: 'tool.result',
          call_id,
          status: exec.status,
          ...(exec.reason === undefined ? {} : { reason: exec.reason }),
          ...(refs.length > 0 ? { provenance_added: refs } : {}),
        })
        if (exec.status !== 'ok') continue
        const content = EXTERNAL_FENCE.fencePayload({ tool: rule.tool, result: exec.data })
        prefetchItems.push({
          id: `prefetch_${rule.name}`,
          kind: 'prefetch',
          source_ref: `grounding:${rule.name}`,
          sensitivity: 'internal',
          content,
          bytes: Buffer.byteLength(content, 'utf8'),
        })
      }
      if (prefetchItems.length > 0) {
        // 17 §6.5：预取结果是**第一条** ContextItem
        effective = { ...req, context: [...prefetchItems, ...req.context] }
        sink({
          type: 'progress',
          step: 'grounding',
          note: `host prefetch ×${prefetchItems.length}`,
        })
      }

      // ── 逐项注入上下文（Model-visible ⟺ logged）────────────────────────
      for (const item of effective.context) {
        sink({
          type: 'context.injected',
          item_id: item.id,
          kind: item.kind,
          bytes: item.bytes,
          hash: contextItemHash(item),
        })
        const ref = refOf(item)
        if (ref !== undefined) prov.see([ref])
        if (item.kind === 'order') {
          const view = orderView(item.content, ref)
          if (view !== undefined) orders.set(view.id, view)
        }
      }

      // ── 装配 prompt ──────────────────────────────────────────────────
      const prompt = assembleDirect(effective)
      messages.push(...prompt.messages)
      tools = prompt.tools
      sink({
        type: 'prompt.assembled',
        hash: prompt.hash,
        static_prefix_hash: prompt.static_prefix_hash,
        total_tokens: prompt.total_tokens,
      })
      if (prompt.total_tokens > req.budget.max_tokens) {
        sink({
          type: 'budget.exhausted',
          which: 'max_tokens',
          used: prompt.total_tokens,
          cap: req.budget.max_tokens,
        })
        return complete('max_tokens 预算耗尽：prompt 本身就超了', 'budget_exhausted')
      }

      const compactLimit =
        options.compactThresholdTokens ??
        Math.max(1, Math.min(Math.floor(req.budget.max_tokens * 0.6), COMPACT_HARD_CAP))

      // ── 产出工具：stage / 起草经注入的回调 ────────────────────────────
      const doStage = async (input: Record<string, unknown>): Promise<ToolExecution> => {
        const orderId =
          typeof input.order_id === 'string'
            ? input.order_id
            : ([...orders.keys()][0] ?? orderIdFromText(threadText(effective)))
        const order = orderId === undefined ? undefined : orders.get(orderId)
        if (order === undefined) return { status: 'error', reason: `unknown_order: ${orderId}` }
        // 15 §6：只能对本次运行"读过"的实体动手
        if (!prov.has(order.ref)) return { status: 'blocked', reason: 'provenance_missing' }
        const amount =
          typeof input.amount === 'number' && Number.isFinite(input.amount)
            ? Math.round(input.amount * 100) / 100
            : Math.round((order.total_price - order.refunded_amount) * 100) / 100
        if (!(amount > 0)) return { status: 'error', reason: 'refund_amount_not_positive' }
        if (options.stage === undefined) return { status: 'error', reason: 'no_stage_callback' }
        const notes = Array.isArray(input.notes)
          ? input.notes.filter((n): n is string => typeof n === 'string')
          : []
        const res = await options.stage({
          request: effective,
          kind: 'refund',
          target: order.ref,
          field: 'refunded_amount',
          before: order.refunded_amount,
          after: order.refunded_amount + amount,
          money: {
            amount,
            currency: typeof input.currency === 'string' ? input.currency : order.currency,
          },
          notes: notes.length > 0 ? notes : ['direct-llm 运行时按政策提出'],
          ...(order.email === undefined
            ? {}
            : { requester: { channel: 'email', external_id: order.email } }),
        })
        if (res === undefined) return { status: 'blocked', reason: 'stage_rejected' }
        staged = true
        prov.pin(order.ref)
        stagedChangeIds.push(res.change_id)
        sink({ type: 'change.staged', change_id: res.change_id })
        outputs.push({ kind: 'staged_change', change_id: res.change_id })
        return { status: 'ok', data: { change_id: res.change_id, state: 'pending_approval' } }
      }

      const doDraft = async (input: Record<string, unknown>): Promise<ToolExecution> => {
        if (options.createDraft === undefined) {
          return { status: 'error', reason: 'no_draft_callback' }
        }
        const to = Array.isArray(input.to)
          ? input.to.filter((t): t is string => typeof t === 'string')
          : typeof input.to === 'string'
            ? [input.to]
            : []
        const body = typeof input.body === 'string' ? input.body : ''
        if (to.length === 0 || body.length === 0) {
          return { status: 'error', reason: 'draft_needs_to_and_body' }
        }
        const threadItem = itemsOfKind(effective, 'thread')[0]
        const citations = Array.isArray(input.citations)
          ? input.citations.flatMap((c) => {
              const o = asRecord(c)
              return typeof o?.fact_card_id === 'string'
                ? [
                    {
                      fact_card_id: o.fact_card_id,
                      quote: typeof o.quote === 'string' ? o.quote : '',
                    },
                  ]
                : []
            })
          : []
        const res = await options.createDraft({
          request: effective,
          channel: 'email',
          to,
          subject: typeof input.subject === 'string' ? input.subject : 'Re: your message',
          body,
          child_change_ids: [...stagedChangeIds],
          citations,
          ...(threadItem === undefined ? {} : { thread_external_id: threadItem.id }),
        })
        if (res === undefined) return { status: 'blocked', reason: 'draft_rejected' }
        sink({
          type: 'proposal.created',
          approval_item_id: res.approval_item_id,
          kind: 'outbound_draft',
        })
        outputs.push({ kind: 'draft', approval_item_id: res.approval_item_id })
        return { status: 'ok', data: { approval_item_id: res.approval_item_id, state: 'queued' } }
      }

      // ── turn loop ────────────────────────────────────────────────────
      for (let turn = 0; turn < maxTurns; turn += 1) {
        if (signal.aborted) {
          closeOpenToolUses('cancelled')
          sink({ type: 'run.cancelled' })
          return finish('cancelled', '运行被中断：未闭合的工具调用已补齐')
        }
        if (secondsSoFar() > req.budget.max_seconds) {
          exhausted = {
            which: 'max_seconds',
            used: Math.round(secondsSoFar()),
            cap: req.budget.max_seconds,
          }
          sink({ type: 'budget.exhausted', ...exhausted })
          closeOpenToolUses('budget_exhausted')
          break
        }
        const spentTokens = usage.input_tokens + usage.output_tokens
        if (spentTokens > req.budget.max_tokens) {
          exhausted = { which: 'max_tokens', used: spentTokens, cap: req.budget.max_tokens }
          sink({ type: 'budget.exhausted', ...exhausted })
          closeOpenToolUses('budget_exhausted')
          break
        }

        // A9 compact_history：超阈值就把最早的工具结果换成占位
        if (historyTokens(messages, tools) > compactLimit) {
          const compacted = compactHistory(messages, tools, compactLimit)
          if (compacted.compacted > 0) {
            messages.length = 0
            messages.push(...compacted.messages)
            sink({
              type: 'progress',
              step: 'compact',
              note: `compact_history: ${compacted.compacted} 条工具结果换成占位`,
            })
          }
        }

        const args: CompleteArgsBase = {
          messages: [...messages],
          tools,
          meta: {
            workspace_id: req.workspace_id,
            assignment_id: req.actor.assignment_id,
            role_id: req.actor.role_id,
            run_id: req.id,
            purpose: 'run',
          },
          max_cost_base: req.budget.max_cost_base,
          ...(req.runtime.seed === undefined ? {} : { seed: req.runtime.seed }),
        }

        let completion: Completion
        try {
          completion =
            turn === 0 && useToolChoice && forced !== undefined && supportsToolChoice(gateway)
              ? await gateway.completeWithToolChoice({
                  ...args,
                  tool_choice: { type: 'tool', name: forced },
                })
              : await gateway.complete(args)
        } catch (err) {
          const error = failureOf(err)
          closeOpenToolUses(error.code)
          sink({ type: 'run.failed', error })
          return finish('failed', `模型调用失败：${error.code}`)
        }

        usage.input_tokens += completion.usage.input_tokens
        usage.output_tokens += completion.usage.output_tokens
        usage.cached_tokens += completion.usage.cached_tokens
        usage.cost_base += completion.usage.cost_base

        const calls = completion.tool_calls ?? []
        if (completion.text.length > 0) {
          sink({ type: 'text.delta', text: completion.text })
          finalText = completion.text
        }
        messages.push({
          role: 'assistant',
          content: [
            completion.text,
            ...calls.map((c) => `[calling ${c.name} ${canonicalJson(c.input)}]`),
          ]
            .filter((s) => s.length > 0)
            .join('\n'),
        })
        if (calls.length === 0) break

        let stop = false
        for (const call of calls) {
          const call_id = call.id.length > 0 ? call.id : `call_${toolCalls + 1}`
          const input = asRecord(call.input) ?? {}
          sink({ type: 'tool.call', call_id, tool: call.name, input: redact(input) })
          openCalls.set(call_id, call.name)

          if (toolCalls >= req.budget.max_tool_calls) {
            exhausted = {
              which: 'max_tool_calls',
              used: toolCalls,
              cap: req.budget.max_tool_calls,
            }
            sink({ type: 'budget.exhausted', ...exhausted })
            closeOpenToolUses('budget_exhausted')
            stop = true
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

          const decision = gateToolCall(call.name, effective, options.sideEffectOf)
          let exec: ToolExecution
          if (!decision.allowed) {
            exec = {
              status: 'blocked',
              ...(decision.reason === undefined ? {} : { reason: decision.reason }),
            }
          } else if (call.name === STAGE_REFUND_TOOL) {
            exec = await doStage(input)
          } else if (call.name === DRAFT_REPLY_TOOL) {
            exec = await doDraft(input)
          } else {
            exec = await runTool(call.name, input, effective)
          }
          toolCalls += 1
          openCalls.delete(call_id)

          const refs = exec.status === 'ok' ? (exec.provenance ?? inferRefs(exec.data)) : []
          if (refs.length > 0) prov.see(refs, { full: true })
          if (exec.status === 'ok') rememberOrders(exec.data)
          sink({
            type: 'tool.result',
            call_id,
            status: exec.status,
            ...(exec.reason === undefined ? {} : { reason: exec.reason }),
            ...(refs.length > 0 ? { provenance_added: refs } : {}),
          })
          messages.push({
            role: 'tool',
            name: call.name,
            tool_call_id: call_id,
            content:
              exec.status === 'ok'
                ? EXTERNAL_FENCE.fencePayload(exec.data)
                : `[${exec.status}: ${exec.reason ?? 'no reason'}]`,
          })

          if (signal.aborted) {
            closeOpenToolUses('cancelled')
            sink({ type: 'run.cancelled' })
            return finish('cancelled', '运行被中断：未闭合的工具调用已补齐')
          }
        }
        if (stop) break
      }

      closeOpenToolUses('turn_limit')

      if (exhausted !== undefined) {
        return complete(
          `预算耗尽（${exhausted.which}）：已补齐未闭合的工具调用`,
          'budget_exhausted',
        )
      }
      if (req.expectations.outputs.includes('answer') && finalText.length > 0) {
        outputs.push({ kind: 'answer', text: finalText })
      }
      return complete(
        `direct-llm 运行：${toolCalls} 次工具调用，${outputs.length} 项产物`,
        'completed',
      )
    },
  }
}

/** `tool.call.input` 记事件前脱敏（17 §2）。 */
function redact(input: Record<string, unknown>): unknown {
  return EXTERNAL_FENCE.sanitizeValue(input, 500)
}

/** 宿主预取时给 grounding 工具补参数（模型还没说话，只能从上下文推）。 */
function defaultToolInput(
  tool: string,
  req: RunRequest,
  orders: Map<string, OrderView>,
): Record<string, unknown> {
  const bare = tool.includes('.') ? tool.slice(tool.indexOf('.') + 1) : tool
  const text = threadText(req)
  const orderItem = itemsOfKind(req, 'order')[0]
  const orderId =
    [...orders.keys()][0] ??
    (orderItem === undefined ? undefined : refOf(orderItem)?.id) ??
    orderIdFromText(text)
  switch (bare) {
    case 'get_order':
      return orderId === undefined ? {} : { order_id: orderId }
    case 'list_orders':
      return {}
    case 'search_policies':
      return { query: 'return window' }
    case 'list_threads': {
      const thread = itemsOfKind(req, 'thread')[0]
      return thread === undefined ? {} : { thread_id: thread.id }
    }
    default:
      return {}
  }
}

/** 给宿主用的小工具：从一次运行的事件里挑出模型真的读到的实体（测试与审计用）。 */
export function refsFromEvents(events: readonly RunEvent[]): ObjectRef[] {
  const out: ObjectRef[] = []
  for (const e of events) {
    if (e.type === 'tool.result' && e.status === 'ok') out.push(...(e.provenance_added ?? []))
  }
  return out
}
