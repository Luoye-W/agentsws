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
import type { WriteRoute } from './ego-write.js'

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
  /** WP411（#11）：这一串的上下文（原帖 + 上下文评论 + 品牌号在这串里已有的回复）。不给 = 只看 `target` 里那几句。 */
  thread?: RedditThreadContext
}

/** WP411：一串里的一条（外部文本，进模型上下文前要围栏）。 */
export interface RedditThreadComment {
  fullname: string
  author?: string
  text: string
  created_at?: Iso8601
  /** 回的是哪一条（`t1_` / `t3_`）。 */
  parent_fullname?: string
  url?: string
}

/**
 * WP411（#11）：起草前读的「整串」——原帖、上下文评论、品牌号在这串里已经说过的话。
 * `read`：`plugin` = 插件这次借品牌号会话现读了整串；`store` = 只有巡查库里已有的那几条（插件不在线 / 没读成）。
 */
export interface RedditThreadContext {
  post?: { fullname: string; title?: string; text: string; author?: string }
  /** 上下文评论（按时间，最多几十条；不含品牌号自己的）。 */
  comments: RedditThreadComment[]
  /** 品牌号在这串里已经发过的（帖子或评论）。 */
  ours: RedditThreadComment[]
  read: 'plugin' | 'store'
  /** 没现读成时那一句（插件不在线 / 读失败）。 */
  note?: string
}

/** WP411（#11）：品牌号在 Reddit 上怎么说话——个人口吻（「我以前在这家工作」）或团队口吻（「我们」）。 */
export interface RedditPersona {
  stance: 'personal' | 'team'
  /** 怎么介绍自己（个人口吻常见：「I used to work at IVRA」）；起草照用，不另编身份。 */
  intro?: string
  /** 别说的话（一句一条，例如「不说 DM me」）。 */
  avoid?: string[]
}

/**
 * WP411（#11）：草稿过了哪几道检查、哪一道没过（卡上照实标出来）。
 * - `contradiction`：和品牌号在这串里已经说过的话对不上；
 * - `ungrounded`：没依据的技术细节（已换成「我去确认一下」时 `fixed: true`）；
 * - `persona`：和配好的口吻不符；
 * - `thread`：这一串没现读成，只看了库里有的。
 */
export interface RedditDraftCheck {
  kind: 'contradiction' | 'ungrounded' | 'persona' | 'thread'
  /** 一句人话。 */
  message: string
  /** 草稿里那一句 / 那几个词。 */
  quote?: string
  /** 对不上的那一句品牌号原话与时间（`contradiction`）。 */
  prior?: string
  prior_at?: Iso8601
  /** 已经改掉了（换成「我去确认一下」）。 */
  fixed?: boolean
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
  /** WP411：几道检查的结果（只列没过 / 改过的）。 */
  checks?: RedditDraftCheck[]
  /** WP411：品牌号在这串里已经说过的（卡上「你 10-12 已回：……」）。 */
  prior_replies?: RedditThreadComment[]
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
  /** WP411：起草时几道检查的结果、品牌号在这串里已经说过的（原样上卡）。 */
  checks?: RedditDraftCheck[]
  prior_replies?: RedditThreadComment[]
}

export type RedditStageResult =
  | { staged: true; approval_item_id: string }
  /**
   * WP411：`skipped` = 不该出卡（品牌号已经回过这一条 / 等人设）——不是出错。
   * 决策 1199（Luoye 10-19 改）：`contradiction` = 重写一次后草稿仍和品牌号说过的矛盾——不出卡，
   * 巡查条目标「和你 <日期> 说的矛盾，要你看」留在待处理（`conflict` 带品牌号原话与日期）。
   */
  | {
      staged: false
      message: string
      skipped?: 'already_replied' | 'needs_persona' | 'contradiction'
      conflict?: RedditDraftConflict
    }

/**
 * 决策 1199：自动起草时草稿和品牌号已说过的话矛盾——不出「发出去」卡，条目上记这一份由人决定。
 */
export interface RedditDraftConflict {
  /** 草稿里对不上的那一句。 */
  quote: string
  /** 品牌号原话。 */
  prior: string
  /** 品牌号那句是哪天说的（拿得到才有）。 */
  prior_at?: Iso8601
}

/** 卡上 `payload` 的形状（`outbound_draft` + `form: 'reddit_write'`）。 */
export interface RedditWritePayload {
  form: typeof REDDIT_WRITE_FORM
  channel: 'reddit'
  /** 卡上一行：「Reddit · r/ivraxr」。 */
  channel_label: string
  /**
   * 写到哪。**不叫 `target`**：审批总线把 `payload.target` 当成「改的是哪个对象」（`ObjectRef`）
   * 算执行快照，叫这个名字会让批完施行时快照对不上。
   */
  reddit: RedditWriteTarget
  /** 正文（批的时候改过就按改过的发：`finalPayload`）。发新帖时 `subject` 是标题。 */
  body: { text: string; subject?: string }
  /** 回的是谁、哪一句（卡上给人看；外部文本，只上卡不进事件）。 */
  author?: string
  in_reply_to?: string
  facts?: RedditDraftFact[]
  rules?: string[]
  reason?: string
  /** WP411：几道检查没过 / 改过的（卡上标出来）。 */
  checks?: RedditDraftCheck[]
  /** WP411：品牌号在这串里已经说过的（卡上「你 10-12 已回：……」）。 */
  prior_replies?: RedditThreadComment[]
  /**
   * WP445（决策 1322）：在哪儿审。`plugin` = 直接进浏览器插件侧边栏「等你发」，工坊**不出卡**（审与发在插件里一步完成）；
   * `workshop` = 公司模式里这条职责设了「要主管先批」，主管在工坊里批，批完再进发起人的插件「等你发」。
   * 老卡没有这一格：按收件规则认（落在本人身上的就是插件里那一种）。
   */
  desk?: 'plugin' | 'workshop'
  /**
   * WP483（决策 1658 / 1660）：出卡那一刻定的路。`ego` = 装了 ego、能连上：卡在工坊里批（`desk: 'workshop'`），
   * 批了工坊自己在 ego 里填好、点发送、读回；ego 跑失败就退插件「等你发」。没有这一格 = 插件路（老卡也是）。
   */
  route?: WriteRoute
}

