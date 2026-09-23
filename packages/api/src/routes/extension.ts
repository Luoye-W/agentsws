/**
 * WP119（68）：**浏览器插件的本地一面** `/v1/extension/*`。
 *
 * 插件的数据走本地，不走云。所以这条路上有两种调用方，判权方式完全不同：
 *
 * - **工作台（所有者）**：`POST /v1/extension/pairings` 出一个 6 位码、
 *   `GET /v1/extension/tokens` 看已配的几把、`POST …/revoke` 撤一把。
 *   走网关那套 Bearer + `X-Assignment`，域是 `store_config`（与连接页同一把闸）。
 * - **插件自己**：`POST /v1/extension/pair` 用码换令牌、
 *   `POST /v1/extension/observations` 报一批观测、`GET /v1/extension/hello` 问状态。
 *   这三条**不走网关鉴权**（`auth: 'public'`），因为插件令牌不是身份 token：
 *   它只有三个动作、绑死一个扩展 id、在 {@link ExtensionStore} 里自成一张表。
 *   判权在处理器里做，**Origin 与令牌同时对**才算通过。
 *
 * 为什么不需要 CORS：MV3 里只有 background service worker 能发这些请求
 * （它持有 `host_permissions`，跨源不受 CORS 检查），content script 一律经它转发。
 * 于是这台机器上不存在「通配 CORS」这件事——一个不在白名单里的网页
 * 连预检都发不出来。
 */

