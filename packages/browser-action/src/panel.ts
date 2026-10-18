/**
 * WP413（T-INMO 10-18 R1，Luoye 10-19 定 a–d）：插件**常驻侧边栏**与本机服务之间的线上形状。
 * 路由在 `packages/api/src/routes/extension-panel.ts`。
 *
 * 侧边栏三块：**进度**（读了什么、几点读的、下次几点、现在在做什么）、**要你处理**（「发出去」类卡：看 / 改 /
 * 不发 / 填进页面）、**记录**（发出记录、记录去处写入结果）。
 *
 * - 身份（决策 c）：插件里批 = 工坊里批——同一张审批卡、同一份记录；批的人是**配对时绑定的那个人**，
 *   账本记 `via: 'extension'`。别人的卡看不到、批不了（只列这个人收得到、有权批的）。
 * - 还是**插件主动找本机**：侧边栏开着时隔几秒问一次快照；本机服务永远不能伸手进浏览器。
 * - 「填进页面」= 批这张卡 + 马上交给插件动作通道（不等取消窗口：真正发出去的那一下永远是人在 Reddit 上点）；
 *   之后的「填好了 / 读回确认已发」走原来的动作通道（`/v1/extension/actions/*`），这里只看结果。
 * - 第一版只做 Reddit（决策 d）；广告后台、红人收录以后套用同一个侧边栏（`kind` 多一种即可）。
 */

/** 巡查的一块（与 `RedditWatchPart` 同名同义）。 */
export type PanelReadPart = 'inbox' | 'own_sub' | 'watch_sub' | 'external'

/** 一块这次读得怎样（与 `RedditWatchPartStatus` 同名同义）。 */
export type PanelReadStatus =
  | 'ok'
  | 'waiting'
  | 'skipped'
  | 'needs_connection'
  | 'needs_setup'
  | 'failed'

export interface PanelReadPartView {
  part: PanelReadPart
  status: PanelReadStatus
  /** 读回来几条、其中新的几条。 */
  fetched: number
  fresh: number
  /** 失败 / 缺什么那一句（照实说）。 */
  message?: string
  finished_at?: string
}

/** ① 进度。 */
export interface PanelProgress {
  /** 巡查设好了没有（自家版块 / 关键词至少一样）。 */
  configured: boolean
  /** 品牌号（插件读到的登录用户名，或设置里的）。 */
  account?: string
  /** 插件那一侧：连上 Reddit 没有、最近一次读的结局（没登录 / 号不对…）。 */
  reddit_connected?: boolean
  note?: string
  /** 最近一次巡查（没跑过就没有）。 */
  last_run?: {
    started_at: string
    finished_at?: string
    trigger: 'schedule' | 'manual' | 'weekly'
    parts: PanelReadPartView[]
    /** 这一轮新出的「要回」几条。 */
    pending: number
  }
  /** 现在正在读（上一轮还没收尾）。 */
  reading: boolean
  /** 下一次大约几点读（按设置算；没设好 / 关了就没有）。 */
  next_run_at?: string
  /** 起草中几条（AI 在写回复草稿）。 */
  drafting: number
  /** 读到的、要回还没处理的几条。 */
  pending: number
}

/** ② 要你处理：一张「发出去」卡（只给这个人收得到、有权批的）。 */
export interface PanelCard {
  /** 审批项 id。 */
  id: string
  /** 卡的版本（乐观并发：改了别处又改，这里会 409）。 */
  version: number
  /** 写哪种：回评论 / 回帖子 / 发新帖。 */
  kind: 'reply' | 'comment' | 'submit'
  subreddit: string
  /** 卡上那一行（「回复 alice（Reddit · r/ivraxr）」）。 */
  title: string
  /** 原帖标题 / 正文（外部文本，界面上只当文字显示）。 */
  post_title?: string
  post_text?: string
  /** 被回的那个人与那句话。 */
  parent_author?: string
  parent_text?: string
  /** 原帖 / 被回那一条的链接。 */
  link?: string
  /** 草稿（人可以改）。发新帖时 `title` 是标题。 */
  draft: { text: string; title?: string }
  /** AI 为什么要回（判断理由）。 */
  reason?: string
  /** 起草用上的 FAQ / 知识卡。 */
  facts?: { id: string; text: string }[]
  /** 这个版的版规原文（读得到才有）。 */
  rules?: string[]
  /** 卡上的提醒（草稿过不了检查那一句）。 */
  warning?: string
  created_at: string
}

