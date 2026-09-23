/**
 * `RuntimeAdapter`（name='dsh'，17 §4）。
 *
 * WP81 起**回合由 dsh 官方 Agent 层驱动**（54（将改号 55）§2）：
 * 每次 `run()` 起一套全新的 dsh 组合（headless、无状态），把 RunRequest 映射成
 * preset + 工具 + 提示词分节 + 上下文分节，然后
 * `ctx.agents.create` → `agent.followup(createUserMessage(...))` → `agent.whenIdle()`，
 * 把 dsh 的 `session/event` 投影成 17 §2 的 `RunEvent`，最后 `handle.dispose()`。
 *
 * 我们不再自己排模型回合：调哪个工具、调几轮，都是模型 + agent-loop 的事。
 * 门禁（五个 seam）仍然是插件，装在 Agent 的 scoped ctx 上（`gate.ts`）；
 * 预算仍然是硬的——工具调用数在 `tools/pre-execute` 里计，token 与步数在 LlmAdapter 里计，
 * 超了就 `agent.cancel()`（官方 agent-loop 自己没有回合预算）。
 * 事件映射表见 `AGENT-LAYER.md`。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ChatMessage,
  ContextItem,
  ObjectRef,
  RunEvent,
  RunRequest,
  RunResult,
  RuntimeAdapter,
  ToolDef,
} from '@agentsws/contracts'
import { canonicalJson, Provenance, sha256 } from '@agentsws/core'
import { staticPrefixHash } from '@agentsws/model-gateway'
import type { DraftPayload, StageIntent } from '@agentsws/stand-ins'
import { assemblePrompt, describeRun, promptHash } from '@agentsws/stand-ins'
import { replySubject } from '@agentsws/support-core'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { DraftArgs, StageArgs } from './gate.js'
import { createHarness } from './harness.js'
import { presetDigest, writePreset } from './preset.js'
import {
  DAY_MS,
  hitsRule,
  itemsOfKind,
  looksLikeChangeRequest,
  type OrderView,
  orderView,
  plainText,
  refOf,
  returnWindowDays,
  threadParticipants,
  threadSubject,
} from './reading.js'
import type { DshRuntimeOptions } from './types.js'

const RUNTIME_NAME = 'dsh'

/**
 * 投给 Agent 的那一条用户消息（17 §1 的"用户消息"槽）。
 *
 * 事项的材料全在 `systemPrompt.context` 的分节里（一段一个 ContextItem），
 * 这一条只说"干什么"，而且是**常量**——静态前缀字节稳定（17 §6 / 22 §2 缓存纪律）。
 */
