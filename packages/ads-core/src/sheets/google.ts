/**
 * Google 广告「批量上传」CSV 生成（docs/101 §2.1）。
 *
 * Google 是**按表上传**的：在「广告系列 / 广告组 / 广告 / 关键词」哪张表上点上传，
 * 就传哪一层的表。所以这里一层一个 CSV，按上级到下级的顺序排（先有系列才能建组）。
 *
 * 新建的每一行：`Action = Add`、状态列写死 `Paused`（决策 553——留空就是启用）。
 * 改已有的：`Action = Edit`，状态列只在暂停 / 启用时写，别的改动留空（= 不动它）。
 */

import { encodeDelimited } from './csv.js'
import {
  GOOGLE_BULK_COLUMNS as COL,
  descriptionHeader,
  GOOGLE_ACTION,
  GOOGLE_STATUS,
  GOOGLE_UPLOAD_FROM,
  headlineHeader,
} from './google-columns.js'
import type { AdSheetOp, AdUploadFile, KeywordMatch, SheetContext } from './types.js'

type Row = Record<string, string>
type SheetId = 'campaigns' | 'ad_groups' | 'ads' | 'keywords'

/** 关键词按官方写法带上匹配符号：完全匹配 `[ ]`、词组匹配 `" "`、广泛匹配不带。 */
export function formatGoogleKeyword(text: string, match: KeywordMatch): string {
  const t = text.trim()
  return match === 'exact' ? `[${t}]` : match === 'phrase' ? `"${t}"` : t
}

/** 金额写两位小数（官方模板示例 `10.00`）。 */
export const money = (n: number): string => n.toFixed(2)

const HEADLINES = Array.from({ length: 15 }, (_, i) => headlineHeader(i + 1))
const DESCRIPTIONS = Array.from({ length: 4 }, (_, i) => descriptionHeader(i + 1))

/** 每张表的列（顺序即输出顺序）。 */
const SHEET_COLUMNS: Record<SheetId, readonly string[]> = {
  campaigns: [
    COL.action.header,
    COL.campaign_status.header,
    COL.customer_id.header,
    COL.campaign_id.header,
    COL.campaign.header,
    COL.campaign_type.header,
    COL.networks.header,
    COL.budget.header,
    COL.budget_type.header,
    COL.bid_strategy_type.header,
    COL.campaign_start_date.header,
    COL.campaign_end_date.header,
    COL.language.header,
    COL.location.header,
  ],
  ad_groups: [
    COL.action.header,
    COL.ad_group_status.header,
    COL.customer_id.header,
    COL.campaign_id.header,
    COL.campaign.header,
    COL.ad_group_id.header,
    COL.ad_group.header,
    COL.max_cpc.header,
  ],
  ads: [
    COL.action.header,
    COL.ad_status.header,
    COL.customer_id.header,
    COL.campaign.header,
    COL.ad_group.header,
    COL.ad_id.header,
    COL.ad_type.header,
    ...HEADLINES,
    ...DESCRIPTIONS,
    COL.path1.header,
    COL.path2.header,
    COL.final_url.header,
  ],
  keywords: [
    COL.action.header,
    COL.keyword_status.header,
    COL.customer_id.header,
    COL.campaign.header,
    COL.ad_group.header,
    COL.keyword.header,
    COL.max_cpc.header,
  ],
}

/** 不管哪一列都空也要留着的（认对象靠它们）。 */
const ALWAYS_KEEP = new Set([COL.action.header, COL.campaign.header, COL.ad_group.header])

const status = (s: 'paused' | 'enabled'): string =>
  s === 'paused' ? GOOGLE_STATUS.paused : GOOGLE_STATUS.enabled

/** 把一条 op 摊成某一张表上的一行。 */
function opToRow(op: AdSheetOp, cid: string | undefined): [SheetId, Row] | undefined {
  const base: Row = cid === undefined ? {} : { [COL.customer_id.header]: cid }
  switch (op.kind) {
    case 'create_campaign': {
      const g = op.google ?? {}
      const c = g.customer_id ?? cid
      return [
        'campaigns',
        {
          ...(c === undefined ? {} : { [COL.customer_id.header]: c }),
          [COL.action.header]: GOOGLE_ACTION.add,
          [COL.campaign_status.header]: GOOGLE_STATUS.paused,
          [COL.campaign.header]: op.campaign,
          [COL.campaign_type.header]: g.campaign_type ?? 'Search',
          [COL.networks.header]: (g.networks ?? []).join('; '),
          [COL.budget.header]: op.daily_budget === undefined ? '' : money(op.daily_budget),
          [COL.budget_type.header]: 'Daily',
          [COL.bid_strategy_type.header]: g.bid_strategy_type ?? 'Manual CPC',
          [COL.campaign_start_date.header]: g.start_date ?? '',
          [COL.campaign_end_date.header]: g.end_date ?? '',
          [COL.language.header]: (g.languages ?? []).join('; '),
          [COL.location.header]: (g.locations ?? []).join('; '),
        },
      ]
    }
    case 'create_ad_group':
      return [
        'ad_groups',
        {
          ...base,
          [COL.action.header]: GOOGLE_ACTION.add,
          [COL.ad_group_status.header]: GOOGLE_STATUS.paused,
          [COL.campaign_id.header]: op.campaign_id ?? '',
          [COL.campaign.header]: op.campaign,
          [COL.ad_group.header]: op.ad_group,
          [COL.max_cpc.header]: op.google?.max_cpc === undefined ? '' : money(op.google.max_cpc),
        },
      ]
    // 广告 / 关键词 / 改动见下一节
    default:
      return opToRowPart2(op, base)
  }
}

