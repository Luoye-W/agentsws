/**
 * WP447（docs/109 §6.2 / S7）：体检骨架——查什么、凭什么。数据，不是逻辑。
 *
 * WP452（docs/109 §5.2 #12）：十个平台（老四家 + 六个新平台）**共用这一套**，检查项挪进数据文件
 * `ads-audit-checklist.content.json`（表名 `ads.audit_checklist`，每行带稳定 id）。开源基础版只带冻结时的骨架；
 * 正式清单带官方出处与核对日期，随「岗位更新」订阅按品牌覆盖这张表（`readContentTable`，WP404 / WP406 那条路）。
 *
 * 只写「查哪一项、证据在哪」，**不写带日期的官方事实**（门槛数字、某天起的新规矩）。
 *
 * 两种证据：
 * - `export`：拿报表就能判（`rule` 是 `audit.ts` 里的判法）；
 * - `backend`：要人去后台那一页看一眼（`where`）——我们没有那一页的证据，一律标「未知」，不猜。
 *
 * 口径「没证据就标未知、没出处不下结论」借鉴 AgriciDaniel/claude-ads（MIT）`ads/references/*-audit.md`，
 * 只借方法与检查项结构（THIRD-PARTY-NOTICES）。
 */

import type { AdsPlatform, ContentTableRow } from '@agentsws/contracts'
import { builtinContentTable, readContentTable } from '@agentsws/core'
import CHECKLIST_FILE from './ads-audit-checklist.content.json' with { type: 'json' }
import type { ExportPlatform } from './columns.js'

type Text = { zh: string; en: string }

/** 拿导出报表就能判的几种判法（`audit.ts` 实现）。 */
export type ExportAuditRule =
  /** 数新不新（最新一天离今天多久）。 */
  | 'fresh_data'
  /** 卡上写没写币种。 */
  | 'currency_stated'
  /** 卡上写没写时区。 */
  | 'timezone_stated'
  /** 花了钱有没有转化（没有多半是追踪没装好）。 */
  | 'conversions_tracked'
  /** 有转化有没有回传金额（没有就算不出 ROAS）。 */
  | 'conversion_value'
  /** 哪几条花了钱一单没有。 */
  | 'zero_conversion_spenders'

const EXPORT_RULES: readonly ExportAuditRule[] = [
  'fresh_data',
  'currency_stated',
  'timezone_stated',
  'conversions_tracked',
  'conversion_value',
  'zero_conversion_spenders',
]

/** WP452：正式清单里一行可带的官方出处（基础版没有）。 */
export interface AuditCheckSource {
  title: string
  url: string
  /** 核对日期 `YYYY-MM-DD`。 */
  checked_on: string
}

export interface AuditCheckSpec {
  id: string
  title: Text
  evidence: { kind: 'export'; rule: ExportAuditRule } | { kind: 'backend'; where: Text }
  /** WP452：官方出处（正式清单才有）。 */
  source?: AuditCheckSource
  /** WP452：这一项要靠官方事实判——没有出处就不下结论（标未知）。 */
  needs_source?: boolean
}

/** WP452：数据表里的一行（`platform: '*'` = 十家都查）。 */
export interface AuditChecklistRow extends ContentTableRow {
  platform: AdsPlatform | '*'
  /** 这一项在一家里的 id（`fresh_data`、`uet_tag` …）。 */
  check: string
  title: Text
  evidence: AuditCheckSpec['evidence']
  source?: AuditCheckSource
  needs_source?: boolean
}

/** 随软件带的那一份（基础版骨架）。 */
export const AUDIT_CHECKLIST_TABLE = builtinContentTable<AuditChecklistRow>(
  CHECKLIST_FILE as { table: string; rows: unknown },
)

const isText = (v: unknown): v is Text =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Text).zh === 'string' &&
  typeof (v as Text).en === 'string'

/** 覆盖来的一行合不合格（有一行不合格整张不用，回落基础版）。 */
export function isAuditChecklistRow(r: unknown): r is AuditChecklistRow {
  if (typeof r !== 'object' || r === null) return false
  const row = r as Partial<AuditChecklistRow>
  if (typeof row.platform !== 'string' || typeof row.check !== 'string' || !isText(row.title))
    return false
  const ev = row.evidence as { kind?: unknown; rule?: unknown; where?: unknown } | undefined
  if (ev?.kind === 'export')
    return typeof ev.rule === 'string' && EXPORT_RULES.includes(ev.rule as ExportAuditRule)
  if (ev?.kind === 'backend') return isText(ev.where)
  return false
}

const specOf = (r: AuditChecklistRow): AuditCheckSpec => ({
  id: r.check,
  title: r.title,
  evidence: r.evidence,
  ...(r.source === undefined ? {} : { source: r.source }),
  ...(r.needs_source === true ? { needs_source: true } : {}),
})

/**
 * WP452：一家的清单（十家都查的在前，这家自己的在后）。给了 `brand` 就按品牌读（订阅来的正式清单）。
 */
export function auditChecklist(
  platform: AdsPlatform,
  options: { brand?: string } = {},
): AuditCheckSpec[] {
  const rows = readContentTable(AUDIT_CHECKLIST_TABLE, {
    ...(options.brand === undefined ? {} : { brand: options.brand }),
    accepts: isAuditChecklistRow,
  })
  return [
    ...rows.filter((r) => r.platform === '*').map(specOf),
    ...rows.filter((r) => r.platform === platform).map(specOf),
  ]
}

const builtinRows = AUDIT_CHECKLIST_TABLE.rows

/** 十家都查的、拿报表就能判的那几项（基础版）。 */
export const COMMON_EXPORT_CHECKS: readonly AuditCheckSpec[] = builtinRows
  .filter((r) => r.platform === '*')
  .map(specOf)

const ofPlatform = (p: AdsPlatform): AuditCheckSpec[] =>
  builtinRows.filter((r) => r.platform === p).map(specOf)

/** 六个新平台各自要去后台看一眼的那几项（基础版；WP447 的公共名，保留）。 */
export const BACKEND_CHECKS: Readonly<Record<ExportPlatform, readonly AuditCheckSpec[]>> = {
  microsoft: ofPlatform('microsoft'),
  pinterest: ofPlatform('pinterest'),
  reddit: ofPlatform('reddit'),
  linkedin: ofPlatform('linkedin'),
  snapchat: ofPlatform('snapchat'),
  apple: ofPlatform('apple'),
}

/** 一家的整份骨架（拿报表能判的在前，要去后台看的在后）。WP452：十家都认，可按品牌读。 */
export function auditSkeleton(
  platform: AdsPlatform,
  options: { brand?: string } = {},
): readonly AuditCheckSpec[] {
  return auditChecklist(platform, options)
}