export const TASK_MESSAGE = [
  'Handle this work item with the context above.',
  'Read what you need first; propose changes with the staging tools; never write to external systems directly.',
].join(' ')

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

  return {
    name: RUNTIME_NAME,

    capabilities() {
      // 实测（0.1.7-rc.1，WP132 复核；WP81 起走官方 Agent 层）：
      // tool_choice —— dsh 的 GenerateOptions 没有 tool_choice 字段，强制先读工具做不到 → false
      // streaming   —— LlmRuntime 是流式的（StreamChunk）→ true
      // followup    —— Agent 有 followup()，但本适配器一次运行一棵树、结束即销毁 → false
      // seedable    —— seed 由我们透传给模型网关，dsh 侧不参与 → true
      return { tool_choice: false, streaming: true, followup: false, seedable: true }
    },

    async health() {
      try {
        const mod = await import('@deepseek-ai/dsh-agent')
        const ok = typeof mod.default === 'function'
        return ok
          ? { ok: true, detail: 'dsh 0.1.7-rc.1 Agent 层可解析；运行走同进程 headless 组合' }
          : { ok: false, detail: 'dsh-agent 没有默认导出的插件' }
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
      const events: RunEvent[] = []
      const usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_base: 0 }
      let exhausted: { which: keyof RunRequest['budget']; used: number; cap: number } | undefined
      let modelError: string | undefined

      const preset = writePreset(req, options.presetRoot)
      const hasConnections = (req.connections ?? []).length > 0
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

      let outputs: RunResult['outputs'] = []
      let toolCalls = 0

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
      /*
       * WP86：职责 preset 生成了没有（55 §4 第三层）。
       *
       * 17 §2 的 `RunEvent` 里**没有** `preset.generated` 这个类型，本棒不新增——
       * 这是一条"装配发生了什么"的记录，不是运行时产出的新东西，`progress` 正是
       * 为这类事准备的那一格。`note` 里记三件排障要的：preset id、内容指纹、
       * 这次写没写文件（`reused` = 内容没变、mtime 没动、上游不会起新一代）。
       * **凭据一个字都不进这条事件**——里面只有名字都没有。
       */
      emit({
        type: 'progress',
        step: 'preset.generated',
        note: `${preset.id} ${presetDigest(req)} ${preset.written ? 'written' : 'reused'} conns=${
          (req.connections ?? []).length
        }`,
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
        order: orderItem === undefined ? undefined : orderView(orderItem.content, refOf(orderItem)),
        policySource: policy.source,
        threadItem,
        daysSinceDelivery: undefined,
      }
      const sinceDelivery = (order: OrderView | undefined): number | undefined => {
        const delivered =
          order?.delivered_at === undefined ? undefined : Date.parse(order.delivered_at)
        return delivered === undefined
          ? undefined
          : Math.floor((Date.parse(clock.now()) - delivered) / DAY_MS)
      }

      const buildStageIntent = (args: StageArgs): StageIntent | undefined => {
        const order =
          args.order_id !== undefined && scratch.order?.id !== args.order_id
            ? (scratch.order ?? undefined)
            : scratch.order
        if (order === undefined) return undefined
        const notes =
          args.notes !== undefined && args.notes.length > 0
            ? args.notes
            : [
                `退货窗口 ${scratch.windowDays} 天内（签收 ${sinceDelivery(order) ?? '?'} 天）`,
                args.reason ?? '由 dsh 运行时按政策提出',
              ]
        return {
          request: req,
          kind: 'refund',
          target: order.ref,
          field: 'refunded_amount',
          before: order.refunded_amount,
          after: order.refunded_amount + args.amount,
          money: { amount: args.amount, currency: args.currency ?? order.currency },
          notes,
          ...(order.email === undefined
            ? {}
            : { requester: { channel: 'email', external_id: order.email } }),
        }
      }

      const buildDraftPayload = (args: DraftArgs): DraftPayload | undefined => {
        const order = scratch.order
        const to =
          args.to !== undefined && args.to.length > 0
            ? args.to
            : order?.email !== undefined
              ? [order.email]
              : threadParticipants(scratch.threadItem)
        const citations =
          args.citations !== undefined && args.citations.length > 0
            ? args.citations
            : scratch.policySource === undefined
              ? []
              : [
                  {
                    fact_card_id: scratch.policySource.id,
                    quote: `returns within ${scratch.windowDays} days of delivery`,
                  },
                ]
        return {
          request: req,
          channel: 'email',
          to,
          subject:
            args.subject.length > 0
              ? args.subject
              : (threadSubject(scratch.threadItem) ?? replySubject(undefined, order, req.vertical)),
          // 正文原样用模型写的那一版：WP55 的出站硬闸在 `createDraft` 那一跳判，
          // 判下来了就打回重写（`gate.ts` 的 answerer），绝不在这里静默改字。
          body: args.body,
          child_change_ids: [...args.child_change_ids],
          citations,
          ...(scratch.threadItem === undefined
            ? {}
            : { thread_external_id: scratch.threadItem.id }),
        }
      }

      let harness: Awaited<ReturnType<typeof createHarness>>
      let stopCancel: (() => void) | undefined
      try {
        harness = await createHarness({
          request: req,
          sink: emit,
          provenance: prov,
          options,
          buildStageIntent,
          buildDraftPayload,
          model: req.runtime.model.model,
          sessionId: `agentsws-${session_id}`,
          /*
           * WP86（55 §4 第三层）：**这条职责有连接才挂 preset**。
           * 没连接就不装 Loader / Include / AgentPresets，工具面里一个 `mcp__*` 都没有
           * ——与 WP82 的浏览器同一条纪律（不用的东西不挂）。
           */
          ...(hasConnections ? { preset: { root: preset.root, id: preset.id } } : {}),
          onToolResult: (_tool, value) => {
            if (scratch.order === undefined) {
              const found = orderView(value)
              if (found !== undefined) scratch.order = found
            }
          },
          onBudgetExhausted: (which, used, cap) => {
            if (exhausted !== undefined) return
            exhausted = { which, used, cap }
            emit({ type: 'budget.exhausted', which, used, cap })
            harness?.cancel()
          },
          tokensSpent: () => usage.input_tokens + usage.output_tokens,
          onModelRequest: ({ messages, tools }) => {
            // Model-visible ⟺ logged：这一步模型看见了几段、哪些工具
            emit({
              type: 'progress',
              step: 'model_request',
              note: `${messages.length} 段 / ${tools.map((t) => t.name).join(',')}`,
            })
          },
          onCompletion: (c) => {
            usage.input_tokens += c.usage.input_tokens
            usage.output_tokens += c.usage.output_tokens
            usage.cached_tokens += c.usage.cached_tokens
            usage.cost_base += c.usage.cost_base
          },
          onModelError: (message) => {
            modelError ??= message
          },
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
        //
        // 装配在 Agent 建好**之后**发：`context.injected` 是门禁在 Agent 的 setup 里
        // 逐段注册时发的（注册 ⟺ 事件），17 §2 的顺序是 started → context.injected* →
        // prompt.assembled。这里的哈希仍然按 `assemblePrompt(req)` 算——它是回放重组的
        // 那一份（17 §6.1 铁律）；真正送模型的那一份由 dsh 的 `systemPrompt.assemble()`
        // 从同一批段装出来，逐步的内容有 `progress{model_request}` 记着。
        const prompt = assemblePrompt(req)
        const total_tokens = estimateTokens(prompt.messages, prompt.tools)
        emit({
          type: 'prompt.assembled',
          hash: promptHash(prompt),
          static_prefix_hash: staticPrefixHash(prompt.messages, prompt.tools),
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
            outputs: [],
            summary: 'max_tokens 预算耗尽',
          })
          return finish('budget_exhausted', 'max_tokens 预算耗尽')
        }

        // grounding（17 §5.4）：WP81 起不再由我们代替模型决定调什么工具，
        // 命中的规则只作为一条提示记进事件——调不调是模型的事。
        const hits = req.grounding.filter((r) => hitsRule(scratch.threadText, r))
        if (hits.length > 0) {
          emit({
            type: 'progress',
            step: 'grounding',
            note: hits.map((r) => `${r.name}→${r.tool}`).join(','),
          })
        }

        // ── 事件投影（17 §2）：dsh 的 `session/event` → 我们的 RunEvent ──────
        const sessionId = harness.session.id
        const offProjection = harness.ctx.on(
          'session/event',
          (session: { id: unknown }, event: SessionEvent) => {
            if (session.id !== sessionId) return
            project(event, emit)
          },
        )

        const onAbort = (): void => {
          harness.cancel()
        }
        signal.addEventListener('abort', onAbort, { once: true })
        stopCancel = () => signal.removeEventListener('abort', onAbort)

        const turn = await harness.runTurn(TASK_MESSAGE)
        offProjection()
        toolCalls = harness.gate.toolCalls

        if (signal.aborted) {
          emit({ type: 'run.cancelled' })
          return finish('cancelled', '运行被中断：未闭合的工具调用已补齐')
        }
        if (modelError !== undefined) {
          emit({
            type: 'run.failed',
            error: { code: 'provider_unavailable', message: modelError, retryable: true },
          })
          return finish('failed', `模型不可用：${modelError}`)
        }

        // ── 边界选择题卡（36 §2.2）：模型压根没提变更那条路也要问一次 ────────
        const askedBoundaries: string[] = []
        if (exhausted === undefined) {
          for (const asked of await harness.gate.askBoundaries()) askedBoundaries.push(asked.label)
        }

        outputs = harness.gate.outputs
        scratch.daysSinceDelivery = sinceDelivery(scratch.order)
        const wantsChange = looksLikeChangeRequest(scratch.threadText)
        const noStage =
          req.expectations.must_stage_if_change_requested && wantsChange && !harness.gate.staged
        // 17 §3：摘要是一句人话（与 stub / direct-llm 同一份拼法）
        const summary = describeRun({
          readTools: harness.gate.readTools,
          drafted: harness.gate.drafted,
          askedBoundaries,
          ...(scratch.order === undefined ? {} : { orderName: scratch.order.name }),
          ...(harness.gate.stagedMoney === undefined ? {} : { staged: harness.gate.stagedMoney }),
          ...(exhausted === undefined ? {} : { exhausted: exhausted.which }),
        })
        if (turn.text.length > 0 && req.expectations.outputs.includes('answer')) {
          outputs.push({ kind: 'answer', text: turn.text })
        }
        emit({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
          },
          outputs,
          summary,
          ...(noStage ? { no_stage: true } : {}),
        })
        return finish(
          exhausted !== undefined ? 'budget_exhausted' : 'completed',
          summary,
          noStage ? { no_stage: true } : undefined,
        )
      } finally {
        stopCancel?.()
        await harness.dispose()
      }
    },
  }
}

