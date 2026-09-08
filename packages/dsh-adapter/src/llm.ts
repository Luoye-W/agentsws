/**
 * LlmAdapter（09 §0 "Plugins not loop changes"）：把 dsh 的补全转到我们的模型网关。
 *
 * 做成适配器而不是工具，是为了让 dsh 的 compaction / token-meter / retry 照常工作：
 * 它们都挂在 `ctx.llm` 的 dispatch 上，工具形态会绕过去。
 */
import type { ChatMessage, Completion, ModelMeta, ToolDef } from '@agentsws/contracts'
import type {
  GenerateOptions,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { ModelGatewayLike } from './types.js'

/** dsh 的 provider 路由名；preset 与 `agent.cordis.yml` 里都用它。 */
export const GATEWAY_PROVIDER = 'agentsws-gateway'

/** dsh 的 ContentBlock → 纯文本（我们的 ChatMessage.content 是字符串）。 */
function blockText(block: { type: string; [k: string]: unknown }): string {
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (block.type === 'tool-result' && Array.isArray(block.content)) {
    return (block.content as { type: string; text?: string }[])
      .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
      .join('')
  }
  return ''
}

/**
 * dsh 的请求 → 22 §1 的 `complete` 请求。
 * `system` 槽在前，随后按序还原会话消息；`tool` 角色 dsh 侧不存在（工具结果是 user 消息）。
 */
export function toChatMessages(options: GenerateOptions): ChatMessage[] {
  const messages: ChatMessage[] = []
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  for (const m of options.messages) {
    const content = m.content.map((b) => blockText(b as never)).join('\n')
    messages.push({ role: m.role, content })
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

export interface GatewayAdapterOptions {
  gateway: ModelGatewayLike
  meta: ModelMeta
  seed?: number
  max_cost_base?: number
  /** 每次补全的用量都回调出去（运行时据此填 `run.completed.usage`）。 */
  onCompletion?: (completion: Completion) => void
}

/**
 * 把 dsh 的一次 `stream()` 变成网关的一次 `complete()`，再把结果按 dsh 的流协议吐回去。
 * stub provider 不产工具调用，所以这里只发文本块 + usage + finish。
 */
export class GatewayLlmAdapter extends LlmAdapter {
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
    const completion = await this.options.gateway.complete({
      messages: toChatMessages(options),
      tools: toToolDefs(options.tools),
      meta: this.options.meta,
      ...(this.options.seed === undefined ? {} : { seed: this.options.seed }),
      ...(this.options.max_cost_base === undefined
        ? {}
        : { max_cost_base: this.options.max_cost_base }),
    })
    this.options.onCompletion?.(completion)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: completion.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: completion.text } }
    yield {
      type: 'usage',
      usage: {
        inputTokens: completion.usage.input_tokens,
        outputTokens: completion.usage.output_tokens,
        cacheReadTokens: completion.usage.cached_tokens,
      },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
