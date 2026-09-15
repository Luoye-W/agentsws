/**
 * 48 §5.3 / 49 §6 WP61 **公共红人库服务**的契约（云侧那一份，`/v1/data/kol/*`）。
 *
 * 这个文件只描述**公共库自己的形状**。红人在本地本体里的六个对象类型
 * （`creator` / `platform_account` / `creator_contact` / `collaboration` /
 * `deliverable` / `tracked_link`）是 WP67 的事，在 `kol.ts` 里定义——
 * 公共库这边一个都不 import：
 *
 * - 公共库是**跨租户**的一层事实，本地那六个对象是**一个工作区自己的**归属数据，
 *   两层的生命周期、可见性、删除语义都不一样（48 §1.2「双层：共享事实 + 私有归属」）；
 * - 所以这里指一个红人用的是**自足键** `{ channel, handle }`（{@link PublicCreatorKey}）
 *   而不是任何一侧的 id。两个包各自能编译、各自能测，合并时不会撞同一个文件。
 *
 * 三条隐私纪律在类型上就能看见（21 §1 / §5）：
 *
 * 1. **邮箱不以明文存在于任何一个类型上**——库里只有 {@link PublicCreatorContact}
 *    的 `email_sha256` + `email_cipher`，明文只在付费 reveal 的响应里出现一次
 *    （{@link RevealedContact}）；
 * 2. **插件令牌只有哈希**（{@link PluginPairing} 上没有 `token` 这一格，明文在
 *    {@link IssuedPluginToken} 里出现一次）；
 * 3. **观察里没有正文**：{@link PUBLIC_OBSERVATION_FIELDS} 是一张白名单，
 *    多一个键就拒——评论、私信、视频文案一个字都不收（48 §1.3 第 4 条）。
 */

import type { Iso8601, WorkspaceId } from './common.js'

/** 48 §5.1 的五条渠道。库按它分区，同一个人在两个渠道是两条记录。 */
export type KolChannel = 'youtube' | 'facebook' | 'instagram' | 'tiktok' | 'x'

export const KOL_CHANNELS: readonly KolChannel[] = [
  'youtube',
  'facebook',
  'instagram',
  'tiktok',
  'x',
]

/**
 * 指一个红人的**自足键**：渠道 + 该渠道上的 handle。
 *
 * 没有 id 这一格是有意的：公共库跨租户，本地那六个对象各租户一份，
 * 两边谁都不该把自己的主键塞给对方（40 §1「真源只有一个」）。
 */
export interface PublicCreatorKey {
  channel: KolChannel
  /** 渠道内唯一的账号名（`@` 去掉、小写）。 */
  handle: string
}

/** 一条公开资料是怎么来的。可信度按它分档（{@link SOURCE_CONFIDENCE}）。 */
export type KolObservationSource = 'plugin' | 'official_api' | 'apify' | 'manual'

export const KOL_OBSERVATION_SOURCES: readonly KolObservationSource[] = [
  'plugin',
  'official_api',
  'apify',
  'manual',
]

/** 各来源的基准可信度（0–1）。官方口最高，人工填的最低——它没有第二个人核过。 */
export const SOURCE_CONFIDENCE: Record<KolObservationSource, number> = {
  official_api: 1,
  apify: 0.8,
  plugin: 0.7,
  manual: 0.5,
}

/**
 * 一条**观察**：某个来源在某一刻看到的公开资料快照。
 *
 * 字段白名单 {@link PUBLIC_OBSERVATION_FIELDS} 就是这个接口的键——多一个键**拒收**。
 * 这是"不接受任何正文"唯一可执行的形式（与 49 M6 的 `assertMeteringEvent` 同一条纪律）：
 * 类型挡住笔误，运行时挡住"把整个页面 spread 一把过来"。
 */
