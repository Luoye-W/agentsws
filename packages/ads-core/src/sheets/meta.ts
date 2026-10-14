/**
 * Meta「批量导入广告」表生成（docs/101 §3.1）。
 *
 * Meta 的表是**平的**：一行一条广告，同一行带着它所在的广告组与广告系列的列；
 * 编号列空着 = 新建，填着 = 改已有。所以分两张表、分开导入：
 *
 * - **新建表**：编号列全空（[用 Excel 新建广告](https://www.facebook.com/business/help/257638938498557)），
 *   三层状态一律 `PAUSED`（决策 553）。挂在已有系列 / 广告组下面的，上级只写编号和名字。
 * - **改已有表**：照官方做法「先导出、在导出的行上改、再导入」
 *   （[用 Excel 编辑广告](https://www.facebook.com/business/help/158169530916536)）。
 *   给了改前导出（`before`）就拿原行原列改那一格；没给就只出编号、名字和要改的那一格，
 *   并提醒——Meta 导入时空格子算「不改」还是「清空」，官方没写。
 *
 * 以 `+ - = @` 开头的值写成 `< > 原文`（与 Meta 自己导出的写法一致；官方说导入时这个前缀会自动去掉）。
 */

import { writeXlsx } from './bytes.js'
import { encodeDelimited } from './csv.js'
import { money } from './google.js'
import {
  META_COLUMN_ORDER,
  META_COLUMNS,
  META_FORMULA_PREFIX,
  META_IMPORT_MAX_BYTES,
  META_STATUS,
  META_UPLOAD_FROM,
  type MetaColumnId,
} from './meta-columns.js'
import type { ExportField, ParsedAdsExport } from './parse.js'
import type {
  AdSheetOp,
  AdUploadFile,
  CreateAdGroupOp,
  CreateCampaignOp,
  SetBudgetOp,
  SetStatusOp,
  SheetProblem,
} from './types.js'

type Row = Partial<Record<MetaColumnId, string>>

/** Meta 导出同款的防公式前缀。 */
export function protectMetaCell(value: string): string {
  return /^[+\-=@]/.test(value) ? `${META_FORMULA_PREFIX} ${value}` : value
}

const IDENTITY: readonly MetaColumnId[] = [
  'campaign_id',
  'campaign_name',
  'ad_set_id',
  'ad_set_name',
  'ad_id',
  'ad_name',
]

function campaignCols(op: CreateCampaignOp | undefined, name: string, id?: string): Row {
  if (op === undefined) return { campaign_id: id ?? '', campaign_name: name }
  return {
    campaign_name: op.campaign,
    campaign_status: META_STATUS.paused,
    campaign_objective: op.meta?.objective ?? '',
    buying_type: op.meta?.buying_type ?? 'AUCTION',
  }
}

function adSetCols(op: CreateAdGroupOp | undefined, name: string, id?: string): Row {
  if (op === undefined) return { ad_set_id: id ?? '', ad_set_name: name }
  const m = op.meta ?? {}
  const num = (n: number | undefined): string => (n === undefined ? '' : String(n))
  return {
    ad_set_name: op.ad_group,
    ad_set_status: META_STATUS.paused,
    ad_set_daily_budget: m.daily_budget === undefined ? '' : money(m.daily_budget),
    ad_set_lifetime_budget: m.lifetime_budget === undefined ? '' : money(m.lifetime_budget),
    ad_set_time_start: m.start_time ?? '',
    countries: (m.countries ?? []).join(', '),
    age_min: num(m.age_min),
    age_max: num(m.age_max),
    optimization_goal: m.optimization_goal ?? '',
    billing_event: m.billing_event ?? '',
    bid_amount: m.bid_amount === undefined ? '' : money(m.bid_amount),
  }
}

