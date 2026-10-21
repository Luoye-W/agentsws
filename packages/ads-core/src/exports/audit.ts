/**
 * WP447：按骨架（`audit-skeleton.ts`）把一家的体检跑一遍。
 *
 * 四种结果：`ok` 没问题、`look` 要看一眼（证据在 `note` 里）、`unknown` 没有证据（**不猜**——后台那几项一律
 * 是它，报表里缺那一列的也是它）、`not_applicable` 这家不适用（Apple 没有转化金额那一列）。
 *
 * Apple 只推 App（docs/109 §6.3）：品牌没有 App（`has_app: false`），或者还不知道有没有、又一份 Apple 报表都
 * 没有——**整张体检就一句「这条只适合推 App」**，不出一张全是「未知」的空表。
 */

import { adsPlatformSpec } from '@agentsws/contracts'
import type { AdsReportRow } from '../sheets/report.js'
import { type AuditCheckSpec, auditSkeleton, type ExportAuditRule } from './audit-skeleton.js'
import { EXPORT_FORMATS, type ExportPlatform } from './columns.js'

export type AuditStatus = 'ok' | 'look' | 'unknown' | 'not_applicable'

export interface AuditItem {
  id: string
  title: { zh: string; en: string }
  status: AuditStatus
  /** 凭什么（报表里的数 / 去后台哪一页看）。 */
  note: string
  evidence: 'export' | 'backend'
}

export interface AdsAuditInput {
  platform: ExportPlatform
  /** 体检看的那段时间里的行（只要这一家的）。 */
  rows: readonly AdsReportRow[]
  /** 最近一份导入写在卡上的那几样。 */
  latest?: { currency?: string; timezone?: string; since?: string; until?: string }
  /** 本地今天 `YYYY-MM-DD`。 */
  today: string
  /** 品牌有没有 App（品牌档案那一格；不知道就不给）。 */
  has_app?: boolean
  /** 数多少天没更新算旧（默认 7）。 */
  stale_days?: number
}

export interface AdsAuditResult {
  platform: ExportPlatform
  /** Apple 且没有 App：整张就这一句（`items` 为空）。 */
  app_only?: string
  items: AuditItem[]
  counts: Record<AuditStatus, number>
}

/** 「这条只适合推 App」那句话（卡上、工具回的都是它）。 */
export const APP_ONLY_NOTE =
  '这条只适合推 App：品牌没有 App 时不用开。有 App 的话把 Apple Ads 的报表拖进来就能体检。'

const sum = (rows: readonly AdsReportRow[], k: 'cost' | 'conversions' | 'conversion_value') => {
  const got = rows.map((r) => r.metrics[k]).filter((n): n is number => n !== undefined)
  return got.length === 0 ? undefined : Math.round(got.reduce((a, b) => a + b, 0) * 100) / 100
}

const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

