/**
 * WP246（Luoye 10-07 定 87 / 88）：**取数路线**——每个平台 = 一张「首选 → 备选」的有序级别表，
 * 每一级有统一的**体检**：通 / 不通 + 一句人话原因 + 怎么修。
 *
 * 思路学自开源项目 Agent-Reach（MIT）的「每平台一张有序后端表 + doctor 体检」，代码是自己写的、
 * 没有引它的任何依赖。我们不整个集成它（Python + 一串命令行，和「用户不碰终端」相冲，决策 87）。
 *
 * 这里只放**结构与形状**：
 *
 * - {@link READ_ROUTE_SPECS}：现在有的三条（Reddit、YouTube 字幕、网页转文字），每条哪几级、默认顺序、
 *   挂哪个只读工具。结构上能加 X / TikTok / Instagram（{@link READ_ROUTE_PLANNED}），加的时候只多一行；
 * - {@link ReadLevelCheck}：一级的体检结果；{@link ReadRoutesView}：连接页「取数路线」那一块读的整张表；
 * - {@link RedditReadAccountStatus}：Reddit 浏览器备选用的「读号」（决策 88：**不用版主号 / 品牌官方号**）。
 *
 * Reddit 那条的顺序与停用仍存在 `data_source_routing['reddit.read']`（WP220，不改）；
 * 另外两条的级别不进那张表（它们不是花钱的数据接口），开关放在 {@link ReadRoutesSettings}。
 */
import type { Iso8601 } from './common.js'

/**
 * 取数的一级。前两个与 `DataSourceLevel` 同名同义（Reddit 那条复用 WP220 的路由设置）。
 *
 * - `workshop`：接口中台（云端接口管理里的能力，按条扣积分）；
 * - `browser_readonly`：本机只读浏览器（WP228）——WP246 起用用户自己登录的**普通读号**；
 * - `page_captions`：直接读视频页里的字幕轨（零配置，不经第三方、不装任何运行时）；
 * - `local_extract`：本机把网页抽成干净正文（零配置，不经第三方）；
 * - `third_party_reader`：第三方网页转文字服务（Jina Reader）——**默认关**，开了网址会经过对方。
 */
export type ReadLevel =
  | 'workshop'
  | 'browser_readonly'
  | 'page_captions'
  | 'local_extract'
  | 'third_party_reader'

export interface ReadRouteSpec {
  /** 平台（连接页一行一个）。 */
  platform: string
  /** 路由键（Reddit 那条就是 `data_source_routing` 的键）。 */
  route_key: string
  /** 默认顺序：首选在前。 */
  levels: readonly ReadLevel[]
  /** 走这条路线的只读工具（`read_` 开头，门禁按「只读外部」放行）。 */
  tool: string
}

export const REDDIT_READ_TOOL_NAME = 'read_reddit'
export const YOUTUBE_TRANSCRIPT_TOOL = 'read_youtube_transcript'
export const READ_WEBPAGE_TOOL = 'read_webpage'

export const YOUTUBE_TRANSCRIPT_ROUTE_KEY = 'youtube.transcript'
export const WEB_READ_ROUTE_KEY = 'web.read'

/** 现在有的三条取数路线（连接页按这个顺序一行一个）。 */
export const READ_ROUTE_SPECS: readonly ReadRouteSpec[] = [
  {
    platform: 'reddit',
    route_key: 'reddit.read',
    levels: ['workshop', 'browser_readonly'],
    tool: REDDIT_READ_TOOL_NAME,
  },
  {
    platform: 'youtube',
    route_key: YOUTUBE_TRANSCRIPT_ROUTE_KEY,
    // 接口中台那一级结构上留着（`social.youtube.transcript` 云端还没接），体检里显示「还没接」
    levels: ['page_captions', 'workshop'],
    tool: YOUTUBE_TRANSCRIPT_TOOL,
  },
  {
    platform: 'web',
    route_key: WEB_READ_ROUTE_KEY,
    levels: ['local_extract', 'third_party_reader'],
    tool: READ_WEBPAGE_TOOL,
  },
]

/** 以后要加的平台（结构上已经能放；加之前先定每级怎么体检）。 */
export const READ_ROUTE_PLANNED: readonly string[] = ['x', 'tiktok', 'instagram']

