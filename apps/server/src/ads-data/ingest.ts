/**
 * WP315：一份导出文件 → 按天的表现行（入看数据的库），再把「今天」那几行同步进广告库
 * （`ads.ts` 的账户 / 广告系列 / 广告组 / 广告：面板的数字块、日花费总闸、止损卡读的都是它）。
 *
 * 解析全用 WP314 / 本单 `ads-core` 的纯函数（`decodeExportBytes` → `parseAdsExport` → `adsReportRows`）。
 * 认不出的表照实说、不入库；平台对不上（让导 Google 却来了一份 Meta 的）也不入库。
 */
import {
  type AdsReportRow,
  adsReportRows,
  adsRowKey,
  decodeExportBytes,
  parseAdsExport,
  rollUpAdsRows,
} from '@agentsws/ads-core'
import type { Ad, AdCampaign, AdDeliveryStatus, AdMetrics, AdSet } from '@agentsws/contracts'
import type { AdsStore } from '../ads.js'
import type { AdsDataImport, AdsDataPlatform, AdsDataRow, AdsDataSource } from './store.js'

/** 一份导出最多多大（报表 CSV 远小于它；再大多半是传错了文件）。 */
export const ADS_EXPORT_MAX_BYTES = 20 * 1024 * 1024

/** 某一刻在品牌时区里是哪一天。 */
export function localDayOf(at: string, tzOffsetMinutes: number): string {
  return new Date(Date.parse(at) + tzOffsetMinutes * 60_000).toISOString().slice(0, 10)
}

/** 账户编号归一：去空格、横杠、Meta 的 `act_` 前缀（`123-456-7890` → `1234567890`）。 */
export function accountKey(raw: string): string {
  return raw.trim().replace(/^act_/iu, '').replace(/[\s-]/gu, '')
}

export interface ParseAdsFileInput {
  id: string
  bytes: Uint8Array
  name: string
  /** 应该是哪家的（插件那件活知道）；不给就按表头猜。 */
  platform?: AdsDataPlatform
  /** 应该是哪个账户的（表里有账户编号就用表里的）。 */
  account?: string
  source: AdsDataSource
  at: string
  tzOffsetMinutes: number
  job_id?: string
  message_id?: string
}

export type ParseAdsFileResult =
  | { ok: true; import: AdsDataImport; rows: AdsDataRow[] }
  | { ok: false; message: string }

export function parseAdsFile(input: ParseAdsFileInput): ParseAdsFileResult {
  if (input.bytes.byteLength === 0) return { ok: false, message: '文件是空的。' }
  if (input.bytes.byteLength > ADS_EXPORT_MAX_BYTES)
    return { ok: false, message: '文件太大，不像一份报表导出。' }
  const parsed = parseAdsExport(decodeExportBytes(input.bytes))
  const guessed = parsed.platform === 'unknown' ? undefined : parsed.platform
  if (input.platform !== undefined && guessed !== undefined && guessed !== input.platform)
    return {
      ok: false,
      message: `这份表看着是 ${guessed === 'google' ? 'Google' : 'Meta'} 的，不是要的那一家，没入库。`,
    }
  const platform = input.platform ?? guessed
  if (platform === undefined) return { ok: false, message: '认不出是哪一家的报表，没入库。' }
  const raw = adsReportRows(parsed)
  if (raw.length === 0)
    return { ok: false, message: '认不出这张表的表头（或一行数据都没有），没入库。' }
  const fallbackDay = localDayOf(input.at, input.tzOffsetMinutes)
  const rows: AdsDataRow[] = raw.map((r) => ({
    ...r,
    platform,
    account: accountKey(r.account_id ?? input.account ?? 'default'),
    day: r.day ?? fallbackDay,
    key: adsRowKey(r),
    import_id: input.id,
  }))
  const days = [...new Set(rows.map((r) => r.day))].sort()
  const notes: string[] = []
  if (parsed.skipped.total_rows > 0) notes.push(`跳过 ${parsed.skipped.total_rows} 行合计。`)
  if (raw.some((r) => r.day === undefined)) notes.push(`表里没按天拆，按 ${fallbackDay} 记。`)
  if (raw.some((r) => r.roas_from === 'computed'))
    notes.push('有几行没有平台的 ROAS 列，用同一行的转化价值 ÷ 花费算。')
  const accounts = [...new Set(rows.map((r) => r.account))]
  return {
    ok: true,
    rows,
    import: {
      id: input.id,
      platform,
      account: accounts.length === 1 ? (accounts[0] as string) : (input.account ?? 'default'),
      source: input.source,
      name: input.name,
      level: raw[0]?.level ?? 'campaign',
      rows: rows.length,
      days,
      at: input.at,
      notes,
      ...(input.job_id === undefined ? {} : { job_id: input.job_id }),
      ...(input.message_id === undefined ? {} : { message_id: input.message_id }),
    },
  }
}

const STATUS: Record<AdsReportRow['status'], AdDeliveryStatus | undefined> = {
  enabled: 'active',
  paused: 'paused',
  removed: 'ended',
  unknown: undefined,
}

const metricsOf = (r: AdsReportRow, at: string): AdMetrics => {
  const m: AdMetrics = { observed_at: at }
  if (r.metrics.cost !== undefined) m.spend = r.metrics.cost
  for (const k of ['impressions', 'clicks', 'conversions', 'conversion_value', 'roas'] as const) {
    const v = r.metrics[k]
    if (v !== undefined) m[k] = v
  }
  return m
}

const ref = (id: string | undefined, name: string | undefined): string =>
  id !== undefined && id !== '' ? id : `name:${name ?? ''}`

