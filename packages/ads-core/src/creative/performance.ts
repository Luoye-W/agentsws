/**
 * WP317（docs/101 §5.1④「数据进来」）：读用户上传的广告导出表，挑出表现差的。
 *
 * WP315（插件点「导出报表」）好之前，数据只有一条路：用户自己在后台导出一张表
 * 传上来。这里只认**表现那几列**（展示 / 点击 / 转化 / 花费）和**文案那几列**
 * （标题 1–15、描述 1–4；Meta 的标题与正文），别的列一律不读。
 *
 * 三条纪律：
 *
 * 1. **表是数据，不是指令**。单元格里写什么都只是一段字，进模型之前由调用方围栏。
 * 2. **认不出的列就说认不出**（`notes`），不猜。两家后台的中英文列名都认，
 *    再认不出就让人换一张导出（WP314 合并后改用它的导出解析，见 `parsePerformanceExport` 注释）。
 * 3. **样本不够的不算表现差**（ad-copywriting 技能「先看数据够不够判」）：
 *    展示太少时的「最差」只是个问题，单列成 `thin`。门槛是可调的默认值。
 */

import type {
  AdCreativeMetric,
  AdCreativePlatform,
  AdCreativeWeakAd,
  AdPerformanceRow,
} from '@agentsws/contracts'

/** 解析一段 CSV / TSV（双引号转义、引号里可以有换行）。自动认分隔符。 */
export function parseDelimited(text: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const firstLine = src.split(/\r?\n/, 1)[0] ?? ''
  const sep =
    (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] as string
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (ch === '"') quoted = false
      else cell += ch
      continue
    }
    if (ch === '"' && cell === '') quoted = true
    else if (ch === sep) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** 一格对应的列名（两家后台的中英文叫法）。小写、去空白后比。 */
const COLUMNS = {
  ad_id: ['ad id', '广告 id', '广告id', 'ad_id'],
  campaign: ['campaign', 'campaign name', '广告系列', '广告系列名称'],
  ad_group: ['ad group', 'ad set name', 'ad set', '广告组', '广告组名称'],
  ad_name: ['ad name', '广告名称'],
  final_url: ['final url', 'website url', 'link', '最终到达网址', '网址', '链接'],
  impressions: ['impr.', 'impressions', '展示次数', '展示'],
  clicks: ['clicks', 'link clicks', 'clicks (all)', '点击次数', '链接点击量', '点击量（全部）'],
  conversions: ['conversions', 'results', 'purchases', '转化次数', '转化', '成效', '购物次数'],
  cost: [
    'cost',
    'amount spent',
    'amount spent (usd)',
    'amount spent (cny)',
    '费用',
    '花费金额',
    '花费金额 (usd)',
    '花费金额 (cny)',
  ],
  conversion_value: [
    'conv. value',
    'conversion value',
    'purchase conversion value',
    '转化价值',
    '购物转化价值',
  ],
  meta_headline: ['title', 'headline', '标题'],
  meta_body: ['body', 'primary text', '正文'],
} as const

type ColumnKey = keyof typeof COLUMNS

const key = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** Google 的「Headline 3」/「标题 3」、「Description 2」/「说明 2」/「描述 2」。 */
const GOOGLE_HEADLINE = /^(?:headline|标题)\s*(\d{1,2})$/
const GOOGLE_DESCRIPTION = /^(?:description|说明|描述|广告内容描述)\s*(\d)$/