export interface PublicCreatorObservation {
  channel: KolChannel
  handle: string
  followers: number
  /** 近 30 天发布数。 */
  posts_30d: number
  /** 互动率（0–1 的小数，不是百分数）。 */
  engagement_rate: number
  /** BCP-47 的主语言（`en` / `zh-CN`），认不出就不给这一格。 */
  language?: string
  /** ISO-3166 的两位地区码。 */
  region?: string
  /** 类目（自由词，最多 {@link MAX_CATEGORIES} 个）。 */
  categories?: string[]
  /** 这份资料**被看到**的时刻（不是被写进库的时刻）。 */
  observed_at: Iso8601
}

/** 观察的字段白名单。运行时逐键比对：不在这张表里的一律拒。 */
export const PUBLIC_OBSERVATION_FIELDS = [
  'channel',
  'handle',
  'followers',
  'posts_30d',
  'engagement_rate',
  'language',
  'region',
  'categories',
  'observed_at',
] as const satisfies readonly (keyof PublicCreatorObservation)[]

/** 一条观察最多带几个类目。 */
export const MAX_CATEGORIES = 8

/** 一次最多上报多少条观察。 */
export const MAX_OBSERVATIONS_PER_BATCH = 100

/**
 * 公共库里对外的那张卡。
 *
 * **没有邮箱**：有没有联系方式只用 `has_contact` 一个布尔表示，
 * 明文要付费 reveal（`data.kol.lookup`）。
 */
export interface PublicCreatorCard {
  channel: KolChannel
  handle: string
  followers: number
  posts_30d: number
  engagement_rate: number
  language?: string
  region?: string
  categories: string[]
  /** 最近一次被看到的时刻。 */
  observed_at: Iso8601
  /** 现在这张卡的资料是哪个来源写的。 */
  source: KolObservationSource
  /** 一共有几条观察落在这个红人上（体检报告的样本量）。 */
  observations: number
  /** 0–1。来源档 + 观察条数 + 新鲜度三项合成。 */
  confidence: number
  /** 库里有没有这个人的联系方式（**只说有没有，不说是什么**）。 */
  has_contact: boolean
  updated_at: Iso8601
}

/** 浏览的过滤条件（全是可选的；`limit` 有上限 {@link MAX_CREATOR_LIMIT}）。 */
export interface PublicCreatorQuery {
  channel?: KolChannel
  /** 在 handle 与类目里找（子串，大小写不敏感）。 */
  q?: string
  min_followers?: number
  category?: string
  limit?: number
}

export const DEFAULT_CREATOR_LIMIT = 20
export const MAX_CREATOR_LIMIT = 100

/**
 * 库里的联系方式。**明文一个字节都没有**：
 * `email_sha256` 用来去重与"同一人合并"（48 §1.2），`email_cipher` 是云侧
 * 租户无关的服务密钥加出来的密文（密钥只从环境变量读，见包的 README）。
 */
export interface PublicCreatorContact {
  channel: KolChannel
  handle: string
  /** 小写化邮箱的 sha256（十六进制）。 */
  email_sha256: string
  /** `iv.tag.ciphertext`（都是 base64url）。 */
  email_cipher: string
  source: KolObservationSource
  /** 谁回填的（给贡献奖励用；不进任何对外响应）。 */
  contributed_by: WorkspaceId
  at: Iso8601
}

/** 付费 reveal 的返回：明文**只在这里出现一次**。 */
export interface RevealedContact {
  channel: KolChannel
  handle: string
  email: string
  source: KolObservationSource
  at: Iso8601
  /** 这一次扣了多少积分（0 = 这个组织本次没有被计费，见响应里的说明）。 */
  credits: number
}

/** 体检报告的风险标记。**只标不判**——是不是不合作由用户自己定。 */
export type AuditRiskFlag =
  | 'no_recent_posts'
  | 'engagement_far_below_peers'
  | 'engagement_far_above_peers'
  | 'follower_spike'
  | 'single_source'
  | 'stale_data'

