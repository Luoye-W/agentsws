/**
 * WP330（docs/102 附：甲方周报要求 + 文末「Luoye 10-14 定」）：**Reddit 周报**的形状。
 *
 * 每周五 17:00 左右（本周最后一次巡查之后）出一份，数据窗口「周日 00:00 — 出报告那一刻」（都可改）：
 * 1. 自家版块本周帖子数 / 评论数；
 * 2. 自家版块的 VOC（用户声音）与 UGC（用户自发内容），只列有效的；
 * 3. 外部社区 VOC 与舆情：按话题归组「话题概括（post / comment × 数量），评估」，下附每条原文（作者、时间、链接）；
 * 4. 我们账号本周回了几条帖子 / 评论 + 链接清单（来自发出记录，WP323）。
 * **不截图**：一律原文引用 + 链接。
 *
 * 数据从 WP328（读与每日巡查）来：它把巡查入库的每一条按 {@link RedditWatchItem} 交出来；
 * 周报只做「按窗口挑、数、归组、排版」，数字不经模型手（docs/29）。
 *
 * 分节与措辞（{@link RedditWeeklyFormat}）是品牌自己的：用户几句话交代，AI 用工具改；不写死任何一家甲方的格式。
 */
import type { Iso8601 } from './common.js'

/* ── WP328 交给周报的那一份 ─────────────────────────────────────────────── */

/** 外部社区话题的评估（WP328 的 AI 判；周报按最重的那一档归到话题上）。 */
export type RedditAssessment = 'no_action' | 'low_relevance' | 'follow_up'

/** 评估从轻到重（话题取组里最重的那一档）。 */
export const REDDIT_ASSESSMENTS: readonly RedditAssessment[] = [
  'no_action',
  'low_relevance',
  'follow_up',
]

/** 巡查入库的一条（自家版块的帖子 / 评论，或外部社区的关键词命中）。 */
export interface RedditWatchItem {
  /** Reddit 全名：帖子 `t3_…`、评论 `t1_…`（同一条只算一次）。 */
  id: string
  kind: 'post' | 'comment'
  /** `own` = 自家版块（用户配的那几个）；`external` = 外部社区（关键词监测命中）。 */
  scope: 'own' | 'external'
  /** 版块名（不带 `r/`）。 */
  subreddit: string
  /** 作者用户名（不带 `u/`）；删号的照 Reddit 写 `[deleted]` 或不给。 */
  author?: string
  /** 在 Reddit 上发出的时间（`created_utc`）。**窗口按它算**，不按我们读到的时间。 */
  created_at: Iso8601
  /** 永久链接（完整的 `https://www.reddit.com/r/…`）。 */
  permalink: string
  /** 帖子标题；评论给它所在帖子的标题。 */
  title?: string
  /** 原文（帖子正文 / 评论全文）。外部文本，只作引用。 */
  text: string
  /** 原文被删了（作者删 / 版主删）：照样计数，但周报不引用原话（Reddit 条款）。 */
  deleted?: boolean
  /** 自家版块：AI 判过「是有效的 VOC / UGC」才带（无效的不带，周报只列有效的）。 */
  signals?: {
    voc?: boolean
    ugc?: boolean
    /** 一句话概括（AI 写的，可选；没给就只列原文）。 */
    note?: string
  }
  /** 外部社区：话题归组（`key` 用来跨天合并，`label` 是「话题概括」那句话）。 */
  topic?: { key: string; label: string }
  /** 外部社区：这一条的评估。 */
  assessment?: RedditAssessment
  /** 外部社区：命中的关键词。 */
  keyword?: string
}

/* ── 分节与措辞（用户几句话交代，可改） ──────────────────────────────────── */

/** 周报的四节（顺序、标题、开关、引言都可改）。 */
export type RedditWeeklySectionId = 'own_stats' | 'voc_ugc' | 'external' | 'our_replies'

export const REDDIT_WEEKLY_SECTION_IDS: readonly RedditWeeklySectionId[] = [
  'own_stats',
  'voc_ugc',
  'external',
  'our_replies',
]

export interface RedditWeeklySectionFormat {
  id: RedditWeeklySectionId
  /** 小节标题（用户怎么叫就怎么写）。 */
  title: string
  enabled: boolean
  /** 标题下面的一句引言（可选）。 */
  intro?: string
}

export interface RedditWeeklyFormat {
  /** 周报标题；`{brand}` `{start}` `{end}` 会换成品牌名与窗口起止日期。 */
  title: string
  /** 小节（数组顺序 = 出现顺序；四节都在，关掉的 `enabled: false`）。 */
  sections: RedditWeeklySectionFormat[]
  /** 小节编号：`zh` 一、二、三 / `arabic` 1. 2. 3. / `none` 不编号。 */
  numbering: 'zh' | 'arabic' | 'none'
  /** 三档评估在周报里怎么写。 */
  assessment_labels: Record<RedditAssessment, string>
  /** 原文引用最多几个字（多了截断加「…」）。 */
  quote_max_chars: number
  /** 每个话题下最多列几条原文（0 = 全列）。 */
  max_quotes_per_topic: number
  /** 时间写法（只认 YYYY MM DD HH mm 记号）。 */
  date_format: string
  /** 数据窗口从周几 00:00 开始（0 = 周日）。 */
  window_start_weekday: number
  /** 用户最近一次交代的原话（留底，AI 再改时读）。 */
  instruction?: string
  updated_at?: Iso8601
}

