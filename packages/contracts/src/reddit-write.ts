/**
 * WP329（docs/102 §2.3「写」/ §4，决策 663 / 667 / 669 / 708；以文末「Luoye 10-14 定」为准）：
 * **Reddit 写**——AI 起草（查 FAQ 知识卡 + 品牌语气 + 帖子上下文 + 版规原文）→ 一张「发出去」卡（卡上能改字）
 * → 人批 → 插件在用户已登录的 Reddit 页面里把草稿填进评论 / 回复 / 发帖框 → **人自己点发送** → 插件读回、
 * 拿到链接 → 本地发出记录多一行（WP323），之后对方回复按编号挂回这一行。
 *
 * - **永远人批**（663）：这类卡不跟职责等级走，一律 L1；审批人在个人模式就是本人（669）。
 * - **不替用户预设推广规矩**（664 被否）：这里没有冷却、跨版查重、身份声明、推广占比之类的格子。
 * - 私信（`t4_`）不在这里回：主动发私信永远不做（docs/102 §3.5）。
 */
import type { Iso8601 } from './common.js'

/** 卡上 `payload.form` 的记号。 */
export const REDDIT_WRITE_FORM = 'reddit_write'

/** 三种写：回评论（楼中楼 / 收件箱里的回复与 @）、回帖子（顶层评论，自家版或别人版）、发新帖。 */
export type RedditWriteKind = 'reply' | 'comment' | 'submit'

/** 这一条从哪来（WP328「待处理」条目 / 社媒库的线程 / 公关的外部发帖 / 人在工作台点的）。 */
export interface RedditWriteSource {
  type: 'reddit_watch_item' | 'community_thread' | 'external_post' | 'manual'
  id: string
}

/** 要写到哪（起草与出卡都用它）。对方的话是**外部文本**：进模型上下文前要围栏。 */
export interface RedditWriteTarget {
  kind: RedditWriteKind
  /** 版块名（不带 `r/`）。 */
  subreddit: string
  /** `reply`：被回的那条评论（`t1_…`）；`comment`：帖子（`t3_…`）。`submit` 不要。 */
  parent_fullname?: string
  /** 被回那一条的链接（`/r/x/comments/…`；`reply` 必须有，插件靠它找到回复框）。 */
  permalink?: string
  /** 原帖标题 / 正文（上下文）。 */
  post_title?: string
  post_text?: string
  /** 被回的那个人与那句话（`reply` / `comment`）。 */
  parent_author?: string
  parent_text?: string
  /** 收件箱里的哪一栏（有就带上，起草提示里用）。 */
  inbox_type?: 'comment_reply' | 'post_reply' | 'username_mention'
  source?: RedditWriteSource
}

/** 起草的入参。`instruction` 是人的一句话要点（发新帖时说「写一个本周问答帖」这种）。 */
export interface RedditDraftInput {
  target: RedditWriteTarget
  instruction?: string
}

/** 起草时用上的一张 FAQ / 知识卡。 */
export interface RedditDraftFact {
  id: string
  /** 卡上那句话（问答卡是 `Q: … A: …`）。 */
  text: string
}

/** 起草回来的样子（只起草：不出卡、不落库）。 */
export interface RedditDraftView {
  text: string
  /** 发新帖的标题。 */
  title?: string
  source: 'ai' | 'template'
  /** 用上的 FAQ 卡（卡上「依据」那一栏）。 */
  facts: RedditDraftFact[]
  /** 读到的版规原文（拿不到就没有；起草时当上下文，不替用户判「能不能推广」）。 */
  rules?: string[]
  /** 草稿自己过不了承诺扫描 / 品牌禁用词时那一句。 */
  warning?: string
  /** 没用 AI 时那一句。 */
  note?: string
}

/** 出卡的入参（人在起草框里改完的字）。 */
export interface RedditStageInput {
  target: RedditWriteTarget
  text: string
  title?: string
  /** 起草用上的知识卡 id（卡上的「依据」、发出记录的「为什么发」）。 */
  fact_ids?: string[]
  /** 为什么回（WP328 的判断理由；进卡与发出记录）。 */
  reason?: string
}

export type RedditStageResult =
  | { staged: true; approval_item_id: string }
  | { staged: false; message: string }

