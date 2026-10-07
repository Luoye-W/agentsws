/**
 * 九条渠道适配器的**接口**（56 §3 末段）。
 *
 * 八个口子，每条渠道**只实现它有的**（`SocialChannelAdapter` 上大半是可选的）：
 * `profile` / `posts` / `comments` / `publish` / `reply` / `members` /
 * `broadcast` / `moderate`。TikTok 没有"读评论"的公开接口，Reddit 没有"群发"，
 * 内容组四条没有"成员"——缺的就是缺的，回 `not_implemented` 那句人话，
 * **不假装有**。
 *
 * 四条纪律：
 *
 * 1. **真 HTTP 形状按各家公开文档写，`fetch` 注入**。适配器自己拼 URL、方法、
 *    头与 body（那是"这家的接口长什么样"这条事实），但真正发出去的那一跳是
 *    调用方递进来的 {@link SocialTransport.fetch}。于是这个包没有网络依赖、
 *    测试里塞一个假 fetch 就能把"401 怎么说""配额用完怎么说"测掉。
 * 2. **凭据从本品牌加密库按连接 id 取，不进日志**。{@link SocialTransport.credential}
 *    是一个**异步取一次**的口子；适配器拿到之后只往请求头里放，**不往返回值里放、
 *    不往错误消息里放**（见 {@link redactUrl}）。这个包里没有一处 `console`。
 * 3. **拿不到就说拿不到**（36 §3）。没连、没批下来、要付费、配额用完、要走浏览器，
 *    一律回 `{ ok: false, reason, message }`，`message` 是给人看的一句话。
 *    绝不回一个空数组假装"搜到 0 条"。
 * 4. **写动作照样先出卡**。`publish` / `broadcast` / `moderate` 这几个口子是
 *    **执行**那一跳（卡被批准之后执行器才调），不是"Agent 想发就发"。
 *    适配器不知道审批，也不该知道——但这一条写在这里，免得有人直接从
 *    起草那一跳调过来。
 */

import type { SocialChannel, SocialPostKind, SocialPostMetrics } from '@agentsws/contracts'

/** 拿不到数据 / 做不了动作的几种原因。界面上按它说不同的话。 */
export type SocialFailure =
  | 'not_connected'
  | 'not_implemented'
  | 'needs_approval'
  | 'needs_paid_tier'
  | 'quota_exhausted'
  | 'browser_required'
  | 'rate_limited'
  | 'upstream_error'
  // WP191（docs/86 §1.4）：正文超了平台的硬限制（字数 / 标签 / @ / 链接）。
  // 与 `upstream_error` 分开：这个用户自己改得好，那个他改不好。
  | 'content_rejected'

export interface SocialError {
  ok: false
  reason: SocialFailure
  /** 一句人话。"TikTok 的发布接口要先申请"比"401"有用得多。 */
  message: string
  /** 上游的状态码（有的话）。**不带 body**：body 里可能有回显的 token。 */
  status?: number
}

export interface SocialOk<T> {
  ok: true
  data: T
  /** 这份数据什么时候看到的（进 `observed_at` / `metrics_observed_at`）。 */
  observed_at: string
}

export type SocialResult<T> = SocialOk<T> | SocialError

/* ── 注入进来的那一跳 ────────────────────────────────────────────────── */

/** 一次 HTTP 的最小形状（`globalThis.fetch` 结构上满足它）。 */
export interface SocialHttpResponse {
  ok: boolean
  status: number
  text(): Promise<string>
  /**
   * WP191：响应头（可选，只加不改）。LinkedIn 发帖成功回 201 + 空 body，
   * 新帖的 id 只在 `x-restli-id` 头上——没有这一格就拿不到它。
   */
  headers?: { get(name: string): string | null }
}

export type SocialFetch = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  },
) => Promise<SocialHttpResponse>

/**
 * 适配器要的三样东西，由宿主注入。
 *
 * `credential` 回的是**这条连接**在本品牌加密库里的那几格（token / bot token /
 * page id …）。宿主每次现取现给，适配器不缓存——同 13 §4.3 与企业微信那条
 * 长连接的纪律：秘密不在对象里留着。
 */
