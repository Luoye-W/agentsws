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
import type { KolChannel } from './kol.js'

/** 48 §5.1 的五条渠道。库按它分区，同一个人在两个渠道是两条记录。 */

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
  /**
   * 近 30 天发布数。
   *
   * WP130：**只对插件来源（`source: 'plugin'`）可缺**——浏览器插件在一个页面上看不到
   * 「近 30 天发了几条」「互动率」，逼它报就只能编一个 0。缺的行照样进库、照样更新
   * 卡面上看得见的那几格，但**k-匿名基准跳过它**（缺不是 0），体检也不拿它下判断。
   * 其余来源（官方 / apify / 工作区手填）照旧必须给。
   */
  posts_30d?: number
  /** 互动率（0–1 的小数，不是百分数）。可缺的规则同 `posts_30d`。 */
  engagement_rate?: number
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

  /*
   * ↓ WP116 搬家（48 §5.3 / 64 §10.2）新增的几格。全是**可选**：本系统自己攒的
   * 行一格都不给，只有从别处搬进来的才有。加它们的理由是搬家那一刻必须无损——
   * 丢掉 `external_id` 之后"同一个人改了 handle"就再也认不回来了。
   */

  /**
   * 平台原生 id（YouTube 的 channelId、IG / TikTok 的 user id）。
   *
   * 库的主键仍然是 `{ channel, handle }`（自足键那条纪律不动），这一格只是
   * **搬家与去重的锚**：handle 会被改，原生 id 不会。
   */
  external_id?: string
  /** 展示名（频道名 / 昵称）。`handle` 是账号名，这一格是给人看的那个名字。 */
  name?: string
  /** 头像地址。**只存地址不存图**——图会过期，而我们不做图床。 */
  avatar_url?: string
  /** 国家 / 地区（ISO-3166 两位）；与 `region` 同义，搬家来的那一批填这一格。 */
  country?: string
  /** 同一个人在多个渠道的分组 id（库内分组，不对外解释成"这就是同一个人"）。 */
  person_id?: string
  /**
   * 对不上我们字段的那些公开事实。
   *
   * **只放标量**（数、串、真假），不放正文、不放数组、不放嵌套对象——
   * `extra` 是一个"别丢掉"的兜底，不是一个可以往里塞任何东西的口袋。
   */
  extra?: Record<string, string | number | boolean>
  /** 这一行是从哪儿搬来的（`kolagents`）。空 = 本系统自己攒的。 */
  imported_from?: string
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

  /*
   * ↓ WP116 搬家新增，全可选。合规上最要紧的是 `source_url`：
   * "这个邮箱你从哪儿看到的" 是任何一次移除请求的第一个问题。
   */

  /** 贡献者当时看到这个邮箱的**公开页面**地址（合规审计线索）。 */
  source_url?: string
  /**
   * 比 `source` 更细的一档（`plugin_manual` / `observation_email` /
   * `youtube_channel_description` / `apify_tiktok_bio` / `manual`）。
   *
   * 为什么不把 `source` 的枚举扩开：那四档是**可信度的档位**（`SOURCE_CONFIDENCE`
   * 按它查表），细分路径是另一件事。混成一个枚举等于每加一条采集路径就要
   * 重新校准一次可信度。
   */
  source_detail?: string
  /** 0–1。搬家来的那一批按原系统的确认 / 报错数折出来。 */
  confidence?: number
  /** 有几个人确认过这条是对的。 */
  confirmations?: number
  /** 有几个人报过错。 */
  disputes?: number
}

/**
 * 一条**内容样本**（WP116 搬家：`public_content` 那一层）。
 *
 * 为什么公共库里要有内容：判断一个红人值不值得合作，"他最近发的东西大概长什么样、
 * 播放量在什么量级"比粉丝数有用得多。而这些是**创作者自己公开发布的元数据**
 * （标题、封面、时长、播放数），不是 48 §1.3 第 4 条挡的那种正文（评论 / 私信 /
 * 视频文案）——**这里一个字的评论都不收**。
 */
