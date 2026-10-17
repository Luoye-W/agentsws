/**
 * WP362（Luoye 10-16）：输入框 AI 钮里每一行右边那一格——**消耗速率**与**厂商**。
 * WP364（决策 958 / 959 / 972，Luoye 10-17）：两个数都**按 token 算**。
 *
 * - **消耗速率**：这个模型的 token 构成下，我们实收的价 ÷ **我们卖 DeepSeek v4 Pro 的价**（决策 972：v4 Pro 自己 = 1.0x）；
 * - **折扣**：我们的售价 ÷ 这家官方标价（同一构成），`< 1` 才显示（「8 折」）。
 *
 * 云端价目里这一行带了 `consumption_rate`（私有云按近 30 天真实 token 构成算的，`discount` 也一并给）→ 照它；
 * 没带 → 本机兜底，**同一个口径**：构成用典型构成（`TYPICAL_TOKEN_MIX`，输入 3 : 输出 1）；倍率的分母是价目里
 * DeepSeek v4 Pro 那一行（没有它、或它限免 → 退回当前默认模型 = 1x，再没有就不显示）；折扣的官方价取本机内置价目
 * （`@agentsws/model-gateway` 的 catalog），积分价按价目里的 `credit_cny` / `fx` 折成同一币种。
 *
 * 价目里同一个模型可能出现好几行（不同上游）：取第一条价不为 0 的那一行，都为 0 就是限免。
 */
import {
  type PricingModelEntry,
  pricingDiscountOf,
  type TokenUnitPrice,
  TYPICAL_TOKEN_MIX,
  tokenMixRatio,
} from '@agentsws/contracts'
import { findModel, PRICE_CATALOG, type PriceCatalog } from '@agentsws/model-gateway'

/** 1x 的那个模型（Luoye 10-16 定；决策 972：分母是我们卖它的价）。 */
export const RATE_BASE_MODEL = 'deepseek-v4-pro'

/** 组标题问号里那一句白话。 */
export const RATE_NOTE =
  '消耗速率按 token 算：这个模型常见的用法下，花的积分是 DeepSeek v4 Pro 的几倍（v4 Pro = 1x）；实际消耗以用量记录为准。'

export type ModelPrice =
  | { kind: 'rate'; rate: number; source: 'stats' | 'list_price'; discount?: number }
  | { kind: 'free' }
  | { kind: 'subscription' }
  | { kind: 'own_key' }

export interface CloudRates {
  /** 价目里每个模型（去重后、按价目原顺序）。 */
  models: string[]
  /** 模型 → 右边那一格。 */
  price(model: string): ModelPrice | undefined
  /** 1x 是谁；`fallback` = 价目里没有 DeepSeek v4 Pro（或它限免），退回了默认模型。 */
  base: { model: string; fallback: boolean } | undefined
}

/** WP364：本机兜底要的那几样（都来自云端价目本身 + 本机内置官方价目）。 */
export interface RateContext {
  /** 1 积分值多少人民币（价目的 `credit_cny`）。 */
  credit_cny: number
  /** 参考汇率（价目的 `fx`，`USD: 7.1` = 1 美元折 7.1 元）。 */
  fx: Record<string, number>
  /** 官方标价表（默认本机内置那份；只用来算折扣）。 */
  catalog?: PriceCatalog
}

const blended = (e: Pick<PricingModelEntry, 'in' | 'out'>): number => (e.in * 3 + e.out) / 4

/** 价目里的模型（去重：取第一条价不为 0 的那一行）。 */
export function dedupeCloudModels(entries: readonly PricingModelEntry[]): PricingModelEntry[] {
  const out = new Map<string, PricingModelEntry>()
  for (const e of entries) {
    const seen = out.get(e.model)
    if (seen === undefined || (blended(seen) === 0 && blended(e) > 0)) out.set(e.model, e)
  }
  return [...out.values()]
}

/**
 * WP364：本机内置价目里这个模型的**官方标价**（每百万 token，折成人民币）。只看按量那几家（订阅档三格是 0，
 * 不是官方价）；同名取排在前面那家（与私有云价目认的是同一行）。认不出回 `undefined`。
 */
export function officialPriceCny(model: string, ctx: RateContext): TokenUnitPrice | undefined {
  for (const vendor of (ctx.catalog ?? PRICE_CATALOG).vendors) {
    if (vendor.billing === 'quota') continue
    const m = findModel(vendor, model)
    if (m === undefined) continue
    const fx = ctx.fx[vendor.currency.toUpperCase()] ?? 1
    return { in: m.in * fx, out: m.out * fx, cached: m.cached * fx }
  }
  return undefined
}