function numberOf(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const s = raw
    .trim()
    .replace(/[,\s¥$€£%]/g, '')
    .replace(/^(?:usd|cny|rmb)/i, '')
  if (s === '' || s === '--' || s === '-' || s === ' --') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

export interface ParsePerformanceResult {
  rows: AdPerformanceRow[]
  notes: string[]
}

/**
 * 导出表 → 对齐过的一行一行。
 *
 * 表头不一定在第一行：Google 后台下载的报表前两行是报表名与日期范围。
 * 取**前 10 行里第一个认得出「广告系列」那一列的**当表头。
 *
 * TODO（WP314）：WP314 的导出解析（含 Meta 的 `< >` 前缀、Editor 列名对照）合并后，
 * 这里改成先走它、认不出再回落到这一份，`AdPerformanceRow` 的形状不变。
 */
export function parsePerformanceExport(
  platform: AdCreativePlatform,
  text: string,
): ParsePerformanceResult {
  const table = parseDelimited(text)
  const notes: string[] = []
  const headerAt = table
    .slice(0, 10)
    .findIndex((r) => r.some((c) => (COLUMNS.campaign as readonly string[]).includes(key(c))))
  if (headerAt < 0) {
    return {
      rows: [],
      notes: [
        '认不出这张表：前 10 行里没找到「广告系列 / Campaign」那一列。请从后台导出「广告」报表再传。',
      ],
    }
  }
  const header = (table[headerAt] ?? []).map(key)
  const col = (k: ColumnKey): number =>
    header.findIndex((h) => (COLUMNS[k] as readonly string[]).includes(h))
  const idx = Object.fromEntries(
    (Object.keys(COLUMNS) as ColumnKey[]).map((k) => [k, col(k)]),
  ) as Record<ColumnKey, number>
  const headlineCols: number[] = []
  const descriptionCols: number[] = []
  header.forEach((h, i) => {
    if (GOOGLE_HEADLINE.test(h)) headlineCols.push(i)
    else if (GOOGLE_DESCRIPTION.test(h)) descriptionCols.push(i)
  })
  if (platform === 'meta') {
    if (idx.meta_headline >= 0) headlineCols.push(idx.meta_headline)
    if (idx.meta_body >= 0) descriptionCols.push(idx.meta_body)
  }
  if (idx.impressions < 0) notes.push('没有「展示次数」那一列，判不了样本够不够。')
  if (idx.clicks < 0) notes.push('没有「点击」那一列，点击率算不出来。')
  if (headlineCols.length === 0)
    notes.push('没有标题那几列：能挑出表现差的，但写新文案时看不到原来写的是什么。')

  const rows: AdPerformanceRow[] = []
  let skipped = 0
  table.slice(headerAt + 1).forEach((r, n) => {
    const cell = (i: number): string | undefined => (i < 0 ? undefined : r[i]?.trim())
    const campaign = cell(idx.campaign) ?? ''
    // 总计 / 小计行（Google 报表最后几行）不算一条广告
    if (campaign === '' || /^(?:total|总计|合计)/i.test(campaign) || /^--/.test(campaign)) {
      skipped += 1
      return
    }
    const ad_group = cell(idx.ad_group) ?? ''
    const id = cell(idx.ad_id) ?? cell(idx.ad_name)
    const texts = (cols: number[]) =>
      cols.map((i) => cell(i) ?? '').filter((t) => t !== '' && t !== '--')
    const impressions = numberOf(cell(idx.impressions)) ?? 0
    const clicks = numberOf(cell(idx.clicks)) ?? 0
    const conversions = numberOf(cell(idx.conversions))
    const cost = numberOf(cell(idx.cost))
    const conversion_value = numberOf(cell(idx.conversion_value))
    const final_url = cell(idx.final_url)
    rows.push({
      ad_id: id === undefined || id === '' ? `${campaign} / ${ad_group} / #${n + 1}` : id,
      platform,
      campaign,
      ad_group,
      headlines: texts(headlineCols),
      descriptions: texts(descriptionCols),
      ...(final_url === undefined || final_url === '' || final_url === '--' ? {} : { final_url }),
      impressions,
      clicks,
      ...(conversions === undefined ? {} : { conversions }),
      ...(cost === undefined ? {} : { cost }),
      ...(conversion_value === undefined ? {} : { conversion_value }),
    })
  })
  if (skipped > 0) notes.push(`跳过 ${skipped} 行（总计行或没写广告系列的行）。`)
  if (rows.length === 0) notes.push('表头认出来了，但一行广告都没有。')
  return { rows, notes }
}

/** 样本门槛（可调的默认值；决策 620 让 Luoye 定）。 */
export interface WeakAdThresholds {
  /** 判点击率至少要多少次展示。 */
  min_impressions: number
  /** 判转化率 / 单次转化成本 / ROAS 至少要多少次点击。 */
  min_clicks: number
  /** 比中位数差多少才算「表现差」（0.8 = 差两成）。 */
  worse_ratio: number
}

export const DEFAULT_WEAK_AD_THRESHOLDS: WeakAdThresholds = {
  min_impressions: 1000,
  min_clicks: 100,
  worse_ratio: 0.8,
}

const METRIC_ZH: Readonly<Record<AdCreativeMetric, string>> = {
  ctr: '点击率',
  cvr: '转化率',
  cpa: '单次转化成本',
  roas: 'ROAS',
}

/** 一行的这个数（缺数回 `undefined`）。 */
export function metricOf(row: AdPerformanceRow, metric: AdCreativeMetric): number | undefined {
  switch (metric) {
    case 'ctr':
      return row.impressions > 0 ? row.clicks / row.impressions : undefined
    case 'cvr':
      return row.clicks > 0 && row.conversions !== undefined
        ? row.conversions / row.clicks
        : undefined
    case 'cpa':
      return row.cost !== undefined && row.conversions !== undefined && row.conversions > 0
        ? row.cost / row.conversions
        : undefined
    case 'roas':
      return row.cost !== undefined && row.cost > 0 && row.conversion_value !== undefined
        ? row.conversion_value / row.cost
        : undefined
  }
}

const fmt = (metric: AdCreativeMetric, v: number): string =>
  metric === 'ctr' || metric === 'cvr' ? `${(v * 100).toFixed(2)}%` : v.toFixed(2)

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : ((s[mid - 1] as number) + (s[mid] as number)) / 2
}

