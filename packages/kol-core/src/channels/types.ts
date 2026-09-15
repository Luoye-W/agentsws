/**
 * 渠道适配器的**接口**（48 §5.2 末段）。
 *
 * 四个口子，五条渠道各实现一份：`search` / `profile` / `benchmark` / `contact_hint`。
 * WP67 只做 YouTube 与 Instagram 的接口 + 假实现，其余三条只有接口 +
 * 一句人话的 `not_implemented`（WP68 接）。
 *
 * 三条纪律：
 *
 * 1. **不在这里打 HTTP**。适配器收一个注入的 `KolChannelTransport`——真实现在
 *    `apps/server`（走连接器的只读 Action、短命令牌、用完吊销，同 `records.ts`），
 *    测试里塞一个假的。这个包因此永远没有 IO。
 * 2. **拿不到就说拿不到**（36 §3）。没连、没批下来、配额用完，一律回
 *    `{ ok: false, reason, message }` 那个形状，`message` 是给人看的一句话。
 *    绝不回一个空数组假装"搜到 0 个"——那两件事在界面上必须分得开。
 * 3. **`benchmark` 永远可能回 `undefined`**：k-匿名基准只有云端算得出来
 *    （48 §5.3），本地档拿不到它是常态，不是错。
 */
import type { KolChannel } from '@agentsws/contracts'

/** 拿不到数据的几种原因。界面上按它说不同的话。 */
export type ChannelFailure =
  | 'not_connected'
  | 'not_implemented'
  | 'quota_exhausted'
  | 'needs_approval'
  | 'upstream_error'

export interface ChannelError {
  ok: false
  reason: ChannelFailure
  /** 一句人话。"TikTok 的 Research API 要先申请"比"401"有用得多。 */
  message: string
}

export interface ChannelOk<T> {
  ok: true
  data: T
  /** 这份数据什么时候看到的（进 `PlatformAccount.observed_at`）。 */
  observed_at: string
}

export type ChannelResult<T> = ChannelOk<T> | ChannelError

/** 搜出来的一条（还不是 `PlatformAccount`——id 由宿主给）。 */
export interface ChannelSearchHit {
  channel: KolChannel
  handle: string
  url: string
  display_name: string
  followers?: number
  engagement_rate?: number
  category?: string
  language?: string
  region?: string
}

export interface ChannelSearchQuery {
  /** 关键词（品类 / 产品 / 竞品名）。 */
  q: string
  language?: string
  region?: string
  followers_band?: { min: number; max: number }
  /** 最多回几条。 */
  limit?: number
}

/** 一条渠道的基准（k-匿名聚合，48 §5.3；本地档常常拿不到）。 */
export interface ChannelBenchmark {
  channel: KolChannel
  /** 这一档粉丝量级的中位互动率。 */
  median_engagement_rate: number
  /** 聚合里有多少个账号（k-匿名的那个 k；低于阈值云端不给数）。 */
  sample_size: number
}

/** 联系方式线索。**不回明文**：回"在哪儿能找到"，取值是宿主那一跳的事。 */
export interface ContactHint {
  kind: 'email' | 'dm' | 'form'
  /** 在哪儿（频道"关于"页 URL / 私信入口 / 合作表单地址）。 */
  where: string
  /** 一句人话：怎么拿到它。 */
  how: string
}

/**
 * 适配器真正打出去的那一跳，由宿主注入。
 *
 * `action` 是连接器上的只读 Action 光杆名（`search_channels` / `get_channel`），
 * 前缀与令牌由宿主按连接现签——这个包既不知道 provider 叫什么，也碰不到凭据。
 */
export interface KolChannelTransport {
  /** 这条渠道现在连上了没有。没连的话适配器一跳都不打。 */
  connected(channel: KolChannel): boolean
  call<T>(input: {
    channel: KolChannel
    action: string
    params: Record<string, unknown>
  }): Promise<T>
  /** 现在（注入；这个包没有 `Date.now()`）。 */
  now(): string
}

/** 一条渠道的适配器。 */
export interface KolChannelAdapter {
  readonly channel: KolChannel
  search(q: ChannelSearchQuery): Promise<ChannelResult<ChannelSearchHit[]>>
  profile(handle: string): Promise<ChannelResult<ChannelSearchHit>>
  benchmark(followers: number): Promise<ChannelResult<ChannelBenchmark | undefined>>
  contact_hint(handle: string): Promise<ChannelResult<ContactHint[]>>
}

/** 没连时的那一句人话（五条渠道共用一个说法，界面上才一致）。 */
export function notConnected(channel: KolChannel, label: string): ChannelError {
  return {
    ok: false,
    reason: 'not_connected',
    message: `${label} 还没连上，所以这一块没有数。去连接页把 ${label} 连上，或者先用导入把你手上的表传进来。`,
  }
}

/** 还没做的那一句人话（与"没连"分得开：那个用户修得好，这个他修不好）。 */
export function notImplemented(label: string, plan: string): ChannelError {
  return {
    ok: false,
    reason: 'not_implemented',
    message: `${label} 的适配器还没做（${plan}）。这条职责的找人、建联、合作、审核、归因照常能用——数据先靠导入与公共库。`,
  }
}
