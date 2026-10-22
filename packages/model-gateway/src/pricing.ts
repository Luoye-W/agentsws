import type { ChatMessage, CompletionUsage, ModelRef, ToolDef } from '@agentsws/contracts'
import { chatContentText } from '@agentsws/contracts'
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

/**
 * WP473：写进缓存的那部分按输入价的几倍收（Anthropic 官方：5 分钟缓存写入 = 1.25 倍）。
 * 只有报得出「写了多少」的 provider（Anthropic 兼容口）才给 `cache_write_tokens`，别家不受影响。
 */
export const CACHE_WRITE_MULTIPLIER = 1.25

/**
 * input_tokens 含 cached_tokens（命中）与 cache_write_tokens（写缓存）；
 * 命中部分按 cached 计价，写缓存部分按 in × {@link CACHE_WRITE_MULTIPLIER}，其余按 in。
 */
export function costOf(
  price: PriceEntry,
  usage: Pick<CompletionUsage, 'input_tokens' | 'output_tokens' | 'cached_tokens'> &
    Partial<Pick<CompletionUsage, 'cache_write_tokens'>>,
): number {
  const cached = Math.min(Math.max(usage.cached_tokens, 0), usage.input_tokens)
  const written = Math.min(
    Math.max(usage.cache_write_tokens ?? 0, 0),
    Math.max(usage.input_tokens - cached, 0),
  )
  const fresh = Math.max(usage.input_tokens - cached - written, 0)
  return (
    (fresh * price.in +
      written * price.in * CACHE_WRITE_MULTIPLIER +
      cached * price.cached +
      usage.output_tokens * price.out) /
    1_000_000
  )
}

export function estimateInputTokens(
  messages: ChatMessage[],
  tools: ToolDef[] | undefined,
  charsPerToken: number,
): number {
  let chars = 0
  for (const m of messages)
    chars += m.role.length + chatContentText(m.content).length + (m.name?.length ?? 0)
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