/**
 * 体检报告（免费那份 `depth: 'basic'`；付费深度体检这一版也是 `basic` 的骨架 +
 * 基准分位，真的深度分析留给后续 WP）。
 *
 * **数据不足就明说**：`insufficient_samples` 为真时几个估计值一格都没有，
 * 而不是给一个编出来的数（21 §4「说不出来就说说不出来」）。
 */
export interface AuditReport {
  channel: KolChannel
  handle: string
  depth: 'basic' | 'deep'
  /** 这份报告基于几条观察。 */
  sample_size: number
  insufficient_samples: boolean
  /** 粉丝真实度估计（0–1）。样本不够就没有这一格。 */
  follower_authenticity?: number
  /** 互动率在同渠道同粉丝量级里的分位（0–100）。基准桶不够 k 就没有这一格。 */
  engagement_percentile?: number
  /** 近 30 天有没有发布。 */
  active_30d: boolean
  risk_flags: AuditRiskFlag[]
  /** 深度体检才有：这个桶的分位数（k-匿名过关时）。 */
  benchmark?: Benchmark
  /** 一句人话，说清楚这份报告能信到什么程度。 */
  note: string
  generated_at: Iso8601
}

/** 出一份可用的体检报告至少要几条观察。 */
export const MIN_AUDIT_SAMPLES = 3

/** 一条资料多久算"旧"（体检报告会标 `stale_data`）。 */
export const STALE_AFTER_DAYS = 90

/** 粉丝量级分桶（k-匿名基准按它分组）。 */
export type FollowersBand = '0-10k' | '10k-100k' | '100k-1m' | '1m+'

export const FOLLOWERS_BANDS: readonly FollowersBand[] = ['0-10k', '10k-100k', '100k-1m', '1m+']

/** 一个粉丝数落在哪个桶。 */
export function followersBandOf(followers: number): FollowersBand {
  if (followers < 10_000) return '0-10k'
  if (followers < 100_000) return '10k-100k'
  if (followers < 1_000_000) return '100k-1m'
  return '1m+'
}

/**
 * k-匿名基准（21）。
 *
 * **每个桶至少 {@link BENCHMARK_MIN_SAMPLES} 条观察才出数**，否则
 * `insufficient_samples: true` 且分位数一格都没有。只回分位数，不回个体——
 * 一个桶里只有三个人的时候，"p50 是多少"就等于把那三个人的数报出去了。
 */
export interface Benchmark {
  channel: KolChannel
  category: string
  followers_band: FollowersBand
  sample_size: number
  insufficient_samples: boolean
  engagement_rate?: { p25: number; p50: number; p75: number }
  followers?: { p25: number; p50: number; p75: number }
  computed_at: Iso8601
}

/** k 的那个 k。低于它不出数。 */
export const BENCHMARK_MIN_SAMPLES = 20

/** 类目没填时用的那一档（基准按渠道 + 量级出，不按类目）。 */
export const ANY_CATEGORY = 'any'

/**
 * 插件配对（48 §5.3「插件采集汇聚」）。
 *
 * 用工作区服务令牌换一把**插件令牌**：短期（{@link PLUGIN_TOKEN_TTL_MS}）、
 * 可撤、库里**只有哈希**。明文只在 {@link IssuedPluginToken} 里出现一次。
 * 为什么不让插件直接拿工作区令牌：插件跑在浏览器里，那把令牌能调模型、能看余额——
 * 一个装在几千台电脑上的扩展不该握着它（18 §1 最小动作集）。
 */
export interface PluginPairing {
  id: string
  workspace_id: WorkspaceId
  org_id: string
  account_id: string
  /** 给人看的名字（"Chrome 上的采集插件"）。 */
  label: string
  token_sha256: string
  issued_at: Iso8601
  expires_at: Iso8601
  revoked_at?: Iso8601
  /** 累计有效观察条数（贡献奖励按它算）。 */
  valid_observations: number
  /** 累计已发的奖励积分。 */
  granted_credits: number
}