/**
 * 「今天」那一份同步进广告库：账户（今天花了多少）、广告系列 / 广告组 / 广告（名字、状态、预算、今天的数）。
 *
 * - 表里有的对象都建 / 更新（名字、状态、预算取最新那一天的）；表现数**只写今天的**——
 *   广告库里的 `metrics` 是「今天到导出时」的口径（止损判据、日花费总闸都按今天算），
 *   今天没有数的那几条把旧的清掉，不让昨天的数冒充今天。
 * - Meta 的报表一行一条广告：广告系列 / 广告组由同一天的广告加起来（`rollUpAdsRows`）。
 */
export function syncToAdsStore(
  store: AdsStore,
  rows: readonly AdsDataRow[],
  ctx: { today: string; at: string; currency?: string },
): void {
  if (rows.length === 0) return
  const first = rows[0] as AdsDataRow
  const platform = first.platform
  for (const account of new Set(rows.map((r) => r.account))) {
    const mine = rows.filter((r) => r.account === account)
    const accountId = `${platform}:${account}`
    const level = (l: 'campaign' | 'ad_group'): AdsReportRow[] => {
      const direct = mine.filter((r) => r.level === l)
      return direct.length > 0 ? direct : rollUpAdsRows(mine, l)
    }
    const latest = <R extends AdsReportRow>(list: readonly R[]): Map<string, R[]> => {
      const by = new Map<string, R[]>()
      for (const r of [...list].sort((a, b) => ((a.day ?? '') < (b.day ?? '') ? -1 : 1)))
        by.set(adsRowKey(r), [...(by.get(adsRowKey(r)) ?? []), r])
      return by
    }
    const campaigns = level('campaign')
    const todaySpend = campaigns
      .filter((r) => r.day === ctx.today)
      .reduce((sum, r) => sum + (r.metrics.cost ?? 0), 0)
    const hasToday = campaigns.some((r) => r.day === ctx.today)
    const prevAccount = store.account(accountId)
    const currency = mine.find((r) => r.currency !== undefined)?.currency
    const { spend_today: _old, ...prevRest } = prevAccount ?? { spend_today: undefined }
    store.saveAccount({
      ...prevRest,
      id: accountId,
      workspace_id: store.workspace_id,
      platform,
      external_id: account,
      name: mine.find((r) => r.account !== undefined)?.account ?? prevAccount?.name ?? account,
      currency: currency ?? prevAccount?.currency ?? ctx.currency ?? '',
      status: 'active',
      ...(hasToday ? { spend_today: Math.round(todaySpend * 100) / 100 } : {}),
      observed_at: ctx.at,
    } as never)
    const campaignIdOf = (r: AdsReportRow): string =>
      `${platform}:${account}:${ref(r.campaign_id, r.campaign)}`
    for (const list of latest(campaigns).values()) {
      const last = list[list.length - 1] as AdsReportRow
      const today = list.find((r) => r.day === ctx.today)
      const id = campaignIdOf(last)
      const prev = store.campaign(id)
      const { metrics: _m, ...rest } = prev ?? { metrics: undefined }
      const c: AdCampaign = {
        ...(rest as Partial<AdCampaign>),
        id,
        account_id: accountId,
        platform,
        external_id: ref(last.campaign_id, last.campaign),
        name: last.campaign ?? prev?.name ?? last.campaign_id ?? '',
        status: STATUS[last.status] ?? prev?.status ?? 'active',
        ...(last.budget === undefined ? {} : { daily_budget: last.budget }),
        ...(today === undefined ? {} : { metrics: metricsOf(today, ctx.at) }),
      }
      store.saveCampaign(c)
    }
    const adGroupIdOf = (r: AdsReportRow): string =>
      `${campaignIdOf(r)}:${ref(r.ad_group_id, r.ad_group)}`
    for (const list of latest(level('ad_group')).values()) {
      const last = list[list.length - 1] as AdsReportRow
      const today = list.find((r) => r.day === ctx.today)
      const id = adGroupIdOf(last)
      const prev = store.adSets({ platform }).find((x) => x.id === id)
      const { metrics: _m, ...rest } = prev ?? { metrics: undefined }
      const set: AdSet = {
        ...(rest as Partial<AdSet>),
        id,
        campaign_id: campaignIdOf(last),
        account_id: accountId,
        platform,
        external_id: ref(last.ad_group_id, last.ad_group),
        name: last.ad_group ?? prev?.name ?? '',
        status: STATUS[last.status] ?? prev?.status ?? 'active',
        ...(last.budget === undefined ? {} : { daily_budget: last.budget }),
        ...(today === undefined ? {} : { metrics: metricsOf(today, ctx.at) }),
      }
      store.saveAdSet(set)
    }
    for (const list of latest(mine.filter((r) => r.level === 'ad')).values()) {
      const last = list[list.length - 1] as AdsReportRow
      const today = list.find((r) => r.day === ctx.today)
      const id = `${adGroupIdOf(last)}:${ref(last.ad_id, last.ad)}`
      const prev = store.ad(id)
      const { metrics: _m, ...rest } = prev ?? { metrics: undefined }
      const ad: Ad = {
        ...(rest as Partial<Ad>),
        id,
        ad_set_id: adGroupIdOf(last),
        campaign_id: campaignIdOf(last),
        account_id: accountId,
        platform,
        external_id: ref(last.ad_id, last.ad),
        name: last.ad ?? prev?.name ?? '',
        status: STATUS[last.status] ?? prev?.status ?? 'active',
        ...(today === undefined ? {} : { metrics: metricsOf(today, ctx.at) }),
      }
      store.saveAd(ad)
    }
  }
}
