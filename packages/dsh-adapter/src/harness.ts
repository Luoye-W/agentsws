/**
 * 一次运行 = 一个 dsh 组合（headless、无状态）。
 *
 * 17 §5.1：运行不读上一次运行的会话文件。这里每次 `run()` 起一棵全新的 Cordis 树，
 * 结束即 dispose，两次运行之间没有任何共享状态（工具注册表、提示词段、审批挂起都随树消失）。
 */
import type { ChatMessage, Completion, ModelMeta, RunEvent, ToolDef } from '@agentsws/contracts'
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { createMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { DshAdapterError } from './errors.js'
import type { GateApi, GateInput } from './gate.js'
import { installGate } from './gate.js'
import { GATEWAY_PROVIDER, GatewayLlmAdapter } from './llm.js'

/** 装配 dsh 服务时等注入就绪的上限（毫秒）。 */
const READY_TIMEOUT_MS = 5000

export interface HarnessInput extends GateInput {
  meta: ModelMeta
  /** dsh 侧的模型路由；provider 固定为我们的网关适配器。 */
  model: string
}

export interface DshHarness {
  ctx: Context
  gate: GateApi
  /** dsh 装配出来的系统提示词（persona complete 段）。 */
  systemText(): Promise<string>
  /** dsh 装配出来的动态上下文快照分节（每个 ContextItem 一段）。 */
  contextSections(): Promise<{ name: string; text: string }[]>
  /** 经 dsh 的 `ctx.llm` 走一次补全（compaction / retry / token-meter 都在这条路上）。 */
  complete(prompt: { messages: ChatMessage[]; tools: ToolDef[] }): Promise<{
    text: string
    completion: Completion
  }>
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
        source: m.role === 'assistant' ? { kind: 'user' } : { kind: 'user' },
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
 * 起一棵 dsh 组合树：核心服务 + 我们的门禁插件 + LlmAdapter。
 *
 * 注意这是**同进程**的 headless 组合，不是 `dsh --profile headless` 子进程：
 * 模拟回路要在同一进程里拿到 `stage` / `createDraft` 回调与合成时钟。
 * 真正跨进程跑同一份 preset 的路径见 `preset.ts` 生成的 `agent.cordis.yml`。
 */
export async function createHarness(input: HarnessInput): Promise<DshHarness> {
  const root = new Context()
  root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  root.plugin(ToolRuntime, {})
  root.plugin(ApprovalService, {})
  root.plugin(LlmRuntime)

  const ctx = await inject(root, ['tools', 'systemPrompt', 'llm'])
  const gate = installGate(ctx, input)

  let lastCompletion: Completion | undefined
  const adapter = new GatewayLlmAdapter({
    gateway: input.options.gateway,
    meta: input.meta,
    ...(input.options.seed === undefined ? {} : { seed: input.options.seed }),
    max_cost_base: input.request.budget.max_cost_base,
    onCompletion: (c) => {
      lastCompletion = c
    },
  })
  const releaseAdapter = ctx.llm.registerAdapter([GATEWAY_PROVIDER], adapter)

  const assemble = async () => ctx.systemPrompt.assemble()

  return {
    ctx,
    gate,
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
    async dispose() {
      releaseAdapter()
      await gate.dispose()
      await root.fiber.dispose()
    },
  }
}

export type { RunEvent }
