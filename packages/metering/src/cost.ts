/**
 * 我方成本（65 §3）。
 *
 * 与 `pricing.ts` 的关系：那一份回答"这一次向用户收多少积分"，这一份回答"这一次
 * 我们自己付出去多少钱"。**两张表、两个文件、两套数字**，刻意不合并——合并之后
 * 改售价会顺手改掉历史成本，于是毛利永远是我们想要的样子。
 *
 * 三条纪律：
 *
 * 1. **整数微单位**（1 元 = 1_000_000 微元）。KefuAgent 曾经把成本四舍五入到分，
 *    于是 200 token 的便宜模型成本恒为 0，看板上毛利率一年都是 100%。
 * 2. **认不出的模型落最贵档**，而且那一档是**从表里算出来的**，不是写死的常数：
 *    往表里加一个更贵的模型，兜底档自动跟着涨。估贵了只让毛利显得保守，
 *    估便宜了会让一条真亏本的调用在看板上显示赚钱。
 * 3. **纯函数，无 IO、无时钟**。表是数据（`cost-table.json`），算是代码。
 */

import { COST_MICRO_UNIT } from '@agentsws/contracts'
import table from './cost-table.json' with { type: 'json' }

/** 一档按 token 计的成本。价是"每百万 token 多少钱"，币种各家自己的。 */
export interface TokenCostEntry {
  provider: string
  /** 模型名前缀。**最长前缀优先**。 */
  prefix: string
  currency: string
  in_per_m: number
  out_per_m: number
  /** WP131：按公开价补、还没核对的那几条（整表另有 `needs_review`）。 */
  unverified?: boolean
  note?: string
}

/** 一档按次计的成本（非 token 的上游：YouTube、Apify…）。 */
export interface UnitCostEntry {
  /** `provider:unit`，比如 `apify:call`。 */
  key: string
  provider: string
  currency: string
  per_unit: number
  note?: string
  /** WP131：按公开价补、还没核对。 */
  unverified?: boolean
}

export interface CostTable {
  version: number
  as_of: string
  /** **null = 还没有人核对过这张表**。后台据此在页脚挂一句话。 */
  last_verified_at: string | null
  needs_review: boolean
  base_currency: string
  fx: Record<string, number>
  token_models: TokenCostEntry[]
  unit_prices: UnitCostEntry[]
}

/** 打包进来的那一份。想换一张（测试、别的部署）就把它当参数传进下面那几个函数。 */
export const COST_TABLE = table as unknown as CostTable

/** 这张表核对过没有。后台页脚与 `/v1/admin/overview` 都读它。 */
export function costTableNeedsReview(t: CostTable = COST_TABLE): boolean {
  return t.needs_review || t.last_verified_at === null
}

/** 各家币种 → 人民币。表里没有这个币种就当 1（并且**不猜**——上层会把它当可疑值报出来）。 */
export function toCny(amount: number, currency: string, t: CostTable = COST_TABLE): number {
  const rate = t.fx[currency.toUpperCase()]
  return amount * (rate ?? 1)
}

/** 人民币 → 整数微元。**向上取整**：成本宁可高估一微元，也不要因为截断显得便宜。 */
export const cnyToMicros = (cny: number): number => Math.ceil(cny * COST_MICRO_UNIT)

/**
 * 按模型名挑一档。**最长前缀优先**——`gpt-5-nano` 必须先命中 `gpt-5-nano`
 * 而不是 `gpt-5`，否则 nano 的成本会被按 gpt-5 记，贵 25 倍。
 */
export function matchTokenCost(
  model: string,
  t: CostTable = COST_TABLE,
): TokenCostEntry | undefined {
  const name = model.trim().toLowerCase()
  let best: TokenCostEntry | undefined
  for (const entry of t.token_models) {
    const prefix = entry.prefix.toLowerCase()
    if (!name.startsWith(prefix)) continue
    if (best === undefined || prefix.length > best.prefix.length) best = entry
  }
  return best
}