/** 默认分节与措辞（通用说法，不是某一家甲方的格式）。 */
export const DEFAULT_REDDIT_WEEKLY_FORMAT: RedditWeeklyFormat = {
  title: '{brand} Reddit 周报（{start} – {end}）',
  sections: [
    { id: 'own_stats', title: '自家版块数据', enabled: true },
    { id: 'voc_ugc', title: '自家版块 VOC 与 UGC', enabled: true },
    { id: 'external', title: '外部社区 VOC 与舆情', enabled: true },
    { id: 'our_replies', title: '我们本周的回复', enabled: true },
  ],
  numbering: 'zh',
  assessment_labels: {
    no_action: '日常讨论，无需处理',
    low_relevance: '相关度不高，不建议回复',
    follow_up: '需跟进',
  },
  quote_max_chars: 280,
  max_quotes_per_topic: 0,
  date_format: 'MM/DD HH:mm',
  window_start_weekday: 0,
}

/* ── 出来的那一份（周报卡的 payload，也是导出文档的来源） ──────────────────── */

/** 周报里的一条原文引用（不截图：原话 + 作者 + 时间 + 链接）。 */
export interface RedditWeeklyQuote {
  id: string
  kind: 'post' | 'comment'
  subreddit: string
  author?: string
  at: Iso8601
  url: string
  title?: string
  /** 截断过的原话；原文被删了就是空串，`deleted: true`。 */
  text: string
  deleted?: boolean
  note?: string
}

/** 外部社区的一个话题。 */
export interface RedditWeeklyTopic {
  key: string
  /** 话题概括。 */
  label: string
  posts: number
  comments: number
  /** 组里最重的那一档。 */
  assessment: RedditAssessment
  quotes: RedditWeeklyQuote[]
  /** 原文多于 `max_quotes_per_topic` 时没列出来的条数。 */
  more: number
}

/** 我们本周发出去的一条（来自发出记录）。 */
export interface RedditWeeklyReply {
  record_id: string
  at: Iso8601
  /** `post` = 回的是帖子；`comment` = 回的是评论（楼中楼）；`new_post` = 我们发的新帖。 */
  target: 'post' | 'comment' | 'new_post'
  /** 我们那一条的链接（没有就是原帖链接）。 */
  url?: string
  destination?: string
  thread_title?: string
  /** 我们发的那句（截断过）。 */
  text: string
}

export type RedditWeeklySection =
  | {
      id: 'own_stats'
      title: string
      intro?: string
      subreddits: string[]
      posts: number
      comments: number
    }
  | {
      id: 'voc_ugc'
      title: string
      intro?: string
      voc: RedditWeeklyQuote[]
      ugc: RedditWeeklyQuote[]
    }
  | {
      id: 'external'
      title: string
      intro?: string
      topics: RedditWeeklyTopic[]
    }
  | {
      id: 'our_replies'
      title: string
      intro?: string
      to_posts: number
      to_comments: number
      new_posts: number
      replies: RedditWeeklyReply[]
    }

export interface RedditWeeklyPayload {
  kind: 'reddit_weekly'
  /** 窗口起点那天（本地日期 YYYY-MM-DD；同一周同一份）。 */
  week_of: string
  window: { since: Iso8601; until: Iso8601 }
  generated_at: Iso8601
  title: string
  /** 一句话概括（卡的摘要）。 */
  summary: string
  /** 按配置的顺序，只含开着的小节。 */
  sections: RedditWeeklySection[]
  totals: {
    posts: number
    comments: number
    voc: number
    ugc: number
    topics: number
    follow_up_topics: number
    external_items: number
    to_posts: number
    to_comments: number
    new_posts: number
  }
  /** 窗口里巡查了几次、最后一次什么时候（没巡查的那几天照实说）。 */
  sweeps: { count: number; last_at?: Iso8601 }
  /** 可复制 / 导出的文档（Markdown）。 */
  markdown: string
  /** 三档评估的写法（卡上照它显示）。 */
  assessment_labels: Record<RedditAssessment, string>
}

/** 发出记录里周报那一行的动作（记录去处只有点名 `weekly_report` 才记，见 {@link OUTBOUND_OPT_IN_ACTIONS}）。 */
export const REDDIT_WEEKLY_ACTION = 'weekly_report'

/**
 * 发出记录里「只有点名才记」的动作：记录去处的筛选里 `actions` 明确列了它才写进去
 * （没列筛选 = 全记，但不含这些——周报不是「发出去的一条回复」，不该默认混进回复记录表）。
 */
export const OUTBOUND_OPT_IN_ACTIONS: readonly string[] = [REDDIT_WEEKLY_ACTION]