export interface PublicContentSample {
  channel: KolChannel
  /** 归属的红人（自足键的另一半）。 */
  handle: string
  /** 平台原生内容 id（YouTube 的 videoId、IG 的 shortcode）。 */
  external_id: string
  content_type: 'video' | 'post' | 'reel'
  /** 标题。它是创作者给自己作品起的名字，不是正文。 */
  title?: string
  url?: string
  thumbnail_url?: string
  /** 从标题里摘出来的话题标签（**不带 `#`**）。 */
  tags?: string[]
  orientation?: 'landscape' | 'portrait'
  duration_seconds?: number
  published_at?: Iso8601
  views?: number
  likes?: number
  comments?: number
  shares?: number
  /**
   * WP129：页面上有没有「含付费推广」这一类广告标识（平台自己打的那个标，
   * 不是我们猜的）。没看到 / 没采到就没有这一格——`false` 是"看过、没有"。
   */
  paid_promotion?: boolean
  /** WP129：有没有带货（商品标签 / 购物车 / 商品链接那一类平台原生入口）。语义同上。 */
  shoppable?: boolean
  /** 这份快照**被看到**的时刻。 */
  observed_at: Iso8601
  source: KolObservationSource
  updated_at: Iso8601
}

/**
 * 一条**内容观测**（WP129）：插件在视频页看到的那一刻的数，经本机服务转发进公共库。
 *
 * 与 {@link PublicCreatorObservation} 同一条纪律：键就是白名单
 * （{@link PUBLIC_CONTENT_OBSERVATION_FIELDS}），多一个键整批拒——**没有评论这一格**，
 * 也没有页面地址 / 封面地址（带平台的一次性参数）与任何用户自己写的备注。
 * `comments` 是评论**数**，不是评论。
 */
export interface PublicContentObservation {
  channel: KolChannel
  /** 作者在这条渠道上的 handle（自足键的另一半；只认 handle，不认平台内部 id）。 */
  handle: string
  /** 平台原生内容 id（YouTube 的 videoId、IG 的 shortcode）。 */
  external_id: string
  content_type: 'video' | 'post' | 'reel'
  /** 标题。创作者给自己作品起的名字，不是正文。 */
  title?: string
  published_at?: Iso8601
  duration_seconds?: number
  orientation?: 'landscape' | 'portrait'
  views?: number
  likes?: number
  comments?: number
  shares?: number
  paid_promotion?: boolean
  shoppable?: boolean
  /** 这一刻**被看到**的时间。幂等按它分桶（{@link CONTENT_OBSERVATION_BUCKET}）。 */
  observed_at: Iso8601
}

/** 内容观测的字段白名单。运行时逐键比对：不在这张表里的一律拒。 */
export const PUBLIC_CONTENT_OBSERVATION_FIELDS = [
  'channel',
  'handle',
  'external_id',
  'content_type',
  'title',
  'published_at',
  'duration_seconds',
  'orientation',
  'views',
  'likes',
  'comments',
  'shares',
  'paid_promotion',
  'shoppable',
  'observed_at',
] as const satisfies readonly (keyof PublicContentObservation)[]

/**
 * 内容观测的幂等分桶：**同一条内容（渠道 + external_id）同一个 UTC 日只算一条**。
 *
 * 与本机 `content_observation` 的去重同一个口径（插件离线攒的队列补传、多人同一天
 * 看同一条视频，都不会让一条事实变成几条）。桶内重复报只刷新卡上的数、不再多记
 * 一行指标、也不算贡献奖励。
 */
export const CONTENT_OBSERVATION_BUCKET = 'utc_day' as const

/**
 * 一条**指标快照**（WP116 搬家：`public_creator_metric` 那一层）。
 *
 * 与 {@link PublicCreatorObservation} 刻意分开，理由只有一条：观察要带
 * `posts_30d` 与 `engagement_rate`，而搬进来的那一批**没有这两个数**。
 * 把 0 填进观察表会让 k-匿名基准的中位互动率变成 0——一个编出来的数比
 * 没有数坏得多（21 §4）。所以它们落在自己这张表上，只出现在"粉丝增长"
 * 这类看得见来源的地方。
 */
export interface PublicCreatorMetricSnapshot {
  channel: KolChannel
  handle: string
  followers?: number
  /** 近期作品的平均播放量。 */
  avg_views?: number
  /** 账号累计作品数（不是近 30 天）。 */
  video_count?: number
  /** 账号累计播放量。 */
  total_views?: number
  observed_at: Iso8601
  source: KolObservationSource
}

/** 同一个人在多个渠道的分组（WP116 搬家：`public_person`）。**只分组，不下结论**。 */
export interface PublicPerson {
  id: string
  display_name?: string
  created_at: Iso8601
  updated_at: Iso8601
}