/** 新建表的行（只看 create_*；关键词 Meta 没有，校验那一层已经拦了）。 */
export function metaCreateRows(ops: readonly AdSheetOp[]): Row[] {
  const campaigns = new Map<string, CreateCampaignOp>()
  const adSets = new Map<string, CreateAdGroupOp>()
  const key = (c: string, g: string): string => `${c}\u0000${g}`
  for (const op of ops) {
    if (op.kind === 'create_campaign') campaigns.set(op.campaign, op)
    if (op.kind === 'create_ad_group') adSets.set(key(op.campaign, op.ad_group), op)
  }
  const rows: Row[] = []
  const coveredSets = new Set<string>()
  const coveredCampaigns = new Set<string>()
  const counter = new Map<string, number>()
  for (const op of ops) {
    if (op.kind !== 'create_ad' || op.meta === undefined) continue
    const k = key(op.campaign, op.ad_group)
    coveredSets.add(k)
    coveredCampaigns.add(op.campaign)
    const n = (counter.get(k) ?? 0) + 1
    counter.set(k, n)
    const m = op.meta
    rows.push({
      ...campaignCols(campaigns.get(op.campaign), op.campaign, op.campaign_id),
      ...adSetCols(adSets.get(k), op.ad_group, op.ad_group_id),
      ad_name: m.ad_name ?? `${op.ad_group} · ${n}`,
      ad_status: META_STATUS.paused,
      // 官方字段对照页原话：用这些广告字段时 Creative Type 写 Page post ad、Story ID 留空
      creative_type: 'Page post ad',
      title: m.title ?? '',
      body: m.body,
      link: op.final_url.trim(),
      link_description: m.link_description ?? '',
      display_link: m.display_link ?? '',
      image: m.image_file ?? '',
      image_hash: m.image_hash ?? '',
      link_object_id: `o:${m.page_id}`,
      call_to_action: m.call_to_action ?? '',
      url_tags: m.url_tags ?? '',
    })
  }
  for (const [k, op] of adSets) {
    if (coveredSets.has(k)) continue
    coveredCampaigns.add(op.campaign)
    rows.push({
      ...campaignCols(campaigns.get(op.campaign), op.campaign, op.campaign_id),
      ...adSetCols(op, op.ad_group),
    })
  }
  for (const [name, op] of campaigns)
    if (!coveredCampaigns.has(name)) rows.push(campaignCols(op, name))
  return rows
}

type EditOp = SetBudgetOp | SetStatusOp

const STATUS_FIELD: Record<string, ExportField> = {
  campaign: 'campaign_status',
  ad_group: 'ad_group_status',
  ad: 'ad_status',
}
const ID_FIELD: Record<string, ExportField> = {
  campaign: 'campaign_id',
  ad_group: 'ad_group_id',
  ad: 'ad_id',
}
const STATUS_COL: Record<string, MetaColumnId> = {
  campaign: 'campaign_status',
  ad_group: 'ad_set_status',
  ad: 'ad_status',
}

const metaStatus = (s: 'paused' | 'enabled'): string =>
  s === 'paused' ? META_STATUS.paused : META_STATUS.active

/** 一条改动要动哪个字段、写成什么。 */
function editTarget(op: EditOp): { col: MetaColumnId; field: ExportField; value: string } {
  if (op.kind === 'set_budget')
    return { col: 'ad_set_daily_budget', field: 'ad_group_daily_budget', value: money(op.after) }
  return {
    col: STATUS_COL[op.level] as MetaColumnId,
    field: STATUS_FIELD[op.level] as ExportField,
    value: metaStatus(op.status),
  }
}

function idOf(op: EditOp): string | undefined {
  const r = op.ref
  return op.level === 'campaign' ? r.campaign_id : op.level === 'ad_group' ? r.ad_group_id : r.ad_id
}

/**
 * 改已有表。回 `{ headers, rows, problems }`；`ops` 里只看 set_budget / set_status。
 */
