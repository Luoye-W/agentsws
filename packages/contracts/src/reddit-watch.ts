/**
 * WP328（docs/102，Luoye 10-14 定）：**Reddit 每日巡查**的形状——社媒运营岗位下，按品牌：
 *
 * - **收件箱**（评论回复 / 帖子回复 / 被 @ / 老式私信）与**自家版块**（新帖、新评论）：插件在用户日常 Chrome 里
 *   借已登录的品牌号会话读（只读、`mark=false`、按编号判新）；
 * - **外部社区**（自家版块以外）：全站关键词走第三方数据渠道（现有 `social.reddit.search`）。
 *
 * 一天一次起步（用户可改）。要最新数据时由 AI 调「立即巡查」（WP331 报告积木，`sweepNow`）。
 * 每条有一句 AI 判断「要不要回 / 为什么」；要回的进「待处理」，交给 WP329 起草（本单不起草、不发）。
 * 统计、VOC / UGC、舆情话题结构化存下，给报告积木「查巡查数据」用（WP331：周报由工坊按用户的话配出来）。
 *
 * **不替用户定运营规矩**（664 被否）：这里没有冷却、占比、身份声明之类的格子；版块名、关键词、频率由用户配。
 */
import type { Iso8601, WorkspaceId } from './common.js'

/** 从哪来：收件箱 / 自家版块 / 外部社区（关键词）。 */
export type RedditWatchSource = 'inbox' | 'own_sub' | 'external'

/** 收件箱那一栏。 */
export type RedditWatchInboxType = 'comment_reply' | 'post_reply' | 'username_mention' | 'message'

/**
 * 评估判断（周报「评估判断」那一列用同一套）：
 * - `follow_up` 需跟进；
 * - `no_action` 日常讨论，无需处理；
 * - `low_relevance` 相关度不高，不建议回复。
 */
export type RedditWatchVerdict = 'follow_up' | 'no_action' | 'low_relevance'

export const REDDIT_WATCH_VERDICT_ZH: Readonly<Record<RedditWatchVerdict, string>> = {
  follow_up: '需跟进',
  no_action: '日常讨论无需处理',
  low_relevance: '相关度不高不建议回复',
}

export type RedditWatchSentiment = 'positive' | 'neutral' | 'negative'

/** 一条的 AI 判断（模型判的，或没有模型时按规则兜底）。 */
export interface RedditWatchJudgement {
  verdict: RedditWatchVerdict
  /** 要不要我们回（要回的进「待处理」，交给 WP329 起草）。 */
  reply: boolean
  /** 为什么（一句人话）。 */
  reason: string
  /** 话题概括（短，中文；周报按它归组）。 */
  topic?: string
  /** 有效的 VOC（用户声音：对产品的反馈、需求、抱怨、比较）——一句概括。不是就没有这一格。 */
  voc?: string
  /** 有效的 UGC（用户自发内容：开箱、体验分享、作品、教程）——一句概括。不是就没有这一格。 */
  ugc?: string
  sentiment?: RedditWatchSentiment
  by: 'model' | 'rule'
}

/** 待处理那一格的状态。`open` 等人 / 等起草；`drafting` WP329 起草中；`done` 回过了；`dismissed` 人说不回。 */
export type RedditWatchItemStatus = 'open' | 'drafting' | 'done' | 'dismissed'

