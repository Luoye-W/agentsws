/**
 * WP331（决策 691，Luoye 10-15）：**报告是能力，不是功能**。
 *
 * 周报、日报、月报……都不是写死的固定功能：用户说一句「每周五 17 点给我出一份……」，AI 用通用积木自己配出来——
 * 官方「自动化任务」（定时）+ 查巡查数据 + 立即巡查 + 查发出记录 + 发布报告（+ 记录去处）。这里只放这几块积木
 * 共用的形状，**不认平台、不认客户**。
 *
 * - {@link WatchItem}：巡查入库的一条（自家版块 / 外部社区），查巡查数据的工具按它筛、数、归组；
 * - {@link ReportPayload}：发布出来的一份报告（报表区的报表块，同一系列同一周期再发 = 同一份的新版本）。
 */
import type { Iso8601 } from './common.js'
import type { CompetitorChange } from './competitor-watch.js'

/** 巡查给外部条目的判断档（从轻到重）。与 WP328 的判断档字面一致。 */
export type WatchAssessment = 'no_action' | 'low_relevance' | 'follow_up'

export const WATCH_ASSESSMENTS: readonly WatchAssessment[] = [
  'no_action',
  'low_relevance',
  'follow_up',
]

/** 判断档的默认说法（AI 写报告时可以换成用户的说法）。 */
export const WATCH_ASSESSMENT_ZH: Readonly<Record<WatchAssessment, string>> = {
  no_action: '日常讨论，无需处理',
  low_relevance: '相关度不高，不建议回复',
  follow_up: '需跟进',
}

/** 巡查入库的一条（巡查那一单交出来的通用形状）。 */
export interface WatchItem {
  /** 平台上的全名 / 编号（同一条只算一次）。 */
  id: string
  /** 哪个平台（`reddit` …）。 */
  platform: string
  /** WP392：`change` = 竞品监控比出来的一条变化（`change` 那一格有全文；`platform` 是 `competitor`）。 */
  kind: 'post' | 'comment' | 'change'
  /** `own` = 自家地盘（用户配的版块 / 频道）；`external` = 外部社区（关键词命中）。 */
  scope: 'own' | 'external'
  /** 在哪（版块 / 频道名，不带前缀）。 */
  place: string
  author?: string
  /** 在平台上发出的时间。**时间窗按它算**，不按我们读到的时间。 */
  created_at: Iso8601
  url: string
  /** 帖子标题；评论给所在帖子的标题。 */
  title?: string
  /** 原文（外部文本，只作引用）。 */
  text: string
  /** 原文被删了：照样计数，不引用原话。 */
  deleted?: boolean
  /** 自家地盘：判过是有效的 VOC / UGC 才带。 */
  signals?: { voc?: boolean; ugc?: boolean; note?: string }
  /** 外部：话题（`key` 跨天稳定，`label` 是话题概括）。 */
  topic?: { key: string; label: string }
  /** 外部：判断档。 */
  assessment?: WatchAssessment
  /** 外部：命中的关键词。 */
  keyword?: string
  /** WP340：命中了告警词（标「优先」）。 */
  priority?: boolean
  /** WP340：本地标签（标签词命中的）。 */
  tags?: string[]
  /** WP392：`kind: 'change'` 时这条变化的全文（前后值、幅度、和自家比…）。 */
  change?: CompetitorChange
}

/** 发布出来的一份报告（报表块的 payload；也是复制 / 导出 .md 的来源）。 */
export interface ReportPayload {
  kind: 'report'
  /** 系列（同一系列 + 同一周期 = 同一份）。AI 不给就用标题。 */
  series: string
  title: string
  /** 这份覆盖哪段时间（人看的那一句）。 */
  period: string
  /** 周期从哪天起（`YYYY-MM-DD`，本地）；给了就按它认「同一周期」。 */
  period_start?: string
  /** 正文（Markdown；飞书 / Notion / Google 文档能直接贴）。 */
  markdown: string
  published_at: Iso8601
  /** 第几版（同一份再发 +1）。 */
  version: number
}

/** 发出记录里报告那一行的动作（记录去处只有点名才记，见 {@link OUTBOUND_OPT_IN_ACTIONS}）。 */
export const REPORT_OUTBOUND_ACTION = 'report'

/**
 * 发出记录里「只有点名才记」的动作：记录去处的筛选里 `actions` 明确列了它才写进去
 * （报告不是「发出去的一条回复」，不该默认混进回复记录表；决策 768 的口径）。
 */
export const OUTBOUND_OPT_IN_ACTIONS: readonly string[] = [
  REPORT_OUTBOUND_ACTION,
  // WP441：消息规则「记到某处」记下的来信——只进规则点名的那个去处（或筛选里明确列了它的）
  'message_rule',
]

/** WP441：发出记录里消息规则记下的那一行的动作。 */
export const MESSAGE_RULE_OUTBOUND_ACTION = 'message_rule'
