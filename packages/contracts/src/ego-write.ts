/**
 * WP483（决策 1658–1661，Luoye 10-23）：**发帖 / 回帖两条路——ego 主推、插件备份**。
 *
 * - **ego 路**：装了 ego、能连上，工坊自己在 ego 里打开页面、挂图、填字、**点发送**（1660：不再强制人点最后一下），
 *   发完读回链接，记「已发 · 已记录」。岗位里开了「发之前让我看一眼」就只填好、留着页面给人点。
 * - **插件路**：没装 ego / ego 跑失败 / 用户自己选了插件：照原来的插件流程（WP445 / WP467「等你发 / 填入」）。
 *
 * 这个文件只放两条路共用的形状与判法（纯函数，没有 IO）；ego 那一段脚本与子进程在服务端
 * `apps/server/src/ego-write/`。
 */
import type { Iso8601 } from './common.js'

/** 这一条走哪条路。 */
export type WriteRoute = 'ego' | 'plugin'

/**
 * ego 能替插件做的那几种写（`<平台>-<动作>`）。不在这里的（Threads、YouTube 发视频、私信……）一律走插件 / 人。
 *
 * - `reddit-reply` 回某条评论（楼中楼）；`reddit-comment` 在帖子下面回一条；`reddit-post` 发新帖（文字帖）
 * - `*-post` 社媒发帖（Instagram / TikTok 必须带图 / 视频）
 * - `*-comment` 在别人（或自己）的帖子下面回一条
 */
export type EgoWritePlatform =
  | 'reddit-reply'
  | 'reddit-comment'
  | 'reddit-post'
  | 'facebook-post'
  | 'instagram-post'
  | 'x-post'
  | 'linkedin-post'
  | 'tiktok-post'
  | 'x-reply'
  | 'facebook-comment'
  | 'instagram-comment'
  | 'linkedin-comment'
  | 'tiktok-comment'

export const EGO_WRITE_PLATFORMS: readonly EgoWritePlatform[] = [
  'reddit-reply',
  'reddit-comment',
  'reddit-post',
  'facebook-post',
  'instagram-post',
  'x-post',
  'linkedin-post',
  'tiktok-post',
  'x-reply',
  'facebook-comment',
  'instagram-comment',
  'linkedin-comment',
  'tiktok-comment',
]

/** 社媒渠道发帖时对应哪一种（没有 = ego 不做，走插件）。 */
export function egoPostPlatformOf(channel: string): EgoWritePlatform | undefined {
  switch (channel) {
    case 'facebook':
      return 'facebook-post'
    case 'instagram':
      return 'instagram-post'
    case 'x':
      return 'x-post'
    case 'linkedin':
      return 'linkedin-post'
    case 'tiktok':
      return 'tiktok-post'
    default:
      return undefined
  }
}

/** 社媒渠道回帖时对应哪一种（没有 = ego 不做）。 */
export function egoReplyPlatformOf(channel: string): EgoWritePlatform | undefined {
  switch (channel) {
    case 'x':
      return 'x-reply'
    case 'facebook':
      return 'facebook-comment'
    case 'instagram':
      return 'instagram-comment'
    case 'linkedin':
      return 'linkedin-comment'
    case 'tiktok':
      return 'tiktok-comment'
    default:
      return undefined
  }
}

/** 这几种发帖必须带图 / 视频（纯文字发不出去）。 */
export const EGO_MEDIA_REQUIRED: ReadonlySet<EgoWritePlatform> = new Set([
  'instagram-post',
  'tiktok-post',
])

/**
 * ego 跑完一次的结果。
 *
 * - `sent`        点了发送、页面上认出发出去的那一条（`link` 读到了就有；读不到时 `readback = 'clicked'`）
 * - `filled`      「发之前让我看一眼」：填好了、页面留在 ego 里等人点
 * - `needs_login` 目标网站在 ego 里没登录（或登录失效）
 * - `blocked`     平台弹了验证码 / 风控提示——**停下、不绕**
 * - `needs_human` ego 自己把 Space 交给人了（浏览器的「显示通知」权限框之类），人在 ego 里点掉后工坊自动接着做
 * - `failed`      选择器对不上 / 脚本出错 / 没认出发出去的那一条
 * - `unavailable` ego 跑不起来（没装、没打开、被「以管理员身份运行」的工坊调用……）
 */
export type EgoWriteState =
  | 'sent'
  | 'filled'
  | 'needs_login'
  | 'blocked'
  | 'needs_human'
  | 'failed'
  | 'unavailable'

export interface EgoWriteStep {
  name: string
  ok: boolean
  ms?: number
}