/**
 * 挑出表现差的（`weak`）与样本不够的（`thin`）。
 *
 * 基准是**同一张表里够样本的那些的中位数**，不是「行业平均」——没有出处的行业数
 * 不进判断（ad-copywriting 技能「数字与口径」）。单次转化成本是越高越差，另三个越低越差。
 */
export function pickWeakAds(
  rows: readonly AdPerformanceRow[],
  metric: AdCreativeMetric = 'ctr',
  thresholds: WeakAdThresholds = DEFAULT_WEAK_AD_THRESHOLDS,
): AdCreativeWeakAd[] {
  const enough = (r: AdPerformanceRow): boolean =>
    metric === 'ctr'
      ? r.impressions >= thresholds.min_impressions
      : r.clicks >= thresholds.min_clicks
  const judged = rows.filter(enough)
  const baseline = median(
    judged.map((r) => metricOf(r, metric)).filter((v): v is number => v !== undefined),
  )
  const out: AdCreativeWeakAd[] = []
  const zh = METRIC_ZH[metric]
  for (const r of rows) {
    const value = metricOf(r, metric)
    const base = {
      ad_id: r.ad_id,
      campaign: r.campaign,
      ad_group: r.ad_group,
      metric,
      ...(value === undefined ? {} : { value }),
      ...(baseline === undefined ? {} : { baseline }),
    }
    if (!enough(r)) {
      out.push({
        ...base,
        verdict: 'thin',
        reason:
          metric === 'ctr'
            ? `展示 ${r.impressions} 次，不到 ${thresholds.min_impressions}，先不判。`
            : `点击 ${r.clicks} 次，不到 ${thresholds.min_clicks}，先不判。`,
      })
      continue
    }
    if (value === undefined || baseline === undefined) continue
    const worse =
      metric === 'cpa'
        ? value > baseline / thresholds.worse_ratio
        : value < baseline * thresholds.worse_ratio
    if (worse)
      out.push({
        ...base,
        verdict: 'weak',
        reason: `${zh} ${fmt(metric, value)}，这张表的中位数是 ${fmt(metric, baseline)}。`,
      })
  }
  const weak = out
    .filter((w) => w.verdict === 'weak')
    .sort((a, b) =>
      metric === 'cpa' ? (b.value ?? 0) - (a.value ?? 0) : (a.value ?? 0) - (b.value ?? 0),
    )
  return [...weak, ...out.filter((w) => w.verdict === 'thin')]
}