function judge(rule: ExportAuditRule, input: AdsAuditInput): { status: AuditStatus; note: string } {
  const { rows, latest } = input
  if (rows.length === 0)
    return { status: 'unknown', note: '还没有这家的报表：导出一份拖进来就能判。' }
  const fmt = EXPORT_FORMATS[input.platform]
  const conv = fmt.conversions_label?.zh ?? '转化'
  const cost = sum(rows, 'cost')
  const conversions = sum(rows, 'conversions')
  switch (rule) {
    case 'fresh_data': {
      const until =
        latest?.until ??
        rows
          .map((r) => r.day ?? '')
          .sort()
          .pop()
      if (until === undefined || until === '')
        return { status: 'unknown', note: '报表里没写日期。' }
      const gap = daysBetween(until, input.today)
      const limit = input.stale_days ?? 7
      return gap > limit
        ? { status: 'look', note: `最新的数到 ${until}，已经 ${gap} 天没新的了。` }
        : { status: 'ok', note: `最新的数到 ${until}。` }
    }
    case 'currency_stated':
      return latest?.currency === undefined
        ? { status: 'look', note: '报表里没写币种：花费先按账户币种看，不和别家相加。' }
        : { status: 'ok', note: `币种 ${latest.currency}。` }
    case 'timezone_stated':
      return latest?.timezone === undefined
        ? { status: 'look', note: '报表里没写时区：按天和店里的订单对账时可能差一天。' }
        : { status: 'ok', note: `时区 ${latest.timezone}。` }
    case 'conversions_tracked':
      if (fmt.columns.conversions?.verified === undefined && conversions === undefined)
        return { status: 'unknown', note: `这家的导出里认不出${conv}那一列。` }
      if (conversions === undefined) return { status: 'unknown', note: `报表里没有${conv}这一列。` }
      if ((cost ?? 0) > 0 && conversions === 0)
        return {
          status: 'look',
          note: `花了 ${cost} 一个${conv}都没有：多半是追踪没装好，先查后台那几项。`,
        }
      return { status: 'ok', note: `${conv} ${conversions}。` }
    case 'conversion_value': {
      if (fmt.columns.conversion_value === undefined)
        return {
          status: 'not_applicable',
          note: '这家后台不给转化金额（App 内收入要看归因那一侧）。',
        }
      const value = sum(rows, 'conversion_value')
      if (conversions === undefined || conversions === 0)
        return { status: 'unknown', note: `没有${conv}，谈不上金额。` }
      if (value === undefined) return { status: 'unknown', note: '报表里没有转化金额这一列。' }
      if (value === 0)
        return {
          status: 'look',
          note: `有 ${conversions} 个${conv}但金额全是 0：没回传金额，ROAS 算不出。`,
        }
      return { status: 'ok', note: `转化金额 ${value}。` }
    }
    case 'zero_conversion_spenders': {
      if (conversions === undefined) return { status: 'unknown', note: `报表里没有${conv}这一列。` }
      const byName = new Map<string, { cost: number; conv: number }>()
      for (const r of rows) {
        const name = r.campaign ?? r.campaign_id
        if (name === undefined) continue
        const prev = byName.get(name) ?? { cost: 0, conv: 0 }
        byName.set(name, {
          cost: prev.cost + (r.metrics.cost ?? 0),
          conv: prev.conv + (r.metrics.conversions ?? 0),
        })
      }
      const bad = [...byName.entries()]
        .filter(([, m]) => m.cost > 0 && m.conv === 0)
        .sort((a, b) => b[1].cost - a[1].cost)
      if (bad.length === 0) return { status: 'ok', note: `每条花了钱的系列都有${conv}。` }
      const top = bad
        .slice(0, 3)
        .map(([n, m]) => `「${n}」花了 ${Math.round(m.cost * 100) / 100}`)
        .join('、')
      return { status: 'look', note: `${bad.length} 条花了钱一个${conv}没有：${top}。` }
    }
  }
}

function run(spec: AuditCheckSpec, input: AdsAuditInput): AuditItem {
  if (spec.evidence.kind === 'backend')
    return {
      id: spec.id,
      title: spec.title,
      status: 'unknown',
      note: `没有证据：去${spec.evidence.where.zh}看一眼。`,
      evidence: 'backend',
    }
  return { id: spec.id, title: spec.title, evidence: 'export', ...judge(spec.evidence.rule, input) }
}

/** 跑一家的体检。 */
export function runAdsAudit(input: AdsAuditInput): AdsAuditResult {
  const counts: Record<AuditStatus, number> = { ok: 0, look: 0, unknown: 0, not_applicable: 0 }
  const appOnly = adsPlatformSpec(input.platform)?.app_only === true
  if (
    appOnly &&
    (input.has_app === false || (input.has_app === undefined && input.rows.length === 0))
  )
    return { platform: input.platform, app_only: APP_ONLY_NOTE, items: [], counts }
  const items = auditSkeleton(input.platform).map((s) => run(s, input))
  for (const i of items) counts[i.status] += 1
  return { platform: input.platform, items, counts }
}