/** 交给插件之后这一条做到哪了（与 `RedditWriteState` 同名同义）。 */
export type PanelWriteState = 'queued' | 'filling' | 'sent' | 'failed'

/** 批过的一条写（「已发 · 已记录」/ 填好了等你点 / 没发出去 · 再填一次）。 */
export interface PanelWrite {
  job_id: string
  approval_item_id: string
  state: PanelWriteState
  /** 卡上那一行。 */
  label?: string
  subreddit: string
  /** 没发出去那一句。 */
  message?: string
  /** 发出去那一条的链接。 */
  link?: string
  /** 发出记录那一行（有 = 已记录）。 */
  record_id?: string
  /** 能「再填一次」（同一份已批的草稿，不用重批）。 */
  can_refill?: boolean
  queued_at: string
  finished_at?: string
  /** 是在插件里批的（不是 = 在工坊里批的）。 */
  via_extension?: boolean
}

/** 一个记录去处写这一行的结果。 */
export interface PanelSinkResult {
  /** 用户交代的去处名字（「INMO 回复记录表」）。 */
  name: string
  status: 'written' | 'pending' | 'failed'
  /** 失败那一句。 */
  message?: string
}

/** ③ 记录：一行发出记录。 */
export interface PanelRecord {
  id: string
  sent_at: string
  channel: string
  /** `reply` / `comment` / `post` …。 */
  action: string
  /** 发到哪（`r/ivraxr`）。 */
  destination?: string
  counterpart?: string
  content: string
  link?: string
  status: 'sent' | 'failed' | 'deleted'
  /** 谁批的（人名）。 */
  approved_by?: string
  /** 在插件里批的。 */
  via_extension?: boolean
  /** 各记录去处写进去没有（没配去处 = 空）。 */
  sinks: PanelSinkResult[]
}

/** 一个记录去处的总状态（去处列表那一行）。 */
export interface PanelSinkView {
  name: string
  /** 与 `SinkState` 同名同义：等确认规矩 / 在写 / 停了 / 出问题了。 */
  state: 'pending_confirm' | 'active' | 'paused' | 'broken'
  written: number
  pending: number
  last_error?: string
}

/** `GET /v1/extension/panel`：侧边栏一屏要的全部事实。 */
export interface PanelSnapshot {
  at: string
  /** 品牌名。 */
  workspace_name?: string
  /** 插件绑定的那个人（「以 Luoye 的身份批」）。 */
  person_name?: string
  /** 这把配对能不能处理卡（有 `reddit.write`）；没有就只看。 */
  can_act: boolean
  progress: PanelProgress
  cards: PanelCard[]
  /** 批过的写（最近 7 天、新的在前；已发的留一天）。 */
  writes: PanelWrite[]
  /** 发出记录（最近 20 条、新的在前）。 */
  records: PanelRecord[]
  sinks: PanelSinkView[]
}

/** `POST /v1/extension/panel/cards/:id/fill`：批（改过就按改过的）并马上交给插件填进页面。 */
export interface PanelFillInput {
  /** 改过的草稿（不给 = 按卡上的）。 */
  text?: string
  /** 发新帖的标题（改过才给）。 */
  title?: string
  /** 卡的版本（与 {@link PanelCard.version} 比对）。 */
  version?: number
}

export type PanelFillResult =
  | { ok: true; write?: PanelWrite; message?: string }
  | { ok: false; message: string }

/** `POST /v1/extension/panel/cards/:id/skip`：不发（驳回这张卡）。 */
export interface PanelSkipInput {
  /** 为什么不发（不给 = 「在插件里点了不发」）。 */
  reason?: string
  version?: number
}

/** 草稿最长多少字（Reddit 评论上限 10000）。 */
export const PANEL_DRAFT_MAX = 10_000
/** 新帖标题最长多少字（Reddit 上限 300）。 */
export const PANEL_TITLE_MAX = 300
/** 侧边栏开着时多久问一次快照。 */
export const PANEL_REFRESH_MS = 5_000
