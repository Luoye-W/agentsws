/**
 * 同一批改动出一份 Google Ads Editor 能导入的 CSV（决策 561：Editor 不是默认路线，
 * 帮助文档里告诉会用的人「可以拿这张表自己导入」）。
 *
 * 与网页版批量上传的三处不同（[Editor · CSV 文件列](https://support.google.com/google-ads/editor/answer/57747?hl=en)）：
 * 一个文件装所有层级（一行一个对象）；状态列分 Campaign Status / Ad Group Status / Status；
 * 关键词不带括号引号，匹配方式写在 Criterion Type。Editor 认表头不分大小写、不管空格。
 *
 * 只出**新建**（一律 Paused）与预算 / 状态改动；改已有的靠名字认（Editor 先把账户下载到本地，
 * 名字在本地是唯一的）。导入后在 Editor 里还要人点「发布」——那一步不归我们。
 */

import { encodeDelimited } from './csv.js'
import { money } from './google.js'
import type { AdSheetOp, AdUploadFile } from './types.js'

const H = (n: number): string => `Headline ${n}`
const D = (n: number): string => `Description ${n}`

export const GOOGLE_EDITOR_HEADERS: readonly string[] = [
  'Campaign',
  'Campaign Type',
  'Networks',
  'Budget',
  'Bid Strategy Type',
  'Languages',
  'Location',
  'Campaign Status',
  'Ad Group',
  'Max CPC',
  'Ad Group Status',
  'Keyword',
  'Criterion Type',
  ...Array.from({ length: 15 }, (_, i) => H(i + 1)),
  ...Array.from({ length: 4 }, (_, i) => D(i + 1)),
  'Path 1',
  'Path 2',
  'Final URL',
  'Status',
]

const MATCH = { broad: 'Broad', phrase: 'Phrase', exact: 'Exact' } as const
const ST = (s: 'paused' | 'enabled'): string => (s === 'paused' ? 'Paused' : 'Enabled')

/** 出 Editor 用的单个 CSV（UTF-8）。Google 广告与 Meta 无关，Meta 的 op 原样跳过。 */
export function buildGoogleEditorCsv(ops: readonly AdSheetOp[]): AdUploadFile {
  const rows: Record<string, string>[] = []
  for (const op of ops) {
    switch (op.kind) {
      case 'create_campaign': {
        const g = op.google ?? {}
        rows.push({
          Campaign: op.campaign,
          'Campaign Type': g.campaign_type ?? 'Search',
          Networks: (g.networks ?? []).join(';'),
          Budget: op.daily_budget === undefined ? '' : money(op.daily_budget),
          'Bid Strategy Type': g.bid_strategy_type ?? 'Manual CPC',
          Languages: (g.languages ?? []).join(';'),
          Location: (g.locations ?? []).join(';'),
          'Campaign Status': 'Paused',
        })
        break
      }
      case 'create_ad_group':
        rows.push({
          Campaign: op.campaign,
          'Ad Group': op.ad_group,
          'Max CPC': op.google?.max_cpc === undefined ? '' : money(op.google.max_cpc),
          'Ad Group Status': 'Paused',
        })
        break
      case 'create_ad': {
        const r: Record<string, string> = {
          Campaign: op.campaign,
          'Ad Group': op.ad_group,
          'Path 1': op.google?.path1 ?? '',
          'Path 2': op.google?.path2 ?? '',
          'Final URL': op.final_url.trim(),
          Status: 'Paused',
        }
        op.google?.headlines.forEach((h, i) => {
          r[H(i + 1)] = h
        })
        op.google?.descriptions.forEach((d, i) => {
          r[D(i + 1)] = d
        })
        rows.push(r)
        break
      }
      case 'add_keyword':
        rows.push({
          Campaign: op.campaign,
          'Ad Group': op.ad_group,
          Keyword: op.text.trim(),
          'Criterion Type': MATCH[op.match],
          'Max CPC': op.max_cpc === undefined ? '' : money(op.max_cpc),
          Status: 'Paused',
        })
        break
      case 'set_budget':
        rows.push({ Campaign: op.ref.campaign, Budget: money(op.after) })
        break
      case 'set_status': {
        const r = op.ref
        if (op.level === 'campaign')
          rows.push({ Campaign: r.campaign, 'Campaign Status': ST(op.status) })
        else if (op.level === 'ad_group')
          rows.push({
            Campaign: r.campaign,
            'Ad Group': r.ad_group ?? '',
            'Ad Group Status': ST(op.status),
          })
        else if (op.level === 'keyword')
          rows.push({
            Campaign: r.campaign,
            'Ad Group': r.ad_group ?? '',
            Keyword: r.keyword ?? '',
            'Criterion Type': MATCH[r.match ?? 'broad'],
            Status: ST(op.status),
          })
        // 单条广告的启停在 Editor 里要靠 #Original 列认广告，这里不出（插件在网页版做）
        break
      }
    }
  }
  const headers = GOOGLE_EDITOR_HEADERS.filter(
    (h) => h === 'Campaign' || rows.some((r) => (r[h] ?? '') !== ''),
  )
  const cells = rows.map((r) => headers.map((h) => r[h] ?? ''))
  return {
    name: 'google-ads-editor.csv',
    mime: 'text/csv',
    content: encodeDelimited([headers, ...cells], ','),
    sheet: 'editor',
    upload_from:
      'Google Ads Editor：账户 → 导入 → 从文件（导入后检查「待确认」的改动，再由人点发布）',
    headers,
    rows: cells,
  }
}
