/**
 * 48 §5.2 红人营销的六个对象 + 五条渠道的常量表（WP67）。
 *
 * 三条纪律写在类型里，不写在文档里：
 *
 * 1. **渠道之间零共享数据**（48 §5.1 末句）。同一个人在 YouTube 和在 Instagram
 *    是两条 {@link PlatformAccount}，各带各的粉丝数、互动率、观测时间。把它们挂到
 *    一起的是 {@link Creator}——而合并**永远是一张建议卡**，不是一次自动写入
 *    （`merged_from` 留着被合掉的那几条 id，所以合错了拆得回来）。
 * 2. **联系方式不存明文**。{@link CreatorContact.value_ref} 是本机加密库里的 key 名，
 *    不是邮箱地址本身。于是导出包、事件日志、模型上下文里出现的都只是一个 key，
 *    真地址只有发信那一跳才解得开。这一条和 21 §1「订单只进模型上下文」是同一条。
 * 3. **合规姿态是 schema 的一部分**（48 §1.3 第 4 条）。{@link CreatorContact.source}
 *    记这条联系方式从哪来（频道"关于"页 / 用户导入 / 公共库 reveal），
 *    {@link PlatformAccount.observed_at} 记这份数字是什么时候看到的——
 *    半年前的粉丝数拿来打分，和编一个数没什么区别。
 */

import type { Iso8601 } from './common.js'

/** 五条渠道（48 §5.1）。职责 id 是 `kol.<channel>`。 */
export type KolChannel = 'youtube' | 'facebook' | 'instagram' | 'tiktok' | 'x'

/**
 * 这条渠道的数据怎么拿得到。
 *
 * - `official`：官方 API 直接可用（申请即给，或公开）；
 * - `apply`：申请制，批了才有（TikTok Research API）；
 * - `paid`：官方 API 收费（X）；
 * - `plugin_only`：只能靠浏览器插件采集汇聚（48 §5.3 云端那一半）。
 *
 * 界面上据此说人话："这条渠道要先申请"比"连接失败"有用得多。
 */
export type KolApiAccess = 'official' | 'apply' | 'paid' | 'plugin_only'

export interface KolChannelSpec {
  id: KolChannel
  /** 中文名（界面上那一个）。 */
  zh: string
  en: string
  /** 品牌图标 id（`apps/workstation` 的 `brand-icons`）。 */
  icon: string
  api_access: KolApiAccess
  /** 这条渠道的连接器 kind（职责 yml 的 `connectors[].kind`）。 */
  connector_kind: string
}

/**
 * 48 §5.1 那张表的机器可读版。**只有这一份**：职责 yml、连接目录、面板分块、
 * URL 解析都读它，谁都不许再抄一张渠道清单。
 */
export const KOL_CHANNELS: readonly KolChannelSpec[] = [
  {
    id: 'youtube',
    zh: 'YouTube',
    en: 'YouTube',
    icon: 'youtube',
    // Data API v3 公开可用，只是全站一天 10k 单位（48 §5.1 渠道特有那一列）
    api_access: 'official',
    connector_kind: 'youtube_data',
  },
  {
    id: 'facebook',
    zh: 'Facebook',
    en: 'Facebook',
    icon: 'facebook',
    // Graph API 要审权限才读得到主页洞察
    api_access: 'apply',
    connector_kind: 'facebook_graph',
  },
  {
    id: 'instagram',
    zh: 'Instagram',
    en: 'Instagram',
    icon: 'instagram',
    api_access: 'apply',
    connector_kind: 'instagram_graph',
  },
  {
    id: 'tiktok',
    zh: 'TikTok',
    en: 'TikTok',
    icon: 'tiktok',
    // Research API 申请制；没批下来就只有插件汇聚那条路
    api_access: 'apply',
    connector_kind: 'tiktok_research',
  },
  {
    id: 'x',
    zh: 'X',
    en: 'X',
    icon: 'x',
    api_access: 'paid',
    connector_kind: 'x_api',
  },
]

/** 渠道 id → 规格；不认识的回 `undefined`（不编造一条）。 */
export function kolChannelSpec(id: string): KolChannelSpec | undefined {
  return KOL_CHANNELS.find((c) => c.id === id)
}

/** 全部渠道 id，按 {@link KOL_CHANNELS} 的顺序。 */
export const KOL_CHANNEL_IDS: readonly KolChannel[] = KOL_CHANNELS.map((c) => c.id)

/**
 * 一个**人**（不是一个账号）。
 *
 * 跨渠道的同一个人靠它挂到一起；`merged_from` 是被合掉的那几条 creator id，
 * 顺序即合并顺序。合并只由人点头（48 §5.2「同一人合并」出的是建议卡）。
 */