/** 卡上 `payload` 的形状（`outbound_draft` + `form: 'reddit_write'`）。 */
export interface RedditWritePayload {
  form: typeof REDDIT_WRITE_FORM
  channel: 'reddit'
  /** 卡上一行：「Reddit · r/inmoxr」。 */
  channel_label: string
  target: RedditWriteTarget
  /** 正文（批的时候改过就按改过的发：`finalPayload`）。发新帖时 `subject` 是标题。 */
  body: { text: string; subject?: string }
  /** 回的是谁、哪一句（卡上给人看；外部文本，只上卡不进事件）。 */
  author?: string
  in_reply_to?: string
  facts?: RedditDraftFact[]
  rules?: string[]
  reason?: string
}

/** 插件那边这一条做到哪了（工作台看）。 */
export type RedditWriteState =
  /** 批了、排着等插件来领（Chrome 没开就一直等，24 小时没人领作废）。 */
  | 'queued'
  /** 插件填好了，等人点发送。 */
  | 'filling'
  /** 读回确认发出去了。 */
  | 'sent'
  /** 没发出去（没点 / 被拦 / 没登录 / 停了 / 作废），照实说原因，不自动重试。 */
  | 'failed'

export interface RedditWriteView {
  approval_item_id: string
  job_id: string
  kind: RedditWriteKind
  subreddit: string
  state: RedditWriteState
  /** 失败时那一句。 */
  message?: string
  /** 发出去那一条的链接。 */
  link?: string
  /** 发出记录那一行（WP323）。 */
  record_id?: string
  queued_at: Iso8601
  finished_at?: Iso8601
}

/**
 * WP328「待处理」条目里起草要用的那几格（结构上与 `RedditWatchItem` 对齐：同名同义，
 * 这样两单合到一起后条目可以直接交进来，不用改形状）。
 */
export interface RedditPendingLike {
  id: string
  kind: 'post' | 'comment' | 'message'
  fullname: string
  subreddit?: string
  author?: string
  title?: string
  text: string
  url?: string
  post_title?: string
  inbox_type?: 'comment_reply' | 'post_reply' | 'username_mention' | 'message'
}

/** 网址 → 站内路径（`https://www.reddit.com/r/x/comments/…?context=3` → `/r/x/comments/…/`）。 */
function sitePath(url: string | undefined): string | undefined {
  if (url === undefined || url.trim() === '') return undefined
  let path = url.trim()
  try {
    if (/^https?:/iu.test(path)) path = new URL(path).pathname
  } catch {
    return undefined
  }
  path = path.split(/[?#]/u)[0] ?? ''
  if (!path.startsWith('/r/')) return undefined
  return path.endsWith('/') ? path : `${path}/`
}

/**
 * 「待处理」的一条 → 要写到哪。帖子 → 在帖子下回（`comment`）；评论（含收件箱里的回复 / @）→ 楼中楼（`reply`）。
 * 私信不回（主动私信永远不做）；评论没链接、没版块也回 `undefined`（找不到回复框）。
 */
export function redditTargetFromItem(item: RedditPendingLike): RedditWriteTarget | undefined {
  if (item.kind === 'message' || item.fullname.startsWith('t4_')) return undefined
  const permalink = sitePath(item.url)
  const sub = item.subreddit?.replace(/^\/?r\//u, '') ?? permalink?.match(/^\/r\/([^/]+)\//u)?.[1]
  if (sub === undefined || sub === '') return undefined
  const source: RedditWriteSource = { type: 'reddit_watch_item', id: item.id }
  if (item.kind === 'post')
    return {
      kind: 'comment',
      subreddit: sub,
      parent_fullname: item.fullname,
      ...(permalink === undefined ? {} : { permalink }),
      ...(item.title === undefined ? {} : { post_title: item.title }),
      post_text: item.text,
      ...(item.author === undefined ? {} : { parent_author: item.author }),
      source,
    }
  if (permalink === undefined) return undefined
  return {
    kind: 'reply',
    subreddit: sub,
    parent_fullname: item.fullname,
    permalink,
    ...(item.post_title === undefined ? {} : { post_title: item.post_title }),
    ...(item.author === undefined ? {} : { parent_author: item.author }),
    parent_text: item.text,
    ...(item.inbox_type === undefined || item.inbox_type === 'message'
      ? {}
      : { inbox_type: item.inbox_type }),
    source,
  }
}
