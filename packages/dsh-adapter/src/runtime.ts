/**
 * `RuntimeAdapter`（name='dsh'，17 §4）。
 *
 * 每次 `run()` 起一套全新的 dsh 组合（headless、无状态），把 RunRequest 映射成
 * preset + 工具 + 提示词分节 + 上下文分节，然后：
 * 上下文逐项注入 → 装配 prompt → 经 `ctx.llm` 走一次补全 → grounding 工具经 dsh 工具流水线 →
 * `stage_refund` / `draft_reply` 经 dsh 的审批 seam 落到注入的回调。
 * 预算是硬的；耗尽即中断并补齐未闭合的工具调用（17 §5.3）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ChatMessage,
  ContextItem,
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
import type { DraftPayload, StageIntent } from '@agentsws/stand-ins'
import { assemblePrompt, describeRun, promptHash } from '@agentsws/stand-ins'
import { createHarness } from './harness.js'
import { writePreset } from './preset.js'
import {
  DAY_MS,
  draftBody,
  hitsRule,
  itemsOfKind,
  looksLikeChangeRequest,
  type OrderView,
  orderView,
  plainText,
  refOf,
  returnWindowDays,
  threadParticipants,
  threadRecipient,
  threadSubject,
  toolInput,
} from './reading.js'
import { DRAFT_TOOL, STAGE_TOOL } from './tools.js'
import type { DshRuntimeOptions } from './types.js'

const RUNTIME_NAME = 'dsh'

function estimateTokens(messages: ChatMessage[], tools: ToolDef[]): number {
  const chars =
    messages.reduce((n, m) => n + m.content.length + m.role.length, 0) + canonicalJson(tools).length
  return Math.ceil(chars / 4)
}

interface Scratch {
  order: OrderView | undefined
  windowDays: number
  policySource: ContextItem | undefined
  threadItem: ContextItem | undefined
  threadText: string
  daysSinceDelivery: number | undefined
  childChangeIds: string[]
}

/**
 * 17 §4 的 dsh 运行时（**进程内装配**档）。所有 dsh API 调用都收在这个包里，
 * 业务代码只见 RuntimeAdapter。跨进程档见 `headless/`——两档的语义、事件序列、
 * `capabilities()` 完全一致（同一份契约测试跑两遍）。
 */
