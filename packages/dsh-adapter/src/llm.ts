/**
 * LlmAdapter（09 §0 "Plugins not loop changes"）：把 dsh 的补全转到我们的模型网关。
 *
 * 做成适配器而不是工具，是为了让 dsh 的 compaction / token-meter / retry 照常工作：
 * 它们都挂在 `ctx.llm` 的 dispatch 上，工具形态会绕过去。
 *
 * WP81 之后这条路多担两件事：
 * 1. **工具调用要过线**——回合由 dsh 的 agent-loop 驱动，模型必须能说"我要调 X"。
 *    网关回的 `Completion.tool_calls` 在这里翻成 dsh 的 `tool-call` 块与 `tool-calls` 终止原因。
 * 2. **预算在这里计数**——17 §5.3 的 `max_tokens` 与轮数上限是硬的，而 dsh 的 loop
 *    自己没有回合预算（官方 agent-loop README「No built-in turn budget」）。每次补全前过一次
 *    预算，超了就回调宿主把 Agent 停下。
 */
import type { ChatMessage, Completion, ModelMeta, ToolDef } from '@agentsws/contracts'
import type {
  ContentBlock,
  GenerateOptions,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk,
  ToolCallId,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { ModelGatewayLike } from './types.js'

/** dsh 的 provider 路由名；preset 与 `agent.cordis.yml` 里都用它。 */
export const GATEWAY_PROVIDER = 'agentsws-gateway'

/**
 * 我们注入模型的每个 ContextItem 都以这一行开头（`gate.ts` 的 `systemPrompt.context`）。
 *
 * dsh 把 persona 段拼成**一条** system 消息、把动态上下文快照拼成**一条** user 消息，
 * 而 17 §1 的装配（`assemblePrompt`）是一段一条消息——网关那一侧（脱敏、缓存前缀、
 * 模拟档的规则脑）看的是后者。所以在这条边界上按这一行拆回去，送进网关的消息形状
 * 与 stub / direct 两个运行时逐字段一致。**只拆不改**：一个字节都没增删，只是换了分段。
 */
const CONTEXT_MARKER = /^\[([a-z_]+):([^\]]*)\]$/

/**
 * dsh 的 ContentBlock → 纯文本（我们的 ChatMessage.content 是字符串）。
 *
 * WP132（0.1.7-rc.1）：`tool-result` 块没了——工具结果升成一等的 `role: 'tool'` 消息
 * （`dsh-llm` 的 `ToolResultMessage`），块里只剩结果本身的 text / image / file；
 * 新增的 `tool-addition` / `tool-removal` 两种块只出现在 `developer` 消息里，没有文字。
 */
function blockText(block: ContentBlock): string {
  if (block.type === 'text') return block.text
  return ''
}

function messageText(message: RequestMessage): string {
  return message.content
    .map((b) => blockText(b))
    .filter((s) => s.length > 0)
    .join('\n')
}

/**
 * 把 dsh 拼好的一整段文本拆回 17 §1 的分段形状。
 *
 * 前缀（persona / 登记表 / dsh 自己的运行时上下文抬头）保持原来的角色；随后每个
 * `[kind:id]` 标记开一条新消息，`thread` 那一段是 `user`（与 `assemblePrompt` 同一条规则），
 * 其余是 `system`。
 */
export function splitSystemText(
  text: string,
  baseRole: ChatMessage['role'] = 'system',
): ChatMessage[] {
  const out: ChatMessage[] = []
  let role: ChatMessage['role'] = baseRole
  let buffer: string[] = []
  const flush = (): void => {
    const content = buffer.join('\n').trim()
    if (content.length > 0) out.push({ role, content })
    buffer = []
  }
  for (const line of text.split('\n')) {
    const marker = CONTEXT_MARKER.exec(line.trim())
    if (marker !== null) {
      flush()
      role = marker[1] === 'thread' ? 'user' : 'system'
      buffer.push(line.trim())
      continue
    }
    buffer.push(line)
  }
  flush()
  return out
}

