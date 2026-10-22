/**
 * WP413（真机联调 10-18 R1，Luoye 10-19 定 a–d）：插件**常驻侧边栏**与本机服务之间的线上形状。
 * 路由在 `packages/api/src/routes/extension-panel.ts`。
 *
 * 侧边栏三块：**进度**（读了什么、几点读的、下次几点、现在在做什么）、**要你处理**（「发出去」类卡：看 / 改 /
 * 不发 / 填进页面）、**记录**（发出记录、记录去处写入结果）。
 *
 * WP445（决策 1322）：AI 起草的 Reddit 回帖 / 发帖不在工坊出卡，**审与发都在这里一步完成**：「等你发」里
 * 每一条（还没批的卡 + 主管在工坊批过的）都是同一个样子——看、改、打开这一条、不发 + 理由、稍后。
 *
 * - 身份（决策 c）：插件里批 = 工坊里批——同一张审批卡、同一份记录；批的人是**配对时绑定的那个人**，
 *   账本记 `via: 'extension'`。别人的卡看不到、批不了（只列这个人收得到、有权批的）。
 * - 还是**插件主动找本机**：侧边栏开着时隔几秒问一次快照；本机服务永远不能伸手进浏览器。
 * - 「填进页面」= 批这张卡 + 马上交给插件动作通道（不等取消窗口：真正发出去的那一下永远是人在 Reddit 上点）；
 *   之后的「填好了 / 读回确认已发」走原来的动作通道（`/v1/extension/actions/*`），这里只看结果。
 * - 第一版只做 Reddit（决策 d）；广告后台、红人收录以后套用同一个侧边栏（`kind` 多一种即可）。
 */

import type { ActionJob } from './types.js'

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

/**
 * WP419（自查 R5 / U17）：起草那一头现在卡在哪（读到了要回的、却还没出卡时才有）。照实说，不让人以为插件坏了：
 * - `no_owner`：没人担 Reddit 运营 / 外部版块，读到的不会起草；
 * - `reading_thread`：先在你的浏览器里读整串（插件下次来问就读），读完就起草；
 * - `needs_plugin`：要读整串但插件这会儿读不了（Chrome 没开 / 没连 Reddit）；
 * - `needs_persona`：等你先定品牌号怎么说话（`card_id` = 工坊里那张卡，点「去定」打开）；
 * - `conflict`：草稿和品牌号以前说的矛盾，没出卡，等你在工坊里看；
 * - `draft_failed`：起草没成（到了你设的上限 / 起草出来是空的…），照实说第一条原因；
 * - `drafting`：正在起草。
 */
export type PanelStageKind =
  | 'no_owner'
  | 'reading_thread'
  | 'needs_plugin'
  | 'needs_persona'
  | 'conflict'
  | 'draft_failed'
  | 'drafting'

export interface PanelStage {
  kind: PanelStageKind
  /** 一句人话（「3 条等你先定品牌号怎么说话」）。 */
  text: string
  /** 卡在这一步的条数。 */
  count: number
  /** 去工坊里处理的那张卡（口吻卡）。 */
  card_id?: string
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
    /** 与 `RedditWatchRun.trigger` 同义（WP411 多了 `backfill`：按时间窗往回补的那一轮）。 */
    trigger: 'schedule' | 'manual' | 'weekly' | 'backfill'
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
  /** WP419：起草卡在哪一步（读到了要回的、还没出卡时才有）。 */
  stage?: PanelStage
  /** WP419：最近 7 天品牌号已经回过、没再起草的几条（WP411）。 */
  replied_before?: number
  /** WP432：今天（品牌本地日）已经发出去几条（读回确认的）。 */
  sent_today?: number
  /** WP432：批了、等你在插件里打开发的几条。 */
  awaiting?: number
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
  /**
   * WP467：写到哪个帖子（不带 `t3_`）、回的是哪一条评论（`t1_…`）——插件按它找用户已经开着的原帖标签页、
   * 认人自己发出去的那一条。发新帖没有。
   */
  target_post?: string
  target_parent?: string
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
  /** WP419：起草时那几道检查的结果（WP411：没依据 / 口吻 / 整串没现读成…；矛盾的不出卡）。 */
  checks?: { kind: string; message: string; fixed?: boolean }[]
  /** WP419：品牌号在这一串里已经说过的（最近几条；外部文本只当文字）。 */
  prior_replies?: { text: string; created_at?: string }[]
  created_at: string
}

/**
 * 交给插件之后这一条做到哪了（与 `RedditWriteState` 同名同义）。
 * WP432：`awaiting` = 批了，等你在侧边栏里点「打开这一条」（插件不自己开页面）。
 */
export type PanelWriteState = 'awaiting' | 'queued' | 'filling' | 'sent' | 'failed'

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
  /** WP432：写哪种（侧边栏发帖台上「回复 / 回帖 / 发帖」）。 */
  kind?: 'reply' | 'comment' | 'submit'
  /** WP432：批过的草稿全文（等你发的那几条；在侧边栏里还能改）。发新帖时 `title` 是标题。 */
  text?: string
  title?: string
  /** WP432：原帖标题、被回的那个人与那句话（外部文本，只当文字）。 */
  post_title?: string
  parent_author?: string
  parent_text?: string
  /** WP432：原帖 / 被回那一条的链接（不是发出去那一条：那个是 `link`）。 */
  thread_link?: string
  /** WP432：为什么回这条。 */
  reason?: string
  /** WP467：写到哪个帖子 / 回哪条评论（同 {@link PanelCard.target_post}）。 */
  target_post?: string
  target_parent?: string
}