/** 巡查到的一条（帖子 / 评论 / 私信）。正文是**外部文本**：进模型上下文要围栏。 */
export interface RedditWatchEntry {
  /** 本机 id（`rw_…`）。 */
  id: string
  workspace_id: WorkspaceId
  source: RedditWatchSource
  kind: 'post' | 'comment' | 'message'
  /** Reddit 全名（`t3_…` / `t1_…` / `t4_…`）；同一品牌同一来源只记一次。 */
  fullname: string
  subreddit?: string
  author?: string
  /** 帖子标题 / 私信主题。 */
  title?: string
  text: string
  url?: string
  /** 回的是哪一条（收件箱 / 评论）——是我们发过的那条，就挂到发出记录那一行下（WP323）。 */
  parent_fullname?: string
  /** 属于哪一帖（评论）。 */
  link_fullname?: string
  /** 评论所在帖子的标题。 */
  post_title?: string
  inbox_type?: RedditWatchInboxType
  /** 外部社区：命中的是哪个关键词。 */
  keyword?: string
  /** 发帖时间（Reddit 上的）。 */
  created_at: Iso8601
  /** 我们读到它的时间。 */
  fetched_at: Iso8601
  /** 哪一次巡查读到的。 */
  run_id: string
  /** 是我们品牌号自己发的（只计数，不判断、不进待处理）。 */
  ours?: true
  /** 回的是我们发过的那一条（发出记录里有）。 */
  reply_to_ours?: true
  judgement?: RedditWatchJudgement
  status: RedditWatchItemStatus
  /** WP329 回过之后挂上发出记录那一行（`OutboundRecord.id`）。 */
  outbound_record_id?: string
  status_at?: Iso8601
  /** 对方删了原话：我们这边正文清空（667）。 */
  deleted?: true
  /**
   * WP340：命中了巡查设置里的「告警词」（本地匹配，不额外计费）→ 标「优先」，单独出一条提醒（同一条只一次）。
   * `alert_hits` 是命中的那几个词。
   */
  priority?: true
  alert_hits?: string[]
  /** WP340：命中的「本地标签词」（如型号写法；只在本地打标签，不进外部计费）。 */
  tags?: string[]
  /** WP340：这一条的「优先」提醒人已经看过 / 收起了（或同一条在别的来源已经提醒过）。 */
  alert_seen?: true
}

/** 每品牌的巡查设置（缺版块 / 缺关键词就出配置卡，按 WP324）。 */
export interface RedditWatchSettings {
  /** 自家版块（不带 `r/`），可以几个。 */
  own_subreddits: string[]
  /** 外部社区监测的关键词（品牌、型号、中文名、竞品、品类词…由用户给）。 */
  keywords: string[]
  /** 品牌号用户名（不带 `u/`）。配了：插件发现登着的不是它就一条都不读。 */
  brand_username?: string
  /** 隔几小时巡查一次（1–168；默认 24 = 一天一次）。 */
  every_hours: number
  /** 一天一次时几点开始（本地时间小时，默认 9）。 */
  day_start_hour: number
  /** 每个关键词每次最多取几条（第三方数据渠道按条计费）。 */
  keyword_limit: number
  /** 总开关（关了就不巡查）。 */
  enabled: boolean
  /**
   * WP340：**重点版块**（别人的版，不带 `r/`）——插件借品牌号会话只读新帖，进「外部社区」那一类（按话题归组）。
   * 老设置没有这一格 = 没有。
   */
  watch_subreddits?: string[]
  /**
   * WP340：按版块分频率（自家版块、重点版块都算；键是小写版块名）：一周几次（7 = 每天、1 = 每周）。
   * 没写的版块跟 `every_hours` 走（默认每天一次）；收件箱、外部关键词照旧按 `every_hours`。
   */
  sub_per_week?: Record<string, number>
  /** WP340：告警词（本地匹配；命中的条目标「优先」并单独提醒一次）。由用户定，AI 只给建议。 */
  alert_words?: string[]
  /** WP340：本地标签词（如型号写法；命中就给条目打这个标签，查巡查数据可按标签筛）。 */
  tag_words?: string[]
}

/** WP340：版块一周几次的可选档（每天 / 每周 3 次 / 每周 2 次 / 每周 1 次）。 */
export const REDDIT_SUB_PER_WEEK_CHOICES: readonly number[] = [7, 3, 2, 1]

export const REDDIT_WATCH_DEFAULTS: Readonly<
  Omit<RedditWatchSettings, 'own_subreddits' | 'keywords'>
> = {
  every_hours: 24,
  day_start_hour: 9,
  keyword_limit: 10,
  enabled: true,
}

/** 巡查里的一块（WP340 加 `watch_sub` 重点版块：插件只读新帖）。 */
export type RedditWatchPart = 'inbox' | 'own_sub' | 'watch_sub' | 'external'

export type RedditWatchPartStatus =
  | 'ok'
  /** 插件领走了还没交回（或排着等插件来领）。 */
  | 'waiting'
  /** 这一块这次不该读（没到点 / 没配）。 */
  | 'skipped'
  /** 缺连接（插件没配对 / 没连 Reddit / 没登录品牌号）——已出连接卡。 */
  | 'needs_connection'
  /** 缺设置（版块 / 关键词）——已出配置卡。 */
  | 'needs_setup'
  | 'failed'