function parseArguments(raw: string): unknown {
  if (raw === '') return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

/**
 * dsh 的请求 → 22 §1 的 `complete` 请求。
 *
 * `system` 槽（一次性调用）在前；loop 建的请求没有 `system` 字段，系统提示词是
 * `messages` 里的第一条 system 消息。工具结果在 dsh 0.1.7 起是**一等的 `role: 'tool'` 消息**
 * （0.1.6 是带 `tool-result` 块的 user 消息），这里翻成我们的 `tool` 角色并补回工具名
 * （从上一条 assistant 的 `tool-call` 块取）。
 *
 * WP87：`reasoningByCallId` 把**思考模型上一轮的推理**接回 assistant 消息。dsh 的
 * `Message` 里没有这一格（它的块只有 text / tool-call 等，没有推理原文），推理在流协议这一层
 * 就掉了；而 `ChatMessage.reasoning` 的契约注释写得很清楚——DeepSeek thinking 模式多轮时
 * 不原样带回就 400（09-14 真店实测）。键取这一轮 assistant 的第一个 tool-call id：
 * 有工具调用的 assistant 才会出现在下一轮的历史里，没有的那一轮 loop 已经结束了。
 */
export function toChatMessages(
  options: GenerateOptions,
  reasoningByCallId?: ReadonlyMap<string, string>,
): ChatMessage[] {
  const messages: ChatMessage[] = []
  if (options.system !== undefined && options.system.length > 0) {
    messages.push(...splitSystemText(options.system))
  }
  /** toolCallId → 工具名（模型这一轮说过的调用）。 */
  const toolNames = new Map<string, string>()
  for (const m of options.messages) {
    if (m.role === 'system') {
      messages.push(...splitSystemText(messageText(m)))
      continue
    }
    if (m.role === 'assistant') {
      const calls = m.content.filter((b) => b.type === 'tool-call')
      for (const c of calls) toolNames.set(String(c.id), c.name)
      const content = m.content
        .map((b) => (b.type === 'tool-call' ? `[calling ${b.name} ${b.arguments}]` : blockText(b)))
        .filter((s) => s.length > 0)
        .join('\n')
      const reasoning =
        calls[0] === undefined ? undefined : reasoningByCallId?.get(String(calls[0].id))
      messages.push({
        role: 'assistant',
        content,
        ...(calls.length === 0
          ? {}
          : {
              tool_calls: calls.map((c) => ({
                id: String(c.id),
                name: c.name,
                input: parseArguments(c.arguments),
              })),
            }),
        ...(reasoning === undefined || reasoning.length === 0 ? {} : { reasoning }),
      })
      continue
    }
    if (m.role === 'tool') {
      const name = toolNames.get(String(m.toolCallId))
      messages.push({
        role: 'tool',
        content: m.content.map((b) => blockText(b)).join(''),
        tool_call_id: String(m.toolCallId),
        ...(name === undefined ? {} : { name }),
      })
      continue
    }
    if (m.role === 'developer') {
      /*
       * WP132：0.1.7 新角色，记"这一轮会话里工具集怎么变了"（`tool-addition` /
       * `tool-removal`），上游注释说 provider 与 UI 在生产方落地前一律拒收。
       * 我们的工具集一次运行定死（`tools.restrict` 白名单），这类消息不该出现；
       * 真出现了也没有可送的文字——有文字才按 system 送，与一次性调用的 `system` 槽同一条路。
       */
      const text = messageText(m)
      if (text.length > 0) messages.push(...splitSystemText(text))
      continue
    }
    messages.push(...splitSystemText(messageText(m), 'user'))
  }
  return messages
}

export function toToolDefs(tools: readonly ToolSchema[] | undefined): ToolDef[] {
  return (tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))
}