/**
 * dsh 的一条 `session/event` → 17 §2 的 RunEvent。完整映射表见 `AGENT-LAYER.md`。
 *
 * `tool/result` **不**在这里投影：门禁的 `tools/post-execute` 才知道这次调用的判定
 * （ok / error / blocked）与 provenance，它发的那一条才是 17 §2 要的。
 */
function project(event: SessionEvent, emit: (e: RunEvent) => void): void {
  switch (event.type) {
    case 'turn/start': {
      emit({ type: 'turn.started', turn: (event.data as { turn: number }).turn })
      return
    }
    case 'turn/end': {
      const data = event.data as { turn: number; reason: { kind: string } }
      emit({ type: 'turn.ended', turn: data.turn, reason: data.reason.kind })
      return
    }
    case 'assistant/message': {
      const message = (
        event.data as { message: { content: readonly { type: string; text?: string }[] } }
      ).message
      const text = message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (text.length > 0) emit({ type: 'text.delta', text })
      return
    }
    case 'tool/call': {
      const data = event.data as { callId: string; name: string; arguments: string }
      let input: unknown = {}
      try {
        input = data.arguments === '' ? {} : (JSON.parse(data.arguments) as unknown)
      } catch {
        input = data.arguments
      }
      emit({ type: 'tool.call', call_id: String(data.callId), tool: data.name, input })
      return
    }
    case 'user/message': {
      // dsh 自己往模型面前放的那些段（审批口径、运行时上下文快照）也要有事件可查
      const source = (event.data as { source?: { kind?: string } }).source
      if (source?.kind === 'user') return
      emit({ type: 'progress', step: 'model_context', note: source?.kind ?? 'unknown' })
      return
    }
    default:
      return
  }
}

export type { ObjectRef }
