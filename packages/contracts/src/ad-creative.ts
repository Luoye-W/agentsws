/**
 * WP317（docs/101 §5.1④，决策 559）：**广告素材流水线**的契约。
 *
 * 这是 Austin 那套做法（docs/100 §1.2）落进投放岗的形状：
 * 导出表进来 → 挑出表现差的 → 标题、描述两个子 Agent 各写一份 →
 * 本地按平台字数 / 条数 / 禁用词过一遍 → 出可下载的上传表（人自己去后台传）
 * → 需要图的交设计岗批量出（L3 下单、L2 挑图、L1 入库）→ 每一轮记一笔实验。
 *
 * 四条纪律写在类型里：
 *
 * 1. **一条文案带着它的字数与上限走**（{@link AdCopyLine}）。卡面与上传表上
 *    看到的那个数，与本地校验判的是同一个数（Google 双宽字按 2 算）。
 * 2. **挡下来的不悄悄丢**（{@link AdCopyRejection}）。超字数、撞禁用词、
 *    为了绕过审核把禁用词拆开写（`f.r.e.e`、`免 费`）——每一条都带一句人话
 *    摆出来，由人或模型重写，不由本地「修」成一句能过的话。
 * 3. **样本不够的不算「表现差」**（{@link AdCreativeWeakAd.verdict}）。
 *    展示太少时最差的那条只是个问题，不是结论。
 * 4. **实验记录按品牌存**（{@link AdExperimentEntry}），三格固定：
 *    假设 / 改了什么 / 结果。结果可以晚一点回填，前两格不许空。
 *
 * 本文件只放跨包的形状；规则与计算在 `@agentsws/ads-core` 的 `creative/` 下。
 */

import type { Iso8601 } from './common.js'

/** 素材流水线目前写得了的两个平台（另两家没有导出表与上传表的口子）。 */
export type AdCreativePlatform = 'google' | 'meta'

export const AD_CREATIVE_PLATFORMS: readonly AdCreativePlatform[] = ['google', 'meta']

/** 一条文案是标题还是描述（Meta 的「描述」= 正文 primary text）。 */
export type AdCopyField = 'headline' | 'description'

/** 按哪个数挑「表现差」。默认点击率（导出表里最常有的一列）。 */
export type AdCreativeMetric = 'ctr' | 'cvr' | 'cpa' | 'roas'

/** 导出表里的一条广告（两家的列名已经对齐成这一套）。 */
export interface AdPerformanceRow {
  /** 表里那一行的广告 id；导出表没有 id 时用「系列 / 组 / 第几行」拼一个。 */
  ad_id: string
  platform: AdCreativePlatform
  campaign: string
  ad_group: string
  headlines: string[]
  descriptions: string[]
  final_url?: string
  impressions: number
  clicks: number
  conversions?: number
  cost?: number
  conversion_value?: number
}

/** 一条表现差（或样本不够）的广告，以及为什么。 */
export interface AdCreativeWeakAd {
  ad_id: string
  campaign: string
  ad_group: string
  metric: AdCreativeMetric
  /** 这条的值（缺数时没有）。 */
  value?: number
  /** 同一张表里够样本的那些的中位数。 */
  baseline?: number
  /** `weak` = 够样本且明显差；`thin` = 样本不够，先不判。 */
  verdict: 'weak' | 'thin'
  /** 一句人话（卡面与面板上原样用）。 */
  reason: string
}

/** 写出来、过了本地校验的一条文案。 */
export interface AdCopyLine {
  field: AdCopyField
  text: string
  /** 按平台口径数的字数（Google 双宽字算 2）。 */
  chars: number
  /** 这个平台这一格的上限。 */
  limit: number
  /** 这条从哪来（哪条评价 / 哪张事实卡 / 哪条旧广告）；模型给了就带着。 */
  source?: string
  /** 角度（痛点 / 结果 / 口碑…）；模型给了就带着。 */
  angle?: string
}

/** 被挡下来的一条，以及为什么。 */
export interface AdCopyRejection {
  field: AdCopyField
  text: string
  rule:
    | 'too_long'
    | 'empty'
    | 'duplicate'
    | 'over_count'
    | 'forbidden'
    | 'evasion'
    | 'commitment'
    /** 以 `=` / `@` 开头（表格软件会当公式执行）、或夹了换行与制表符。 */
    | 'format'
  /** 一句人话：为什么挡、该怎么重写（**不替它改**）。 */
  reason: string
}

/** 一条广告这一轮的产出。 */
export interface AdCreativeRewrite {
  ad_id: string
  campaign: string
  ad_group: string
  headlines: AdCopyLine[]
  descriptions: AdCopyLine[]
  rejected: AdCopyRejection[]
  /** 少于平台最少条数、模型没接上之类的话。 */
  notes: string[]
}

/** 一轮（一次「出新文案」）。 */
export interface AdCreativeRound {
  id: string
  platform: AdCreativePlatform
  import_id: string
  rewrites: AdCreativeRewrite[]
  /** 这一轮带进上下文的实验记录条数（让人知道「上次学到的」用上了没有）。 */
  experiments_used: number
  created_at: Iso8601
}

/** 一次导入（用户上传的导出表）。 */
export interface AdCreativeImport {
  id: string
  platform: AdCreativePlatform
  metric: AdCreativeMetric
  rows: AdPerformanceRow[]
  weak: AdCreativeWeakAd[]
  /** 读不懂的行 / 缺的列，人话。 */
  notes: string[]
  created_at: Iso8601
}

/**
 * 一笔实验记录（Austin 的「简易记忆」，docs/100 §1.2）。
 *
 * 按品牌存（一个品牌一张库）；下次出文案时最近几笔带进上下文。
 */
export interface AdExperimentEntry {
  id: string
  /** 第几轮（同一品牌内递增）。 */
  round: number
  platform?: AdCreativePlatform
  /** 假设：「标题里带价格点击率更高」。 */
  hypothesis: string
  /** 改了什么：「12 条标题里 6 条带价格」。 */
  change: string
  /** 结果：「带价格的 CTR 2.1% vs 1.4%（10-01 到 10-07）」。可以晚点回填。 */
  result?: string
  /** 关联的那一轮（如果是从「出新文案」那一下记的）。 */
  round_id?: string
  /** 同步进投放岗记忆那一条的 id（岗位记忆面板里能看到它）。 */
  memory_id?: string
  at: Iso8601
  updated_at?: Iso8601
}

/** 上传表（可下载的那一份）。 */
export interface AdUploadSheet {
  /** `google_csv`：Google 批量上传 CSV；`meta_tsv`：Meta 导入可粘贴文字（制表符分隔）。 */
  format: 'google_csv' | 'meta_tsv'
  filename: string
  content_type: string
  text: string
  /** 几行广告。 */
  rows: number
  /** 一句提醒（新建一律「已暂停」、列名以 WP314 为准之类）。 */
  notes: string[]
}
