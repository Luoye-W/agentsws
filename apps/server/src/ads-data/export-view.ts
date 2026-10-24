/**
 * WP447：六个新平台的**账户概况**与**体检**——职责页那两块、`read_ads_export` / `run_ads_audit` 两个工具
 * 读的是同一份（不各算一遍）。
 *
 * 概况按**最近一份报表覆盖的那几天**算：同一家同一账户的行先取广告系列那一层（没有就由广告组 / 广告加上去），
 * 不同层不相加（加了就重复算）。币种、时区、日期范围照最近那份报表写；没写的就是没写。
 */

import {
  type AdsAuditResult,
  type AdsMetrics,
  type AdsReportRow,
  EXPORT_PLATFORMS,
  type ExportPlatform,
  rollUpAdsRows,
  runAdsAudit,
  sumAdsMetrics,
} from '@agentsws/ads-core'
import { ADS_PLATFORM_IDS, type AdsPlatform } from '@agentsws/contracts'
import type { AdsDataImport, AdsDataRow, AdsDataStore } from './store.js'

/** 读这两样只要库的这一面（服务与测试都满足）。 */
export interface ExportViewSource {
  rows: AdsDataStore['rows']
  imports: AdsDataStore['imports']
  today(): string
}

export interface ExportOverviewRow {
  platform: ExportPlatform
  account: string
  since?: string
  until?: string
  currency?: string
  timezone?: string
  metrics: AdsMetrics
  /** 这几天里有几条广告系列。 */
  campaigns: number
  imported_at: string
  file: string
  summary_only?: boolean
}

/** 广告系列那一层（没有就由更细的加上去）。 */
function campaignLevel(rows: readonly AdsDataRow[]): AdsReportRow[] {
  const direct = rows.filter((r) => r.level === 'campaign')
  return direct.length > 0 ? direct : rollUpAdsRows(rows, 'campaign')
}

const dayAdd = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** 一家的最近一份报表（没有回 `undefined`）。 */
export function latestExport(
  src: ExportViewSource,
  platform: AdsPlatform,
): AdsDataImport | undefined {
  return src.imports({ platform, limit: 1 })[0]
}

/** 一家的概况：每个账户一行（一份报表都没有就是空的）。 */
export function exportOverview(
  src: ExportViewSource,
  platform: ExportPlatform,
): ExportOverviewRow[] {
  const imp = latestExport(src, platform)
  if (imp === undefined || imp.days.length === 0) return []
  const first = imp.days[0] as string
  const last = imp.days[imp.days.length - 1] as string
  const rows = src.rows({ since: first, until: last, platform })
  const out: ExportOverviewRow[] = []
  for (const account of new Set(rows.map((r) => r.account))) {
    const mine = campaignLevel(rows.filter((r) => r.account === account))
    out.push({
      platform,
      account,
      ...(imp.since === undefined ? { since: first } : { since: imp.since }),
      ...(imp.until === undefined ? { until: last } : { until: imp.until }),
      ...(imp.currency === undefined ? {} : { currency: imp.currency }),
      ...(imp.timezone === undefined ? {} : { timezone: imp.timezone }),
      metrics: sumAdsMetrics(mine),
      campaigns: new Set(mine.map((r) => r.campaign_id ?? r.campaign)).size,
      imported_at: imp.at,
      file: imp.name,
      ...(imp.summary_only === true ? { summary_only: true } : {}),
    })
  }
  return out
}

/** 一家的广告系列表（最近一份报表那几天，按花费从大到小）。 */
export function exportCampaigns(
  src: ExportViewSource,
  platform: ExportPlatform,
  limit = 20,
): (AdsMetrics & { campaign: string; account: string })[] {
  const imp = latestExport(src, platform)
  if (imp === undefined || imp.days.length === 0) return []
  const rows = src.rows({
    since: imp.days[0] as string,
    until: imp.days[imp.days.length - 1] as string,
    platform,
  })
  const by = new Map<string, { account: string; campaign: string; rows: AdsReportRow[] }>()
  for (const account of new Set(rows.map((r) => r.account)))
    for (const r of campaignLevel(rows.filter((x) => x.account === account))) {
      const name = r.campaign ?? r.campaign_id ?? ''
      const k = `${account}\u0000${r.campaign_id ?? name}`
      const prev = by.get(k) ?? { account, campaign: name, rows: [] }
      prev.rows.push(r)
      by.set(k, prev)
    }
  return [...by.values()]
    .map((g) => ({ account: g.account, campaign: g.campaign, ...sumAdsMetrics(g.rows) }))
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))
    .slice(0, limit)
}

/**
 * 一家的体检（最近 30 天的行 + 最近那份报表上写的币种 / 时区 / 日期）。
 * WP452：十家都走这里（老四家的行是插件每天导的同一张表）；`brand` 给了按品牌读订阅来的正式清单。
 */
export function exportAudit(
  src: ExportViewSource,
  platform: AdsPlatform,
  opts: { has_app?: boolean; brand?: string } = {},
): AdsAuditResult {
  const today = src.today()
  const rows = src.rows({ since: dayAdd(today, -30), until: today, platform })
  const imp = latestExport(src, platform)
  const campaigns = [...new Set(rows.map((r) => r.account))].flatMap((a) =>
    campaignLevel(rows.filter((r) => r.account === a)),
  )
  return runAdsAudit({
    platform,
    rows: campaigns,
    today,
    ...(imp === undefined
      ? {}
      : {
          latest: {
            ...(imp.currency === undefined ? {} : { currency: imp.currency }),
            ...(imp.timezone === undefined ? {} : { timezone: imp.timezone }),
            ...(imp.since === undefined ? {} : { since: imp.since }),
            ...(imp.until === undefined
              ? imp.days.length === 0
                ? {}
                : { until: imp.days[imp.days.length - 1] as string }
              : { until: imp.until }),
          },
        }),
    ...(opts.has_app === undefined ? {} : { has_app: opts.has_app }),
    ...(opts.brand === undefined ? {} : { brand: opts.brand }),
  })
}

/** 投放面板要的那两份（概况六家、体检十家；面板那一层按职责筛）。 */
export function exportDeckData(
  src: ExportViewSource,
  opts: { has_app?: boolean; brand?: string } = {},
): {
  exports: ExportOverviewRow[]
  audits: AdsAuditResult[]
} {
  return {
    exports: EXPORT_PLATFORMS.flatMap((p) => exportOverview(src, p)),
    audits: ADS_PLATFORM_IDS.map((p) => exportAudit(src, p, opts)),
  }
}
