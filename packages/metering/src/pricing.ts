/**
 * 价目表（49 §3「定价表是数据不是代码」）。
 *
 * 这个文件里**没有一个价钱**——数字全在 `pricing.json` 与
 * `@agentsws/model-gateway` 的 `catalog.json` 里。这里只有三件事：
 *
 * 1. 把两份数据拼成一张对用户可见的价目表（AI 那两条按模型展开）；
 * 2. 换算口径：**成本（各家官网标价，原币）→ 参考汇率折人民币 → × 倍率 → 积分**，
 *    1 积分 = ¥1，所以"人民币"与"积分"在数字上是一回事；
 * 3. 按能力 / 按模型算钱的两个函数。
 *
 * 为什么不换成实时汇率：积分价必须稳定。汇率每天动一点，用户看到的单价就每天动一点，
 * 账对不上也说不清。`fx` 是一张带 `as_of` 的快照，改它要出一个版本。
 */
import type { Pricing, PricingEntry, PricingModelEntry } from '@agentsws/contracts'
import type { PriceCatalog } from '@agentsws/model-gateway'
import { PRICE_CATALOG } from '@agentsws/model-gateway'
import RAW from './pricing.json' with { type: 'json' }

/** `pricing.json` 的形状：契约那份 + 只有算价时才用得上的几项。 */
export interface PricingFile extends Omit<Pricing, 'entries'> {
  note: string
  fx_note: string
  /** 67 §1 三块分组的口径说明（数据层的注释，不进界面）。 */
  blocks_note?: string
  /** 数据驻留 `cn` 的请求只允许这几家（22 §2）。 */
  cn_vendors: string[]
  cn_vendors_note: string
  entries: (PricingEntry & { fallback_note?: string; note_zh?: string })[]
}

export const PRICING_FILE: PricingFile = RAW as PricingFile

/** 按 token 计价的能力（这两条的 `models` 是拼出来的，不是手写的）。 */
export const TOKEN_CAPABILITIES = ['ai.chat', 'ai.embeddings'] as const

/** 估算输出 token 数：请求没给 `max_tokens` 时按它预扣（结算按真实 usage）。 */
export const DEFAULT_ESTIMATED_OUTPUT_TOKENS = 1000

/** 积分保留四位小数（1 积分 = ¥1，四位就是"厘"以下，够记账也不会因浮点抖动）。 */
export const roundCredits = (n: number): number => Math.round(n * 10_000) / 10_000

/** 向上取整到四位小数：预扣宁可多留一点，结算时差额会退回去。 */
export const ceilCredits = (n: number): number => Math.ceil(n * 10_000) / 10_000

/**
 * 每百万 token 的官网标价（原币）→ 每千 token 的积分价。
 *
 * `price_per_million × fx × multiplier ÷ 1000`。认不出币种就按 1 折（等于当人民币），
 * 而不是悄悄按美元算——猜错汇率比不换算更危险。
 */
export function creditsPerThousandTokens(
  price_per_million: number,
  currency: string,
  fx: Record<string, number>,
  multiplier: number,
): number {
  const rate = fx[currency.toUpperCase()] ?? 1
  return roundCredits((price_per_million * rate * multiplier) / 1000)
}

/**
 * 拼出完整价目表：`ai.chat` 那条按模型展开，其余条目原样。
 *
 * 展开出来的每条带 `cn`——数据驻留 `cn` 的请求只认这些（22 §2）。
 */
