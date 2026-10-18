/**
 * WP380（Luoye 10-17，决策 1066）：GEO 第二层——**比较胜率**、**描述准确度**、**对外说法一致性**、
 * **改完自动复查**，以及周报里「每个数标来路」和给 WP381 留的位置。
 *
 * 思路参考 Aleyda Solis《AI Search Optimization Checklist》（aleydasolis.com，2026-09-26 版），
 * 形状与口径是我们自己的。两条硬规矩沿用 WP321：
 *
 * - 数由规则数，模型只做「判断」那一步（这条回答更推荐谁、这句说得对不对），**必须附原话**，
 *   原话在回答里找不到就不算；界面与报告标「AI 判断」。
 * - 官方事实表带日期：事实改过，旧说法记「过时」而不是「错」。
 *
 * **只加不删**。
 */
import type { Iso8601 } from './common.js'
import type { AiPlatform } from './search-data.js'
import type { CitedSiteKind } from './seo.js'

/* ------------------------------------------------------------------ */
/* 官方事实表（从品牌档案来，人可改；带日期与以前的说法）                    */
/* ------------------------------------------------------------------ */

/** 官方事实表里的几格（描述准确度逐项对的就是这几样）。 */
export type GeoFactKey = 'name' | 'category' | 'price' | 'selling_points' | 'markets'

/** 展示顺序。 */
export const GEO_FACT_KEYS: readonly GeoFactKey[] = [
  'name',
  'category',
  'price',
  'selling_points',
  'markets',
]

/** 一条官方事实。`as_of` 起是这个说法；改过的旧说法留在 `previous`（新的在前）。 */
export interface GeoOfficialFact {
  key: GeoFactKey
  value: string
  /** 从哪天起是这个说法（`YYYY-MM-DD`）。 */
  as_of: string
  /** 从品牌档案跟过来的 / 人在这里改的（人改的不被档案盖）。 */
  source: 'profile' | 'human'
  /** 以前的说法（换过才有；新的在前）。AI 或网页说的是它们 → 记「过时」。 */
  previous?: { value: string; until: string }[]
}

/** 人改官方事实（`value` 空 = 退回跟品牌档案走）。 */
export interface GeoFactsPatch {
  facts: { key: GeoFactKey; value: string }[]
}

/* ------------------------------------------------------------------ */
/* 一条回答的「AI 判断」：比较胜率 + 描述准确度                             */
/* ------------------------------------------------------------------ */

/** 一句说法对不对：对 / 错 / 过时（说的是以前的官方说法）。 */
export type GeoClaimVerdict = 'correct' | 'wrong' | 'outdated'

/** 回答里说到我们的一句（名称 / 品类 / 价格 / 卖点 / 市场）。 */
export interface GeoAnswerClaim {
  field: GeoFactKey
  verdict: GeoClaimVerdict
  /** 回答里说的是什么（模型复述，短）。 */
  said: string
  /** 回答原话（逐字；对不上的整条丢掉）。 */
  quote: string
}

/** 回答把我们和竞品比时更推荐谁：我们 / 竞品 / 没分高下。 */
export type GeoCompareVerdict = 'ours' | 'competitor' | 'tie'

/** 一条回答的 AI 判断（`geo_insights`；只对提到我们的回答判）。 */
export interface GeoAnswerInsight {
  answer_id: string
  /** 同时提到我们与竞品时才有；回答没在比较就不写。 */
  compare?: { verdict: GeoCompareVerdict; rival?: string; quote: string }
  claims: GeoAnswerClaim[]
  /** 判的时候官方事实表是哪天的（最新那格的 `as_of`）。 */
  facts_as_of?: string
  judged_at: Iso8601
}

/* ------------------------------------------------------------------ */
/* 对外说法一致性                                                          */
/* ------------------------------------------------------------------ */

/** 被对照的页面是哪一类。 */
export type GeoSurface =
  | 'site'
  | 'product_page'
  | 'structured_data'
  | 'listing'
  | 'review'
  | 'partner'

/** 改的事归哪个岗位（岗位模板 id）：建站 / 网站运营 / 公关。 */
export type GeoFixOwner = 'site' | 'web-ops' | 'pr'

/** 一处过时或说法不一。 */
export interface GeoConsistencyFinding {
  id: string
  url: string
  surface: GeoSurface
  field: GeoFactKey
  verdict: 'wrong' | 'outdated'
  /** 页面上写的是什么。 */
  said: string
  /** 页面原话（规则找到的、或模型摘的且在页面里对得上的）。 */
  quote?: string
  /** 官方说法与日期。 */
  official: string
  official_as_of: string
  owner: GeoFixOwner
  by: 'rules' | 'ai'
}

/** 这一次对了哪几页（取不到的照实写）。 */
export interface GeoConsistencyPage {
  url: string
  surface: GeoSurface
  status: 'ok' | 'failed' | 'skipped'
  reason?: string
}

/** 一次一致性检查。 */
export interface GeoConsistencyRun {
  id: string
  at: Iso8601
  /** 官方事实表最新那格的日期。 */
  facts_as_of?: string
  pages: GeoConsistencyPage[]
  findings: GeoConsistencyFinding[]
  /** 出了分派卡才有。 */
  card_id?: string
  /** 来源批次（同一次检查派出去的几件事带同一个，同 WP350）。 */
  batch_id?: string
}