/**
 * 搬家的一行。NDJSON 一行一条，`kind` 是判别键。
 *
 * 为什么是一个联合而不是六个接口 / 六个路由：搬家是**一次性**的，而一次性的东西
 * 越少入口越好。一个 `POST /v1/admin/kol/import` 收所有 kind，脚本一趟推完，
 * 顺序由脚本保证（先 person / creator，再 contact / content / metric）。
 */
export type KolImportRecord =
  | ({ kind: 'person' } & PublicPerson)
  | ({
      kind: 'creator'
      /** 落库用的自足键的一半；没有 handle 的账号用 `external_id` 顶上。 */
      handle: string
      channel: KolChannel
      external_id?: string
      name?: string
      avatar_url?: string
      country?: string
      language?: string
      person_id?: string
      followers?: number
      posts_30d?: number
      engagement_rate?: number
      categories?: string[]
      observed_at?: Iso8601
      extra?: Record<string, string | number | boolean>
    } & Record<string, unknown>)
  | ({
      kind: 'contact'
      channel: KolChannel
      handle: string
      /** **明文**（只在导入的那一趟里出现；落库前就变成哈希 + 密文）。 */
      email: string
      source?: KolObservationSource
      source_url?: string
      source_detail?: string
      confirmations?: number
      disputes?: number
      at?: Iso8601
    } & Record<string, unknown>)
  | ({ kind: 'content' } & Partial<PublicContentSample> & {
        channel: KolChannel
        handle: string
        external_id: string
      })
  | ({ kind: 'content_metric' } & {
      channel: KolChannel
      handle: string
      /** 归属内容的平台原生 id。 */
      content_external_id: string
      views?: number
      likes?: number
      comments?: number
      shares?: number
      observed_at?: Iso8601
      source?: KolObservationSource
    })
  | ({ kind: 'metric' } & Partial<PublicCreatorMetricSnapshot> & {
        channel: KolChannel
        handle: string
      })

/** 搬家一趟的结果。**坏行不让整趟失败**，但要数出来。 */
export interface KolImportResult {
  received: number
  inserted: number
  updated: number
  skipped: number
  /** 一条一句人话（同一个理由合并计数）。 */
  rejected: { reason: string; count: number }[]
  at: Iso8601
}

/** 一次搬家最多推多少行（脚本按它分块）。 */
export const MAX_KOL_IMPORT_BATCH = 500

/** 公共红人库在运营后台那一页看到的那几个数（65 / WP116）。 */
export interface KolLibraryStats {
  creators: number
  contacts: number
  contents: number
  observations: number
  /** 从别处搬进来的红人行数。 */
  imported: number
  /** 被移除过（opt-out）的条数。 */
  removed: number
  new_7d: number
  new_30d: number
  by_channel: { channel: KolChannel; creators: number; contacts: number }[]
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
  /**
   * 这一次扣了多少积分（WP126 起体检报告按 `data.kol.audit` 收；老调用方
   * 看不到这一格时当 0 处理——字段是后加的，契约只加不删）。
   */
  credits?: number
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

/**
 * 贡献发不发积分奖励。**09-23 Luoye 定：不发**——红人观测、联系方式、内容观测一律
 * 不返 `granted` 积分（推翻 48 §5.3「免费（有贡献奖励）」、49 §3「贡献奖励发 granted」、
 * 75 §2 口径③）。贡献照旧免费、照旧不预扣；「贡献了什么」照旧记账（配额表的累计数、
 * 配对行的有效条数、每次结算回执里的 received / accepted）。下面几个奖励常量留着
 * （契约只加不删），只是不再生效。
 */
export const CONTRIBUTION_REWARDS_ENABLED = false

/** 多少条**有效**观察换 1 积分。（09-23 起停发，见 {@link CONTRIBUTION_REWARDS_ENABLED}） */
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
  /** WP129 加 `content`（内容观测；契约只加不删）。 */
  kind: 'observation' | 'contact' | 'content'
  /** 收到几条。 */
  received: number
  /** 其中几条算有效（过了去重与白名单）。 */
  accepted: number
  /** 这一次发了多少奖励积分。09-23 起恒为 0（{@link CONTRIBUTION_REWARDS_ENABLED}）。 */
  credits_granted: number
  /** 今天还能拿多少（到 {@link MAX_DAILY_REWARD_CREDITS} 封顶）。09-23 起恒为 0。 */
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
