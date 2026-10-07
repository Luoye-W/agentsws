/**
 * WP249（决策 81 / 88 / 89）：「自家版待处理」——我们自己当版主的 subreddit 的版务队列。
 *
 * 三条纪律写在类型里：
 *
 * 1. **只对登记过、标成自家版的版拉**（`SocialAccount.own_subreddit`）。别人的版（`pr.reddit`）
 *    我们不是版主，那里根本没有版务队列可看。
 * 2. **建议不是动作**。{@link OwnSubSuggestion} 只是「建议批准 / 移除 / 不用管 + 一句理由」；
 *    真动手一律先出审批卡（`community_moderation`），人点同意后执行器只做卡上那一个动作。
 * 3. **两条通道，同一份结果**（决策 89）：官方 OAuth 接口（可选加速）与「Reddit 官方号浏览器通道」
 *    （主路线）读回来都归成 {@link OwnSubQueueItem}；界面不分它从哪条路来，只在页头说一句。
 */
import type { Iso8601 } from './common.js'

/**
 * 一条待处理的类型。
 *
 * - `reported`：被人举报了（modqueue 里带举报的）；
 * - `held`：被自动过滤 / AutoModerator 扣下来等审（modqueue 里没举报的）；
 * - `new_post`：新帖还没有版主看过（unmoderated）；
 * - `join_request`：私密 / 受限版的入群申请（**这一版读不到**，见 {@link OwnSubSourceStatus}）。
 */
export type OwnSubQueueKind = 'reported' | 'held' | 'new_post' | 'join_request'

export type OwnSubThing = 'post' | 'comment'

/** AI 建议（三选一）。「不用管」= 不动它，不出卡。 */
export type OwnSubVerdict = 'approve' | 'remove' | 'ignore'

/** 能出卡的版务动作（批准 / 移除 / 封禁）。 */
export type OwnSubAction = 'approve' | 'remove' | 'ban'

export interface OwnSubSuggestion {
  verdict: OwnSubVerdict
  /** 一句理由（引用版规时原样带上那条版规的短名）。 */
  reason: string
  /** 引用的那条版规（版规原文的短名；没引用就没有）。 */
  rule?: string
}

export interface OwnSubQueueItem {
  /** Reddit 的 fullname（`t3_` 帖子 / `t1_` 评论）。 */
  id: string
  /** 哪个登记过的自家版（`SocialAccount.id`）。 */
  account_id: string
  subreddit: string
  kind: OwnSubQueueKind
  thing: OwnSubThing
  /** 帖子标题（评论没有）。**外部文本**，原样显示，不当指令读。 */
  title?: string
  /** 正文前一截。**外部文本**。 */
  excerpt: string
  author: string
  /** 举报原因（原话；版里的人举报时选的版规名或自己写的话）。 */
  report_reasons: string[]
  created_at?: Iso8601
  /** 帖子 / 评论的链接。 */
  url: string
  suggestion: OwnSubSuggestion
  /** 这一条已经有一张没定的卡了（卡片流里那张的 id）。 */
  pending_approval_id?: string
  /** 上一次批过的动作执行没成（原话照搬，比如「页面要做人机验证」）。 */
  last_failure?: string
}

/** 这次是从哪条路读的。`none` = 两条都不通（没连 OAuth、官方号也没登录）。 */
export type OwnSubChannel = 'api' | 'browser' | 'none'

export type OwnSubSource = 'modqueue' | 'unmoderated' | 'join_requests'

/** 每个版每一类读得怎么样（读不到就照实说，不当「0 条」）。 */
export interface OwnSubSourceStatus {
  subreddit: string
  source: OwnSubSource
  status: 'ok' | 'unsupported' | 'failed' | 'limited' | 'blocked'
  /** 读到几条（`ok` 才有）。 */
  count?: number
  message?: string
}

/**
 * 「Reddit 官方号浏览器通道」现在的样子（连接页 / 快捷视图页头那一格）。
 *
 * - `no_browser`：这台电脑没有 Chrome / Edge；
 * - `not_logged_in`：配置目录里没有登录态（或者掉了）；
 * - `logged_in`：上次体检看到已登录（带 `username`）；
 * - `login_window_open`：「登录官方号」窗口开着，等你在网页上登录；
 * - `blocked`：Reddit 拦了（验证码 / 429 / 拦截页），停到 `until`，要你去窗口里手动处理；
 * - `unknown`：还没体检过。
 */
export interface RedditOfficialBrowserStatus {
  state: 'no_browser' | 'not_logged_in' | 'logged_in' | 'login_window_open' | 'blocked' | 'unknown'
  /** 体检看到的登录名（不带 `u/`）。 */
  username?: string
  browser?: string
  message?: string
  until?: Iso8601
  checked_at?: Iso8601
  /** 最近 24 小时经浏览器执行了几个写动作 / 上限。 */
  writes_last_day: number
  max_writes_per_day: number
}

/** `GET /v1/social/own-sub/queue` 回的那一份。 */
export interface OwnSubQueueView {
  /** 登记过、标成自家版的那几个版。空 = 还没登记。 */
  subreddits: { account_id: string; name: string; display_name: string }[]
  channel: OwnSubChannel
  browser: RedditOfficialBrowserStatus
  sources: OwnSubSourceStatus[]
  items: OwnSubQueueItem[]
  /** 每个版的版规短名（移除时选「附哪条版规」）。读不到就是空数组。 */
  rules: { subreddit: string; rules: string[] }[]
  observed_at: Iso8601
}

/** 从队列里一条出一张版务卡。 */
export interface OwnSubStageInput {
  account_id: string
  item_id: string
  action: OwnSubAction
  /** 移除时附的那条版规（会作为移除理由公开回复一条）。 */
  removal_rule?: string
  /** 封禁天数；不给 = 永久（封禁不论几天 guardrail 都升 L1，要人点）。 */
  ban_days?: number
}