export function createInProcessDshRuntime(options: DshRuntimeOptions): RuntimeAdapter {
  const { clock } = options
  const seed = options.seed ?? 1
  const defaultWindow = options.defaultReturnWindowDays ?? 14
  const signature = options.signature ?? 'Customer Care'

  return {
    name: RUNTIME_NAME,

    capabilities() {
      // 实测（0.1.3-alpha.2）：
      // tool_choice —— dsh 的 GenerateOptions 没有 tool_choice 字段，强制先读工具做不到 → false
      // streaming   —— LlmRuntime 是流式的（StreamChunk）→ true
      // followup    —— 有会话概念，但本适配器每次运行一套组合、结束即销毁 → false
      // seedable    —— seed 由我们透传给模型网关，dsh 侧不参与 → true
      return { tool_choice: false, streaming: true, followup: false, seedable: true }
    },

    async health() {
      try {
        const mod = await import('@deepseek-ai/dsh-sdk-client')
        const ok = typeof mod.DeepSeekHarness === 'function'
        return ok
          ? { ok: true, detail: 'dsh 0.1.3-alpha.2 SDK 可解析；运行走同进程 headless 组合' }
          : { ok: false, detail: 'dsh-sdk-client 未导出 DeepSeekHarness' }
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) }
      }
    },

    async run(
      req: RunRequest,
      sink: (e: RunEvent) => void,
      signal: AbortSignal,
    ): Promise<RunResult> {
      const startedMs = Date.parse(clock.now())
      const prov = new Provenance(req.id)
      const outputs: RunOutput[] = []
      const events: RunEvent[] = []
      const usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_base: 0 }
      let toolCalls = 0
      let exhausted: { which: keyof RunRequest['budget']; used: number; cap: number } | undefined
      let staged = false
      /** 摘要用：真的读成功过的工具（按调用顺序）。 */
      const readTools: string[] = []
      const askedBoundaries: string[] = []
      let stagedMoney: { kind: string; amount: number; currency: string } | undefined

      const preset = writePreset(req, options.presetRoot)
      const session_id = sha256(canonicalJson({ run: req.id, seed, preset: preset.dir })).slice(
        0,
        26,
      )
      const log_uri =
        options.sessionLogRoot === undefined
          ? `memory://dsh/${req.id}`
          : `file://${join(options.sessionLogRoot, `${session_id}.jsonl`)}`

      const emit = (e: RunEvent): void => {
        events.push(e)
        sink(e)
      }

      const flushLog = (): void => {
        if (options.sessionLogRoot === undefined) return
        mkdirSync(options.sessionLogRoot, { recursive: true })
        writeFileSync(
          join(options.sessionLogRoot, `${session_id}.jsonl`),
          `${events.map((e) => canonicalJson(e)).join('\n')}\n`,
          'utf8',
        )
      }

      const finish = (
        status: RunResult['status'],
        summary: string,
        extra?: { no_stage?: boolean },
      ): RunResult => {
        flushLog()
        const seconds = Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000)
        return {
          request_id: req.id,
          status,
          outputs,
          provenance: prov.toState(clock.now()),
          memory_candidates: [],
          lessons: [],
          usage: { ...usage, tool_calls: toolCalls, seconds },
          session_ref: { runtime: RUNTIME_NAME, session_id, log_uri },
          summary,
          ...(extra?.no_stage === true ? { no_stage: true } : {}),
        }
      }

      emit({
        type: 'run.started',
        request_id: req.id,
        runtime: RUNTIME_NAME,
        model: req.runtime.model,
      })
      if (signal.aborted) {
        emit({ type: 'run.cancelled' })
        return finish('cancelled', '运行开始前即被中断')
      }

      // ── 上下文事实：dsh 组合建起来之前就要有，stage 意图靠它补全 ──────────
      const threadItem = itemsOfKind(req, 'thread')[0]
      const orderItem = itemsOfKind(req, 'order')[0]
      const policy = returnWindowDays(req, defaultWindow)
      const scratch: Scratch = {
        windowDays: policy.days,
        threadText: threadItem === undefined ? '' : plainText(threadItem.content),
        childChangeIds: [],
        order: orderItem === undefined ? undefined : orderView(orderItem.content, refOf(orderItem)),
        policySource: policy.source,
        threadItem,
        daysSinceDelivery: undefined,
      }

      const buildStageIntent = (args: {
        amount: number
        currency?: string
        reason?: string
      }): StageIntent | undefined => {
        const order = scratch.order
        if (order === undefined) return undefined
        return {
          request: req,
          kind: 'refund',
          target: order.ref,
          field: 'refunded_amount',
          before: order.refunded_amount,
          after: order.refunded_amount + args.amount,
          money: { amount: args.amount, currency: args.currency ?? order.currency },
          notes: [
            `退货窗口 ${scratch.windowDays} 天内（签收 ${scratch.daysSinceDelivery ?? '?'} 天）`,
            args.reason ?? '由 dsh 运行时按政策提出',
          ],
          ...(order.email === undefined
            ? {}
            : { requester: { channel: 'email', external_id: order.email } }),
        }
      }

      const buildDraftPayload = (args: {
        subject: string
        body: string
      }): DraftPayload | undefined => {
        const order = scratch.order
        return {
          request: req,
          channel: 'email',
          to: order?.email !== undefined ? [order.email] : threadParticipants(scratch.threadItem),
          subject: args.subject,
          body: args.body,
          child_change_ids: [...scratch.childChangeIds],
          citations:
            scratch.policySource === undefined
              ? []
              : [
                  {
                    fact_card_id: scratch.policySource.id,
                    quote: `returns within ${scratch.windowDays} days of delivery`,
                  },
                ],
          ...(scratch.threadItem === undefined
            ? {}
            : { thread_external_id: scratch.threadItem.id }),
        }
      }

      let harness: Awaited<ReturnType<typeof createHarness>>
      try {
        harness = await createHarness({
          request: req,
          sink: emit,
          provenance: prov,
          options,
          buildStageIntent,
          buildDraftPayload,
          model: req.runtime.model.model,
          meta: {
            workspace_id: req.workspace_id,
            assignment_id: req.actor.assignment_id,
            role_id: req.actor.role_id,
            run_id: req.id,
            purpose: 'run',
          },
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        emit({ type: 'run.failed', error: { code: 'internal', message, retryable: false } })
        return finish('failed', `dsh 组合装配失败：${message}`)
      }

      try {
        // ── prompt 装配（17 §6.1：与回放重组逐字节一致的那一份）────────────
        const prompt = assemblePrompt(req)
        const prefixHash = staticPrefixHash(prompt.messages, prompt.tools)
        const total_tokens = estimateTokens(prompt.messages, prompt.tools)
        emit({
          type: 'prompt.assembled',
          hash: promptHash(prompt),
          static_prefix_hash: prefixHash,
          total_tokens,
        })

        if (total_tokens > req.budget.max_tokens) {
          usage.input_tokens = total_tokens
          emit({
            type: 'budget.exhausted',
            which: 'max_tokens',
            used: total_tokens,
            cap: req.budget.max_tokens,
          })
          emit({
            type: 'run.completed',
            usage: { ...usage, tool_calls: 0, seconds: 0 },
            outputs,
            summary: 'max_tokens 预算耗尽',
          })
          return finish('budget_exhausted', 'max_tokens 预算耗尽')
        }

        // ── 模型：经 dsh 的 `ctx.llm`（我们的 LlmAdapter → 模型网关）─────────
        try {
          const { text, completion } = await harness.complete(prompt)
          usage.input_tokens = completion.usage.input_tokens
          usage.cached_tokens = completion.usage.cached_tokens
          usage.cost_base = completion.usage.cost_base
          if (text.length > 0) emit({ type: 'text.delta', text })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          emit({
            type: 'run.failed',
            error: { code: 'provider_unavailable', message, retryable: true },
          })
          return finish('failed', `模型不可用：${message}`)
        }

        // ── grounding：命中即先读；没命中但有订单 → 默认 get_order ──────────
        const hitRules = req.grounding.filter((r) => hitsRule(scratch.threadText, r))
        const planned =
          hitRules.length > 0
            ? hitRules.map((r) => r.tool)
            : scratch.order !== undefined || orderItem !== undefined
              ? ['get_order']
              : []

        const runTool = async (
          tool: string,
          input: Record<string, unknown>,
        ): Promise<{ ok: boolean; value?: unknown }> => {
          const call_id = `call_${toolCalls + 1}`
          emit({ type: 'tool.call', call_id, tool, input })
          if (toolCalls >= req.budget.max_tool_calls) {
            exhausted = {
              which: 'max_tool_calls',
              used: toolCalls,
              cap: req.budget.max_tool_calls,
            }
            emit({ type: 'budget.exhausted', ...exhausted })
            // 17 §5.3：补齐未闭合的工具调用再结束
            emit({ type: 'tool.result', call_id, status: 'blocked', reason: 'budget_exhausted' })
            harness.gate.emitted.add(call_id)
            return { ok: false }
          }
          if (toolCalls + 1 === req.budget.max_tool_calls) {
            emit({
              type: 'budget.warning',
              which: 'max_tool_calls',
              used: toolCalls + 1,
              cap: req.budget.max_tool_calls,
            })
          }
          const res = await harness.gate.execute(call_id, tool, input)
          toolCalls += 1
          if (!res.isError && tool !== STAGE_TOOL && tool !== DRAFT_TOOL) readTools.push(tool)
          if (!harness.gate.emitted.has(call_id)) {
            harness.gate.emitted.add(call_id)
            emit({
              type: 'tool.result',
              call_id,
              status: res.isError ? 'error' : 'ok',
              ...(res.isError ? { reason: res.error.message } : {}),
            })
          }
          return res.isError ? { ok: false } : { ok: true, value: res.value }
        }

        for (const tool of planned) {
          if (signal.aborted) {
            emit({ type: 'run.cancelled' })
            return finish('cancelled', '运行被中断')
          }
          const input = toolInput(tool, {
            threadText: scratch.threadText,
            ...(scratch.order === undefined ? {} : { order: scratch.order }),
            ...(orderItem === undefined ? {} : { orderItem }),
            ...(scratch.threadItem === undefined ? {} : { threadItem: scratch.threadItem }),
          })
          const res = await runTool(tool, input)
          if (exhausted !== undefined) break
          if (res.ok && scratch.order === undefined) {
            const found = orderView(res.value)
            if (found !== undefined) scratch.order = found
          }
        }

        // ── 变更意图：窗口内才提，且必须"读过"目标（15 §6）────────────────
        const wantsChange = looksLikeChangeRequest(scratch.threadText)
        const order = scratch.order
        const deliveredMs =
          order?.delivered_at === undefined ? undefined : Date.parse(order.delivered_at)
        const nowMs = Date.parse(clock.now())
        scratch.daysSinceDelivery =
          deliveredMs === undefined ? undefined : Math.floor((nowMs - deliveredMs) / DAY_MS)
        const withinWindow =
          exhausted === undefined &&
          scratch.daysSinceDelivery !== undefined &&
          scratch.daysSinceDelivery <= scratch.windowDays &&
          order !== undefined
        const refundAmount =
          order === undefined
            ? undefined
            : Math.round((order.total_price - order.refunded_amount) * 100) / 100

        if (
          exhausted === undefined &&
          wantsChange &&
          withinWindow &&
          order !== undefined &&
          refundAmount !== undefined &&
          refundAmount > 0 &&
          options.stage !== undefined &&
          // 36 §2.2：管着这次退款的边界还没答过就不提（门禁插件的 pre-execute 是兜底那道门）
          harness.gate.boundary.allowed &&
          (req.expectations.outputs.includes('staged_change') ||
            req.expectations.must_stage_if_change_requested) &&
          prov.has(order.ref)
        ) {
          const res = await runTool(STAGE_TOOL, {
            order_id: order.id,
            amount: refundAmount,
            currency: order.currency,
            reason: `退货窗口 ${scratch.windowDays} 天内`,
          })
          const value = res.value as { change_id?: unknown } | undefined
          if (res.ok && typeof value?.change_id === 'string') {
            staged = true
            stagedMoney = { kind: 'refund', amount: refundAmount, currency: order.currency }
            scratch.childChangeIds.push(value.change_id)
            prov.pin(order.ref)
            emit({ type: 'change.staged', change_id: value.change_id })
            outputs.push({ kind: 'staged_change', change_id: value.change_id })
          }
        }

        // ── 边界选择题卡（36 §2.2）：门禁插件发的卡在这里收进产物 ─────────────
        if (exhausted === undefined) {
          for (const asked of await harness.gate.askBoundaries()) {
            askedBoundaries.push(asked.label)
            outputs.push({ kind: 'proposal', approval_item_id: asked.approval_item_id })
          }
        }

        // ── 起草回复 ────────────────────────────────────────────────────────
        let body = ''
        if (
          exhausted === undefined &&
          req.expectations.outputs.includes('draft') &&
          options.createDraft !== undefined
        ) {
          const customer =
            order?.customer_name ??
            order?.email?.split('@')[0] ??
            threadRecipient(scratch.threadItem) ??
            'there'
          const subject =
            threadSubject(scratch.threadItem) ??
            (order === undefined ? 'Re: your message' : `Re: order ${order.name}`)
          body = draftBody({
            windowDays: scratch.windowDays,
            withinWindow,
            signature,
            customer,
            ...(order === undefined ? {} : { order }),
            ...(scratch.daysSinceDelivery === undefined
              ? {}
              : { daysSinceDelivery: scratch.daysSinceDelivery }),
            ...(staged && refundAmount !== undefined ? { refundAmount } : {}),
          })
          const res = await runTool(DRAFT_TOOL, { subject, body })
          const value = res.value as { approval_item_id?: unknown } | undefined
          if (res.ok && typeof value?.approval_item_id === 'string') {
            emit({
              type: 'proposal.created',
              approval_item_id: value.approval_item_id,
              kind: 'outbound_draft',
            })
            outputs.push({ kind: 'draft', approval_item_id: value.approval_item_id })
          }
        }

        usage.output_tokens = Math.ceil(body.length / 4) + (seed % 7)
        const noStage = req.expectations.must_stage_if_change_requested && wantsChange && !staged
        // 17 §3：摘要是一句人话（与 stub / direct-llm 同一份拼法）
        const summary = describeRun({
          readTools,
          drafted: body.length > 0,
          askedBoundaries,
          ...(order === undefined ? {} : { orderName: order.name }),
          ...(stagedMoney === undefined ? {} : { staged: stagedMoney }),
          ...(exhausted === undefined ? {} : { exhausted: exhausted.which }),
        })
        emit({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
          },
          outputs,
          summary,
        })
        return finish(
          exhausted !== undefined ? 'budget_exhausted' : 'completed',
          summary,
          noStage ? { no_stage: true } : undefined,
        )
      } finally {
        await harness.dispose()
      }
    },
  }
}

export type { ObjectRef }