export interface SocialTransport {
  fetch: SocialFetch
  /** 这条渠道现在连上了没有（没连的话适配器一跳都不打）。 */
  connected(channel: SocialChannel): boolean
  /**
   * 取这条连接的凭据。
   *
   * 返回的对象里是**明文**，所以：只往请求头 / query 里放，**绝不**放进
   * 返回值、错误消息或事件。取不到（没连、被吊销）就抛，由适配器翻成
   * `not_connected`。
   */
  credential(channel: SocialChannel): Promise<Record<string, string>>
  /** 现在（注入；这个包里没有 `Date.now()`）。 */
  now(): string
  /**
   * WP191：等一会儿（可选，只加不改）。IG / Threads 的视频是两跳发布，容器要等
   * 平台处理完才能发；给了它就隔几秒问一次状态，不给就只问一次、没好就照实说。
   */
  sleep?(ms: number): Promise<void>
}

/* ── 八个口子的出入参 ───────────────────────────────────────────────── */

/** 账号资料（读回来的那一份；`SocialAccount` 的 id 由宿主给）。 */
export interface ChannelProfile {
  channel: SocialChannel
  external_id: string
  handle: string
  display_name: string
  url: string
  followers?: number
  member_count?: number
  bio?: string
}

/** 一条帖子（读回来的那一份）。 */
export interface ChannelPost {
  external_id: string
  kind: SocialPostKind
  body: string
  published_at?: string
  url?: string
  metrics?: SocialPostMetrics
}

/** 一条评论 / 讨论 / 私信（读回来的那一份）。 */
export interface ChannelComment {
  external_id: string
  /** 挂在哪条帖子下（私信没有）。 */
  parent_external_id?: string
  surface: 'thread' | 'comment' | 'dm'
  author_external_id: string
  author_handle: string
  /** 正文。**外部文本**——调用方进模型上下文前要围栏（21 §1 / 39）。 */
  text: string
  created_at: string
  /**
   * WP257（决策 152）：这条是不是冲着我们来的——@ 了我们的机器人，或回的是机器人说的那句。
   * 判类打标签时当一条结构判据用。平台给不出就没有这一格（不猜）。
   */
  mentions_us?: boolean
}

/** 一个社群成员（读回来的那一份）。 */
export interface ChannelMember {
  external_id: string
  handle: string
  display_name?: string
  /** `pending` = 递了入群申请还没批。 */
  status: 'pending' | 'active' | 'muted' | 'banned'
  joined_at?: string
  application_answers?: string[]
}

export interface PublishInput {
  account_external_id: string
  kind: SocialPostKind
  body: string
  media_urls?: readonly string[]
  /** 排期时间；不给就是立即发。 */
  scheduled_at?: string
}

export interface ReplyInput {
  /** 回在哪条下面（评论 id / 讨论 id / 会话 id）。 */
  parent_external_id: string
  text: string
  account_external_id?: string
  /**
   * WP73：**对方最近一条入站消息**的时刻。
   *
   * 只有 WhatsApp 用得上：它的自由文本只能在 24 小时客服窗口里发，窗口的起点
   * 就是这一格。不给 = 当成窗口关着（把"没记过"当成"还开着"等于把这一闸悄悄
   * 打开，而闸后面是账号被封）。别的渠道忽略它。
   */
  last_inbound_at?: string
}

export interface BroadcastInput {
  account_external_id: string
  body: string
  /** 收件人（群发到群里的渠道不需要它）。 */
  recipients?: readonly string[]
  /** WhatsApp 才有：预先审过的模板名（Cloud API 的 `template.name`）。 */
  template_id?: string
  template_variables?: Readonly<Record<string, string>>
  /**
   * WP73：这批人是不是都 opt-in 过（WhatsApp 才有）。
   *
   * **不为真就不发**。与 `BroadcastProposal.opt_in_verified` 是同一件事的
   * 两个位置：那边 guardrail 拦，这边适配器再拦一次（执行器有可能被别的路径调到）。
   */
  opt_in_verified?: boolean
}

