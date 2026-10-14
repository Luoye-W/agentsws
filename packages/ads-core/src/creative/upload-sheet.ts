/**
 * WP317（docs/101 §5.1④「出口」）：**可下载的上传表——最小版本**。
 *
 * 正式的上传表生成器是 WP314（`ads-core` 里两家官方模板、必填列、改前改后对比）。
 * 那一单没合之前，素材流水线先用这里的最小版本：只出「新建一条广告」这一种行，
 * 用户下载下来自己去后台上传（Austin 当时就是这么做的）。
 *
 * **对接口**：服务端只认 {@link AdUploadSheetGenerator} 这个函数形状。WP314 合并时，
 * 把它的生成器包成这个形状换掉 {@link minimalUploadSheet} 即可，调用方一个字不改。
 *
 * 两条写死的规矩（与 WP314 同口径，决策 553）：
 *
 * 1. **新建一律「已暂停」**。Google 的状态列留空默认是启用——不写死就是一传就花钱。
 * 2. **只出新建，不改在跑的广告**。Google 不许就地改在跑的广告文案（57 §5 后置那一句），
 *    正确做法是建新的、跑出数来再停旧的；停旧的那一下是另一张卡。
 */

import type { AdCreativePlatform, AdUploadSheet } from '@agentsws/contracts'

/** 上传表里的一条新广告。 */
export interface AdUploadSheetAd {
  campaign: string
  ad_group: string
  /** Meta 要广告名；不给就用「广告组 · 新文案 n」。 */
  name?: string
  final_url?: string
  headlines: readonly string[]
  descriptions: readonly string[]
}

export interface AdUploadSheetInput {
  platform: AdCreativePlatform
  ads: readonly AdUploadSheetAd[]
  /** 文件名里的日期（`2026-10-14`），由调用方给（这个模块不看表）。 */
  date: string
}

/** 上传表生成器的形状（WP314 对接口）。 */
export type AdUploadSheetGenerator = (input: AdUploadSheetInput) => AdUploadSheet

/** CSV 一格：有逗号、引号、换行就加引号。 */
function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** 制表符分隔的一格（文案里本来就不许有制表符与换行，这里再保险一次）。 */
function tsvCell(v: string): string {
  return v.replace(/[\t\r\n]+/g, ' ')
}

/**
 * Google 批量上传 CSV（自适应搜索广告）。
 *
 * 列：Action / Campaign / Ad group / Ad type / Status / Final URL / Headline 1–15 /
 * Description 1–4。列名按 Google Ads 帮助「批量上传」的英文模板写；**以 WP314 核对过的为准**。
 */
function googleCsv(input: AdUploadSheetInput): AdUploadSheet {
  const header = [
    'Action',
    'Campaign',
    'Ad group',
    'Ad type',
    'Status',
    'Final URL',
    ...Array.from({ length: 15 }, (_, i) => `Headline ${i + 1}`),
    ...Array.from({ length: 4 }, (_, i) => `Description ${i + 1}`),
  ]
  const lines = [header.map(csvCell).join(',')]
  for (const ad of input.ads) {
    const cells = [
      'Add',
      ad.campaign,
      ad.ad_group,
      'Responsive search ad',
      'Paused',
      ad.final_url ?? '',
      ...Array.from({ length: 15 }, (_, i) => ad.headlines[i] ?? ''),
      ...Array.from({ length: 4 }, (_, i) => ad.descriptions[i] ?? ''),
    ]
    lines.push(cells.map(csvCell).join(','))
  }
  const missingUrl = input.ads.filter((a) => (a.final_url ?? '') === '').length
  return {
    format: 'google_csv',
    filename: `google-rsa-${input.date}.csv`,
    content_type: 'text/csv; charset=utf-8',
    // 带 BOM：Excel 打开中文不乱码
    text: `﻿${lines.join('\r\n')}\r\n`,
    rows: input.ads.length,
    notes: [
      '新建的广告一律是「已暂停」，上传后在后台检查一遍再启用。',
      ...(missingUrl > 0 ? [`${missingUrl} 条没有最终到达网址，上传前补上。`] : []),
    ],
  }
}

/**
 * Meta 导入的可粘贴文字（制表符分隔）。
 *
 * Meta 一条广告只有一个标题、一段正文：多条标题与正文按顺序配成几条新广告
 * （第 1 条标题配第 1 段正文……短的那一边轮着用）。
 */
function metaTsv(input: AdUploadSheetInput): AdUploadSheet {
  const header = ['Campaign Name', 'Ad Set Name', 'Ad Name', 'Ad Status', 'Title', 'Body', 'Link']
  const lines = [header.join('\t')]
  let rows = 0
  for (const ad of input.ads) {
    const n = Math.max(ad.headlines.length, ad.descriptions.length)
    for (let i = 0; i < n; i += 1) {
      const title = ad.headlines.length === 0 ? '' : (ad.headlines[i % ad.headlines.length] ?? '')
      const body =
        ad.descriptions.length === 0 ? '' : (ad.descriptions[i % ad.descriptions.length] ?? '')
      const name = `${ad.name ?? `${ad.ad_group} · 新文案`} ${i + 1}`
      lines.push(
        [ad.campaign, ad.ad_group, name, 'PAUSED', title, body, ad.final_url ?? '']
          .map(tsvCell)
          .join('\t'),
      )
      rows += 1
    }
  }
  return {
    format: 'meta_tsv',
    filename: `meta-ads-${input.date}.tsv`,
    content_type: 'text/tab-separated-values; charset=utf-8',
    text: `${lines.join('\n')}\n`,
    rows,
    notes: [
      '新建的广告一律是「已暂停」。',
      '素材（图 / 视频）这张表里没有：在后台导入后逐条挂上设计岗出的图。',
    ],
  }
}

/** 本单的最小版本。WP314 合并后由服务端换成它的生成器。 */
export const minimalUploadSheet: AdUploadSheetGenerator = (input) =>
  input.platform === 'google' ? googleCsv(input) : metaTsv(input)