function opToRowPart2(op: AdSheetOp, base: Row): [SheetId, Row] | undefined {
  switch (op.kind) {
    case 'create_ad': {
      const g = op.google
      const row: Row = {
        ...base,
        [COL.action.header]: GOOGLE_ACTION.add,
        [COL.ad_status.header]: GOOGLE_STATUS.paused,
        [COL.campaign.header]: op.campaign,
        [COL.ad_group.header]: op.ad_group,
        [COL.ad_type.header]: 'Responsive search ad',
        [COL.path1.header]: g?.path1 ?? '',
        [COL.path2.header]: g?.path2 ?? '',
        [COL.final_url.header]: op.final_url.trim(),
      }
      g?.headlines.forEach((h, i) => {
        row[headlineHeader(i + 1)] = h
      })
      g?.descriptions.forEach((d, i) => {
        row[descriptionHeader(i + 1)] = d
      })
      return ['ads', row]
    }
    case 'add_keyword':
      return [
        'keywords',
        {
          ...base,
          [COL.action.header]: GOOGLE_ACTION.add,
          [COL.keyword_status.header]: GOOGLE_STATUS.paused,
          [COL.campaign.header]: op.campaign,
          [COL.ad_group.header]: op.ad_group,
          [COL.keyword.header]: formatGoogleKeyword(op.text, op.match),
          [COL.max_cpc.header]: op.max_cpc === undefined ? '' : money(op.max_cpc),
        },
      ]
    case 'set_budget':
      return [
        'campaigns',
        {
          ...base,
          [COL.action.header]: GOOGLE_ACTION.edit,
          [COL.campaign_id.header]: op.ref.campaign_id ?? '',
          [COL.campaign.header]: op.ref.campaign,
          [COL.budget.header]: money(op.after),
        },
      ]
    case 'set_status': {
      const r = op.ref
      const edit = {
        ...base,
        [COL.action.header]: GOOGLE_ACTION.edit,
        [COL.campaign.header]: r.campaign,
      }
      const st = status(op.status)
      if (op.level === 'campaign')
        return [
          'campaigns',
          {
            ...edit,
            [COL.campaign_id.header]: r.campaign_id ?? '',
            [COL.campaign_status.header]: st,
          },
        ]
      if (op.level === 'ad_group')
        return [
          'ad_groups',
          {
            ...edit,
            [COL.campaign_id.header]: r.campaign_id ?? '',
            [COL.ad_group_id.header]: r.ad_group_id ?? '',
            [COL.ad_group.header]: r.ad_group ?? '',
            [COL.ad_group_status.header]: st,
          },
        ]
      if (op.level === 'ad')
        return [
          'ads',
          {
            ...edit,
            [COL.ad_group.header]: r.ad_group ?? '',
            [COL.ad_id.header]: r.ad_id ?? '',
            [COL.ad_status.header]: st,
          },
        ]
      return [
        'keywords',
        {
          ...edit,
          [COL.ad_group.header]: r.ad_group ?? '',
          [COL.keyword.header]: formatGoogleKeyword(r.keyword ?? '', r.match ?? 'broad'),
          [COL.keyword_status.header]: st,
        },
      ]
    }
    default:
      return undefined
  }
}

const SHEET_ORDER: readonly SheetId[] = ['campaigns', 'ad_groups', 'ads', 'keywords']

/**
 * 出 Google 批量上传的 CSV（一层一个，按上传顺序）。**不做校验**——校验在
 * `validateAdSheetOps`；对外请用 `buildAdUploadBundle`，它先查再出、有错不出。
 */
export function buildGoogleBulkFiles(
  ops: readonly AdSheetOp[],
  ctx: SheetContext = {},
): AdUploadFile[] {
  const bySheet = new Map<SheetId, Row[]>()
  for (const op of ops) {
    const hit = opToRow(op, ctx.customer_id)
    if (hit === undefined) continue
    const list = bySheet.get(hit[0]) ?? []
    list.push(hit[1])
    bySheet.set(hit[0], list)
  }
  const files: AdUploadFile[] = []
  for (const sheet of SHEET_ORDER) {
    const rows = bySheet.get(sheet)
    if (rows === undefined) continue
    // 全空的列不出（没改的列 Google 本来就忽略；少一列就少一处列名没核实的风险）
    const headers = SHEET_COLUMNS[sheet].filter(
      (h) => ALWAYS_KEEP.has(h) || rows.some((r) => (r[h] ?? '') !== ''),
    )
    const cells = rows.map((r) => headers.map((h) => r[h] ?? ''))
    files.push({
      name: `google-${sheet.replace('_', '-')}.csv`,
      mime: 'text/csv',
      content: encodeDelimited([headers, ...cells], ','),
      sheet,
      upload_from: GOOGLE_UPLOAD_FROM[sheet],
      headers,
      rows: cells,
    })
  }
  return files
}
