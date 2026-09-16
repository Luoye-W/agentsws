/**
 * 一次运行 = 一个 dsh 组合（headless、无状态）。
 *
 * 17 §5.1：运行不读上一次运行的会话文件。这里每次 `run()` 起一棵全新的 Cordis 树 +
 * 一个 Agent + 一个**内存** Session，结束即 dispose，两次运行之间没有任何共享状态
 * （工具注册表、提示词段、审批挂起、会话事件都随树消失）。
 *
 * WP81：回合改由 dsh 官方 Agent 层驱动（54（将改号 55）§2）。挂了哪些包见 `createHarness`
 * 上面那段注释；我们的五个门禁仍然是插件，装在 Agent 的 scoped ctx 上（`gate.ts`）。
 */
import { randomUUID } from 'node:crypto'
import type { ChatMessage, Completion, ModelMeta, RunEvent, ToolDef } from '@agentsws/contracts'
import { canonicalJson, sha256 } from '@agentsws/core'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { DshAdapterError } from './errors.js'
import type { GateApi, GateInput } from './gate.js'
import { installGate } from './gate.js'
import type { GatewayBudget } from './llm.js'
import { GATEWAY_PROVIDER, GatewayLlmAdapter } from './llm.js'

/** 装配 dsh 服务时等注入就绪的上限（毫秒）。 */
const READY_TIMEOUT_MS = 5000

/** 一次运行允许的模型步数上限（与 direct-llm 的 turn loop 同一个数）。 */
export const DEFAULT_MAX_STEPS = 8

export interface HarnessInput extends GateInput {
  meta: ModelMeta
  /** dsh 侧的模型路由；provider 固定为我们的网关适配器。 */
  model: string
  /** 这次运行的 dsh 会话 id（无状态：一次运行一个，结束即销毁）。 */
  sessionId?: string
  /** 模型步数上限；缺省 8。 */
  maxSteps?: number
  /** 预算耗尽时的回调（宿主发 `budget.exhausted` 并停 Agent）；与 `GateInput` 同一个签名。 */
  /** 宿主累计的 token 用量（预算判定读它）。 */
  tokensSpent?: () => number
  /** 每次真的送进网关的请求（Model-visible ⟺ logged）。 */
  onModelRequest?: (request: { messages: ChatMessage[]; tools: ToolDef[] }) => void
  /** 每次补全的用量。 */
  onCompletion?: (completion: Completion) => void
  /** 网关抛错时的原样消息（26 `freeze_on_model_outage` 要的那句话）。 */
  onModelError?: (message: string) => void
}

export interface DshHarness {
  ctx: Context
  gate: GateApi
  /** dsh 官方 Agent 层的句柄；回合由它驱动。 */
  agent: Agent
  session: Session
  /** dsh 装配出来的系统提示词（persona complete 段）。 */
  systemText(): Promise<string>
  /** dsh 装配出来的动态上下文快照分节（每个 ContextItem 一段）。 */
  contextSections(): Promise<{ name: string; text: string }[]>
  /** 经 dsh 的 `ctx.llm` 走一次补全（一次性调用；回合里的补全由 agent-loop 发起）。 */
  complete(prompt: { messages: ChatMessage[]; tools: ToolDef[] }): Promise<{
    text: string
    completion: Completion
  }>
  /**
   * 投一轮：`followup(createUserMessage(...))` → `whenIdle()`。
   * 返回这一轮 Agent 最后说的那段文本与终止原因。
   */
  runTurn(text: string): Promise<{ text: string; reason: string }>
  /** 中断这一轮（17 §5.6）。 */
  cancel(): void
  dispose(): Promise<void>
}

function toDshMessages(messages: ChatMessage[]): { system: string; messages: Message[] } {
  const systems: string[] = []
  const rest: Message[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      systems.push(m.content)
      continue
    }
    rest.push(
      createMessage({
        role: m.role === 'tool' ? 'user' : m.role,
        content: [{ type: 'text', text: m.content }],
        source: { kind: 'user' },
      }),
    )
  }
  return { system: systems.join('\n\n'), messages: rest }
}

function toDshToolSchemas(tools: ToolDef[]): ToolSchema[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: (t.input_schema ?? {}) as Record<string, unknown>,
  }))
}

/** 等一个已 provide 的服务出现在 context 上（Cordis 的注入是异步的）。 */
async function inject(root: Context, services: string[]): Promise<Context> {
  return new Promise<Context>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new DshAdapterError('timeout', `dsh 服务未就绪：${services.join(', ')}`, {
          retryable: true,
        }),
      )
    }, READY_TIMEOUT_MS)
    root.plugin({
      name: 'agentsws-gate-host',
      inject: services,
      apply(ctx: Context) {
        clearTimeout(timer)
        resolve(ctx)
      },
    })
  })
}

/**
 * 起一棵 dsh 组合树：官方 Agent 层 + 核心服务 + 我们的门禁插件 + LlmAdapter。
 *
 * **最小挂载**（54（将改号 55）§2.1，不用 `dsh-base`、不起 web server、不读 DSH_HOME）：
 * - `dsh-session`：Session 是 Agent 的真源；**不挂** `session-persistence-jsonl` → 内存会话（17 §5.1）
 * - `dsh-session-projection`：`agent-loop` 的 `inject` 之一（inbox 与 turn-boundary 两个投影要它）
 * - `dsh-agent`：`ctx.agents` 与 `Agent` 句柄
 * - `dsh-agent-loop`：唯一的官方驱动（把自己注册成 `ctx.agents` 的 factory），回合就是它排的
 * - `dsh-system-prompt` / `dsh-tools` / `dsh-user-approval` / `dsh-llm`：四个门禁挂的地方，WP30 起就在
 *
 * 注意这是**同进程**的 headless 组合，不是 `dsh --profile headless` 子进程：
 * 模拟回路要在同一进程里拿到 `stage` / `createDraft` 回调与合成时钟。
 * 跨进程那一档见 `headless/child.ts`（同一份组合，换宿主进程）。
 */