/** 一个记录去处写这一行的结果。 */
export interface PanelSinkResult {
  /** 用户交代的去处名字（「IVRA 回复记录表」）。 */
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

/**
 * WP419（决策 1231）：到点了、交给你在自己登录着的后台里发的一条社媒帖子。侧边栏里：打开发帖页（能预填就预填）、
 * 复制文案、发好了（可贴回那一条的链接 = 读回确认）/ 不发了。
 */
export interface PanelPost {
  id: string
  /** 渠道 id（`x` / `facebook`…）与人话名。 */
  channel: string
  channel_label: string
  /** 发到哪个号（显示名）。 */
  account: string
  /** 批过的正文（插件只用它）。 */
  body: string
  kind: string
  scheduled_at?: string
  /** 打开哪一页（只会是 `SOCIAL_COMPOSE_HOSTS` 里的站）。 */
  compose_url: string
  /** 正文已经预填进那一页（X / Threads / LinkedIn）；否则要人粘贴。 */
  prefilled: boolean
  /** 要带的素材几个（在工坊素材库里；这一版插件不替你传文件）。 */
  media: number
  handed_at: string
}

/** `POST /v1/extension/panel/posts/:id/done|skip`：交给你发的那一条，你回的话。 */
export interface PanelPostAnswerInput {
  /** 发好了：那一条的链接（贴了 = 读回确认；不贴 = 只是你说发了）。 */
  link?: string
  /** 不发了：为什么。 */
  reason?: string
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
  /** WP419：交给你发的社媒帖子（到点了、没接官方接口）。 */
  posts?: PanelPost[]
  /** WP419：这把配对能不能回「发好了 / 不发了」（有 `social.post`）。 */
  can_post?: boolean
  /**
   * WP432：工坊版本与工坊插件文件夹里那一版（侧边栏底下写自己是哪一版，对不上就提示重新加载）。
   * 不是桌面版（没有固定文件夹）就没有 `folder`。
   */
  versions?: { workshop?: string; folder?: string }
  /** WP432：「等你发」要不要弹系统通知（工坊设置 → 通知「等你发」那一类的「系统」开关）。 */
  notify_system?: boolean
}

/** WP432：`POST /v1/extension/panel/writes/:job/open`：人点「打开这一条」（改过就带改过的字）。 */
export interface PanelOpenInput {
  text?: string
  /** 发新帖的标题（改过才给）。 */
  title?: string
}

/** WP432：`POST /v1/extension/panel/writes/:job/drop`：不发了。 */
export interface PanelDropInput {
  reason?: string
}

/**
 * WP432：「打开这一条」的回执——交给插件的那一件活（插件在当前窗口新开标签页、填好、等人点）。
 * 本机服务不开任何页面；只有人点的这一下能拿到它。
 */
export type PanelOpenResult =
  | { ok: true; job: ActionJob; write?: PanelWrite }
  | { ok: false; message: string }

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

/**
 * WP445：「不发」的回执。写了理由、AI 按理由判出同类的几张也一并不发了时带 `followed`（侧边栏顶上一行「另外 N 条
 * 同类的也不发了 · 撤回」；撤回走 `POST /v1/extension/panel/cards/:leader/follow/undo`）。
 */
export interface PanelSkipResult {
  ok: true
  followed?: { leader_id: string; ids: string[]; titles: string[] }
}

/** WP445：「不发」时的快捷理由（理由可选；写了理由才跟随同类、才进学习回路）。 */
export const PANEL_SKIP_REASONS: readonly string[] = ['不相关', '时机不对', '不想回']

/**
 * WP467：`POST /v1/extension/panel/writes/:job/sent`——人在 Reddit 上自己发出去了（插件填好之后点的、或复制粘贴发的），
 * 记成「已记录」。三种来路：
 * - `seen`：插件在原帖页上认出来的（这个帖子里、文本相近、当前登录的号发的）；
 * - `link`：人在侧边栏「我发了，帮我记一下」里贴的那一条的链接；
 * - `latest`：人点「认最近一条」，插件读这个帖子里这个号最新发的那一条。
 * 本机服务再核一遍：链接要在这个帖子里（错帖不记）、`seen` 要文本相近、同一条不记两次。
 */
export interface PanelSentInput {
  how: 'seen' | 'link' | 'latest'
  /** 那一条的链接（站内路径或完整网址）。 */
  permalink?: string
  /** `t1_…` / `t3_…`（不给就从链接里认）。 */
  fullname?: string
  /** 页面上读回来的正文（真发出去的字）。 */
  text?: string
  /** 页面上标的作者。 */
  author?: string
}

/** 草稿最长多少字（Reddit 评论上限 10000）。 */
export const PANEL_DRAFT_MAX = 10_000
/** 新帖标题最长多少字（Reddit 上限 300）。 */
export const PANEL_TITLE_MAX = 300
/** 侧边栏开着时多久问一次快照。 */
export const PANEL_REFRESH_MS = 5_000
