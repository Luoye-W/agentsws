/**
 * WP420（自查 ads-amazon A4）：止损**数据到了就判**，不靠 AI 记得调。
 *
 * 以前：判据用「今天到导出时」的花费；导出一天一次、9 点以后；止损只在 10 点日报的提示词里让 AI 调
 * `stage_ads_stop_loss`——早上 10 点今天才花了一两个小时，「花费占日预算 ≥ 30%」几乎不会成立，
 * 而且整件事取决于 AI 记不记得。现在：
 *
 * 1. **判据按昨天整天**（有昨天那一行就用它；今天的数单独再判一次，任一成立就算）；
 * 2. **数一入库就判一遍**（服务端自己算，成立就经广告库那一面 `pauseCampaign` 出止损卡，
 *    走同一个 guardrail，L3 自动；不经 AI）；
 * 3. 同一条广告系列一天只自动提一次（已经停着、已经排着暂停的不提）。
 */
import { type AdsReportRow, adsRowKey, rollUpAdsRows, stopLossVerdict } from '@agentsws/ads-core'
import type { AdsActor, AdsPort, AdsStagedView } from '@agentsws/api'
import type { AdCampaign, AdsCaps } from '@agentsws/contracts'
import type { AdsStore } from '../ads.js'
import type { AdsDataPlatform, AdsDataRow } from './store.js'

/** 判据那一天的数（给止损卡用）。 */
export interface StopLossBasis {
  day: string
  spend: number
  roas?: number
  /** 卡上那句「今天花了」换成什么（「昨天整天花了」）。 */
  label: string
}

/** 前一天（`2026-10-19` → `2026-10-18`）。 */
export function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
}

const ref = (id: string | undefined, name: string | undefined): string =>
  id !== undefined && id !== '' ? id : `name:${name ?? ''}`

/** 广告库里那条广告系列的编号（与 `ingest.ts` 的 `syncToAdsStore` 同一种拼法）。 */
export const campaignStoreId = (
  platform: string,
  account: string,
  r: Pick<AdsReportRow, 'campaign_id' | 'campaign'>,
): string => `${platform}:${account}:${ref(r.campaign_id, r.campaign)}`

/**
 * 某一天每条广告系列的整天数（Meta 一行一条广告，按广告系列加起来）。
 * 回 `广告库编号 → 那一天的花费 / ROAS`。
 */
export function campaignDayTotals(
  rows: readonly AdsDataRow[],
  day: string,
): Map<string, { spend: number; roas?: number }> {
  const out = new Map<string, { spend: number; roas?: number }>()
  const ofDay = rows.filter((r) => r.day === day)
  for (const account of new Set(ofDay.map((r) => r.account))) {
    const mine = ofDay.filter((r) => r.account === account)
    const platform = mine[0]?.platform ?? 'google'
    const direct = mine.filter((r) => r.level === 'campaign')
    const list = direct.length > 0 ? direct : rollUpAdsRows(mine, 'campaign')
    // 同一天同一条可能来自两份导出：留最后一份
    const by = new Map<string, AdsReportRow>()
    for (const r of list) by.set(adsRowKey(r), r)
    for (const r of by.values()) {
      const spend = r.metrics.cost
      if (spend === undefined) continue
      const roas =
        r.metrics.roas ??
        (r.metrics.conversion_value !== undefined && spend > 0
          ? Math.round((r.metrics.conversion_value / spend) * 100) / 100
          : undefined)
      out.set(campaignStoreId(platform, account, r), {
        spend: Math.round(spend * 100) / 100,
        ...(roas === undefined ? {} : { roas }),
      })
    }
  }
  return out
}

/** 一条广告系列昨天整天的判据底数（没有昨天那一行回 undefined）。 */
export function yesterdayBasis(
  rows: readonly AdsDataRow[],
  today: string,
  campaign_id: string,
): StopLossBasis | undefined {
  const day = dayBefore(today)
  const hit = campaignDayTotals(rows, day).get(campaign_id)
  if (hit === undefined) return undefined
  return {
    day,
    spend: hit.spend,
    ...(hit.roas === undefined ? {} : { roas: hit.roas }),
    label: '昨天整天',
  }
}

export interface AutoStopLossInput {
  platform: AdsDataPlatform
  ads: AdsStore
  rows: readonly AdsDataRow[]
  today: string
  caps: Partial<AdsCaps>
  port: AdsPort | undefined
  /** 担着这家投放的那个人（出卡用他的分配）。没人担 → 不判。 */
  actor: AdsActor | undefined
  /** 这条今天自动提过没有（提过的不再提）。 */
  done(campaign_id: string): boolean
  markDone(campaign_id: string): void
}

/** 一条广告系列按「昨天整天」与「今天到现在」两份数各判一次，任一成立就算。 */
export function judgeCampaign(
  c: AdCampaign,
  basis: StopLossBasis | undefined,
  caps: Partial<AdsCaps>,
): { trigger: boolean; by?: 'yesterday' | 'today' } {
  const budget = c.daily_budget
  const today = stopLossVerdict({
    ...(c.metrics?.roas === undefined ? {} : { roas: c.metrics.roas }),
    ...(c.metrics?.spend === undefined ? {} : { spend: c.metrics.spend }),
    ...(budget === undefined ? {} : { daily_budget: budget }),
    caps,
  })
  if (today.outcome === 'trigger') return { trigger: true, by: 'today' }
  if (basis === undefined) return { trigger: false }
  const y = stopLossVerdict({
    ...(basis.roas === undefined ? {} : { roas: basis.roas }),
    spend: basis.spend,
    ...(budget === undefined ? {} : { daily_budget: budget }),
    caps,
  })
  return y.outcome === 'trigger' ? { trigger: true, by: 'yesterday' } : { trigger: false }
}

/**
 * 数一入库就判一遍：这家正在跑的广告系列里判据成立的，经广告库那一面提止损卡（L3 自动，guardrail 再核一次）。
 * 回提了哪几条。
 */
export async function autoStopLoss(input: AutoStopLossInput): Promise<AdsStagedView[]> {
  if (input.port === undefined || input.actor === undefined) return []
  const out: AdsStagedView[] = []
  const active = input.ads
    .campaigns({ platform: input.platform })
    .filter((c) => c.status === 'active')
  for (const c of active) {
    if (input.done(c.id)) continue
    const basis = yesterdayBasis(input.rows, input.today, c.id)
    if (!judgeCampaign(c, basis, input.caps).trigger) continue
    input.markDone(c.id)
    const port = input.port
    const actor = input.actor
    const staged = await Promise.resolve()
      .then(() =>
        port.pauseCampaign(actor, c.id, {
          reason: 'stop_loss',
          note: '数据一到工坊自己判的（不经 AI）。',
        }),
      )
      .catch(() => undefined)
    if (staged !== undefined) out.push(staged)
  }
  return out
}