export interface EgoWriteResult {
  state: EgoWriteState
  platform: EgoWritePlatform
  /** 发出去那一条的链接（读回到了才有）。 */
  link?: string
  /** 平台那一侧的编号（Reddit `t1_…` / `t3_…`；别的平台从链接里取得到才有）。 */
  external_id?: string
  /** 页面上读回的真发出去的字（截 10000 字）。 */
  sent_text?: string
  /** `sent` 时怎么确认的：`link` 读回了那一条；`clicked` 点了发送、页面没报错，但没读回链接（照实标）。 */
  readback?: 'link' | 'clicked'
  /** 说给人听的那一句（失败 / 交给人 / 被拦时）。 */
  why?: string
  /** ego 那边这次的 Space 编号（交给人之后接着做要用）。 */
  space_id?: number
  /** 发送按钮找到了没有（只填不发时）。 */
  button_found?: boolean
  /**
   * 工坊已经点过发送了（不管读没读回）。**点过就不再退插件**——退过去人再发一次，关注的人会看到两条一样的；
   * 这时候没认出发出去的那一条就停下、请人去看一眼。
   */
  clicked?: boolean
  steps?: EgoWriteStep[]
  duration_ms?: number
}

/** 一次结果之后下一步怎么走。 */
export type EgoWriteNext =
  /** 发出去了：记「已发 · 已记录」。 */
  | 'done'
  /** 只填好了（发之前让我看一眼）：等人点，之后读回。 */
  | 'review'
  /** ego 交给人了：人在 ego 里处理完自动接着做（等太久再退插件）。 */
  | 'wait_human'
  /** 退插件路（ego 跑不起来 / 没登录 / 选择器对不上），事项里说一句原因。 */
  | 'plugin'
  /** 平台拦了：停下、记原因、提醒人，**不绕、不换路重试**。 */
  | 'stop'

export function egoWriteNext(result: Pick<EgoWriteResult, 'state' | 'clicked'>): EgoWriteNext {
  // 点过发送、又没确认发出去：不换路重发（可能已经发出去了），停下请人看
  if (result.clicked === true && result.state !== 'sent') return 'stop'
  switch (result.state) {
    case 'sent':
      return 'done'
    case 'filled':
      return 'review'
    case 'needs_human':
      return 'wait_human'
    case 'blocked':
      return 'stop'
    default:
      return 'plugin'
  }
}

/** 一句人话（事项 / 卡 / 铃铛里那一行）。 */
export function egoWriteSentence(
  result: Pick<EgoWriteResult, 'state' | 'why' | 'clicked'>,
): string {
  const why = result.why === undefined || result.why.trim() === '' ? '' : `（${result.why.trim()}）`
  if (result.clicked === true && result.state !== 'sent')
    return `工坊在 ego 里点了发送，但没确认发出去${why}——可能已经发出去了，所以没换路重发，去页面上看一眼`
  switch (result.state) {
    case 'sent':
      return '已在 ego 里发出去'
    case 'filled':
      return '已在 ego 里填好，等你看一眼、自己点发送'
    case 'needs_login':
      return `ego 里这个网站没登录${why}，这一次改交给插件；在 ego 里登录之后，下一条就会走 ego`
    case 'blocked':
      return `平台弹了验证 / 风控提示${why}，工坊停下了、没有绕过去，等你去看一眼`
    case 'needs_human':
      return 'ego 里弹了一个要你处理的框（比如「显示通知」，点「阻止」就行），处理完工坊会自己接着做'
    case 'unavailable':
      return `ego 这会儿用不了${why}，这一次改交给插件`
    default:
      return `ego 没发成${why}，这一次改交给插件`
  }
}

/** ego 交给人之后最多等多久（再久就退插件路）。 */
export const EGO_HUMAN_WAIT_MS = 30 * 60_000

/** 「发之前让我看一眼」填好之后，隔多久回去读一次「人发了没有」（读完这几次还没看到就不再读，人可以在插件 / 待办里点「发好了」）。 */
export const EGO_READBACK_DELAYS_MS: readonly number[] = [
  2 * 60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
]

/** ego 官网下载页（自己认 Mac / Windows；不给安装包直链、不代下载）。 */
export const EGO_DOWNLOAD_URL = 'https://lite.ego.app/download'

/**
 * ego 那一次写的进度（Reddit 那一条写、社媒那一条帖子各挂一份）。
 */
export interface EgoWriteProgress {
  /** 现在在哪一步。 */
  state: 'running' | 'needs_human' | 'filled' | 'sent' | 'fell_back' | 'stopped'
  /** ego 那边的 Space（交给人之后接着做用）。 */
  space_id?: number
  /** 第几次跑（交给人之后接着做算一次）。 */
  tries: number
  /** 开始等人的时刻（`needs_human` / `filled`）。 */
  since?: Iso8601
  /** 下一次回去读「发了没有」的时刻（`filled`）。 */
  next_check_at?: Iso8601
  /** 已经读回过几次。 */
  checks?: number
  /** 最近一次的那一句（退插件 / 被拦的原因也在这）。 */
  note?: string
}

/** WP483（决策 1660）：岗位上的「发之前让我看一眼」（默认关）。 */
export interface WriteReviewSetting {
  position_id: string
  review_before_send: boolean
}
