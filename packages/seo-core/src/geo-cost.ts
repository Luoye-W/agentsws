/**
 * WP321（决策 460 / 469，docs/99 §6）：一轮 / 每月大概花多少——按 AI 分开、Claude 单列。
 *
 * 官方那条路按单价（云上给的；没给用兜底价并标「估」）；自带 key 不扣积分（0）；没接不写数。
 * Claude 一格 3.6 积分左右，是另几家的十几倍：单格 ≥ 1 积分时「现在跑一轮」先**一轮合并确认一次**
 * （docs/75，不逐格弹），定时那几轮在定策略时（设定卡上写清每月多少）就算确认过了。
 */
import type { AiPlatform, BrandWatchFrequency, GeoRunEstimate } from '@agentsws/contracts'
import {
  GEO_CONFIRM_UNIT_CREDITS,
  GEO_ESTIMATE_FALLBACK_PRICES,
  GEO_RUNS_PER_MONTH,
} from '@agentsws/contracts'

/** 单价（积分 / 格）。缺的用兜底价（并标 `estimated`）。 */
export interface GeoUnitPrices {
  ai_answer?: number | undefined
  claude?: number | undefined
  rank_check?: number | undefined
}

const tenth = (v: number): number => Math.round(v * 10) / 10

export function geoRunEstimate(input: {
  route: 'official' | 'byo' | 'none'
  prompts: number
  markets: number
  platforms: readonly AiPlatform[]
  /** 关注词 × 设备（`both` = 2）。 */
  keywords: number
  devices: number
  prices: GeoUnitPrices
  frequency: BrandWatchFrequency
}): GeoRunEstimate {
  const cells = input.prompts * input.markets
  const rankCells = input.keywords * input.markets * input.devices
  const priced = input.route !== 'none'
  let estimated = false
  const unit = (kind: keyof GeoUnitPrices): number | undefined => {
    if (input.route === 'byo') return 0
    if (input.route === 'none') return undefined
    const p = input.prices[kind]
    if (p !== undefined) return p
    estimated = true
    return GEO_ESTIMATE_FALLBACK_PRICES[kind]
  }
  const platforms = input.platforms.map((platform) => {
    const u = unit(platform === 'claude' ? 'claude' : 'ai_answer')
    return {
      platform,
      cells,
      ...(u === undefined ? {} : { unit_credits: u, credits: tenth(u * cells) }),
    }
  })
  const ru = rankCells > 0 ? unit('rank_check') : undefined
  const rank =
    rankCells === 0
      ? undefined
      : {
          cells: rankCells,
          ...(ru === undefined ? {} : { unit_credits: ru, credits: tenth(ru * rankCells) }),
        }
  const credits = priced
    ? tenth(platforms.reduce((a, p) => a + (p.credits ?? 0), 0) + (rank?.credits ?? 0))
    : undefined
  const perMonth = GEO_RUNS_PER_MONTH[input.frequency]
  const claude = platforms.find((p) => p.platform === 'claude')
  const needs_confirm =
    input.route === 'official' &&
    platforms.some((p) => p.cells > 0 && (p.unit_credits ?? 0) >= GEO_CONFIRM_UNIT_CREDITS)
  return {
    route: input.route,
    prompts: input.prompts,
    markets: input.markets,
    platforms,
    ...(rank === undefined ? {} : { rank }),
    ...(credits === undefined ? {} : { credits, credits_per_month: tenth(credits * perMonth) }),
    ...(claude?.credits === undefined
      ? {}
      : { claude_credits_per_month: tenth(claude.credits * perMonth) }),
    ...(estimated ? { estimated_prices: true } : {}),
    needs_confirm,
  }
}

/** 估算 → 一句人话（卡上 / 报告里用；不写取数方式）。 */
export function estimateLine(e: GeoRunEstimate): string {
  if (e.route === 'none' || e.credits === undefined) return ''
  if (e.route === 'byo') return '用你自己的 key，不扣积分。'
  const claude = e.platforms.find((p) => p.platform === 'claude')
  const est = e.estimated_prices === true ? '约' : ''
  return [
    `这一轮${est} ${e.credits} 积分`,
    e.credits_per_month === undefined || e.credits_per_month === 0
      ? ''
      : `，每月${est} ${e.credits_per_month} 积分`,
    claude?.credits === undefined || e.claude_credits_per_month === undefined
      ? ''
      : `（其中 Claude 每月${est} ${e.claude_credits_per_month}）`,
    '。',
  ].join('')
}