/** 17 §5.3：预算在这条路上兑现（dsh 的 loop 自己没有回合预算）。 */
export interface GatewayBudget {
  /** 一次运行允许的模型步数上限（防死循环）。 */
  max_steps: number
  max_tokens: number
  /** 已经花掉多少 token（宿主累计）。 */
  spent(): number
  /**
   * 预算耗尽时回调宿主：宿主发 `budget.exhausted` 并把 Agent 停下。
   * 回调之后这一轮收成一个空的 `stop`，让 loop 干净地结束。
   */
  exhausted(which: 'max_tokens' | 'max_seconds', used: number, cap: number): void
}

export interface GatewayAdapterOptions {
  gateway: ModelGatewayLike
  meta: ModelMeta
  seed?: number
  max_cost_base?: number
  /** 每次补全的用量都回调出去（运行时据此填 `run.completed.usage`）。 */
  onCompletion?: (completion: Completion) => void
  /** 每次真的送进网关的消息与工具（Model-visible ⟺ logged，宿主据此发事件）。 */
  onRequest?: (request: { messages: ChatMessage[]; tools: ToolDef[] }) => void
  /**
   * 网关抛错时的原样消息。dsh 的 loop 把失败收成一个 `error` 终止原因，
   * 原始错误就此消失；26 的 `freeze_on_model_outage` 要的是"模型挂了"这句话。
   */
  onError?: (message: string) => void
  budget?: GatewayBudget
}

/**
 * 把 dsh 的一次 `stream()` 变成网关的一次 `complete()`，再把结果按 dsh 的流协议吐回去。
 */
export class GatewayLlmAdapter extends LlmAdapter {
  private steps = 0
  /**
   * WP87：这次运行里每一轮的推理，按该轮 assistant 的**每一个** tool-call id 记一份。
   * 下一轮 `toChatMessages` 据此把 `reasoning_content` 原样带回（思考模型的硬要求）。
   */
  private readonly reasoningByCallId = new Map<string, string>()

  constructor(private readonly options: GatewayAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'agentsws model gateway' }
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const budget = this.options.budget
    this.steps += 1
    if (budget !== undefined) {
      if (this.steps > budget.max_steps) {
        budget.exhausted('max_seconds', this.steps, budget.max_steps)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const spent = budget.spent()
      if (spent > budget.max_tokens) {
        budget.exhausted('max_tokens', spent, budget.max_tokens)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
    }
    const messages = toChatMessages(options, this.reasoningByCallId)
    const tools = toToolDefs(options.tools)
    this.options.onRequest?.({ messages, tools })
    let completion: Completion
    try {
      completion = await this.options.gateway.complete({
        messages,
        tools,
        meta: this.options.meta,
        ...(this.options.seed === undefined ? {} : { seed: this.options.seed }),
        ...(this.options.max_cost_base === undefined
          ? {}
          : { max_cost_base: this.options.max_cost_base }),
      })
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error.message : String(error))
      throw error
    }
    this.options.onCompletion?.(completion)

    let index = 0
    if (completion.text.length > 0) {
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text: completion.text }
      yield { type: 'block-end', index, block: { type: 'text', text: completion.text } }
      index += 1
    }
    const calls = completion.tool_calls ?? []
    for (const call of calls) {
      const id = (call.id.length > 0 ? call.id : `call_${index + 1}`) as ToolCallId
      // 推理跟着这一轮的调用 id 走：下一轮历史里认得出是哪一条 assistant
      if (completion.reasoning !== undefined && completion.reasoning.length > 0) {
        this.reasoningByCallId.set(String(id), completion.reasoning)
      }
      const args = JSON.stringify(call.input ?? {})
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id, name: call.name, arguments: args },
      }
      index += 1
    }
    yield {
      type: 'usage',
      usage: {
        inputTokens: completion.usage.input_tokens,
        outputTokens: completion.usage.output_tokens,
        cacheReadTokens: completion.usage.cached_tokens,
      },
    }
    yield { type: 'finish', reason: calls.length > 0 ? { kind: 'tool-calls' } : { kind: 'stop' } }
  }
}