export interface ModerateInput {
  account_external_id: string
  /** 删帖时是帖子 id，禁言 / 封禁时是人的 id。 */
  target_external_id: string
  /**
   * WP249：`approve` = 版务队列里「批准」（被举报 / 被扣下 / 新帖放行，清掉举报）。只加不改：
   * 目前只有 Reddit 有这一口，别的渠道回 `not_implemented`。
   */
  action: 'delete_post' | 'mute' | 'unmute' | 'ban' | 'permanent_ban' | 'unban' | 'approve'
  /** 禁言多久（分钟）；不给就按平台默认。 */
  duration_minutes?: number
  reason?: string
  /**
   * WP249：移除时附的一句理由（版规条目），**公开**留给作者看。只有 Reddit 用它；
   * 不给就只移除、不留话。
   */
  removal_message?: string
  /**
   * WP249：这一条在哪个版务队列里（浏览器通道要在那一页上点按钮；OAuth 接口用不着）。
   */
  queue?: 'modqueue' | 'unmoderated'
}

/**
 * WP249：版务队列里的一条（被举报 / 被扣下 / 新帖未审），两条通道（OAuth 接口、官方号浏览器）
 * 读回来都归成这个形状。`title` / `excerpt` / `report_reasons` 是**外部文本**。
 */
export interface ModQueueEntry {
  /** fullname（`t3_` 帖子 / `t1_` 评论）。 */
  id: string
  subreddit: string
  thing: 'post' | 'comment'
  title?: string
  excerpt: string
  author: string
  report_reasons: string[]
  created_at?: string
  url: string
  /** 从哪个队列读的。 */
  source: 'modqueue' | 'unmoderated'
}

/** WP249：读哪一个版务队列。`join_requests` = 入群申请（Reddit 这一版读不到，照实说）。 */
export type ModQueueSource = 'modqueue' | 'unmoderated' | 'join_requests'

/**
 * WP256（决策 147）：「群里的帖子」自动进帖——读一个频道里**某条之后**的新消息（按平台 id 续读）。
 * 一页的结果：别人说的话（机器人自己的不算）+ 这一页读到的最后一条的 id（含机器人那几条，续读从它往后）。
 */
export interface ChannelFeedPage {
  items: ChannelComment[]
  /** 这一页里 id 最大的那一条（不管是谁说的）；没读到就没有。下一次从它往后读。 */
  last_id?: string
  /** 平台这一页回了几条（含过滤掉的）。不满一页 = 读到头了。 */
  fetched: number
}

/**
 * WP256：读消息还缺什么（照实提示缺哪个权限）。
 *
 * - `bot_not_in_server`：机器人不在这个服务器里（没邀请 / 被踢了）
 * - `view_channel`：看不到这个频道（「查看频道」）
 * - `read_message_history`：看得到频道但读不了历史消息（「读取消息历史」）
 * - `message_content`：开发者后台没开 Message Content Intent（读回来的正文全是空的）
 */
export type ChannelReadGap =
  | 'bot_not_in_server'
  | 'view_channel'
  | 'read_message_history'
  | 'message_content'
  /** WP257（Telegram）：机器人开着隐私模式（privacy mode），又不是群管理员——群里只看得到 @它的话与命令。 */
  | 'privacy_mode'
  /** WP257（Telegram）：这个机器人设了 webhook（别的工具在收它的消息），`getUpdates` 读不了。 */
  | 'webhook_active'

/**
 * WP257（决策 156）：Telegram 那种「整个机器人一条收件流」的一页（`getUpdates`）。
 *
 * 和 Discord 按频道续读不一样：Telegram 的新消息不分群，一个机器人只有一条流，按 `update_id` 续读；
 * 读走（下一次带上 `offset`）就算确认了，Telegram 不再给第二遍。所以每一条都带着它是哪个群的。
 */
export interface ChannelUpdatesPage {
  items: {
    /** 哪个群（数字 id 的字符串，超级群是 `-100…`）。 */
    chat_id: string
    /** 公开群的 @用户名（不带 @）；私有群没有。 */
    chat_username?: string
    comment: ChannelComment
  }[]
  /** 下一次从哪儿接着读（最后一条 `update_id + 1`）。这一页一条都没有就没有。 */
  next_offset?: string
  /** 平台这一页回了几条（含过滤掉的）。不满一页 = 读到头了。 */
  fetched: number
}

export interface MemberDecisionInput {
  account_external_id: string
  member_external_id: string
  decision: 'approve' | 'reject' | 'remove'
}

