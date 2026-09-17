/**
 * 四条平台适配器的**接口**（57 §2）。
 *
 * 五个口子，每个平台只实现它有的：`accounts` / `campaigns` / `adSets` / `insights` /
 * `pixels` 是读，`applyChange` 是写（**执行**那一跳，卡被批准之后才调）。
 *
 * 四条纪律（与 `@agentsws/social-core` 的适配器逐字同源——同一个仓里两套写法
 * 是最容易出事的地方）：
 *
 * 1. **真 HTTP 形状按各家公开文档写，`fetch` 注入**。适配器自己拼 URL、方法、
 *    头与 body（那是"这家的接口长什么样"这条事实），真正发出去的那一跳是调用方
 *    递进来的 {@link AdsTransport.fetch}。于是这个包没有网络依赖，测试里塞一个
 *    假 fetch 就能把"401 怎么说""配额用完怎么说"测掉。**零真 key**。
 * 2. **凭据从本品牌加密库按连接 id 取，不进日志**。{@link AdsTransport.credential}
 *    异步取一次，适配器拿到之后只往请求头里放，**不往返回值里放、不往错误消息里放**
 *    （见 {@link redactUrl}）。这个包里没有一处 `console`。
 * 3. **拿不到就说拿不到**（36 §3）。没连、没申请下来、要 developer token、
 *    配额用完，一律回 `{ ok: false, reason, message }`，`message` 是给人看的一句话。
 *    绝不回一个空数组假装"这个账户今天没花钱"——那个 0 会直接去撑总闸。
 * 4. **写动作照样先出卡**。{@link AdsChannelAdapter.applyChange} 是执行器调的，
 *    不是"Agent 想改就改"。适配器不知道审批，也不该知道——但这一条写在这里，
 *    免得有人直接从起草那一跳调过来。
 */

import type {
  AdAccount,
  AdCampaign,
  AdMetrics,
  AdSet,
  AdsPlatform,
  PixelEvent,
} from '@agentsws/contracts'

/** 拿不到数据 / 做不了动作的几种原因。界面上按它说不同的话。 */
export type AdsFailure =
  | 'not_connected'
  | 'not_implemented'
  | 'needs_approval'
  | 'needs_developer_token'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'upstream_error'

export interface AdsError {
  ok: false
  reason: AdsFailure
  /** 一句人话。"Google Ads 要先申请一个 developer token 并过审"比"401"有用得多。 */
  message: string
  /** 上游的状态码（有的话）。**不带 body**：body 里可能有回显的 token。 */
  status?: number
}

export interface AdsOk<T> {
  ok: true
  data: T
  /** 这份数据什么时候看到的（进 `observed_at`）。 */
  observed_at: string
}

export type AdsResult<T> = AdsOk<T> | AdsError

/* ── 注入进来的那一跳 ────────────────────────────────────────────────── */

/** 一次 HTTP 的最小形状（`globalThis.fetch` 结构上满足它）。 */
export interface AdsHttpResponse {
  ok: boolean
  status: number
  text(): Promise<string>
}

export type AdsFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<AdsHttpResponse>

/**
 * 适配器要的三样东西，由宿主注入。
 *
 * `credential` 回的是**这条连接**在本品牌加密库里的那几格（access token /
 * developer token / customer id …）。宿主每次现取现给，适配器不缓存——
 * 秘密不在对象里留着。
 */
export interface AdsTransport {
  fetch: AdsFetch
  /** 这个平台现在连上了没有（没连的话适配器一跳都不打）。 */
  connected(platform: AdsPlatform): boolean
  /**
   * 取这条连接的凭据。
   *
   * 返回的对象里是**明文**，所以：只往请求头 / query 里放，**绝不**放进返回值、
   * 错误消息或事件。取不到（没连、被吊销）就抛，由适配器翻成 `not_connected`。
   */
  credential(platform: AdsPlatform): Promise<Record<string, string>>
  /** 现在（注入；这个包里没有 `Date.now()`）。 */
  now(): string
}

/* ── 五个口子的出入参 ───────────────────────────────────────────────── */

/** 读回来的一个账户（`AdAccount` 的 id 与 `workspace_id` 由宿主给）。 */
export type ChannelAccount = Omit<AdAccount, 'id' | 'workspace_id' | 'observed_at'>

/** 读回来的一条 campaign（id 由宿主给）。 */
export type ChannelCampaign = Omit<AdCampaign, 'id' | 'account_id'> & {
  account_external_id: string
}

/** 读回来的一个广告组。 */
export type ChannelAdSet = Omit<AdSet, 'id' | 'campaign_id' | 'account_id'> & {
  campaign_external_id: string
}

