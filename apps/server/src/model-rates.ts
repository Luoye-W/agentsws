/**
 * WP362（Luoye 10-16）：输入框 AI 钮里每一行右边那一格——**消耗速率**与**厂商**。
 *
 * Luoye 原话：「消耗速率以官方原价的 DeepSeek v4 Pro = 1x 为参考；经过后台的长期统计计算出其他模型的消耗速率，
 * 更贴近真实使用体验，实际消耗以真实日志显示为准。」
 *
 * - 云端价目里这个模型带了 `consumption_rate`（私有云按用量账本长期统计的）→ 照它；
 * - 没带 → 按官方原价折算：积分价 = 官方价 × 同一个倍率，所以两个模型积分价之比就是官方价之比。
 *   一个模型的「价」取输入、输出按 3 : 1 加权（干活的一轮里读进去的远比写出来的多）；
 * - 基准（1x）是 DeepSeek v4 Pro；价目里没有它、或者它的价是 0（名字对不上 / 限免）→ 退回当前默认模型 = 1x，
 *   再没有就不显示倍率（不编）。
 *
 * 价目里同一个模型可能出现好几行（不同上游）：取第一条价不为 0 的那一行，都为 0 就是限免。
 */
import type { PricingModelEntry } from '@agentsws/contracts'

/** 1x 的那个模型（Luoye 10-16 定）。 */
export const RATE_BASE_MODEL = 'deepseek-v4-pro'

/** 组标题问号里那一句白话。 */
export const RATE_NOTE =
  '消耗速率以 DeepSeek v4 Pro 官方原价为 1x，按后台长期统计换算；实际消耗以用量记录为准。'

export type ModelPrice =
  | { kind: 'rate'; rate: number; source: 'stats' | 'list_price' }
  | { kind: 'free' }
  | { kind: 'subscription' }
  | { kind: 'own_key' }

export interface CloudRates {
  /** 价目里每个模型（去重后、按价目原顺序）。 */
  models: string[]
  /** 模型 → 右边那一格。 */
  price(model: string): ModelPrice | undefined
  /** 1x 是谁；`fallback` = 价目里没有 DeepSeek v4 Pro（或它的价是 0），退回了默认模型。 */
  base: { model: string; fallback: boolean } | undefined
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

/** 云端价目 → 每个模型的消耗速率。`defaultModel` = 当前默认模型（基准退路）。 */
export function cloudRates(
  entries: readonly PricingModelEntry[],
  defaultModel: string | undefined,
): CloudRates {
  const list = dedupeCloudModels(entries)
  const byModel = new Map(list.map((e) => [e.model, e]))
  const pick = (model: string | undefined): PricingModelEntry | undefined => {
    const hit = model === undefined ? undefined : byModel.get(model)
    return hit !== undefined && blended(hit) > 0 ? hit : undefined
  }
  const official = pick(RATE_BASE_MODEL)
  const baseEntry = official ?? pick(defaultModel)
  const base =
    baseEntry === undefined
      ? undefined
      : { model: baseEntry.model, fallback: official === undefined }
  return {
    models: list.map((e) => e.model),
    base,
    price(model) {
      const e = byModel.get(model)
      if (e === undefined) return undefined
      if (e.consumption_rate !== undefined && Number.isFinite(e.consumption_rate))
        return e.consumption_rate <= 0
          ? { kind: 'free' }
          : { kind: 'rate', rate: e.consumption_rate, source: e.rate_source ?? 'stats' }
      if (blended(e) === 0) return { kind: 'free' }
      if (baseEntry === undefined) return undefined
      return { kind: 'rate', rate: blended(e) / blended(baseEntry), source: 'list_price' }
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