export function metaEditSheet(
  ops: readonly AdSheetOp[],
  before?: ParsedAdsExport,
): { headers: string[]; rows: string[][]; problems: SheetProblem[] } {
  const problems: SheetProblem[] = []
  const edits = ops
    .map((op, i) => [op, i] as const)
    .filter(
      (x): x is readonly [EditOp, number] =>
        x[0].kind === 'set_budget' || x[0].kind === 'set_status',
    )
  if (edits.length === 0) return { headers: [], rows: [], problems }

  if (before !== undefined && before.headers.length > 0) {
    const headerOf = (f: ExportField): string | undefined => {
      const i = before.fields.indexOf(f)
      return i < 0 ? undefined : before.headers[i]
    }
    const touched = new Map<number, Record<string, string>>()
    for (const [op, i] of edits) {
      const id = idOf(op)
      const t = editTarget(op)
      const idHeader = headerOf(ID_FIELD[op.level] as ExportField)
      const colHeader = headerOf(t.field) ?? META_COLUMNS[t.col].header
      const hits = before.rows.flatMap((r, k) =>
        id !== undefined && r.values[ID_FIELD[op.level] as ExportField] === id ? [k] : [],
      )
      if (idHeader === undefined || hits.length === 0) {
        problems.push({
          severity: 'error',
          code: 'not_in_before',
          op_index: i,
          message: `改前导出里找不到这条（${op.ref.campaign}${op.ref.ad_group === undefined ? '' : ` › ${op.ref.ad_group}`}，编号 ${id ?? '没给'}）——先导出包含它的那一份再改。`,
        })
        continue
      }
      for (const k of hits) {
        const row = touched.get(k) ?? { ...(before.rows[k]?.raw ?? {}) }
        row[colHeader] = t.value
        touched.set(k, row)
      }
    }
    const headers = [...before.headers]
    for (const row of touched.values())
      for (const h of Object.keys(row)) if (!headers.includes(h)) headers.push(h)
    const rows = [...touched.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, r]) => headers.map((h) => protectMetaCell(r[h] ?? '')))
    return { headers, rows, problems }
  }

  problems.push({
    severity: 'warning',
    code: 'no_before_export',
    message:
      '没有改前导出，只写了编号、名字和要改的那一格。Meta 官方的做法是先导出再在原行上改；导入时空格子算「不改」还是「清空」官方没写——上传前最好先导出一份。',
  })
  const rows: Row[] = edits.map(([op]) => {
    const r = op.ref
    const t = editTarget(op)
    const row: Row = { campaign_name: r.campaign }
    if (r.campaign_id !== undefined) row.campaign_id = r.campaign_id
    if (op.level !== 'campaign') {
      if (r.ad_group !== undefined) row.ad_set_name = r.ad_group
      if (r.ad_group_id !== undefined) row.ad_set_id = r.ad_group_id
    }
    if (op.level === 'ad') {
      if (r.ad !== undefined) row.ad_name = r.ad
      if (r.ad_id !== undefined) row.ad_id = r.ad_id
    }
    row[t.col] = t.value
    return row
  })
  return { ...rowsToTable(rows), problems }
}

/** 列按官方顺序；全空的列不出，编号与名字列一直留着。 */
export function rowsToTable(rows: readonly Row[]): { headers: string[]; rows: string[][] } {
  const cols = META_COLUMN_ORDER.filter(
    (c) => IDENTITY.includes(c) || rows.some((r) => (r[c] ?? '') !== ''),
  )
  return {
    headers: cols.map((c) => META_COLUMNS[c].header),
    rows: rows.map((r) => cols.map((c) => protectMetaCell(r[c] ?? ''))),
  }
}

/** 一张 Meta 表 → 上传文件（.xlsx 字节 + 可粘贴文字）。超 2MB 回问题。 */
export function metaFile(
  kind: 'meta_new' | 'meta_edit',
  table: { headers: readonly string[]; rows: readonly (readonly string[])[] },
): { file: AdUploadFile; problems: SheetProblem[] } {
  const grid = [table.headers, ...table.rows]
  const paste = encodeDelimited(grid, '\t')
  const content = writeXlsx(grid, 'Ads')
  const problems: SheetProblem[] = []
  const bytes = Math.max(content.length, new TextEncoder().encode(paste).length)
  if (bytes > META_IMPORT_MAX_BYTES)
    problems.push({
      severity: 'error',
      code: 'too_big',
      message: `这张表约 ${Math.ceil(bytes / 1024)}KB，Meta 导入大约 2MB 封顶，拆成几批。`,
    })
  return {
    file: {
      name: kind === 'meta_new' ? 'meta-new-ads.xlsx' : 'meta-edit-ads.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content,
      sheet: kind,
      upload_from: META_UPLOAD_FROM,
      headers: table.headers,
      rows: table.rows,
      paste_text: paste,
    },
    problems,
  }
}