/** 读回来的一条像素 / 转化事件。 */
export type ChannelPixel = Omit<PixelEvent, 'id' | 'account_id' | 'observed_at'>

/** 一条表现记录（按 campaign 聚合）。 */
export interface ChannelInsight {
  campaign_external_id: string
  campaign_name: string
  metrics: AdMetrics
}

/**
 * 一次**已经被批准**的改动（执行器调）。
 *
 * `kind` 用的是仓里那四个名字（`@agentsws/contracts` 的 `ADS_CHANGE_KINDS`），
 * 不是 57 §1 那两个别名——同一件事不给第二个名字。
 */
export interface AdsChangeRequest {
  kind: 'create_campaign' | 'budget_change' | 'bid_change' | 'pause_ad' | 'creative_swap'
  /** 改的是哪一条（平台那一侧的 id）。 */
  external_id: string
  /** 哪个账户（平台那一侧的 id）。 */
  account_external_id: string
  /** 改成什么（各 kind 自己的形状；适配器按 kind 取自己认得的那几格）。 */
  after: Record<string, unknown>
  /** 这条改动的审批卡 id。**没有它就不许动手**（纪律 4）。 */
  approval_id: string
}

export interface AdsChangeOutcome {
  /** 平台那一侧的 id（新建的话是刚建出来那条）。 */
  external_id: string
  /** 平台原样回的一句话（有的话）。**不带 token**。 */
  note?: string
}

export interface AdsChannelAdapter {
  platform: AdsPlatform
  /** 这个平台的适配器有没有真调用（`false` = 只有接口 + 一句人话）。 */
  implemented: boolean
  accounts(): Promise<AdsResult<ChannelAccount[]>>
  campaigns(account_external_id: string): Promise<AdsResult<ChannelCampaign[]>>
  adSets(campaign_external_id: string): Promise<AdsResult<ChannelAdSet[]>>
  insights(input: {
    account_external_id: string
    /** `YYYY-MM-DD`，含两端。 */
    since: string
    until: string
  }): Promise<AdsResult<ChannelInsight[]>>
  pixels(account_external_id: string): Promise<AdsResult<ChannelPixel[]>>
  applyChange(input: AdsChangeRequest): Promise<AdsResult<AdsChangeOutcome>>
}

/* ── 共用的几句话 ───────────────────────────────────────────────────── */

export function notConnected(label: string): AdsError {
  return {
    ok: false,
    reason: 'not_connected',
    message: `${label} 还没连上。去连接页把它连上，这一块就有数了——在那之前不猜一个数糊上去（那个数会直接去撑日花费总闸）。`,
  }
}

export function notImplemented(label: string, plan: string): AdsError {
  return {
    ok: false,
    reason: 'not_implemented',
    message: `${label} 的适配器还没做（${plan}）。提案、审批、额度这几件事照常能用——真正动到平台那一跳等接上。`,
  }
}

/** URL 里的 query 一律抹掉：token 可能在上面（Graph API 就接 `?access_token=`）。 */
export function redactUrl(url: string): string {
  const q = url.indexOf('?')
  return q < 0 ? url : `${url.slice(0, q)}?…`
}

export function httpFailure(label: string, status: number, url: string): AdsError {
  const where = redactUrl(url)
  if (status === 401 || status === 403)
    return {
      ok: false,
      reason: 'needs_approval',
      status,
      message: `${label} 回了 ${status}（${where}）。多半是这把凭据的权限还没批下来，或者授权过期了——**不是**这条广告有问题。去连接页重新授权一次。`,
    }
  if (status === 429)
    return {
      ok: false,
      reason: 'rate_limited',
      status,
      message: `${label} 说打得太快了（429，${where}）。等一会儿再拉，这一跳没有重试。`,
    }
  return {
    ok: false,
    reason: 'upstream_error',
    status,
    message: `${label} 回了 ${status}（${where}）。原样报给你——我们不替平台解释它的错误码。`,
  }
}

export function upstreamError(label: string, error: unknown, url: string): AdsError {
  return {
    ok: false,
    reason: 'upstream_error',
    message: `${label} 这一跳没打通（${redactUrl(url)}）：${error instanceof Error ? error.message : String(error)}`,
  }
}

export function guardConnected(
  transport: AdsTransport,
  platform: AdsPlatform,
  label: string,
): AdsError | undefined {
  return transport.connected(platform) ? undefined : notConnected(label)
}

/** 打一跳并把 JSON 读回来。失败一律翻成 {@link AdsError}，**不抛**。 */
export async function callJson<T>(
  transport: AdsTransport,
  label: string,
  url: string,
  init?: Parameters<AdsFetch>[1],
): Promise<{ ok: true; data: T } | AdsError> {
  let res: AdsHttpResponse
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