/**
 * 表里最贵的那一档（折成人民币之后比）。认不出的模型用它。
 *
 * 用"折算后"比而不是"标价"比：20 CNY/M 与 4 USD/M 直接比大小是错的。
 */
export function mostExpensiveTokenCost(t: CostTable = COST_TABLE): TokenCostEntry | undefined {
  let best: TokenCostEntry | undefined
  let bestCny = -1
  for (const entry of t.token_models) {
    // 用 in + out 之和当"贵"的度量：只看 out 会把输入极贵的模型算便宜
    const cny = toCny(entry.in_per_m + entry.out_per_m, entry.currency, t)
    if (cny > bestCny) {
      bestCny = cny
      best = entry
    }
  }
  return best
}

/** 算出来的一次成本。`fallback = true` 意味着"这个模型我们不认识，按最贵的算了"。 */
export interface CostEstimate {
  /** 整数微元。 */
  micros: number
  /** 折算前的币种（给人看"原始标价是哪一家的哪种钱"）。 */
  currency: string
  provider: string
  fallback: boolean
}

/**
 * 按 token 算一次调用的成本。
 *
 * `input_tokens` / `output_tokens` 必须**分开传**：只存合计就再也算不出输入输出的
 * 成本比，而输出通常贵四到五倍（KOLAgents 的坑，照它踩过的地方绕）。
 */
export function tokenCostMicros(
  model: string,
  usage: { input_tokens: number; output_tokens: number },
  t: CostTable = COST_TABLE,
): CostEstimate {
  const matched = matchTokenCost(model, t)
  const entry = matched ?? mostExpensiveTokenCost(t)
  if (entry === undefined)
    // 表是空的：报 0 而不是抛。成本算不出来不该让一次正常的调用失败
    return { micros: 0, currency: t.base_currency, provider: 'unknown', fallback: true }
  const raw =
    (Math.max(0, usage.input_tokens) / 1_000_000) * entry.in_per_m +
    (Math.max(0, usage.output_tokens) / 1_000_000) * entry.out_per_m
  return {
    micros: cnyToMicros(toCny(raw, entry.currency, t)),
    currency: entry.currency,
    provider: entry.provider,
    fallback: matched === undefined,
  }
}

/**
 * 按次算（非 token 的上游）。键是 `provider:unit`——同一家不同动作可以不同价。
 *
 * 认不出的键**回 0 且 `fallback: true`**，不落最贵档：非 token 的上游各家量纲
 * 差着几个数量级（一次 YouTube 调用与一次 Apify 抓取不是一回事），拿其中最贵的
 * 去兜底只会造出一个看起来很吓人的假成本。认不出就是认不出，看板上显示为
 * "成本未知"，让人去补表。
 */
export function unitCostMicros(
  key: string,
  quantity: number,
  t: CostTable = COST_TABLE,
): CostEstimate {
  const entry = t.unit_prices.find((e) => e.key.toLowerCase() === key.trim().toLowerCase())
  if (entry === undefined)
    return {
      micros: 0,
      currency: t.base_currency,
      provider: key.split(':')[0] ?? 'unknown',
      fallback: true,
    }
  return {
    micros: cnyToMicros(toCny(entry.per_unit * Math.max(0, quantity), entry.currency, t)),
    currency: entry.currency,
    provider: entry.provider,
    fallback: false,
  }
}

/**
 * 从模型名猜供应商（New API 转出来的名字里通常带家族名）。
 *
 * 只在成本表里认不出这个模型、又必须给 `provider` 一个值的时候用。猜不出回
 * `unknown`——**不回模型名本身**：那会让"按供应商"那张表变成第二张"按模型"。
 */
export function providerOfModel(model: string, t: CostTable = COST_TABLE): string {
  const matched = matchTokenCost(model, t)
  if (matched !== undefined) return matched.provider
  const name = model.trim().toLowerCase()
  const slash = name.indexOf('/')
  // `deepseek/deepseek-flash` 这种 OpenRouter 风格的名字，斜杠前那一段就是供应商
  if (slash > 0) return name.slice(0, slash)
  return 'unknown'
}