/**
 * WP445（决策 1322）：这张卡是不是「插件里审」的那一种（工坊不出卡、插件侧边栏「等你发」里有它）。
 *
 * - Reddit「发出去」卡：`desk: 'workshop'` 或按主管 / 老板收件的不是（主管在工坊批）；老卡按收件规则认；
 * - WP419 社媒「交给你发」的发布卡（`staged_change` + `social_post`）：出卡时就标了 `after.desk = 'plugin'` 的才是。
 */
export function isPluginDeskCard(item: {
  kind: string
  payload: unknown
  routing?: { rule?: string }
}): boolean {
  const p = item.payload
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return false
  const r = p as Record<string, unknown>
  if (item.kind === 'staged_change') {
    const after = r.after
    return (
      r.kind === 'social_post' &&
      typeof after === 'object' &&
      after !== null &&
      (after as Record<string, unknown>).desk === 'plugin'
    )
  }
  if (item.kind !== 'outbound_draft') return false
  if (r.form !== REDDIT_WRITE_FORM) return false
  if (r.desk === 'plugin') return true
  if (r.desk === 'workshop') return false
  const rule = item.routing?.rule
  return rule !== 'scope_manager' && rule !== 'owner'
}

/** 插件那边这一条做到哪了（工作台看）。 */
export type RedditWriteState =
  /**
   * WP432：批了，**等你在浏览器插件侧边栏里点「打开这一条」**（插件不自己开页面；7 天没打开作废）。
   * 之后的「填好了等你点发送 / 已发」照旧。
   */
  | 'awaiting'
  /** 批了、排着等插件来领（Chrome 没开就一直等，24 小时没人领作废）。WP432 起 Reddit 的写不再走这一档。 */
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
  /** WP332：卡上那一行（「回复 alice（Reddit · r/ivraxr）」）；岗位页提醒条用它说是哪一条。 */
  label?: string
  /** WP332：没发出去的那一类（`handover` 停下交给人 / `stopped` 点了停止 / `expired` 没人来领 / `failed`…）。 */
  outcome?: string
  /** WP332（决策 762）：能「再填一次」（同一份已批的草稿再交给插件，不用重批）。 */
  can_refill?: boolean
  /** WP332：再填过几次。 */
  refills?: number
  /** WP332：人看过、收起了提醒（再填一次之后又没发出去会重新出）。 */
  dismissed?: boolean
  /** WP432：批过的草稿（等你发的那几条在插件侧边栏里显示、还能改）。发新帖时 `title` 是标题。 */
  text?: string
  title?: string
  /** WP432：读回的真发出去的字（人在页面上改过时与 `text` 不一样）。 */
  sent_text?: string
  /** WP432：批了之后人又改过字（侧边栏里改、或在 Reddit 页面上改了再发）。 */
  edited?: boolean
  /** WP432：在页面上没认出框（新版改版了），是人自己粘贴发的。 */
  pasted?: boolean
  /** WP483：这一条走的哪条路（`ego` = 工坊在 ego 里发；没有 = 插件）。 */
  route?: WriteRoute
  /** WP483：ego 没发成、退回插件 / 被平台拦停下时那一句（事项里照实说）。 */
  route_note?: string
}

/** `GET /v1/social/reddit/writes` 的回包。 */
export interface RedditWritesList {
  rows: RedditWriteView[]
  /** WP445：插件里等你发的几条（还没在插件里打开的卡 + 主管批过、等你打开的），看板上那一行用。 */
  in_plugin?: number
}

/** WP332：没发出去的提醒在岗位页留多久（天）；更早的进度里还在，不再占一行。 */
export const REDDIT_WRITE_NOTICE_DAYS = 7

/**
 * WP332（决策 762，docs/96 出现规则）：岗位页「没发出去」提醒条该出哪几条——
 * 只出**没发出去、没收起、最近 {@link REDDIT_WRITE_NOTICE_DAYS} 天内**的；同一条写只一行（按 `job` 那一条算，
 * 再填一次不另起一行）。正常（排着 / 填好等你点 / 发出去了）一条都不出。
 */
export function redditWriteNotices(
  rows: readonly RedditWriteView[],
  now: Iso8601,
): RedditWriteView[] {
  const nowMs = Date.parse(now)
  const seen = new Set<string>()
  return rows.filter((r) => {
    if (r.state !== 'failed' || r.dismissed === true) return false
    const at = Date.parse(r.finished_at ?? r.queued_at)
    if (Number.isFinite(at) && nowMs - at > REDDIT_WRITE_NOTICE_DAYS * 86_400_000) return false
    if (seen.has(r.approval_item_id)) return false
    seen.add(r.approval_item_id)
    return true
  })
}

/**
 * WP328「待处理」条目里起草要用的那几格（结构上与 WP328 的 `RedditWatchEntry` 对齐：同名同义，
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