import type { Iso8601, KolChannel, MaybePromise } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import type { ExtensionScope, ExtensionSession, ExtensionStore } from '../extension-store.js'
import { body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/** 插件报上来的一条观测。字段就是这几个——**正文、评论、私信一个都没有**。 */
export interface ExtensionObservation {
  channel: KolChannel
  /** 平台上的 handle（YouTube 保留前导 `@`）。 */
  handle: string
  external_id?: string | undefined
  display_name?: string | undefined
  url?: string | undefined
  avatar_url?: string | undefined
  followers?: number | undefined
  /** 页面上原样渲染的那串（`1.2万位订阅者`）——解析对不对由服务端再判一次。 */
  followers_text?: string | undefined
  avg_views?: number | undefined
  video_count?: number | undefined
  country?: string | undefined
  bio?: string | undefined
  /** 用户显式点过「收下这个邮箱」才有；明文当场进本机加密库。 */
  contact?: { kind: 'email' | 'dm' | 'phone' | 'form'; value: string; source?: string } | undefined
  observed_at: Iso8601
  page_url?: string | undefined
  source: 'channel_page' | 'content_page' | 'search_results'
  /**
   * WP130（docs/76 §11，只加）：列表页批量采集时这一行从哪种列表来——搜索结果 /
   * 视频页右栏「相关视频」/ hashtag 页。记在本机粉丝快照上（`account_observation`），
   * **不出本机**（公共库那条窄行里没有它）。
   */
  source_page?: 'search' | 'watch_related' | 'hashtag' | undefined
  /** 这一批读自哪里：搜索词，或列表页的网址。 */
  source_query?: string | undefined
  /** 相关视频栏的预筛分（0–100）。没打分就没有这一格——「没法判」不是 0 分。 */
  relevance_score?: number | undefined
}

export type ExtensionIngestStatus = 'ok' | 'deduped' | 'invalid'

export interface ExtensionIngestRow {
  handle: string
  status: ExtensionIngestStatus
  creator_id?: string
  reason?: string
}

export interface ExtensionIngestResult {
  rows: ExtensionIngestRow[]
  /** 这一批里有几条同时转发去了云端公共红人库（未登录 = 0）。 */
  forwarded_to_public_library: number
  /**
   * WP131（只加）：**这次采集批次的 id**（`bt_…`）。插件一次列表采集按 20 条分块发，
   * 第一块不带 `batch_id`、服务端发一个新的；后面几块把它原样带上，同一批就落在同一个
   * 批次里。「回作战室看这批」深链 `/influencer/creators?batch=<id>` 拿它筛。
   * 老服务不回这一格——插件回落到不带批次的深链。
   */
  batch_id?: string
  /** WP131（只加）：采集后自动评分 / 体检的排队回执；开关关着就没有这一格。 */
  auto_score?: ExtensionAutoScoreQueued
}

/**
 * WP131：「采集后自动评分」那一条开关（**每工作区一个，默认关**）。
 *
 * 开着时，收进红人库的人会排队跑两件事：
 * 1. 本机打分（`kol-core` 的 `scoreCreator`，**不花积分**）；
 * 2. 关联了云账号时，再跑一次云端体检报告（`data.kol.audit`，**花积分**，
 *    按 `credits_per_creator` 那个价；30 天内体检过的人不重复体检）。
 */
export interface ExtensionAutoScoreView {
  enabled: boolean
  /** 关联了云账号 = 体检那一半会跑（花积分）；没关联只做本机打分（免费）。 */
  cloud_linked: boolean
  /** 每位红人约多少积分（体检那一次的价；没关联云账号时是 0）。面板在收进前常显它。 */
  credits_per_creator: number
  /** 还在队里没跑完的人数。 */
  pending: number
  /** 一句人话（面板上直接显示）。 */
  note: string
}

/** 一次采集的排队回执。 */
export interface ExtensionAutoScoreQueued {
  /** 这一次排进队的人数。 */
  queued: number
  /** 其中会跑云端体检的人数（30 天内体检过的、没关联云账号的不算）。 */
  audits: number
  /** 这一批体检最多花多少积分（`audits × 单价`；样本不够的那几位不收，实扣只会更少）。 */
  credits_estimate: number
}

/** 插件开屏那一行要的全部事实。 */
export interface ExtensionHello {
  workspace_id: string
  workspace_name: string
  /** 关联了 agentsws 云账号 = 观测默认共享到公共红人库。 */
  cloud_linked: boolean
  shares_to_public_library: boolean
  scopes: ExtensionScope[]
  server_version: string
  /**
   * WP119c：**工作台的基址**（`http://127.0.0.1:<端口>`）。「去工作台看」的深链
   * （`/influencer/creators`、`/settings/credits` …）拿它当基底，插件自己不猜端口。
   * 装配没给就回 `undefined`——插件回落到自己配的基址。
   */
  workbench_url?: string
}

export interface ExtensionPort {
  store: ExtensionStore
  ingest(
    session: ExtensionSession,
    input: { observations: ExtensionObservation[]; batch_id?: string },
  ): MaybePromise<ExtensionIngestResult>
  hello(session: ExtensionSession): MaybePromise<ExtensionHello>

  /* ── WP119c：完整版面板要的那一批（docs/76 §10；清单出自私有仓 parity.md §六）────
   *
   * 十一条，全部**只加不改**：已有两个字段与两个方法的语义一个字不动。
   * 每一条的鉴权都是同一套（插件令牌 + Origin，`sessionOf`），scope 在各路由声明。
   */

  /** 品牌（工作区）/ 活动 / 候选池——存入面板与搜索 FAB 的组织上下文。 */
  setup(session: ExtensionSession): MaybePromise<ExtensionSetup>
  /** 显式存入红人池（upsert 全量快照；写本地红人库）。 */
  saveCreator(
    session: ExtensionSession,
    input: ExtensionCreatorSave,
  ): MaybePromise<ExtensionCreatorSaveResult>
  /** 本机观测历史 + 粉丝趋势 + 已存状态。库里没这个人回 `undefined`（路由接 404）。 */
  creatorReport(
    session: ExtensionSession,
    key: ExtensionCreatorKey,
  ): MaybePromise<ExtensionCreatorReport | undefined>
  /** 看一次邮箱的积分价（**不消耗**；价取 `pricing.json` 的 `data.kol.lookup`）。 */
  revealPricing(session: ExtensionSession): MaybePromise<ExtensionRevealPricing>
  /** 公共库 reveal（本机代理云端；计费在服务端，余额不足回人话不回裸码）。 */
  contactLookup(
    session: ExtensionSession,
    key: ExtensionCreatorKey,
  ): MaybePromise<ExtensionContactLookup>
  /** 贡献一条联系方式到公共库（云端收；本机顺手存进自己的红人池）。 */
  contactContribute(
    session: ExtensionSession,
    key: ExtensionCreatorKey,
    input: { value: string; source_url?: string },
  ): MaybePromise<ExtensionContactContribution>
  /** 标记一条联系方式是错的（免费；云端只记不裁）。 */
  contactDispute(
    session: ExtensionSession,
    key: ExtensionCreatorKey,
    input: { value?: string; reason?: string },
  ): MaybePromise<ExtensionContactDispute>
  /** 写进自己红人池的联系方式行（明文进本机加密库）。 */
  saveContact(
    session: ExtensionSession,
    input: ExtensionContactSave,
  ): MaybePromise<ExtensionContactSaveResult>
  /** 公共池内容观测。**永不携带评论文本**（红线，schema 整批拒 + 测试钉住）。 */
  contentObservation(
    session: ExtensionSession,
    input: ExtensionContentObservation,
  ): MaybePromise<ExtensionContentResult>
  /** 存入自己的内容库（**唯一**可带已采评论的端点；最多保 200 条）。 */
  contentSave(
    session: ExtensionSession,
    input: ExtensionContentSave,
  ): MaybePromise<ExtensionContentSaveResult>
  /** 简介外链页（Linktree / Beacons）观测。 */
  bioLinkObservation(
    session: ExtensionSession,
    input: ExtensionBioLinkObservation,
  ): MaybePromise<ExtensionBioLinkResult>
  /** 种子频道主题词。库里没这个人回 `undefined`（路由接 404 = 不是种子）。 */
  seedSignature(
    session: ExtensionSession,
    key: ExtensionCreatorKey,
  ): MaybePromise<ExtensionSeedSignature | undefined>

  /* ── WP131（只加；可选——老装配不实现，两条路回 not_implemented）──────── */

  /** 「采集后自动评分」开关的现状（含每位约多少积分）。 */
  autoScore?(session: ExtensionSession): MaybePromise<ExtensionAutoScoreView>
  /** 开 / 关「采集后自动评分」（每工作区一个）。 */
  setAutoScore?(
    session: ExtensionSession,
    input: { enabled: boolean },
  ): MaybePromise<ExtensionAutoScoreView>
}

/* ── WP119c 的线上形状（与 docs/76 §10 一一对应）────────────────────────── */

/** report / contact / seed-signature 共用的「这个人」键。handle 与平台 id 都认。 */
export interface ExtensionCreatorKey {
  channel: KolChannel
  /** handle 或平台的稳定 id（`UC…`）；服务端两边都找。 */
  handle: string
}

/** `GET /v1/extension/setup` 的回执。字段是旧面板认的那三个清单 + 候选池。 */
export interface ExtensionSetup {
  organizations: { id: string; name: string }[]
  workspaces: { id: string; organization_id: string; name: string }[]
  brands: { id: string; organization_id: string; workspace_id: string; name: string }[]
  /** 活动来自本地红人库的合作记录上的 `campaign_id`（去重；没有合作就是空清单）。 */
  campaigns: { id: string; brand_id: string; name: string; created_at?: Iso8601 }[]
  /** 本机候选池（红人库）的清单概览；`creators` 最多给 100 条。 */
  creator_pool: {
    total: number
    creators: {
      creator_id: string
      display_name: string
      channel: KolChannel
      handle: string
      followers?: number
    }[]
  }
}

/** `POST /v1/extension/creators` 的入参——观测的白名单再加显式存入才有的几格。 */
export interface ExtensionCreatorSave {
  channel: KolChannel
  handle: string
  external_id?: string
  display_name?: string
  url?: string
  avatar_url?: string
  banner_url?: string
  followers?: number
  followers_text?: string
  avg_views?: number
  video_count?: number
  total_views?: number
  country?: string
  bio?: string
  /** 页面上看到的商务邮箱。存入是一次显式动作，这一格随它走（明文进本机加密库）。 */
  contact?: { kind: 'email' | 'dm' | 'phone' | 'form'; value: string; source?: string }
  /** 存进哪个活动（本地合作记录上的 campaign）；不给就不挂。 */
  campaign_id?: string
  observed_at: Iso8601
  page_url?: string
  source?: 'channel_page' | 'content_page' | 'search_results' | 'manual_save'
}

export interface ExtensionCreatorSaveResult {
  status: 'ok' | 'deduped'
  creator_id: string
  campaign_id?: string
}

/** `GET /v1/extension/creators/:channel/:handle/report` 的回执。 */
export interface ExtensionCreatorReport {
  creator: {
    channel: KolChannel
    handle: string
    external_id?: string
    display_name?: string
    latest_captured_at?: Iso8601
  }
  report: {
    followers: number | null
    avg_views: number | null
    video_count: number | null
    /** 最近 30 天里最早与最近两个快照的差；快照不足两个 = null（不是 0）。 */
    follower_trend: { days: number; delta: number; percent: number } | null
    snapshot_count: number
  }
  /**
   * 「你已拥有」的那一半：这个工作区自己的红人池里有没有他、已有的邮箱（
   * 自己存的或公共库取过的——**明文**，配对面板要显示它）与上次更新。
   */
  tenant_pool: {
    saved: boolean
    email?: string | null
    last_updated_at?: string | null
  }
}

/** 30 天窗口（与云端「30 天内重看不另收费」同一个数；本机存下之后一直免费）。 */
export const REVEAL_FREE_WINDOW_DAYS = 30

export interface ExtensionRevealPricing {
  capability: string
  credits_per_reveal: number
  free_window_days: number
  note: string
}

export type ExtensionContactLookup =
  | {
      status: 'found'
      contact: { value: string; source?: string; confirmed_at?: Iso8601 }
      /** 这次实际花了多少。本机已有的邮箱是 0——已经是你自己的了。 */
      credits_charged: number
    }
  | { status: 'none'; message: string }
  | {
      status: 'payment_required'
      reason: 'insufficient_credits'
      credits_required: number
      message: string
    }

export type ExtensionContactContribution =
  | { status: 'recorded'; action: 'new' | 'noop'; rewarded: boolean; message?: string }
  | { status: 'unavailable'; message: string }

export interface ExtensionContactDispute {
  status: 'recorded' | 'noop'
  message: string
}

export interface ExtensionContactSave {
  channel: KolChannel
  handle: string
  external_id?: string
  display_name?: string
  /** 联系方式的值（邮箱 / 私信名 / 表单地址）。明文只经过这一跳进加密库。 */
  contact_value: string
  contact_kind: 'email' | 'dm' | 'phone' | 'form'
  source?: string
  page_url?: string
  observed_at?: Iso8601
}

export interface ExtensionContactSaveResult {
  status: 'ok' | 'not_stored'
  contact_id?: string
  creator_id: string
  reason?: string
}

/** 一条内容的计数。**没有评论这一格**——评论只走 `/contents`。 */
export interface ExtensionContentStats {
  views?: number
  likes?: number
  comments?: number
  shares?: number
}

export interface ExtensionContentObservation {
  channel: KolChannel
  /** 平台的稳定内容 id（视频 id / shortcode）。 */
  content_external_id: string
  content_type: 'video' | 'post' | 'reel'
  /**
   * 标题。**WP131 起可选**（Luoye 09-23）：IG 网格 / TikTok hashtag 格子上的帖子没有标题，
   * 照样是内容观测。空串 / 全空白也当没有。界面上无标题的条目显示「（无标题）· 平台 · 编号」。
   */
  title?: string
  url?: string
  thumbnail_url?: string
  published_at?: Iso8601
  stats: ExtensionContentStats
  author: { external_id: string; handle?: string; name?: string; followers?: number }
  orientation?: 'landscape' | 'portrait'
  duration_seconds?: number
  /**
   * WP129：页面上平台自己打的「含付费推广」标识。没采到就别带这一格——
   * `false` 是"看过、没有"。登录了云账号时随内容观测进公共库。
   */
  paid_promotion?: boolean
  /** WP129：有没有带货入口（商品标签 / 购物车 / 商品链接）。语义同上。 */
  shoppable?: boolean
  captured_at: Iso8601
  source_url?: string
}

export interface ExtensionContentResult {
  status: 'ok' | 'deduped'
  content_id: string
  /**
   * WP129：这一条有没有送进公共红人库（1 / 0）。登录了云账号才会送（同红人观测的
   * 规则，没有第二个开关）；没登录、云连不上、作者 handle 认不出来都是 0。
   * 老服务不回这一格——插件当 0 看。
   */
  forwarded_to_public_library?: number
}

export interface ExtensionContentComment {
  text: string
  author?: string
  like_count?: number
  published_at?: string
}

/** 存入自己的内容库：观测的白名单 + 已采评论 + 活动。评论**只**在这里有入口。 */
export interface ExtensionContentSave extends ExtensionContentObservation {
  campaign_id?: string
  /** 最多保 200 条（按 like 数留最响的）；服务端回实存几条。 */
  captured_comments?: ExtensionContentComment[]
}

export interface ExtensionContentSaveResult {
  status: 'ok' | 'deduped'
  content_id: string
  creator_id: string
  comments_stored?: number
}

export interface ExtensionBioLinkObservation {
  platform: 'linktree' | 'beacons'
  /** 页面自己的 handle（`linktr.ee/<slug>` 的那一段）。 */
  slug: string
  source_url: string
  links: { title?: string; url: string }[]
  social_links: { type?: string; url: string }[]
  emails: string[]
  bio?: string
  display_name?: string
  avatar_url?: string
  captured_at: Iso8601
}

export interface ExtensionBioLinkResult {
  status: 'ok' | 'deduped'
  /** 这条页面能对上库里的几个红人（本机按 slug ↔ 页面来路对；对不上就是 0，不是失败）。 */
  attached_creators: number
}

export interface ExtensionSeedSignature {
  platform: KolChannel
  external_id: string
  /** 短主题词（取自已存红人的类目与简介）。空清单 = 瘤种子，面板不做预筛。 */
  topic_keywords: string[]
}

/**
 * 权限照连接页那一套（31 §3.1 完整元组）：**读**清单是
 * `store_config.read@workspace`，**发码 / 撤令牌**是策略层的
 * `policy.stage@workspace`——给一个外部程序发一把能写本地红人库的令牌，
 * 跟授权一个连接器是同一件事，永远 L1。
 */
const READ = {
  domain: 'store_config',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const MANAGE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

function portOf(deps: GatewayDeps): ExtensionPort {
  const p = deps.extension
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配浏览器插件的本地一面（GatewayDeps.extension）。插件配不上对，工作台其余一切照常。',
    )
  return p
}

/**
 * 插件令牌 + Origin 双校验。
 *
 * 失败一律 `unauthenticated` 且**不区分原因**（码错了 / 撤了 / 过期了 / Origin 不对
 * 都是同一句）——区分等于给人一台探测机。
 */
function sessionOf(c: Parameters<Route['handler']>[0], deps: GatewayDeps): ExtensionSession {
  const raw = c.req.header('Authorization') ?? ''
  const session = portOf(deps).store.authenticate(raw, c.req.header('Origin'))
  if (session === undefined)
    throw new ApiError(
      'unauthenticated',
      '插件令牌无效、已撤销、已过期，或不是从配对时那个扩展发来的',
    )
  return session
}

const contactSchema = z.object({
  kind: z.enum(['email', 'dm', 'phone', 'form']),
  value: z.string().min(1).max(320),
  source: z.string().max(300).optional(),
})

/**
 * 观测的**白名单**。`.strict()` 不是洁癖：多一个键整批拒，是因为
 * 一条带正文的观测是一个信号，悄悄丢掉它等于把信号也丢了（同 48 §5.3）。
 */
const observationSchema = z
  .object({
    channel: z.enum(['youtube', 'instagram', 'tiktok', 'facebook', 'x']),
    handle: z.string().min(1).max(120),
    external_id: z.string().max(120).optional(),
    display_name: z.string().max(200).optional(),
    url: z.string().max(600).optional(),
    avatar_url: z.string().max(600).optional(),
    followers: z.number().int().nonnegative().optional(),
    followers_text: z.string().max(120).optional(),
    avg_views: z.number().nonnegative().optional(),
    video_count: z.number().int().nonnegative().optional(),
    country: z.string().max(80).optional(),
    bio: z.string().max(2000).optional(),
    contact: contactSchema.optional(),
    observed_at: z.string().min(1),
    page_url: z.string().max(600).optional(),
    source: z.enum(['channel_page', 'content_page', 'search_results']),
    // WP130：列表来源（只加；老插件不带，照旧）
    source_page: z.enum(['search', 'watch_related', 'hashtag']).optional(),
    source_query: z.string().max(600).optional(),
    relevance_score: z.number().int().min(0).max(100).optional(),
  })
  .strict()

/**
 * 采集批次 id 的样子（WP131）：服务端发的 `bt_` + 小写字母数字。插件只能原样带回，
 * 不能自己编一个别的形状——那样工作台按批次筛就对不上。
 */
export const EXTENSION_BATCH_ID = /^bt_[a-z0-9]{4,40}$/

/** 一批最多 100 条（插件自己按 20 条分块发，100 是给别的调用方留的上限）。 */
const ingestSchema = z.object({
  observations: z.array(observationSchema).min(1).max(100),
  // WP131：同一次列表采集的后几块带上第一块拿到的批次 id（只加；老插件不带）
  batch_id: z.string().regex(EXTENSION_BATCH_ID).optional(),
})

const autoScoreSchema = z.object({ enabled: z.boolean() }).strict()

const pairSchema = z.object({ code: z.string().min(1).max(12) })

const pairingSchema = z.object({ label: z.string().min(1).max(60).optional() })

/* ── WP119c 的请求体 schema（全部 `.strict()`：多一个键整批拒）──────────── */

const channelSchema = z.enum(['youtube', 'instagram', 'tiktok', 'facebook', 'x'])

/**
 * 内容观测的白名单。红线在这里钉死：**没有评论这一格**——
 * `captured_comments` / `comments_text` 之类的键一律走 `.strict()` 的「多一个键
 * 整批拒」，让「有人想把评论塞进公共池」变成一个看得见的 400，而不是被悄悄剥掉。
 */
const contentStatsSchema = z
  .object({
    views: z.number().int().nonnegative().optional(),
    likes: z.number().int().nonnegative().optional(),
    comments: z.number().int().nonnegative().optional(),
    shares: z.number().int().nonnegative().optional(),
  })
  .strict()

const contentObservationSchema = z
  .object({
    channel: channelSchema,
    content_external_id: z.string().min(1).max(160),
    content_type: z.enum(['video', 'post', 'reel']),
    // WP131：标题可选（空串也收，当没有）——没标题的帖子照样进内容观测
    title: z.string().max(300).optional(),
    url: z.string().max(600).optional(),
    thumbnail_url: z.string().max(600).optional(),
    published_at: z.string().max(60).optional(),
    stats: contentStatsSchema,
    author: z
      .object({
        external_id: z.string().min(1).max(160),
        handle: z.string().max(120).optional(),
        name: z.string().max(200).optional(),
        followers: z.number().int().nonnegative().optional(),
      })
      .strict(),
    orientation: z.enum(['landscape', 'portrait']).optional(),
    duration_seconds: z.number().nonnegative().optional(),
    // WP129：带货 / 广告标识（只加；布尔，没采到就不带）
    paid_promotion: z.boolean().optional(),
    shoppable: z.boolean().optional(),
    captured_at: z.string().min(1),
    source_url: z.string().max(600).optional(),
  })
  .strict()

const contentCommentSchema = z
  .object({
    text: z.string().min(1).max(2000),
    author: z.string().max(120).optional(),
    like_count: z.number().int().nonnegative().optional(),
    published_at: z.string().max(60).optional(),
  })
  .strict()

const contentSaveSchema = contentObservationSchema
  .extend({
    campaign_id: z.string().max(80).optional(),
    // 最多带 500 条，服务端只保 200 条——上跟旧插件同一张帽子。
    captured_comments: z.array(contentCommentSchema).max(500).optional(),
  })
  .strict()

/** 显式存入红人池：观测的白名单再加存入才有的几格。 */
const creatorSaveSchema = z
  .object({
    channel: channelSchema,
    handle: z.string().min(1).max(120),
    external_id: z.string().max(120).optional(),
    display_name: z.string().max(200).optional(),
    url: z.string().max(600).optional(),
    avatar_url: z.string().max(600).optional(),
    banner_url: z.string().max(600).optional(),
    followers: z.number().int().nonnegative().optional(),
    followers_text: z.string().max(120).optional(),
    avg_views: z.number().nonnegative().optional(),
    video_count: z.number().int().nonnegative().optional(),
    total_views: z.number().nonnegative().optional(),
    country: z.string().max(80).optional(),
    bio: z.string().max(2000).optional(),
    contact: contactSchema.optional(),
    campaign_id: z.string().max(80).optional(),
    observed_at: z.string().min(1),
    page_url: z.string().max(600).optional(),
    source: z.enum(['channel_page', 'content_page', 'search_results', 'manual_save']).optional(),
  })
  .strict()

/** 写进自己红人池的联系方式行。 */
const contactSaveSchema = z
  .object({
    channel: channelSchema,
    handle: z.string().min(1).max(120),
    external_id: z.string().max(120).optional(),
    display_name: z.string().max(200).optional(),
    contact_value: z.string().min(1).max(320),
    contact_kind: z.enum(['email', 'dm', 'phone', 'form']),
    source: z.string().max(300).optional(),
    page_url: z.string().max(600).optional(),
    observed_at: z.string().min(1).optional(),
  })
  .strict()

const contactContributeSchema = z
  .object({ value: z.string().min(1).max(320), source_url: z.string().max(600).optional() })
  .strict()

const contactDisputeSchema = z
  .object({ value: z.string().max(320).optional(), reason: z.string().max(600).optional() })
  .strict()

const bioLinkObservationSchema = z
  .object({
    platform: z.enum(['linktree', 'beacons']),
    slug: z.string().min(1).max(120),
    source_url: z.string().min(1).max(600),
    links: z
      .array(
        z
          .object({ title: z.string().max(200).optional(), url: z.string().min(1).max(600) })
          .strict(),
      )
      .max(50),
    social_links: z
      .array(z.object({ type: z.string().max(40).optional(), url: z.string().max(600) }).strict())
      .max(50),
    emails: z
      .array(
        z
          .string()
          .max(320)
          .refine((v) => v.includes('@'), '不是邮箱'),
      )
      .max(20),
    bio: z.string().max(2000).optional(),
    display_name: z.string().max(200).optional(),
    avatar_url: z.string().max(600).optional(),
    captured_at: z.string().min(1),
  })
  .strict()

/** scope 检查的统一出口：三个 scope 的名字与话术都收在这一个函数里。 */
function requireScope(session: ExtensionSession, scope: ExtensionScope, doing: string): void {
  if (!session.scopes.includes(scope))
    throw new ApiError('forbidden', `这把令牌没有 ${scope}，做不了「${doing}」这一步`)
}

export function extensionRoutes(): Route[] {
  return [
    route(
      {
        method: 'post',
        path: '/v1/extension/pairings',
        operationId: 'createExtensionPairing',
        summary: '出一个 6 位配对码（5 分钟、一次性；再按一下上一码作废）',
        tag: 'extension',
        auth: 'bearer',
        assignment: true,
        authz: MANAGE,
        body: pairingSchema,
        returns: 'PairingView',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const input = await body(c, pairingSchema)
        return ok(
          c,
          portOf(deps).store.createPairing({
            workspace_id: p.workspace_id,
            person_id: p.person_id,
            ...(input.label === undefined ? {} : { label: input.label }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/extension/tokens',
        operationId: 'listExtensionTokens',
        summary: '已配上的插件（扩展 id、最近使用时间、撤销状态）',
        tag: 'extension',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ tokens: ExtensionTokenView[] }',
      },
      async (c, deps) => ok(c, { tokens: portOf(deps).store.list(principalOf(c).workspace_id) }),
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/tokens/:id/revoke',
        operationId: 'revokeExtensionToken',
        summary: '撤一把插件令牌（写 revoked_at，不删行）',
        tag: 'extension',
        auth: 'bearer',
        assignment: true,
        authz: MANAGE,
        returns: 'ExtensionTokenView',
      },
      async (c, deps) => {
        const view = portOf(deps).store.revoke(principalOf(c).workspace_id, param(c, 'id'))
        if (view === undefined) throw new ApiError('not_found', '没有这把插件令牌')
        return ok(c, view)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/pair',
        operationId: 'redeemExtensionPairing',
        summary: '插件用 6 位码换一把只给它用的令牌（Origin 必须是扩展自己的）',
        tag: 'extension',
        auth: 'public',
        body: pairSchema,
        returns: 'RedeemedToken',
      },
      async (c, deps) => {
        const input = await body(c, pairSchema)
        const out = portOf(deps).store.redeem({
          code: input.code,
          origin: c.req.header('Origin'),
        })
        if (!out.ok) {
          // Origin 不对是「你不是扩展」，其余都是「码不对」——两句人话，不给码。
          if (out.reason === 'bad_origin')
            throw new ApiError(
              'forbidden',
              '这条只给浏览器扩展用（Origin 必须是 chrome-extension://…）',
            )
          throw new ApiError(
            'unauthenticated',
            '配对码不对、已经用过，或已经过期了。回工作台再生成一个。',
          )
        }
        return ok(c, out.issued)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/extension/hello',
        operationId: 'extensionHello',
        summary: '插件问状态：这是哪个品牌、登录了没有、观测会不会上公共库',
        tag: 'extension',
        auth: 'public',
        returns: 'ExtensionHello',
      },
      async (c, deps) => ok(c, await portOf(deps).hello(sessionOf(c, deps))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/observations',
        operationId: 'ingestExtensionObservations',
        summary: '插件报一批观测（写本地红人库；登录态同时转发到公共红人库）',
        tag: 'extension',
        auth: 'public',
        body: ingestSchema,
        returns: 'ExtensionIngestResult',
      },
      async (c, deps) => {
        const session = sessionOf(c, deps)
        if (!session.scopes.includes('kol.observe'))
          throw new ApiError('forbidden', '这把令牌没有 kol.observe')
        const input = await body(c, ingestSchema)
        return ok(
          c,
          await portOf(deps).ingest(
            session,
            input as { observations: ExtensionObservation[]; batch_id?: string },
          ),
        )
      },
    ),

    /* ── WP119c：完整版面板要的那一批（docs/76 §10）──────────────────────── */

    route(
      {
        method: 'get',
        path: '/v1/extension/setup',
        operationId: 'extensionSetup',
        summary: '品牌（工作区）/ 活动 / 候选池清单——存入与搜索 FAB 的组织上下文',
        tag: 'extension',
        auth: 'public',
        returns: 'ExtensionSetup',
      },
      async (c, deps) => {
        const session = sessionOf(c, deps)
        requireScope(session, 'kol.capture', '读取工作区上下文')
        return ok(c, await portOf(deps).setup(session))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/creators',
        operationId: 'saveExtensionCreator',
        summary: '显式存入红人池（upsert 全量快照；写本地红人库）',
        tag: 'extension',
        auth: 'public',
        body: creatorSaveSchema,
        returns: 'ExtensionCreatorSaveResult',
      },
      async (c, deps) => {
        const session = sessionOf(c, deps)
        requireScope(session, 'kol.capture', '存入红人池')
        const input = await body(c, creatorSaveSchema)
        return ok(
          c,
          await portOf(deps).saveCreator(session, input as unknown as ExtensionCreatorSave),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/extension/creators/:channel/:handle/report',
        operationId: 'extensionCreatorReport',
        summary: '本机观测历史 + 粉丝趋势 + 已存状态（库里的没有这个人 = 404）',
        tag: 'extension',
        auth: 'public',
        params: [
          { name: 'channel', in: 'path', required: true, description: '哪条渠道' },
          { name: 'handle', in: 'path', required: true, description: 'handle 或平台的稳定 id' },
        ],
        returns: 'ExtensionCreatorReport',
      },
      async (c, deps) => {
        const session = sessionOf(c, deps)
        requireScope(session, 'kol.read', '读红人报告')
        const report = await portOf(deps).creatorReport(session, creatorKeyOf(c))
        if (report === undefined)
          throw new ApiError(
            'not_found',
            '本机红人库里还没有这个人的任何记录。先在主页采集一次，或用「存入红人池」收下他。',
          )
        return ok(c, report)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/extension/reveal-pricing',
        operationId: 'extensionRevealPricing',
        summary: '看一次邮箱的积分价（不消耗；价取 pricing.json 的 data.kol.lookup）',
        tag: 'extension',
        auth: 'public',
        returns: 'ExtensionRevealPricing',
      },
      async (c, deps) => {
        const session = sessionOf(c, deps)
        requireScope(session, 'kol.read', '读积分价')
        return ok(c, await portOf(deps).revealPricing(session))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/extension/creators/:channel/:handle/contact',
        operationId: 'extensionContactLookup',
        summary:
          '公共库 reveal（本机代理云端，计费在服务端；本机已有的邮箱不扣分；余额不足回人话）',
        tag: 'extension',
        auth: 'public',
        params: [
          { name: 'channel', in: 'path', required: true, description: '哪条渠道' },
          { name: 'handle', in: 'path', required: true, description: 'handle 或平台的稳定 id' },
        ],
        returns: 'ExtensionContactLookup',
      },
      async (c, deps) => {
        const session = sessionOf(c, deps)
        requireScope(session, 'kol.capture', '取联系方式')
        return ok(c, await portOf(deps).contactLookup(session, creatorKeyOf(c)))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/creators/:channel/:handle/contact',
        operationId: 'extensionContactContribute',
        summary: '贡献一条联系方式到公共库（云端收；回执说清是新的还是库里已有）',
        tag: 'extension',
        auth: 'public',
        params: [
          { name: 'channel', in: 'path', required: true, description: '哪条渠道' },
          { name: 'handle', in: 'path', required: true, description: 'handle 或平台的稳定 id' },
        ],
        body: contactContributeSchema,
        returns: 'ExtensionContactContribution',
      },
      async (c, deps) => {
        const session = sessionOf(c, deps)
        requireScope(session, 'kol.capture', '贡献联系方式')
        const input = await body(c, contactContributeSchema)
        return ok(
          c,
          await portOf(deps).contactContribute(
            session,
            creatorKeyOf(c),
            input as { value: string; source_url?: string },
          ),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/creators/:channel/:handle/contact/dispute',
        operationId: 'extensionContactDispute',
        summary: '标记一条联系方式是错的（免费；云端只记不裁）',
        tag: 'extension',
        auth: 'public',
        params: [
          { name: 'channel', in: 'path', required: true, description: '哪条渠道' },
          { name: 'handle', in: 'path', required: true, description: 'handle 或平台的稳定 id' },
        ],
        body: contactDisputeSchema,
        returns: 'ExtensionContactDispute',
      },
      async (c, deps) => {
        const session = sessionOf(c, deps)
        requireScope(session, 'kol.capture', '标记联系方式有误')
        const input = await body(c, contactDisputeSchema)
        return ok(
          c,
          await portOf(deps).contactDispute(
            session,
            creatorKeyOf(c),
            input as { value?: string; reason?: string },
          ),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/contacts',
        operationId: 'saveExtensionContact',
        summary: '写进自己红人池的联系方式行（明文进本机加密库，库里只留 key 名）',
        tag: 'extension',
        auth: 'public',
        body: contactSaveSchema,
        returns: 'ExtensionContactSaveResult',
      },
      async (c, deps) => {
        const session = sessionOf(c, deps)
        requireScope(session, 'kol.capture', '存联系方式')
        const input = await body(c, contactSaveSchema)
        return ok(
          c,
          await portOf(deps).saveContact(session, input as unknown as ExtensionContactSave),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/content-observations',
        operationId: 'ingestExtensionContentObservation',
        summary: '内容观测。红线：请求体里没有评论这一格，多一个键整批拒',
        tag: 'extension',
        auth: 'public',
        body: contentObservationSchema,
        returns: 'ExtensionContentResult',
      },
      async (c, deps) => {
        const session = sessionOf(c, deps)
        requireScope(session, 'kol.observe', '上报内容观测')
        const input = await body(c, contentObservationSchema)
        return ok(
          c,
          await portOf(deps).contentObservation(
            session,
            input as unknown as ExtensionContentObservation,
          ),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/contents',
        operationId: 'saveExtensionContent',
        summary: '存入自己的内容库（唯一可带已采评论的端点；服务端最多保 200 条）',
        tag: 'extension',
        auth: 'public',
        body: contentSaveSchema,
        returns: 'ExtensionContentSaveResult',
      },
      async (c, deps) => {
        const session = sessionOf(c, deps)
        requireScope(session, 'kol.capture', '存入内容库')
        const input = await body(c, contentSaveSchema)
        return ok(
          c,
          await portOf(deps).contentSave(session, input as unknown as ExtensionContentSave),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/bio-link-observations',
        operationId: 'ingestExtensionBioLinkObservation',
        summary: '简介外链页（Linktree / Beacons）观测',
        tag: 'extension',
        auth: 'public',
        body: bioLinkObservationSchema,
        returns: 'ExtensionBioLinkResult',
      },
      async (c, deps) => {
        const session = sessionOf(c, deps)
        requireScope(session, 'kol.observe', '上报简介外链页')
        const input = await body(c, bioLinkObservationSchema)
        return ok(
          c,
          await portOf(deps).bioLinkObservation(
            session,
            input as unknown as ExtensionBioLinkObservation,
          ),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/extension/auto-score',
        operationId: 'extensionAutoScore',
        summary: '「采集后自动评分」开关现状：开没开、每位约多少积分、队里还有几位（WP131）',
        tag: 'extension',
        auth: 'public',
        returns: 'ExtensionAutoScoreView',
      },
      async (c, deps) => {
        const session = sessionOf(c, deps)
        requireScope(session, 'kol.read', '读自动评分开关')
        const port = portOf(deps)
        if (port.autoScore === undefined)
          throw new ApiError('not_implemented', '这个本机服务版本还没有「采集后自动评分」。')
        return ok(c, await port.autoScore(session))
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/extension/auto-score',
        operationId: 'setExtensionAutoScore',
        summary: '开 / 关「采集后自动评分」（每工作区一个，默认关；开着时体检花积分）（WP131）',
        tag: 'extension',
        auth: 'public',
        body: autoScoreSchema,
        returns: 'ExtensionAutoScoreView',
      },
      async (c, deps) => {
        const session = sessionOf(c, deps)
        requireScope(session, 'kol.capture', '开关自动评分')
        const input = await body(c, autoScoreSchema)
        const port = portOf(deps)
        if (port.setAutoScore === undefined)
          throw new ApiError('not_implemented', '这个本机服务版本还没有「采集后自动评分」。')
        return ok(c, await port.setAutoScore(session, { enabled: input.enabled }))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/extension/seed-signature',
        operationId: 'extensionSeedSignature',
        summary: '种子频道主题词（库里没有这个人 = 404，面板不做预筛）',
        tag: 'extension',
        auth: 'public',
        params: [
          { name: 'channel', in: 'query', required: true, description: '哪条渠道' },
          {
            name: 'externalId',
            in: 'query',
            description: 'handle 或平台的稳定 id（与 external_id 同义，两个名字都认）',
          },
          { name: 'external_id', in: 'query', description: '同上（蛇形名）' },
        ],
        returns: 'ExtensionSeedSignature',
      },
      async (c, deps) => {
        const session = sessionOf(c, deps)
        requireScope(session, 'kol.read', '读种子签名')
        // 面板发的是 platform（旧插件那套参数名），库里叫 channel——两个名字都认。
        const channelRaw = c.req.query('channel') ?? c.req.query('platform') ?? ''
        if (channelRaw === '') throw new ApiError('invalid_input', '缺 channel（哪条渠道）')
        const externalId = c.req.query('externalId') ?? c.req.query('external_id') ?? ''
        if (externalId === '') throw new ApiError('invalid_input', '缺 externalId（这是谁）')
        if (!(channelSchema as unknown as { options: string[] }).options.includes(channelRaw))
          throw new ApiError('invalid_input', '不认这条渠道')
        const channel = channelRaw as KolChannel
        const signature = await portOf(deps).seedSignature(session, { channel, handle: externalId })
        if (signature === undefined)
          throw new ApiError(
            'not_found',
            '这不是种子频道（本机红人库里没有这个人的记录），面板不做预筛。',
          )
        return ok(c, signature)
      },
    ),
  ]
}

/** 路径里的「这个人」键：`:channel/:handle`，handle 与平台 id 都认。 */
function creatorKeyOf(c: Parameters<Route['handler']>[0]): ExtensionCreatorKey {
  return {
    channel: param(c, 'channel') as KolChannel,
    handle: param(c, 'handle'),
  }
}
