import type {
  ChatMessage,
  CompletionUsage,
  ModelProvider,
  ModelRef,
  ToolDef,
} from '@agentsws/contracts'
import { canonicalJson, sha256 } from '@agentsws/core'
import { estimateInputTokens } from '@agentsws/model-gateway'

export interface ScriptedToolCall {
  id?: string
  name: string
  input: Record<string, unknown>
}

export interface ScriptedTurn {
  text?: string
  tool_calls?: ScriptedToolCall[]
}

export interface ScriptInput {
  messages: ChatMessage[]
  tools?: ToolDef[]
  seed?: number
  /** 第几轮（按对话里已有的 assistant 消息数推，纯函数，不藏状态）。 */
  turn: number
}

export type ScriptFn = (input: ScriptInput) => ScriptedTurn

export interface ScriptedProviderOptions {
  script: readonly ScriptedTurn[] | ScriptFn
  ref?: ModelRef
  seed?: number
}

const byte = (hash: string, i: number): number => Number.parseInt(hash.slice(i * 2, i * 2 + 2), 16)

/** 对话里已有的 assistant 消息数 = 下一轮的序号。 */
export function turnOf(messages: readonly ChatMessage[]): number {
  return messages.filter((m) => m.role === 'assistant').length
}

/**
 * 确定性脚本 provider（22 的 stub provider 不返 tool_calls，本包测试用它跑工具循环）。
 *
 * 按轮次返回预设的 tool_call / 文本；usage 从 (messages, tools, seed) 的哈希算，
 * 同一输入必然同一输出——"同 seed 两次事件序列相同"靠这一条。
 */
export function scriptedProvider(options: ScriptedProviderOptions): ModelProvider {
  const ref: ModelRef = options.ref ?? { provider: 'stub', model: 'scripted-v1', region: 'cn' }
  const script = options.script

  const usageOf = (
    hash: string,
    messages: ChatMessage[],
    tools: ToolDef[] | undefined,
    text: string,
  ): CompletionUsage => ({
    input_tokens: estimateInputTokens(messages, tools, 4),
    output_tokens: Math.max(1, Math.ceil(text.length / 4)) + (byte(hash, 8) % 4),
    cached_tokens: 0,
    cost_base: 0,
  })

  return {
    ref,
    async complete(req) {
      const turn = turnOf(req.messages)
      const step: ScriptedTurn =
        typeof script === 'function'
          ? script({
              messages: req.messages,
              turn,
              ...(req.tools === undefined ? {} : { tools: req.tools }),
              ...(req.seed === undefined ? {} : { seed: req.seed }),
            })
          : (script[turn] ?? { text: '' })
      const hash = sha256(
        canonicalJson({
          messages: req.messages,
          tools: req.tools ?? [],
          seed: req.seed ?? options.seed ?? 0,
        }),
      )
      const text = step.text ?? ''
      const calls = (step.tool_calls ?? []).map((c, i) => ({
        id: c.id ?? `call_${turn + 1}_${i + 1}`,
        name: c.name,
        input: c.input,
      }))
      return {
        text,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
        usage: usageOf(hash, req.messages, req.tools, text),
      }
    },
  }
}
