/**
 * WP447：按骨架（`audit-skeleton.ts`）把一家的体检跑一遍。WP452：十个平台都走这一套（老四家的行来自插件每天
 * 导的同一张表），每一项另给**三态结论**（`verdict`：过 / 不过 / 未知；「不适用」的不算进三态）。
 *
 * 四种结果：`ok` 没问题、`look` 要看一眼（证据在 `note` 里）、`unknown` 没有证据（**不猜**——后台那几项一律
 * 是它，报表里缺那一列的也是它）、`not_applicable` 这家不适用（Apple 没有转化金额那一列）。
 *
 * Apple 只推 App（docs/109 §6.3）：品牌没有 App（`has_app: false`），或者还不知道有没有、又一份 Apple 报表都
 * 没有——**整张体检就一句「这条只适合推 App」**，不出一张全是「未知」的空表。
 */

import { type AdsPlatform, adsPlatformSpec } from '@agentsws/contracts'
import type { AdsReportRow } from '../sheets/report.js'
import { type AuditCheckSpec, auditSkeleton, type ExportAuditRule } from './audit-skeleton.js'
import { EXPORT_FORMATS, isExportPlatform } from './columns.js'

export type AuditStatus = 'ok' | 'look' | 'unknown' | 'not_applicable'

/** WP452：体检三态（派工单「过 / 不过 / 未知」）。`not_applicable` 不进三态（这家没这一项）。 */
export type AuditVerdict = 'pass' | 'fail' | 'unknown'

/** 四种状态 → 三态（不适用回 `undefined`）。 */
export function auditVerdictOf(status: AuditStatus): AuditVerdict | undefined {
  return status === 'ok'
    ? 'pass'
    : status === 'look'
      ? 'fail'
      : status === 'unknown'
        ? 'unknown'
        : undefined
}

/** 三态的中文（面板、卡、工具回的都是它）。 */
export const AUDIT_VERDICT_ZH: Readonly<Record<AuditVerdict, string>> = {
  pass: '过',
  fail: '不过',
  unknown: '未知',
}

export interface AuditItem {
  id: string
  title: { zh: string; en: string }
  status: AuditStatus
  /** 凭什么（报表里的数 / 去后台哪一页看）。 */
  note: string
  evidence: 'export' | 'backend'
  /** WP452：三态结论（不适用的没有）。 */
  verdict?: AuditVerdict
  /** WP452：正式清单里这一项的官方出处（基础版没有）。 */
  source?: AuditCheckSpec['source']
}

export interface AdsAuditInput {
  /** WP452：十个平台都认（WP447 时只有六个新平台）。 */
  platform: AdsPlatform
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
  /** WP452：按哪个品牌读清单（订阅来的正式清单按品牌覆盖）。 */
  brand?: string
}

export interface AdsAuditResult {
  platform: AdsPlatform
  /** Apple 且没有 App：整张就这一句（`items` 为空）。 */
  app_only?: string
  items: AuditItem[]
  counts: Record<AuditStatus, number>
  /** WP452：三态计数（不适用的不算）。 */
  verdicts?: Record<AuditVerdict, number>
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
  const fmt = isExportPlatform(input.platform) ? EXPORT_FORMATS[input.platform] : undefined
  const conv = fmt?.conversions_label?.zh ?? '转化'
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
      if (
        fmt !== undefined &&
        fmt.columns.conversions?.verified === undefined &&
        conversions === undefined
      )
        return { status: 'unknown', note: `这家的导出里认不出${conv}那一列。` }
      if (conversions === undefined) return { status: 'unknown', note: `报表里没有${conv}这一列。` }
      if ((cost ?? 0) > 0 && conversions === 0)
        return {
          status: 'look',
          note: `花了 ${cost} 一个${conv}都没有：多半是追踪没装好，先查后台那几项。`,
        }
      return { status: 'ok', note: `${conv} ${conversions}。` }
    case 'conversion_value': {
      if (fmt !== undefined && fmt.columns.conversion_value === undefined)
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

function judged(spec: AuditCheckSpec, input: AdsAuditInput): Omit<AuditItem, 'verdict'> {
  const base = {
    id: spec.id,
    title: spec.title,
    ...(spec.source === undefined ? {} : { source: spec.source }),
  }
  if (spec.evidence.kind === 'backend')
    return {
      ...base,
      status: 'unknown',
      note: `没有证据：去${spec.evidence.where.zh}看一眼。`,
      evidence: 'backend',
    }
  // WP452：要靠官方事实判的项，没有出处就不下结论
  if (spec.needs_source === true && spec.source === undefined)
    return {
      ...base,
      status: 'unknown',
      note: '这一项要按平台的官方说法判，清单里还没有出处：先不下结论。',
      evidence: 'export',
    }
  const out = judge(spec.evidence.rule, input)
  const cite =
    spec.source === undefined
      ? ''
      : `（出处：${spec.source.title}，核于 ${spec.source.checked_on}）`
  return { ...base, evidence: 'export', status: out.status, note: `${out.note}${cite}` }
}

function run(spec: AuditCheckSpec, input: AdsAuditInput): AuditItem {
  const item = judged(spec, input)
  const verdict = auditVerdictOf(item.status)
  return verdict === undefined ? item : { ...item, verdict }
}

/** 跑一家的体检。 */
export function runAdsAudit(input: AdsAuditInput): AdsAuditResult {
  const counts: Record<AuditStatus, number> = { ok: 0, look: 0, unknown: 0, not_applicable: 0 }
  const verdicts: Record<AuditVerdict, number> = { pass: 0, fail: 0, unknown: 0 }
  const appOnly = adsPlatformSpec(input.platform)?.app_only === true
  if (
    appOnly &&
    (input.has_app === false || (input.has_app === undefined && input.rows.length === 0))
  )
    return { platform: input.platform, app_only: APP_ONLY_NOTE, items: [], counts, verdicts }
  const items = auditSkeleton(
    input.platform,
    input.brand === undefined ? {} : { brand: input.brand },
  ).map((s) => run(s, input))
  for (const i of items) {
    counts[i.status] += 1
    if (i.verdict !== undefined) verdicts[i.verdict] += 1
  }
  return { platform: input.platform, items, counts, verdicts }
}