/**
 * 一条渠道的适配器。**大半是可选的**：平台没有的口子就不实现，
 * 调用方按 `adapter.publish === undefined` 判"这条渠道发不了"。
 *
 * 为什么不给一个全实现、缺的返回 `not_implemented`：那样界面上分不出
 * "这条渠道没有这个能力"和"这次调用失败了"。缺席本身就是信息。
 */
export interface SocialChannelAdapter {
  readonly channel: SocialChannel
  /** 这条渠道靠什么干活（`browser` 的写动作走第三栏受控浏览器）。 */
  readonly mode: 'api' | 'browser'
  profile?(account_external_id: string): Promise<SocialResult<ChannelProfile>>
  posts?(input: {
    account_external_id: string
    limit?: number
  }): Promise<SocialResult<ChannelPost[]>>
  comments?(input: {
    account_external_id: string
    post_external_id?: string
    limit?: number
  }): Promise<SocialResult<ChannelComment[]>>
  publish?(input: PublishInput): Promise<SocialResult<{ external_id: string; url?: string }>>
  reply?(input: ReplyInput): Promise<SocialResult<{ external_id: string }>>
  members?(input: {
    account_external_id: string
    status?: 'pending' | 'active'
    limit?: number
  }): Promise<SocialResult<ChannelMember[]>>
  decideMember?(input: MemberDecisionInput): Promise<SocialResult<{ ok: true }>>
  broadcast?(input: BroadcastInput): Promise<SocialResult<{ sent: number; failed: number }>>
  moderate?(input: ModerateInput): Promise<SocialResult<{ ok: true }>>
  /**
   * WP249：读一个版务队列（只有自家版、我们是版主才有）。只加不改：目前只有 Reddit 实现。
   */
  modQueue?(input: {
    account_external_id: string
    source: ModQueueSource
    limit?: number
  }): Promise<SocialResult<ModQueueEntry[]>>
  /** WP249：这个社群的版规（短名，一条一行）。只有 Reddit 实现。 */
  communityRules?(account_external_id: string): Promise<SocialResult<string[]>>
  /**
   * WP256（决策 147）：读一个频道里 `after` 之后的新消息（不给 `after` = 最近一页）。**只读**：
   * 不回复、不加反应。只加不改：目前只有 Discord 实现。
   */
  feed?(input: {
    account_external_id: string
    after?: string
    limit?: number
  }): Promise<SocialResult<ChannelFeedPage>>
  /** WP256：读这个频道的消息还缺哪几样权限（空数组 = 都齐了）。Discord、Telegram（WP257）实现。 */
  readAccess?(account_external_id: string): Promise<SocialResult<{ missing: ChannelReadGap[] }>>
  /**
   * WP257（决策 155 / 156）：登记一个群 / 频道时读一次它叫什么（**只读**一跳）：Discord 回「#general」，
   * Telegram 回群名，并把 `@用户名` 换成数字 id（收件流里只认数字 id）。
   */
  describeTarget?(
    account_external_id: string,
  ): Promise<SocialResult<{ name: string; external_id?: string }>>
  /**
   * WP257（决策 156）：整个机器人的新消息流（Telegram `getUpdates`），从 `offset` 往后读一页。**只读**：
   * 不回复。读走即确认（见 {@link ChannelUpdatesPage}）。只加不改：目前只有 Telegram 实现。
   */
  updates?(input: { offset?: string; limit?: number }): Promise<SocialResult<ChannelUpdatesPage>>
}

/* ── 共用的那几句人话与那几段样板 ─────────────────────────────────────── */

/** 没连时的那一句（九条渠道共用一个说法，界面上才一致）。 */
export function notConnected(label: string): SocialError {
  return {
    ok: false,
    reason: 'not_connected',
    message: `${label} 还没连上，所以这一块没有数。去连接页把 ${label} 连上。`,
  }
}

/** 还没做的那一句（与"没连"分得开：那个用户修得好，这个他修不好）。 */
export function notImplemented(label: string, plan: string): SocialError {
  return {
    ok: false,
    reason: 'not_implemented',
    message: `${label} 的适配器还没做（${plan}）。排期、草稿、审批这几件事照常能用——真正发出去那一跳等接上。`,
  }
}

/** 申请制那一句（TikTok）。 */
export function needsApproval(label: string, what: string): SocialError {
  return {
    ok: false,
    reason: 'needs_approval',
    message: `${label} 的${what}是申请制：要先向平台提交用途说明，批下来才有接口。没批下来之前，这一块只能人工去后台做。`,
  }
}