/** 某个平台的路线（没有回 `undefined`）。 */
export function readRouteSpec(platform: string): ReadRouteSpec | undefined {
  return READ_ROUTE_SPECS.find((s) => s.platform === platform)
}

/** YouTube 字幕在接口中台的能力名（云端还没接；接上之前体检显示「还没接」）。 */
export const YOUTUBE_TRANSCRIPT_CAPABILITY = 'social.youtube.transcript'

/**
 * 一级的体检状态。
 *
 * - `ok`：通；
 * - `down`：不通（原因 + 怎么修）；
 * - `off`：被关掉了（用户关的，或默认关的那一级）；
 * - `pending`：结构上有这一级，还没接（云端能力还没开）。
 */
export type ReadCheckState = 'ok' | 'down' | 'off' | 'pending'

/** 「怎么修」对应的那个按钮（界面据此给一个动作；没有就只给一句话）。 */
export type ReadFixAction =
  | 'link_account'
  | 'login_read_account'
  | 'install_browser'
  | 'enable_level'
  | 'check_network'
  | 'wait'

export interface ReadLevelCheck {
  level: ReadLevel
  state: ReadCheckState
  /** 一句人话：为什么通 / 为什么不通。 */
  reason: string
  /** 不通时怎么修（一句人话）。 */
  fix?: string
  action?: ReadFixAction
  /** 补一句细节（Reddit 读号：`u/xxx`）。 */
  detail?: string
  /** 最近一次真去取数的结果（工具用过才有）。 */
  last?: { ok: boolean; at: Iso8601; message?: string }
}

export interface ReadRouteHealth {
  platform: string
  route_key: string
  tool: string
  /** 按**生效的**顺序（Reddit 那条按品牌调过的顺序）。 */
  levels: ReadLevelCheck[]
  /** 现在走哪一级（第一个通的）；都不通没有这一格。 */
  active?: ReadLevel
}

export interface ReadRoutesDoctor {
  routes: ReadRouteHealth[]
  checked_at: Iso8601
  /** 这次是不是「重新体检」（真去连了网）；打开页面时给的是不连网的快查。 */
  deep: boolean
}

/** Reddit 自动读取时浏览器怎么开（报告里有评估）。 */
export type ReadBrowserWindowMode = 'minimized' | 'headless'

export interface ReadRoutesSettings {
  /** 网页转文字：本机抽不出时转给第三方（Jina Reader）。**默认关**，开了网址会经过对方。 */
  web_third_party_reader: boolean
  /** Reddit 浏览器备选：有头最小化（默认，更不容易被验证码拦）/ 无头。 */
  reddit_browser_window: ReadBrowserWindowMode
}

export const DEFAULT_READ_ROUTES_SETTINGS: Readonly<ReadRoutesSettings> = {
  web_third_party_reader: false,
  reddit_browser_window: 'minimized',
}

/** 连接页「取数路线」那一块读的整张表。 */
export interface ReadRoutesView {
  doctor: ReadRoutesDoctor
  settings: ReadRoutesSettings
  /** Reddit 读号（没装本机只读浏览器 / 托管实例没有这一格）。 */
  reddit_account?: RedditReadAccountStatus
}

/**
 * Reddit 读号（决策 88）：本机只读浏览器那份用户数据目录里，用户自己在网页上登录的**普通号**。
 * 我们不碰密码、不读 cookie 内容，只读页面上显示的用户名。
 *
 * - `none`：还没登录读号；
 * - `logging_in`：「登录读号」的窗口开着（用户在网页上登录，关掉窗口后自动体检）；
 * - `logged_in`：已登录 `u/<username>`；
 * - `refused`：登录的是品牌登记的号（官方号 / 版主号）——拦下，提示换号；
 * - `unknown`：登录过，但这次没认出是谁（页面改版 / 被拦），照实说。
 */
export interface RedditReadAccountStatus {
  state: 'none' | 'logging_in' | 'logged_in' | 'refused' | 'unknown'
  /** 页面上读到的用户名（不带 `u/`）。 */
  username?: string
  message?: string
  checked_at?: Iso8601
}

/** 用户名归一（去 `u/` `/u/` `@`、小写），比对品牌登记的号用。 */
export function normalizeRedditUsername(raw: string): string {
  return raw
    .trim()
    .replace(/^\/?u(?:ser)?\//iu, '')
    .replace(/^@/u, '')
    .replace(/\/+$/u, '')
    .toLowerCase()
}