export interface RedditWatchRunPart {
  part: RedditWatchPart
  status: RedditWatchPartStatus
  /** 一句人话（失败 / 缺什么）。 */
  message?: string
  /** 读回来几条、其中新的几条。 */
  fetched: number
  fresh: number
  finished_at?: Iso8601
}

/** 一次巡查。 */
export interface RedditWatchRun {
  id: string
  workspace_id: WorkspaceId
  started_at: Iso8601
  finished_at?: Iso8601
  /** WP330 时「周报前的本周最后一次」；WP331 起不再有这一说，新跑的都是 `false`（字段留着，老数据照读）。 */
  final: boolean
  /** 谁让跑的：定时 / 人点「现在巡查」或 AI 调「立即巡查」/ `weekly` 只在 WP330 留下的老数据里。 */
  trigger: 'schedule' | 'manual' | 'weekly'
  parts: RedditWatchRunPart[]
  /** 这次新出的「待处理」几条。 */
  pending: number
}

/** 工作台 / 插件状态那一块。 */
export interface RedditWatchView {
  settings: RedditWatchSettings
  /** 版块和关键词至少配了一样。 */
  configured: boolean
  extension: {
    /** 插件最近一次来问是什么时候（没来过就没有）。 */
    seen_at?: Iso8601
    /** 插件里连上 Reddit 了没有（给了站点权限）。 */
    reddit_connected?: boolean
    /** 最近一次读到的登录用户名。 */
    user?: string
    /** 最近一次读的结局（没登录 / 号不对…）。 */
    note?: string
  }
  last_run?: RedditWatchRun
  /** 要回、还没处理的（新的在前）。 */
  pending: RedditWatchEntry[]
  /**
   * WP340：「优先」提醒（命中告警词、人还没收起、最近 {@link REDDIT_WATCH_ALERT_DAYS} 天内；同一条只一行，新的在前）。
   * 没有就不出（docs/96 提醒条：只在有事时出）。
   */
  alerts?: RedditWatchEntry[]
}

/** WP340：「优先」提醒在岗位页留几天。 */
export const REDDIT_WATCH_ALERT_DAYS = 7

/** 周报那一组外部话题。 */
export interface RedditWatchTopicGroup {
  topic: string
  verdict: RedditWatchVerdict
  posts: number
  comments: number
  /** 原文引用（作者、时间、链接都在条目上）。 */
  items: RedditWatchEntry[]
}

/**
 * 给周报（WP330）的一周汇总：窗口默认周日 00:00（本地）到现在。
 * 截图一律不做，用原文 + 链接。我们自己回了几条在发出记录里（WP323），不在这里。
 */
export interface RedditWatchDigest {
  workspace_id: WorkspaceId
  since: Iso8601
  until: Iso8601
  own_sub: {
    subreddits: string[]
    /** 窗口内自家版块的新帖数、新评论数（按 Reddit 上的发帖时间算；含我们自己发的）。 */
    posts: number
    comments: number
    /** 其中我们品牌号自己发的。 */
    ours: { posts: number; comments: number }
  }
  /** 自家版块（与收件箱）里有效的 VOC / UGC（只列有效的）。 */
  voc: RedditWatchEntry[]
  ugc: RedditWatchEntry[]
  /** 外部社区按话题归组（需跟进的在前）。 */
  external: RedditWatchTopicGroup[]
  /** 收件箱：窗口内进来几条、其中要回的几条。 */
  inbox: { total: number; reply: number }
  /** 窗口内跑了几次巡查、最后一次什么时候、是不是已经做过本周最后一次。 */
  runs: number
  last_run_at?: Iso8601
  final_done: boolean
  /** 哪几块这周没读成（照实写进周报，不当成 0）。 */
  gaps: { part: RedditWatchPart; message: string }[]
}

/**
 * 周报窗口：本周日 00:00（按品牌时区）到 `now`。
 * `tzOffsetMinutes` 东八区 = 480。
 */
export function redditWeekWindow(
  now: Iso8601,
  tzOffsetMinutes: number,
): { since: Iso8601; until: Iso8601 } {
  const nowMs = Date.parse(now)
  const local = new Date(nowMs + tzOffsetMinutes * 60_000)
  const day = local.getUTCDay()
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - day)
  return {
    since: new Date(startLocal - tzOffsetMinutes * 60_000).toISOString(),
    until: new Date(nowMs).toISOString(),
  }
}