export function buildPricing(catalog: PriceCatalog = PRICE_CATALOG): Pricing {
  const file = PRICING_FILE
  const cn = new Set(file.cn_vendors)
  const models: PricingModelEntry[] = []
  for (const vendor of catalog.vendors) {
    for (const m of vendor.models) {
      const entry: PricingModelEntry = {
        model: m.model,
        in: creditsPerThousandTokens(m.in, vendor.currency, file.fx, file.ai_multiplier),
        out: creditsPerThousandTokens(m.out, vendor.currency, file.fx, file.ai_multiplier),
        cached: creditsPerThousandTokens(m.cached, vendor.currency, file.fx, file.ai_multiplier),
        ...(cn.has(vendor.id) ? { cn: true } : { cn: false }),
      }
      models.push(entry)
    }
  }
  models.sort((a, b) => a.model.localeCompare(b.model))
  return {
    version: file.version,
    as_of: file.as_of,
    credit_cny: file.credit_cny,
    ai_multiplier: file.ai_multiplier,
    fx: { ...file.fx },
    entries: file.entries.map((e) => {
      const base: PricingEntry = {
        capability: e.capability,
        unit: e.unit,
        credits_per_unit: e.credits_per_unit,
        label_zh: e.label_zh,
        label_en: e.label_en,
        // 67 §1：三块分组。表里没写的那些由 `pricingBlockOf` 按能力名前缀兜底
        ...(e.block === undefined ? {} : { block: e.block }),
      }
      return e.capability === 'ai.chat' ? { ...base, models } : base
    }),
  }
}

/** 这张表里有没有这项能力。 */
export function entryFor(pricing: Pricing, capability: string): PricingEntry | undefined {
  return pricing.entries.find((e) => e.capability === capability)
}

/** 按次 / 按页 / 按分钟那几条：数量 × 单价。认不出的能力回 `undefined`（调用方拒，不猜价）。 */
export function creditsFor(
  pricing: Pricing,
  capability: string,
  quantity: number,
): number | undefined {
  const entry = entryFor(pricing, capability)
  if (entry === undefined) return undefined
  return roundCredits(entry.credits_per_unit * quantity)
}

/** 价目表里这个模型那一条（按模型名精确找；找不到回 `undefined`）。 */
export function modelPrice(pricing: Pricing, model: string): PricingModelEntry | undefined {
  return entryFor(pricing, 'ai.chat')?.models?.find((m) => m.model === model)
}

/** 这个模型在境内可不可用（数据驻留 `cn`）。价目表里没有的一律不可用。 */
export function isCnAvailable(pricing: Pricing, model: string): boolean {
  return modelPrice(pricing, model)?.cn === true
}

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cached_tokens?: number
}

/**
 * 一次 AI 调用多少积分。
 *
 * 模型不在价目表里就退回 `ai.chat` 那条的 `credits_per_unit`（按总 token 算）——
 * 兜底价是一个数字，不是"免费"：认不出的模型照样要收，只是收得粗一点。
 */
export function aiCredits(pricing: Pricing, model: string, usage: TokenUsage): number {
  const price = modelPrice(pricing, model)
  if (price === undefined) {
    const fallback = entryFor(pricing, 'ai.chat')?.credits_per_unit ?? 0
    const total = usage.input_tokens + usage.output_tokens
    return roundCredits((fallback * total) / 1000)
  }
  const cachedTokens = usage.cached_tokens ?? 0
  const freshInput = Math.max(0, usage.input_tokens - cachedTokens)
  const cachedPrice = price.cached ?? price.in
  return roundCredits(
    (freshInput * price.in + cachedTokens * cachedPrice + usage.output_tokens * price.out) / 1000,
  )
}

/**
 * 调用前的预扣估算：输入按实际字符估的 token 数，输出按 `max_tokens`，
 * 没给就按 {@link DEFAULT_ESTIMATED_OUTPUT_TOKENS}。
 *
 * **向上取整**：预扣宁可多留一点——结算按真实 `usage`，差额当场释放。
 */
export function estimateAiCredits(
  pricing: Pricing,
  model: string,
  args: { input_tokens: number; max_tokens?: number | undefined },
): number {
  return ceilCredits(
    aiCredits(pricing, model, {
      input_tokens: args.input_tokens,
      output_tokens: args.max_tokens ?? DEFAULT_ESTIMATED_OUTPUT_TOKENS,
    }),
  )
}

/** 约 4 个字符一个 token（与 `model-gateway` 的估算口径一致）。 */
export const DEFAULT_CHARS_PER_TOKEN = 4

/** 粗估一段文字有多少 token（预扣用；结算永远按真实 `usage`）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / DEFAULT_CHARS_PER_TOKEN)
}