/** 价目里这一行（积分 / 1k token）→ 每百万 token 多少人民币。 */
const ourPriceCny = (e: PricingModelEntry, creditCny: number): TokenUnitPrice => ({
  in: e.in * 1000 * creditCny,
  out: e.out * 1000 * creditCny,
  cached: (e.cached ?? e.in) * 1000 * creditCny,
})

/** 折扣保留两位（0.8 → 8 折、0.85 → 8.5 折）；`≥ 1` 或算不出就没有。 */
const discountFrom = (ratio: number | undefined): number | undefined =>
  ratio === undefined ? undefined : pricingDiscountOf({ discount: Math.round(ratio * 100) / 100 })

/** 云端价目 → 每个模型的消耗速率。`defaultModel` = 当前默认模型（基准退路）。 */
export function cloudRates(
  entries: readonly PricingModelEntry[],
  defaultModel: string | undefined,
  ctx?: RateContext,
): CloudRates {
  const list = dedupeCloudModels(entries)
  const byModel = new Map(list.map((e) => [e.model, e]))
  const pick = (model: string | undefined): PricingModelEntry | undefined => {
    const hit = model === undefined ? undefined : byModel.get(model)
    return hit !== undefined && blended(hit) > 0 ? hit : undefined
  }
  // 决策 972：分母 = 我们卖 v4 Pro 的价（价目里那一行）；没有就退回默认模型
  const listed = pick(RATE_BASE_MODEL)
  const baseEntry = listed ?? pick(defaultModel)
  const base =
    baseEntry === undefined ? undefined : { model: baseEntry.model, fallback: listed === undefined }
  return {
    models: list.map((e) => e.model),
    base,
    price(model) {
      const e = byModel.get(model)
      if (e === undefined) return undefined
      if (e.consumption_rate !== undefined && Number.isFinite(e.consumption_rate)) {
        // 云上算好的：倍率与折扣都照它（云上没给折扣 = 不到「折」，本机不另算）
        const discount = pricingDiscountOf(e)
        return e.consumption_rate <= 0
          ? { kind: 'free' }
          : {
              kind: 'rate',
              rate: e.consumption_rate,
              source: e.rate_source ?? 'stats',
              ...(discount === undefined ? {} : { discount }),
            }
      }
      if (blended(e) === 0) return { kind: 'free' }
      if (baseEntry === undefined) return undefined
      const rate = tokenMixRatio(e, baseEntry, TYPICAL_TOKEN_MIX)
      if (rate === undefined) return undefined
      const own = ctx === undefined ? undefined : officialPriceCny(model, ctx)
      const discount =
        own === undefined || ctx === undefined
          ? undefined
          : discountFrom(tokenMixRatio(ourPriceCny(e, ctx.credit_cny), own, TYPICAL_TOKEN_MIX))
      return {
        kind: 'rate',
        rate,
        source: 'list_price',
        ...(discount === undefined ? {} : { discount }),
      }
    },
  }
}

/** 「1.0x」「2.3x」「0.05x」「12x」。 */
export function formatRate(rate: number): string {
  if (rate >= 10) return `${Math.round(rate)}x`
  if (rate >= 0.1) return `${(Math.round(rate * 10) / 10).toFixed(1)}x`
  return `${Math.max(0.01, Math.round(rate * 100) / 100)}x`
}

/**
 * 模型名 → 厂商（图标用）。只认我们用得到的那几家；认不出回 `undefined`（界面落到来源的图标）。
 */
export function vendorOfModel(model: string): string | undefined {
  const m = model.toLowerCase()
  if (m.startsWith('deepseek')) return 'deepseek'
  if (/^(gpt|o\d|chatgpt|codex)/.test(m)) return 'openai'
  if (m.startsWith('claude')) return 'anthropic'
  if (m.startsWith('gemini') || m.startsWith('gemma')) return 'google'
  if (m.startsWith('qwen') || m.startsWith('qwq')) return 'qwen'
  if (m.startsWith('glm') || m.startsWith('chatglm')) return 'zhipu'
  if (m.startsWith('kimi') || m.startsWith('moonshot')) return 'moonshot'
  if (m.startsWith('minimax') || m.startsWith('abab')) return 'minimax'
  if (m.startsWith('doubao')) return 'doubao'
  if (m.startsWith('llama')) return 'meta'
  if (m.startsWith('mistral') || m.startsWith('codestral')) return 'mistral'
  return undefined
}
