import type { ChatMessage, CompletionUsage, ModelRef, ToolDef } from '@agentsws/contracts'
import type { PriceEntry, PriceTable } from './types.js'
import { GatewayError } from './types.js'

export const DEFAULT_CHARS_PER_TOKEN = 4
export const DEFAULT_EXPECTED_OUTPUT_TOKENS = 512

export function priceKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`
}

/** 价格表按每 100 万 token 计价；缺条目在调用前就拒（不做"先花钱再说"）。 */
export function priceFor(prices: PriceTable, ref: ModelRef): PriceEntry {
  const entry = prices[priceKey(ref)]
  if (entry === undefined) {
    throw new GatewayError('invalid_input', 'no price table entry for model', {
      model: priceKey(ref),
    })
  }
  return entry
}

/** input_tokens 含 cached_tokens；未命中缓存的部分按 in 计价，命中部分按 cached 计价。 */
export function costOf(
  price: PriceEntry,
  usage: Pick<CompletionUsage, 'input_tokens' | 'output_tokens' | 'cached_tokens'>,
): number {
  const cached = Math.min(usage.cached_tokens, usage.input_tokens)
  const fresh = Math.max(usage.input_tokens - cached, 0)
  return (fresh * price.in + cached * price.cached + usage.output_tokens * price.out) / 1_000_000
}

export function estimateInputTokens(
  messages: ChatMessage[],
  tools: ToolDef[] | undefined,
  charsPerToken: number,
): number {
  let chars = 0
  for (const m of messages) chars += m.role.length + m.content.length + (m.name?.length ?? 0)
  for (const t of tools ?? []) {
    chars += t.name.length + t.description.length + JSON.stringify(t.input_schema ?? null).length
  }
  return Math.ceil(chars / charsPerToken)
}

/** 并发预留用的估算成本：估算输入 token × in 价 + 预计输出 token × out 价。 */
export function estimateCost(
  price: PriceEntry,
  inputTokens: number,
  expectedOutputTokens: number,
): number {
  return (inputTokens * price.in + expectedOutputTokens * price.out) / 1_000_000
}
