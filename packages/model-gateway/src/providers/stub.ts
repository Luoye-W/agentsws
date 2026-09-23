import type {
  ChatMessage,
  CompletionUsage,
  ModelProvider,
  ModelRef,
  ToolDef,
} from '@agentsws/contracts'
import { canonicalJson, sha256 } from '@agentsws/core'
import { staticPrefixHash } from '../prefix.js'
import { estimateInputTokens } from '../pricing.js'
import { ProviderError } from '../types.js'
import { hasImagePart, VISION_PROBE_WORD, visionProbeBase64 } from '../vision-probe.js'

export interface StubProviderOptions {
  /** 随机全部经 seed；同一 (messages, tools, seed) 必然同一输出。 */
  seed: number
  ref?: ModelRef
  /** 假向量维度（默认 8）。 */
  dim?: number
  /**
   * WP127：这个替身能不能看图（默认能——产品只支持多模态模型）。
   *
   * - 能：认得出验证用的那张测试图（按字节认），回那个约定的词；别的图照常回确定性假话。
   * - 不能：见到带图的消息就像真上游那样回 400（模拟「配了看不了图的模型」）。
   */
  vision?: boolean
}

const VOCAB = [
  'order',
  'refund',
  'ticket',
  'draft',
  'policy',
  'shipment',
  'customer',
  'reply',
  'stub',
  'deterministic',
  'reviewed',
  'pending',
  'window',
  'label',
  'note',
  'ok',
]

const byte = (hash: string, i: number): number => Number.parseInt(hash.slice(i * 2, i * 2 + 2), 16)

/**
 * 26 §模拟替身：规则 stub。按 messages 哈希 + seed 生成可重复文本与假 usage。
 * 重复看到同一静态前缀时报 cached_tokens > 0，用来测 22 §5 用例 2 的缓存纪律。
 */
export function stubProvider(options: StubProviderOptions): ModelProvider {
  const ref: ModelRef = options.ref ?? { provider: 'stub', model: 'stub-v1', region: 'cn' }
  const dim = options.dim ?? 8
  const seenPrefixes = new Set<string>()

  const text = (hash: string): string => {
    const words: string[] = []
    for (let i = 0; i < 8; i += 1) words.push(VOCAB[byte(hash, i) % VOCAB.length] ?? 'stub')
    return words.join(' ')
  }

  const usageOf = (
    hash: string,
    messages: ChatMessage[],
    tools: ToolDef[] | undefined,
  ): CompletionUsage => {
    const input_tokens = estimateInputTokens(messages, tools, 4)
    const prefixHash = staticPrefixHash(messages, tools)
    let cached_tokens = 0
    if (seenPrefixes.has(prefixHash)) {
      let n = 0
      while (n < messages.length && messages[n]?.role === 'system') n += 1
      cached_tokens = Math.min(estimateInputTokens(messages.slice(0, n), tools, 4), input_tokens)
    } else {
      seenPrefixes.add(prefixHash)
    }
    return {
      input_tokens,
      output_tokens: 8 + (byte(hash, 8) % 24),
      cached_tokens,
      cost_base: 0,
    }
  }

  const vision = options.vision ?? true

  return {
    ref,
    capabilities: { vision, image_generation: false },
    async complete(req) {
      if (hasImagePart(req.messages)) {
        if (!vision) {
          throw new ProviderError('HTTP 400 this model does not support image input', {
            status: 400,
          })
        }
        const probe = visionProbeBase64()
        const sawProbe = req.messages.some(
          (m) =>
            Array.isArray(m.content) &&
            m.content.some((part) => part.type === 'image' && part.data === probe),
        )
        if (sawProbe) {
          return {
            text: VISION_PROBE_WORD,
            usage: usageOf(sha256(probe), req.messages, req.tools),
          }
        }
      }
      const hash = sha256(
        canonicalJson({
          messages: req.messages,
          tools: req.tools ?? [],
          seed: req.seed ?? options.seed,
        }),
      )
      return { text: text(hash), usage: usageOf(hash, req.messages, req.tools) }
    },
    async embed(texts) {
      const vectors = texts.map((t) => {
        const hash = sha256(canonicalJson({ text: t, seed: options.seed }))
        return Array.from({ length: dim }, (_, i) => (byte(hash, i % 32) - 127.5) / 127.5)
      })
      const input_tokens = texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0)
      return {
        vectors,
        usage: { input_tokens, output_tokens: 0, cached_tokens: 0, cost_base: 0 },
      }
    },
  }
}