/** 付费档那一句（X）。 */
export function needsPaidTier(label: string, what: string): SocialError {
  return {
    ok: false,
    reason: 'needs_paid_tier',
    message: `${label} 的${what}在付费档上。免费档拿不到这个口子——要么买档，要么这一块人工做。`,
  }
}

/**
 * WP191：正文超了平台硬限制那一句（`checkPostText` 量出来的几条原样拼上）。
 * 发出去一定会被平台退回的东西，不打那一跳。
 */
export function contentRejected(
  label: string,
  problems: readonly { message: string }[],
): SocialError {
  return {
    ok: false,
    reason: 'content_rejected',
    message: `${label} 会退回这条：${problems.map((p) => p.message).join(' ')}`,
  }
}

/** 浏览器模式那一句（Facebook 群组）。 */
export function browserRequired(label: string, what: string): SocialError {
  return {
    ok: false,
    reason: 'browser_required',
    message: `${label} 没有可用的接口（官方 API 已停），${what}要走第三栏的受控浏览器。这条路还没接上执行器——现在只能人工去做。`,
  }
}

/**
 * 把 URL 里的 query 去掉再进错误消息。
 *
 * 好几家把 token 放在 query 上（YouTube 的 `key=`、Telegram 直接写在路径里），
 * 错误消息会进事件日志与卡面——原样贴一个 URL 等于把 token 抄进日志。
 */
export function redactUrl(url: string): string {
  const q = url.indexOf('?')
  const base = q < 0 ? url : url.slice(0, q)
  // Telegram 的 token 在**路径**上（`/bot<token>/method`），单独抹一次
  return base.replace(/\/bot[^/]+\//, '/bot***/')
}

/** 上游抛出来的东西 → 一句人话。认不出来的一律 `upstream_error`，**不编原因**。 */
export function upstreamError(label: string, e: unknown, url?: string): SocialError {
  const text = e instanceof Error ? e.message : String(e)
  return {
    ok: false,
    reason: 'upstream_error',
    message: `${label} 那边没给回数据${url === undefined ? '' : `（${redactUrl(url)}）`}：${text.slice(0, 160)}`,
  }
}

/**
 * HTTP 状态码 → 人话。
 *
 * 401 / 403 说的是"连接掉了或者权限不够"，429 说的是"太快了"，
 * 5xx 说的是"那边的问题"。**响应 body 不进消息**：body 里可能有回显的凭据，
 * 也常常是一大段 JSON，对人没有用。
 */
export function httpFailure(label: string, status: number, url: string): SocialError {
  if (status === 401 || status === 403)
    return {
      ok: false,
      reason: 'not_connected',
      status,
      message: `${label} 拒绝了这次调用（${status}）。多半是授权掉了或者这把 token 的权限不够——去连接页重新授权一次。`,
    }
  if (status === 429)
    return {
      ok: false,
      reason: 'rate_limited',
      status,
      message: `${label} 说太快了（429）。等一会儿再试；这一批先排着，不会丢。`,
    }
  return {
    ok: false,
    reason: 'upstream_error',
    status,
    message: `${label} 回了 ${status}（${redactUrl(url)}）。`,
  }
}

/**
 * 打一跳并把 JSON 解出来。**所有适配器共用这一段**，所以"错误怎么翻成人话"
 * 全仓只有一处。
 */
export async function callJson<T>(
  transport: SocialTransport,
  label: string,
  url: string,
  init?: Parameters<SocialFetch>[1],
): Promise<{ ok: true; data: T } | SocialError> {
  let res: SocialHttpResponse
  try {
    res = await transport.fetch(url, init)
  } catch (e) {
    return upstreamError(label, e, url)
  }
  if (!res.ok) return httpFailure(label, res.status, url)
  try {
    return { ok: true, data: JSON.parse(await res.text()) as T }
  } catch (e) {
    return upstreamError(label, e, url)
  }
}

/** 没连就短路（九条渠道的每个口子第一行都是它）。 */
export function guardConnected(
  transport: SocialTransport,
  channel: SocialChannel,
  label: string,
): SocialError | undefined {
  return transport.connected(channel) ? undefined : notConnected(label)
}