/** 配对的返回：明文只在这里出现一次。 */
export interface IssuedPluginToken {
  pairing: PluginPairing
  /** `plg_…`。不进日志、不进事件、不进任何库。 */
  token: string
  expires_at: Iso8601
}

/** 插件令牌前缀。 */
export const PLUGIN_TOKEN_PREFIX = 'plg_'

/** 插件令牌有效期：30 天（18 §1「短期」，没有"永不过期"这一档）。 */
export const PLUGIN_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 每个插件每天最多上报多少条观察；超了 429。 */
export const MAX_PLUGIN_OBSERVATIONS_PER_DAY = 500

/** 多少条**有效**观察换 1 积分。 */
export const OBSERVATIONS_PER_CREDIT = 100

/** 同一个 handle 多久之内重复上报不算有效（风控）。 */
export const OBSERVATION_DEDUPE_HOURS = 24

/** 一个贡献者一天最多拿多少奖励积分（风控）。 */
export const MAX_DAILY_REWARD_CREDITS = 5

/** 奖励积分是"送的"那一类：{@link CONTRIBUTION_CREDIT_TTL_DAYS} 天到期清零（49 §3）。 */
export const CONTRIBUTION_CREDIT_TTL_DAYS = 90

/** 回填一条新联系方式给多少积分。 */
export const CONTACT_REWARD_CREDITS = 1

/**
 * 一次贡献结算的结果（上报观察 / 回填联系方式都回它）。
 *
 * `rejected` 里是**为什么没算**，一条一句人话——风控不该是一个静默的 0。
 */
export interface ContributionEvent {
  kind: 'observation' | 'contact'
  /** 收到几条。 */
  received: number
  /** 其中几条算有效（过了去重与白名单）。 */
  accepted: number
  /** 这一次发了多少奖励积分。 */
  credits_granted: number
  /** 今天还能拿多少（到 {@link MAX_DAILY_REWARD_CREDITS} 封顶）。 */
  daily_reward_remaining: number
  /** 今天这个插件还能报多少条。 */
  daily_quota_remaining: number
  rejected: { reason: string; count: number }[]
  at: Iso8601
}

/** 争议：某条公开资料不对。**只记不裁**——owner 后台看，系统不自动改数据。 */
export interface Dispute {
  id: string
  channel: KolChannel
  handle: string
  /** 哪一格不对（`followers` / `region` / `contact` …）。 */
  field: string
  /** 一句话说明。**不收正文**：最长 {@link MAX_DISPUTE_CLAIM} 个字。 */
  claim: string
  reported_by: WorkspaceId
  org_id: string
  status: 'open'
  at: Iso8601
}

export const MAX_DISPUTE_CLAIM = 500

/** 三条能力名（价目表 `pricing.json` 里本来就有这三条，WP59 留的）。 */
export const KOL_LOOKUP_CAPABILITY = 'data.kol.lookup'
export const KOL_AUDIT_CAPABILITY = 'data.kol.audit'
export const SOCIAL_FETCH_CAPABILITY = 'social.fetch'

/** 计价单位（价目表里那三条都是按次）。 */
export const KOL_UNIT = 'call'

/**
 * YouTube 官方 API 的**全站**日配额（单位，不是次数）。耗尽自动降级到 Apify。
 *
 * 为什么是全站一个池子而不是按租户分：配额本来就是我们这把 key 的配额，
 * 按租户切只会让第一个租户把别人的份额也占着（48 §1.2 的原文做法）。
 */
export const YOUTUBE_UNITS_PER_DAY = 10_000

/** 一次搜索 / 一次频道读各消耗多少单位（YouTube Data API 的官方口径）。 */
export const YOUTUBE_UNIT_COST = { search: 100, channel: 1 } as const

/** 数据驻留头（22 §2；与服务入口那条逐字同一个）。 */
export const KOL_REGION_HEADER = 'X-Agentsws-Region'

/** 公共库这一组要的动作集（18 §1 最小动作集）。 */
export const KOL_PUBLIC_SCOPE = 'data'