export async function createHarness(input: HarnessInput): Promise<DshHarness> {
  const root = new Context()
  root.plugin(SessionStore)
  root.plugin(SessionProjectionRegistry)
  root.plugin(AgentRegistry)
  root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  root.plugin(ToolRuntime, {})
  root.plugin(ApprovalService, {})
  root.plugin(LlmRuntime)
  // 串行：并行工具调用会让两档的事件顺序不可比（17 §4「换宿主不换语义」）
  root.plugin(AgentLoop, { maxParallelToolCalls: 1, agents: [] })

  const ctx = await inject(root, ['tools', 'systemPrompt', 'llm', 'agents', 'sessions'])

  let lastCompletion: Completion | undefined
  const budget: GatewayBudget | undefined =
    input.onBudgetExhausted === undefined || input.tokensSpent === undefined
      ? undefined
      : {
          max_steps: input.maxSteps ?? DEFAULT_MAX_STEPS,
          max_tokens: input.request.budget.max_tokens,
          spent: input.tokensSpent,
          exhausted: (which, used, cap) => input.onBudgetExhausted?.(which, used, cap),
        }
  const adapter = new GatewayLlmAdapter({
    gateway: input.options.gateway,
    meta: input.meta,
    ...(input.options.seed === undefined ? {} : { seed: input.options.seed }),
    max_cost_base: input.request.budget.max_cost_base,
    ...(budget === undefined ? {} : { budget }),
    ...(input.onModelRequest === undefined ? {} : { onRequest: input.onModelRequest }),
    ...(input.onModelError === undefined ? {} : { onError: input.onModelError }),
    onCompletion: (c) => {
      lastCompletion = c
      input.onCompletion?.(c)
    },
  })
  const releaseAdapter = ctx.llm.registerAdapter([GATEWAY_PROVIDER], adapter)

  const sessionId = (input.sessionId ?? `agentsws-${randomUUID()}`) as SessionId
  let gate: GateApi | undefined
  let handle: AgentHandle
  try {
    handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: GATEWAY_PROVIDER, model: input.model },
      setup: (agentCtx: Context, agent: Agent) => {
        // 工具与 hook 装在宿主 ctx 上（scope-filtered dispatch 按 `exec.agent` 路由），
        // `tools.restrict` 则必须在 Agent 的 scoped ctx 上调——全局 ctx 会抛。
        gate = installGate(ctx, { ...input, agent, agentCtx })
      },
    })
  } catch (e) {
    releaseAdapter()
    await root.fiber.dispose()
    throw e
  }
  if (gate === undefined) {
    await handle.dispose()
    releaseAdapter()
    await root.fiber.dispose()
    throw new DshAdapterError('internal', 'Agent setup 没有装上门禁插件')
  }
  const installed = gate
  const agent = handle.agent

  const assemble = async () => ctx.systemPrompt.assemble({ agent } as never)

  return {
    ctx,
    gate: installed,
    agent,
    session: agent.session,
    async systemText() {
      return renderPrompt(await assemble())
    },
    async contextSections() {
      return renderContextSections(await assemble()).map((s) => ({ name: s.name, text: s.text }))
    },
    async complete(prompt) {
      const { system, messages } = toDshMessages(prompt.messages)
      const options: GenerateOptions = {
        provider: GATEWAY_PROVIDER,
        model: input.model,
        system,
        messages,
        tools: toDshToolSchemas(prompt.tools),
      }
      let text = ''
      for await (const chunk of ctx.llm.stream(options)) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          throw new DshAdapterError('provider_unavailable', 'dsh LlmRuntime 报告补全失败', {
            retryable: true,
          })
        }
      }
      if (lastCompletion === undefined) {
        throw new DshAdapterError('provider_unavailable', '网关没有返回补全')
      }
      return { text, completion: lastCompletion }
    },
    async runTurn(text) {
      const firstSeq = Number(agent.session.seq)
      agent.followup(
        createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      )
      await agent.whenIdle()
      return summarizeTurn(agent.session, firstSeq)
    },
    cancel() {
      agent.cancel({ kind: 'user' } as never)
    },
    async dispose() {
      releaseAdapter()
      await installed.dispose()
      await handle.dispose()
      await root.fiber.dispose()
    },
  }
}

/** 一轮结束后：Agent 最后说的那段文本 + 终止原因（官方 headless 的 `summarize` 同款）。 */
function summarizeTurn(session: Session, firstSeq: number): { text: string; reason: string } {
  let text = ''
  let reason = 'unknown'
  const length = Number(session.seq)
  for (let seq = firstSeq; seq < length; seq += 1) {
    const event = session.eventAt(seq as never) as SessionEvent | undefined
    if (event === undefined) continue
    if (event.type === 'assistant/message') {
      const joined = (
        event.data as { message: { content: { type: string; text?: string }[] } }
      ).message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') {
      reason = (event.data as { reason: { kind: string } }).reason.kind
    }
  }
  return { text, reason }
}

/** 一段模型可见内容的指纹（事件里只记哈希，正文不重复进日志）。 */
export function visibleDigest(value: unknown): string {
  return sha256(canonicalJson(value)).slice(0, 16)
}

export type { RunEvent }