export interface Creator {
  id: string
  display_name: string
  /** 合进来的那几条的 id（没合过就是空数组，不是 `undefined`——查询里少一个分支）。 */
  merged_from: string[]
  /**
   * WP117 交付 4：这一条是**演练数据**。
   *
   * 三件事挂在这一格上，缺一件演练模式就不成立：
   *
   * 1. **发不出去**。出站那一跳（服务端唯一的 `deliverOutbound`）看见收件人是
   *    演练红人就当场拦死，改投内存邮箱。硬闸在那里，不在界面上。
   * 2. **一键清得掉**。清空演练 = 删掉所有带这一格的记录，真数据一条不碰。
   * 3. **界面上看得出来**。列表里带一个「演练」角标，顶上一条状态带。
   *
   * 不带这一格 = 真数据。**默认真**是故意的：漏标一条演练数据只是多算一笔，
   * 漏标一条真数据会让本该发出去的信发不出去。
   */
  sandbox?: boolean
}

/** 一个渠道上的一个账号。同一个人在两条渠道 = 两条这个。 */
export interface PlatformAccount {
  id: string
  creator_id: string
  channel: KolChannel
  /** 平台上的用户名（带不带 @ 由解析归一，见 `kol-core` 的 `urls.ts`）。 */
  handle: string
  url: string
  followers?: number
  /** 互动率，**0–1 的小数**（不是百分数；两种写法混用是打分错得最难查的一种）。 */
  engagement_rate?: number
  category?: string
  /** BCP-47 语言标签（`en` / `zh-Hans` / `de`）。 */
  language?: string
  /** ISO-3166 地区码（`US` / `DE`）。 */
  region?: string
  /** 这份数字是什么时候看到的。**必填**：没有它，粉丝数是个不知道多旧的传闻。 */
  observed_at: Iso8601
}

/** 联系方式的种类。`form` = 平台上的合作表单 / 商务合作页。 */
export type CreatorContactKind = 'email' | 'dm' | 'form'

/**
 * 一条联系方式。**明文不在这里**（见文件头第 2 条）。
 */
export interface CreatorContact {
  id: string
  creator_id: string
  kind: CreatorContactKind
  /** 本机加密库里的 key 名。取明文要经加密库，拿不到就发不出信——这正是想要的。 */
  value_ref: string
  /** 从哪来：`channel_about` / `import` / `public_library` / `reply`（自由字符串，界面上原样显示）。 */
  source: string
  /** 验过没有（发过一封没退信 / 对方回过信）。没验过就是 `undefined`，不是 false。 */
  verified_at?: Iso8601
}

/**
 * 合作的阶段（48 §5.1 那条链）。
 *
 * 九态，单向为主：`sourced → contacted → replied → negotiating → agreed →
 * delivering → delivered → closed`，任何一态都可以掉到 `declined`。
 * 合法迁移表在 `@agentsws/kol-core` 的 `stages.ts` 里——**只有那一份**。
 */
export type CollaborationStage =
  | 'sourced'
  | 'contacted'
  | 'replied'
  | 'negotiating'
  | 'agreed'
  | 'delivering'
  | 'delivered'
  | 'closed'
  | 'declined'

export interface Collaboration {
  id: string
  creator_id: string
  /** 这次合作走的是哪条渠道（同一个人两条渠道各一条合作，额度各算各的）。 */
  channel: KolChannel
  campaign_id?: string
  stage: CollaborationStage
  /** 预算。**永远 L1**（`kol_collaboration` 在 15 §2 的 `HARD_L1` 里）。 */
  budget?: number
  currency: string
  agreed_at?: Iso8601
  /** 条款正文的引用（知识层的一张卡 / 一个附件 id），不把合同正文塞进这条记录。 */
  terms_ref?: string
  /** WP117 交付 4：这条合作属于演练活动（见 {@link Creator.sandbox}）。 */
  sandbox?: boolean
}

/** 交付物的形态（五条渠道的并集）。 */
export type DeliverableKind = 'video' | 'post' | 'story' | 'reel' | 'thread' | 'live'
/** 审核结论。`changes_requested` 与 `rejected` 分开：一个是还能改，一个是这条不要了。 */
export type DeliverableReview = 'pending' | 'approved' | 'changes_requested' | 'rejected'

export interface Deliverable {
  id: string
  collaboration_id: string
  kind: DeliverableKind
  url?: string
  due_at: Iso8601
  submitted_at?: Iso8601
  review: DeliverableReview
  notes?: string
}

/**
 * 一条带 UTM / 联盟码的追踪链接。归因表就是这张表的投影。
 *
 * `clicks` / `orders` / `revenue` 是**回填**的：链接建出来的时候三个都是 0，
 * 订单匹配上了才涨。不给默认值（写成 `?`）的话，面板上分不清"还没有数"
 * 和"真的是 0"。
 */
export interface TrackedLink {
  id: string
  collaboration_id: string
  url: string
  /** UTM 五参数（`utm_source` 那一套，键名不带前缀）。 */
  utm: KolUtm
  affiliate_code?: string
  clicks: number
  orders: number
  revenue: number
}

/** UTM 五参数。`source` / `medium` / `campaign` 必填，另外两个可选（GA4 的口径）。 */
export interface KolUtm {
  source: string
  medium: string
  campaign: string
  term?: string
  content?: string
}