/* ------------------------------------------------------------------ */
/* 改完自动复查                                                            */
/* ------------------------------------------------------------------ */

/** 复查看哪个数。 */
export type GeoRecheckMetric = 'mention_rate' | 'citation_rate' | 'win_rate' | 'accuracy'

/** 复查之后的建议：保留 / 扩大 / 修改 / 停。 */
export type GeoRecheckAdvice = 'keep' | 'expand' | 'modify' | 'stop'

/** 复查前 / 后那一边：这组问题上的数与样本量。 */
export interface GeoRecheckSide {
  /** 0–1；没有样本不写。 */
  value?: number
  n: number
  /** 前：取的是哪一周的回答；后：复查那一轮的周。 */
  week?: string
}

/** 一张 GEO 改动的复查记录（`geo_rechecks`）。 */
export interface GeoRecheck {
  id: string
  created_at: Iso8601
  /** 从哪来：变化大出的事项 / 一致性分派 / 人自己登记的。 */
  source: 'alert' | 'consistency' | 'human'
  /** 改了什么（一句人话）。 */
  change: string
  /** 期望哪个数动。 */
  metric: GeoRecheckMetric
  /** 到期重跑的那组问题。 */
  prompt_ids: string[]
  markets?: string[]
  owner?: GeoFixOwner | 'content'
  matter_id?: string
  /** 复查日期（`YYYY-MM-DD`）。 */
  due: string
  before: GeoRecheckSide
  status: 'waiting' | 'done' | 'skipped'
  /** 到期重跑过几次（没拿到回答会再等一周，最多两次）。 */
  tries?: number
  after?: GeoRecheckSide
  /** 前后差几个百分点（两边都有数才写）。 */
  delta_pp?: number
  advice?: GeoRecheckAdvice
  /** 一句为什么。 */
  why?: string
  run_id?: string
  card_id?: string
}

/** 登记一条复查（人在别处改了东西也能登记）。 */
export interface GeoRecheckInput {
  change: string
  metric: GeoRecheckMetric
  prompt_ids: string[]
  /** 几天后复查（不写按职责阈值，默认 14）。 */
  due_days?: number
  matter_id?: string
  owner?: GeoRecheck['owner']
}

/* ------------------------------------------------------------------ */
/* 看板与周报                                                              */
/* ------------------------------------------------------------------ */

/** 缺位的主要原因（十种，决定交给谁）。 */
export type GeoGapCause =
  | 'not_crawlable'
  | 'not_readable'
  | 'not_useful'
  | 'outdated'
  | 'no_difference'
  | 'not_recognized'
  | 'inconsistent'
  | 'no_corroboration'
  | 'not_trusted'
  | 'not_buyable'

/** 报告里一个数的来路：实测 / 推算 / 估算。 */
export type GeoFigureBasis = 'measured' | 'derived' | 'estimated'

/** 报告里的一个数（带来路、样本量、日期）。 */
export interface GeoReportFigure {
  key: string
  label: string
  /** 已排好的样子（「38%」「第 2.1」「约 16 积分」）。 */
  value: string
  basis: GeoFigureBasis
  n?: number
  /** 数据是哪天的（`YYYY-MM-DD`）。 */
  as_of: string
}

/** 站外来源地图的一行：某个市场里某一类站被引用的情况，和该交给谁。 */
export interface GeoSourceMapRow {
  market: string
  /** 自有 / 媒体 / 用户社区（另有电商平台、视频）。 */
  group: 'owned' | 'media' | 'community' | 'marketplace' | 'video' | 'other'
  site_kind: CitedSiteKind
  /** 被引用次数多的在前（最多 5 个）。 */
  domains: { domain: string; citations: number; mentions_us: boolean }[]
  citations: number
  /** 交给谁：公关（媒体）/ 评价 / 社区 / 红人 / 内容（自有）。 */
  owner: 'pr' | 'reviews' | 'community' | 'kol' | 'content'
}

/** WP381 的数据放进周报的位置（没有就不显示）。 */
export interface GeoReportSlot {
  title: string
  lines: string[]
  basis?: GeoFigureBasis
  n?: number
  as_of?: string
}

/** 看板「说得对不对、比得过谁」那一块要的数（规则数；判断那一步是 AI，附原话）。 */
export interface GeoQualityView {
  week?: string
  /** 近 4 周逐项：对 / 错 / 过时各几条。 */
  fields: { field: GeoFactKey; correct: number; wrong: number; outdated: number }[]
  /** 最新一周说错 / 过时的那几句（最多 10 条）。 */
  bad_claims: {
    answer_id: string
    week: string
    platform: AiPlatform
    market: string
    prompt_text: string
    field: GeoFactKey
    verdict: 'wrong' | 'outdated'
    said: string
    quote: string
    official?: string
  }[]
  /** 近 4 周和每个竞品比：赢 / 输 / 平。 */
  rivals: { name: string; wins: number; losses: number; ties: number }[]
  facts: GeoOfficialFact[]
  consistency?: GeoConsistencyRun
  /** 等着复查的 + 最近复查过的（最多 10 条）。 */
  rechecks: GeoRecheck[]
  by: 'ai'
}
